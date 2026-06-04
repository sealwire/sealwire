use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use tokio::{
    sync::{oneshot, Mutex, RwLock},
    time::{sleep, Duration},
};

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{
        ApprovalDecision, ApprovalDecisionInput, ModelOptionView, ThreadSummaryView,
        TranscriptEntryKind, TranscriptEntryView,
    },
    provider::{ProviderBridge, StartThreadResult, ThreadSyncData},
    state::{
        ApprovalKind, BrokerPendingMessage, PendingApproval, PendingTranscriptDelta, RelayState,
        TranscriptDeltaKind,
    },
};

#[derive(Clone)]
struct FakeThread {
    summary: ThreadSummaryView,
    transcript: Vec<TranscriptEntryView>,
}

pub struct FakeProviderBridge {
    state: Arc<RwLock<RelayState>>,
    threads: Arc<Mutex<HashMap<String, FakeThread>>>,
    next_id: AtomicU64,
    // When set, a non-`bypass` turn parks on an approval request (a fake Bash
    // command) until respond_to_approval resolves it — letting tests exercise
    // the real permission-modal path. Off by default so existing fake e2e
    // suites (which send turns under various policies) stay unaffected; flipped
    // on via FAKE_PROVIDER_ENFORCE_APPROVALS for the permission-mode e2e.
    enforce_approvals: Arc<AtomicBool>,
    approval_gates: Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
}

impl FakeProviderBridge {
    pub async fn spawn(state: Arc<RwLock<RelayState>>) -> Result<Self, String> {
        let threads = Arc::new(Mutex::new(restore_threads_from_relay(&state).await));
        {
            let mut relay = state.write().await;
            relay.set_provider_connection("fake", true);
            relay.set_provider_name("fake".to_string());
            relay.push_log("info", "Connected to fake agent provider.");
            relay.notify();
        }

        let enforce_approvals = std::env::var("FAKE_PROVIDER_ENFORCE_APPROVALS")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        Ok(Self {
            state,
            threads,
            next_id: AtomicU64::new(1),
            enforce_approvals: Arc::new(AtomicBool::new(enforce_approvals)),
            approval_gates: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Read the approval policy recorded for a thread, falling back to the
    /// session-wide policy. Used to decide whether a turn must park on approval.
    async fn approval_policy_for(&self, thread_id: &str) -> String {
        let relay = self.state.read().await;
        relay
            .thread_settings(thread_id)
            .map(|settings| settings.approval_policy)
            .filter(|policy| !policy.is_empty())
            .unwrap_or_else(|| relay.approval_policy.clone())
    }

    fn next_token(&self, prefix: &str) -> String {
        format!(
            "{prefix}-{}-{}",
            unix_now(),
            self.next_id.fetch_add(1, Ordering::Relaxed)
        )
    }
}

#[async_trait]
impl ProviderBridge for FakeProviderBridge {
    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        let mut threads = self
            .threads
            .lock()
            .await
            .values()
            .map(|thread| thread.summary.clone())
            .collect::<Vec<_>>();
        threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        threads.truncate(limit);
        Ok(threads)
    }

    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        Ok(vec![ModelOptionView {
            model: "fake-echo".to_string(),
            display_name: "Fake Echo".to_string(),
            provider: "fake".to_string(),
            supported_reasoning_efforts: vec![
                "low".to_string(),
                "medium".to_string(),
                "high".to_string(),
            ],
            default_reasoning_effort: "medium".to_string(),
            hidden: false,
            is_default: true,
        }])
    }

    async fn start_thread(
        &self,
        cwd: &str,
        _model: &str,
        _approval_policy: &str,
        _sandbox: &str,
        _initial_prompt: Option<&str>,
    ) -> Result<StartThreadResult, String> {
        let thread = ThreadSummaryView {
            id: self.next_token("fake-thread"),
            name: Some("Fake E2E Session".to_string()),
            preview: String::new(),
            cwd: cwd.to_string(),
            updated_at: unix_now(),
            source: "fake".to_string(),
            status: "idle".to_string(),
            model_provider: "fake".to_string(),
            provider: "fake".to_string(),
        };
        self.threads.lock().await.insert(
            thread.id.clone(),
            FakeThread {
                summary: thread.clone(),
                transcript: Vec::new(),
            },
        );

        Ok(StartThreadResult {
            thread,
            consumed_initial_prompt: false,
            initial_user_message: None,
            started_turn_id: None,
        })
    }

    async fn resume_thread(
        &self,
        thread_id: &str,
        _approval_policy: &str,
        _sandbox: &str,
    ) -> Result<(), String> {
        if self.threads.lock().await.contains_key(thread_id) {
            Ok(())
        } else {
            Err(format!("fake thread '{thread_id}' was not found"))
        }
    }

    async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String> {
        let threads = self.threads.lock().await;
        let thread = threads
            .get(thread_id)
            .ok_or_else(|| format!("fake thread '{thread_id}' was not found"))?;
        Ok(ThreadSyncData {
            thread: thread.summary.clone(),
            status: thread.summary.status.clone(),
            active_flags: Vec::new(),
            transcript: thread.transcript.clone(),
        })
    }

    async fn read_thread_entry_detail(
        &self,
        thread_id: &str,
        item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        Ok(self.threads.lock().await.get(thread_id).and_then(|thread| {
            thread
                .transcript
                .iter()
                .find(|entry| entry.item_id.as_deref() == Some(item_id))
                .cloned()
        }))
    }

    async fn archive_thread(&self, thread_id: &str) -> Result<(), String> {
        self.threads.lock().await.remove(thread_id);
        Ok(())
    }

    async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        self.threads.lock().await.remove(thread_id);
        Ok(LocalThreadDeleteSummary {
            deleted_paths: Vec::new(),
            deleted_thread_row: true,
        })
    }

    async fn start_turn(
        &self,
        thread_id: &str,
        text: &str,
        _model: &str,
        _effort: &str,
    ) -> Result<Option<String>, String> {
        if !self.threads.lock().await.contains_key(thread_id) {
            return Err(format!("fake thread '{thread_id}' was not found"));
        }

        let thread_id = thread_id.to_string();
        let prompt = text.to_string();
        let reply = fake_reply_for_prompt(&prompt);
        let turn_id = self.next_token("fake-turn");
        let user_item_id = self.next_token("fake-user");
        let assistant_item_id = self.next_token("fake-assistant");
        let state = self.state.clone();
        let threads = self.threads.clone();
        let turn_id_for_task = turn_id.clone();

        // Decide up front whether this turn must park on an approval request.
        let needs_approval = self.enforce_approvals.load(Ordering::Relaxed)
            && self.approval_policy_for(&thread_id).await != "bypass";
        let approval_request_id = self.next_token("fake-approval");
        let approval_gates = self.approval_gates.clone();

        tokio::spawn(async move {
            let user_entry = TranscriptEntryView {
                item_id: Some(user_item_id.clone()),
                kind: TranscriptEntryKind::UserText,
                text: Some(prompt.clone()),
                status: "completed".to_string(),
                turn_id: Some(turn_id_for_task.clone()),
                tool: None,
            };
            let assistant_entry = TranscriptEntryView {
                item_id: Some(assistant_item_id.clone()),
                kind: TranscriptEntryKind::AgentText,
                text: Some(reply.clone()),
                status: "completed".to_string(),
                turn_id: Some(turn_id_for_task.clone()),
                tool: None,
            };

            // 1. Record the user's turn.
            {
                let mut relay = state.write().await;
                relay.set_thread_status(&thread_id, "active".to_string(), Vec::new());
                if relay.active_thread_id.as_deref() == Some(thread_id.as_str()) {
                    relay.set_active_turn(Some(turn_id_for_task.clone()));
                    relay.upsert_user_message(
                        user_item_id.clone(),
                        prompt.clone(),
                        turn_id_for_task.clone(),
                    );
                } else {
                    let now = unix_now();
                    relay.bg_set_active_turn(&thread_id, Some(turn_id_for_task.clone()), now);
                    relay.bg_set_thread_status(&thread_id, "active".to_string(), Vec::new(), now);
                    relay.bg_upsert_user_message(
                        &thread_id,
                        user_item_id.clone(),
                        prompt.clone(),
                        turn_id_for_task.clone(),
                        now,
                    );
                }
                relay.notify();
            }

            // 2. Park on an approval request when the policy requires it. Only
            // foreground (active) turns gate; background fake turns auto-proceed.
            if needs_approval
                && state.read().await.active_thread_id.as_deref() == Some(thread_id.as_str())
            {
                let (decision_tx, decision_rx) = oneshot::channel();
                approval_gates
                    .lock()
                    .await
                    .insert(approval_request_id.clone(), decision_tx);
                {
                    let mut relay = state.write().await;
                    relay.set_thread_status(
                        &thread_id,
                        "active".to_string(),
                        vec!["waitingOnApproval".to_string()],
                    );
                    relay.pending_approvals.insert(
                        approval_request_id.clone(),
                        make_fake_approval(&approval_request_id, &thread_id, &prompt),
                    );
                    relay.touch_progress(Some("waiting_approval"), None);
                    relay.push_log("approval", "Fake provider requests approval for: Bash");
                    relay.notify();
                }

                let decision = decision_rx.await.unwrap_or(ApprovalDecision::Cancel);
                approval_gates.lock().await.remove(&approval_request_id);

                if !matches!(decision, ApprovalDecision::Approve) {
                    let mut relay = state.write().await;
                    relay.pending_approvals.remove(&approval_request_id);
                    relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
                    if relay.active_thread_id.as_deref() == Some(thread_id.as_str()) {
                        relay.set_active_turn(None);
                    }
                    relay.push_log("info", "Fake provider turn was denied.");
                    relay.notify();
                    if let Some(thread) = threads.lock().await.get_mut(&thread_id) {
                        thread.summary.status = "idle".to_string();
                        thread.summary.updated_at = unix_now();
                        thread.transcript.push(user_entry);
                    }
                    return;
                }

                // Approved: drop the waiting flag before streaming the reply.
                let mut relay = state.write().await;
                relay.set_thread_status(&thread_id, "active".to_string(), Vec::new());
                relay.notify();
            }

            // 3. Begin the agent reply.
            {
                let mut relay = state.write().await;
                if relay.active_thread_id.as_deref() == Some(thread_id.as_str()) {
                    relay.start_agent_message(assistant_item_id.clone(), turn_id_for_task.clone());
                } else {
                    relay.bg_start_agent_message(
                        &thread_id,
                        assistant_item_id.clone(),
                        turn_id_for_task.clone(),
                        unix_now(),
                    );
                }
                relay.notify();
            }

            for chunk in reply_chunks(&reply) {
                sleep(Duration::from_millis(20)).await;
                let mut relay = state.write().await;
                if relay.active_thread_id.as_deref() == Some(thread_id.as_str()) {
                    let mutation =
                        relay.append_agent_delta(&assistant_item_id, &chunk, &turn_id_for_task);
                    relay
                        .pending_broker_messages
                        .push(BrokerPendingMessage::TranscriptDelta(
                            PendingTranscriptDelta {
                                thread_id: thread_id.clone(),
                                base_revision: mutation.base_revision,
                                revision: mutation.revision,
                                entry_seq: mutation.entry_seq,
                                server_time: mutation.server_time,
                                item_id: assistant_item_id.clone(),
                                turn_id: Some(turn_id_for_task.clone()),
                                delta: chunk,
                                kind: TranscriptDeltaKind::AgentText,
                            },
                        ));
                } else {
                    relay.bg_append_agent_delta(
                        &thread_id,
                        &assistant_item_id,
                        &chunk,
                        &turn_id_for_task,
                        unix_now(),
                    );
                }
                relay.notify();
            }

            {
                let mut relay = state.write().await;
                relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
                if relay.active_thread_id.as_deref() == Some(thread_id.as_str()) {
                    relay.complete_agent_message(
                        assistant_item_id,
                        reply,
                        turn_id_for_task.clone(),
                    );
                    relay.set_active_turn(None);
                } else {
                    let now = unix_now();
                    relay.bg_complete_agent_message(
                        &thread_id,
                        assistant_item_id,
                        reply,
                        turn_id_for_task.clone(),
                        now,
                    );
                    relay.bg_set_active_turn(&thread_id, None, now);
                    relay.bg_set_thread_status(&thread_id, "idle".to_string(), Vec::new(), now);
                }
                relay.push_log(
                    "info",
                    format!("Fake provider completed turn {turn_id_for_task}."),
                );
                relay.notify();
            }

            if let Some(thread) = threads.lock().await.get_mut(&thread_id) {
                thread.summary.preview = user_entry.text.clone().unwrap_or_default();
                thread.summary.status = "idle".to_string();
                thread.summary.updated_at = unix_now();
                thread.transcript.push(user_entry);
                thread.transcript.push(assistant_entry);
            }
        });

        Ok(Some(turn_id))
    }

    async fn interrupt_turn(&self, thread_id: &str, _turn_id: &str) -> Result<(), String> {
        let mut relay = self.state.write().await;
        relay.set_active_turn(None);
        relay.set_thread_status(thread_id, "idle".to_string(), Vec::new());
        relay.push_log("info", "Fake provider turn interrupted.");
        relay.notify();
        Ok(())
    }

    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        // Unblock the parked turn (if any) with the user's decision. The app
        // layer clears the pending approval from relay state after this returns.
        if let Some(sender) = self.approval_gates.lock().await.remove(&pending.request_id) {
            let _ = sender.send(input.decision);
        }
        Ok(())
    }

    async fn respond_to_ask_user_question(
        &self,
        _request_id: &str,
        _answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        Err("fake provider does not surface AskUserQuestion".to_string())
    }

    fn provider_name(&self) -> &'static str {
        "fake"
    }
}

async fn restore_threads_from_relay(
    state: &Arc<RwLock<RelayState>>,
) -> HashMap<String, FakeThread> {
    let snapshot = state.read().await.snapshot();
    let Some(thread_id) = snapshot.active_thread_id.clone() else {
        return HashMap::new();
    };

    // The relay no longer persists transcript history to disk (it is treated as
    // ephemeral provider data, restored on resume from the provider's own
    // store). The fake provider has no real session store, so tests that need a
    // pre-existing transcript seed it via FAKE_PROVIDER_SEED_PATH — a JSON file
    // holding a `Vec<TranscriptEntryView>`. Fall back to whatever the snapshot
    // carries (normally empty on a cold boot) when no seed is configured.
    let transcript = load_seed_transcript().unwrap_or(snapshot.transcript);

    let preview = transcript
        .iter()
        .rev()
        .find_map(|entry| entry.text.clone())
        .unwrap_or_default();
    let thread = ThreadSummaryView {
        id: thread_id.clone(),
        name: Some("Fake E2E Session".to_string()),
        preview,
        cwd: snapshot.current_cwd,
        updated_at: snapshot.server_time,
        source: "fake".to_string(),
        status: snapshot.current_status,
        model_provider: "fake".to_string(),
        provider: "fake".to_string(),
    };

    HashMap::from([(
        thread_id,
        FakeThread {
            summary: thread,
            transcript,
        },
    )])
}

/// Load a transcript fixture for the fake provider from `FAKE_PROVIDER_SEED_PATH`,
/// if set. The file is a JSON array of `TranscriptEntryView`. Used by browser
/// e2e tests that need to render a pre-existing transcript (e.g. file-diff
/// rollback/reapply) without depending on relay-state persistence internals.
fn load_seed_transcript() -> Option<Vec<TranscriptEntryView>> {
    let path = std::env::var_os("FAKE_PROVIDER_SEED_PATH")?;
    let contents = match std::fs::read(&path) {
        Ok(contents) => contents,
        Err(error) => {
            eprintln!(
                "fake provider: failed to read FAKE_PROVIDER_SEED_PATH {}: {error}",
                Path::new(&path).display()
            );
            return None;
        }
    };
    match serde_json::from_slice::<Vec<TranscriptEntryView>>(&contents) {
        Ok(transcript) => Some(transcript),
        Err(error) => {
            eprintln!(
                "fake provider: failed to decode FAKE_PROVIDER_SEED_PATH transcript: {error}"
            );
            None
        }
    }
}

fn make_fake_approval(request_id: &str, thread_id: &str, prompt: &str) -> PendingApproval {
    PendingApproval {
        request_id: request_id.to_string(),
        raw_request_id: serde_json::Value::String(request_id.to_string()),
        kind: ApprovalKind::Command,
        thread_id: thread_id.to_string(),
        summary: format!("Run a shell command for: {prompt}"),
        detail: None,
        command: Some("echo fake-approval".to_string()),
        cwd: None,
        context_preview: None,
        requested_permissions: None,
        available_decisions: vec!["approve".to_string(), "deny".to_string()],
        supports_session_scope: false,
    }
}

fn fake_reply_for_prompt(prompt: &str) -> String {
    if let Some((_, expected)) = prompt.split_once("and no extra text:\n") {
        return expected.trim_end().to_string();
    }

    prompt
        .strip_prefix("Reply with exactly: ")
        .unwrap_or(prompt)
        .to_string()
}

fn reply_chunks(reply: &str) -> Vec<String> {
    let mut chunks = reply
        .split_inclusive('\n')
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use tokio::{
        sync::watch,
        time::{sleep, Duration},
    };

    use super::*;
    use crate::state::SecurityProfile;

    #[tokio::test]
    async fn spawn_restores_active_thread_from_relay_state() {
        let (change_tx, _change_rx) = watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp/project".to_string(),
            change_tx,
            SecurityProfile::private(),
        )));

        {
            let mut relay = state.write().await;
            relay.activate_thread(
                test_thread("fake-thread-1", "/tmp/project"),
                "/tmp/project",
                "fake-echo",
                "never",
                "workspace-write",
                "medium",
                "device-1",
            );
            relay.upsert_transcript_item(
                "history-1".to_string(),
                TranscriptEntryKind::AgentText,
                Some("before restart".to_string()),
                "completed".to_string(),
                Some("turn-1".to_string()),
                None,
            );
        }

        let bridge = FakeProviderBridge::spawn(state)
            .await
            .expect("fake provider");
        let restored = bridge
            .read_thread("fake-thread-1")
            .await
            .expect("restored thread should be readable");
        assert_eq!(restored.thread.id, "fake-thread-1");
        assert_eq!(restored.thread.cwd, "/tmp/project");
        assert_eq!(restored.transcript.len(), 1);
        assert_eq!(
            restored.transcript[0].text.as_deref(),
            Some("before restart")
        );

        bridge
            .start_turn(
                "fake-thread-1",
                "Reply with exactly: after restart",
                "fake-echo",
                "medium",
            )
            .await
            .expect("restored fake thread should accept a new turn");

        let completed = wait_for_thread_text(&bridge, "fake-thread-1", "after restart").await;
        assert!(
            completed,
            "restored fake thread should store the post-restart reply"
        );
    }

    async fn wait_for_thread_text(
        bridge: &FakeProviderBridge,
        thread_id: &str,
        expected: &str,
    ) -> bool {
        for _ in 0..20 {
            let data = bridge.read_thread(thread_id).await.expect("thread data");
            if data
                .transcript
                .iter()
                .any(|entry| entry.text.as_deref() == Some(expected))
            {
                return true;
            }
            sleep(Duration::from_millis(20)).await;
        }
        false
    }

    fn test_thread(id: &str, cwd: &str) -> ThreadSummaryView {
        ThreadSummaryView {
            id: id.to_string(),
            name: Some("Fake E2E Session".to_string()),
            preview: String::new(),
            cwd: cwd.to_string(),
            updated_at: unix_now(),
            source: "fake".to_string(),
            status: "idle".to_string(),
            model_provider: "fake".to_string(),
            provider: "fake".to_string(),
        }
    }

    // --- approval-gating (permission-mode) behavior --------------------------

    const ACTIVE_THREAD: &str = "fake-thread-active";

    async fn relay_with_active_thread(policy: &str) -> Arc<RwLock<RelayState>> {
        let (change_tx, _change_rx) = watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp/project".to_string(),
            change_tx,
            SecurityProfile::private(),
        )));
        {
            let mut relay = state.write().await;
            relay.activate_thread(
                test_thread(ACTIVE_THREAD, "/tmp/project"),
                "/tmp/project",
                "fake-echo",
                policy,
                "workspace-write",
                "medium",
                "device-1",
            );
        }
        state
    }

    async fn wait_for_pending_approval(state: &Arc<RwLock<RelayState>>) -> Option<PendingApproval> {
        for _ in 0..50 {
            if let Some(pending) = state
                .read()
                .await
                .pending_approvals
                .values()
                .next()
                .cloned()
            {
                return Some(pending);
            }
            sleep(Duration::from_millis(20)).await;
        }
        None
    }

    fn decision_input(decision: ApprovalDecision) -> ApprovalDecisionInput {
        ApprovalDecisionInput {
            decision,
            scope: None,
            device_id: None,
        }
    }

    #[tokio::test]
    async fn bypass_policy_skips_the_approval_gate() {
        let state = relay_with_active_thread("bypass").await;
        let bridge = FakeProviderBridge::spawn(state.clone())
            .await
            .expect("fake provider");
        bridge.enforce_approvals.store(true, Ordering::Relaxed);

        bridge
            .start_turn(
                ACTIVE_THREAD,
                "Reply with exactly: pong",
                "fake-echo",
                "medium",
            )
            .await
            .expect("turn");

        assert!(
            wait_for_thread_text(&bridge, ACTIVE_THREAD, "pong").await,
            "a bypass turn should reply without requesting approval",
        );
        assert!(
            state.read().await.pending_approvals.is_empty(),
            "a bypass turn must not park on an approval",
        );
    }

    #[tokio::test]
    async fn non_bypass_turn_parks_until_approved() {
        let state = relay_with_active_thread("untrusted").await;
        let bridge = FakeProviderBridge::spawn(state.clone())
            .await
            .expect("fake provider");
        bridge.enforce_approvals.store(true, Ordering::Relaxed);

        bridge
            .start_turn(
                ACTIVE_THREAD,
                "Reply with exactly: pong",
                "fake-echo",
                "medium",
            )
            .await
            .expect("turn");

        let pending = wait_for_pending_approval(&state)
            .await
            .expect("a non-bypass turn should request approval");
        // The reply must not land before the user approves.
        let before = bridge.read_thread(ACTIVE_THREAD).await.expect("thread");
        assert!(
            !before
                .transcript
                .iter()
                .any(|entry| entry.text.as_deref() == Some("pong")),
            "reply must not arrive while the turn is parked on approval",
        );

        bridge
            .respond_to_approval(&pending, &decision_input(ApprovalDecision::Approve))
            .await
            .expect("approve");
        assert!(
            wait_for_thread_text(&bridge, ACTIVE_THREAD, "pong").await,
            "an approved turn should resume and reply",
        );
    }

    #[tokio::test]
    async fn denied_turn_yields_no_reply() {
        let state = relay_with_active_thread("untrusted").await;
        let bridge = FakeProviderBridge::spawn(state.clone())
            .await
            .expect("fake provider");
        bridge.enforce_approvals.store(true, Ordering::Relaxed);

        bridge
            .start_turn(
                ACTIVE_THREAD,
                "Reply with exactly: pong",
                "fake-echo",
                "medium",
            )
            .await
            .expect("turn");
        let pending = wait_for_pending_approval(&state)
            .await
            .expect("approval requested");

        bridge
            .respond_to_approval(&pending, &decision_input(ApprovalDecision::Deny))
            .await
            .expect("deny");

        // The denied turn settles without ever producing a reply, and the
        // approval is cleared so the thread returns to idle.
        sleep(Duration::from_millis(120)).await;
        let data = bridge.read_thread(ACTIVE_THREAD).await.expect("thread");
        assert!(
            !data
                .transcript
                .iter()
                .any(|entry| entry.text.as_deref() == Some("pong")),
            "a denied turn must not reply",
        );
        assert!(
            state.read().await.pending_approvals.is_empty(),
            "the approval should be cleared after a denial",
        );
    }
}
