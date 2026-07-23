use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncWriteExt,
    sync::{oneshot, Mutex, RwLock},
    time::{sleep, Duration},
};

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{
        ApprovalDecision, ApprovalDecisionInput, ModelOptionView, ThreadSummaryView,
        TranscriptEntryKind, TranscriptEntryView,
    },
    provider::{ProviderBridge, ProviderImage, StartThreadResult, ThreadSyncData},
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

#[derive(Clone, Debug, Default, Deserialize)]
struct FakeScenarioConfig {
    #[serde(default)]
    prompts: HashMap<String, FakeTurnScenario>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct FakeTurnScenario {
    reply: Option<String>,
    chunks: Option<Vec<String>>,
    chunk_delay_ms: Option<u64>,
    pause_after_chunks: Option<usize>,
    barrier: Option<String>,
    #[serde(default)]
    duplicate_chunk_indices: Vec<usize>,
    #[serde(default)]
    late_chunks: Vec<String>,
    late_chunk_delay_ms: Option<u64>,
    #[serde(default)]
    require_approval: bool,
    #[serde(default)]
    terminal: FakeTerminalBehavior,
    error_message: Option<String>,
    #[serde(default)]
    stop: FakeStopBehavior,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum FakeTerminalBehavior {
    #[default]
    Complete,
    Error,
    Disconnect,
    Missing,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum FakeStopBehavior {
    #[default]
    Complete,
    Reject,
    Ignore,
}

#[derive(Serialize)]
struct FakeProviderEvent<'a> {
    seq: u64,
    at_unix_ms: u128,
    event: &'a str,
    thread_id: &'a str,
    turn_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<serde_json::Value>,
}

#[derive(Clone)]
struct FakeScenarioHarness {
    config: FakeScenarioConfig,
    control_dir: PathBuf,
    barrier_timeout: Duration,
    event_seq: Arc<AtomicU64>,
    event_log_lock: Arc<Mutex<()>>,
}

impl FakeScenarioHarness {
    fn from_env() -> Result<Option<Self>, String> {
        let Some(config_path) = std::env::var_os("FAKE_PROVIDER_SCENARIO_PATH") else {
            return Ok(None);
        };
        let control_dir = std::env::var_os("FAKE_PROVIDER_CONTROL_DIR").ok_or_else(|| {
            "FAKE_PROVIDER_CONTROL_DIR is required with FAKE_PROVIDER_SCENARIO_PATH".to_string()
        })?;
        let contents = std::fs::read(&config_path).map_err(|error| {
            format!(
                "failed to read fake-provider scenario {}: {error}",
                Path::new(&config_path).display()
            )
        })?;
        let config: FakeScenarioConfig = serde_json::from_slice(&contents)
            .map_err(|error| format!("failed to decode fake-provider scenario: {error}"))?;
        for scenario in config.prompts.values() {
            if scenario.pause_after_chunks.is_some() {
                let barrier = scenario.barrier.as_deref().ok_or_else(|| {
                    "fake-provider scenario pause_after_chunks requires barrier".to_string()
                })?;
                validate_barrier_name(barrier)?;
            }
        }
        let barrier_timeout = std::env::var("FAKE_PROVIDER_BARRIER_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_secs(60));
        Ok(Some(Self {
            config,
            control_dir: PathBuf::from(control_dir),
            barrier_timeout,
            event_seq: Arc::new(AtomicU64::new(1)),
            event_log_lock: Arc::new(Mutex::new(())),
        }))
    }

    fn scenario_for_prompt(&self, prompt: &str) -> Option<FakeTurnScenario> {
        self.config.prompts.get(prompt).cloned()
    }

    async fn record_event(
        &self,
        event: &str,
        thread_id: &str,
        turn_id: &str,
        detail: Option<serde_json::Value>,
    ) {
        let _guard = self.event_log_lock.lock().await;
        if tokio::fs::create_dir_all(&self.control_dir).await.is_err() {
            return;
        }
        let entry = FakeProviderEvent {
            seq: self.event_seq.fetch_add(1, Ordering::Relaxed),
            at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default(),
            event,
            thread_id,
            turn_id,
            detail,
        };
        let Ok(mut line) = serde_json::to_vec(&entry) else {
            return;
        };
        line.push(b'\n');
        let path = self.control_dir.join("events.ndjson");
        if let Ok(mut file) = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await
        {
            let _ = file.write_all(&line).await;
        }
    }

    async fn wait_for_barrier(
        &self,
        barrier: &str,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<(), String> {
        validate_barrier_name(barrier)?;
        tokio::fs::create_dir_all(&self.control_dir)
            .await
            .map_err(|error| {
                format!("failed to create fake-provider control directory: {error}")
            })?;
        let paused_path = self.control_dir.join(format!("{barrier}.paused.json"));
        let release_path = self.control_dir.join(format!("{barrier}.release"));
        let _ = tokio::fs::remove_file(&release_path).await;
        let marker = serde_json::json!({
            "barrier": barrier,
            "thread_id": thread_id,
            "turn_id": turn_id,
        });
        tokio::fs::write(
            &paused_path,
            serde_json::to_vec_pretty(&marker).expect("barrier marker should encode"),
        )
        .await
        .map_err(|error| format!("failed to publish fake-provider barrier: {error}"))?;
        self.record_event(
            "barrier_paused",
            thread_id,
            turn_id,
            Some(serde_json::json!({ "barrier": barrier })),
        )
        .await;

        let deadline = tokio::time::Instant::now() + self.barrier_timeout;
        while tokio::time::Instant::now() < deadline {
            if tokio::fs::try_exists(&release_path).await.unwrap_or(false) {
                let _ = tokio::fs::remove_file(&release_path).await;
                let _ = tokio::fs::remove_file(&paused_path).await;
                self.record_event(
                    "barrier_released",
                    thread_id,
                    turn_id,
                    Some(serde_json::json!({ "barrier": barrier })),
                )
                .await;
                return Ok(());
            }
            sleep(Duration::from_millis(10)).await;
        }
        Err(format!(
            "timed out waiting for fake-provider barrier '{barrier}'"
        ))
    }
}

struct FakeApprovalGate {
    turn_id: String,
    sender: oneshot::Sender<ApprovalDecision>,
}

fn validate_barrier_name(barrier: &str) -> Result<(), String> {
    if barrier.is_empty()
        || !barrier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(format!(
            "fake-provider barrier names may contain only ASCII letters, digits, '-' and '_': {barrier:?}"
        ));
    }
    Ok(())
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
    approval_gates: Arc<Mutex<HashMap<String, FakeApprovalGate>>>,
    turn_stop_behaviors: Arc<Mutex<HashMap<String, FakeStopBehavior>>>,
    stopped_turns: Arc<Mutex<HashSet<String>>>,
    scenario_harness: Option<FakeScenarioHarness>,
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
        let scenario_harness = FakeScenarioHarness::from_env()?;

        Ok(Self {
            state,
            threads,
            next_id: AtomicU64::new(1),
            enforce_approvals: Arc::new(AtomicBool::new(enforce_approvals)),
            approval_gates: Arc::new(Mutex::new(HashMap::new())),
            turn_stop_behaviors: Arc::new(Mutex::new(HashMap::new())),
            stopped_turns: Arc::new(Mutex::new(HashSet::new())),
            scenario_harness,
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
            forked_from: None,
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
        _images: &[ProviderImage],
    ) -> Result<Option<String>, String> {
        if !self.threads.lock().await.contains_key(thread_id) {
            return Err(format!("fake thread '{thread_id}' was not found"));
        }

        let thread_id = thread_id.to_string();
        let prompt = text.to_string();
        let scenario = self
            .scenario_harness
            .as_ref()
            .and_then(|harness| harness.scenario_for_prompt(&prompt));
        let chunks = scenario
            .as_ref()
            .and_then(|scenario| scenario.chunks.clone())
            .unwrap_or_else(|| reply_chunks(&fake_reply_for_prompt(&prompt)));
        let reply = scenario
            .as_ref()
            .and_then(|scenario| scenario.reply.clone())
            .unwrap_or_else(|| chunks.concat());
        let chunk_delay = Duration::from_millis(
            scenario
                .as_ref()
                .and_then(|scenario| scenario.chunk_delay_ms)
                .unwrap_or(20),
        );
        let pause_after_chunks = scenario
            .as_ref()
            .and_then(|scenario| scenario.pause_after_chunks);
        let barrier = scenario
            .as_ref()
            .and_then(|scenario| scenario.barrier.clone());
        let duplicate_chunk_indices = scenario
            .as_ref()
            .map(|scenario| scenario.duplicate_chunk_indices.clone())
            .unwrap_or_default();
        let late_chunks = scenario
            .as_ref()
            .map(|scenario| scenario.late_chunks.clone())
            .unwrap_or_default();
        let late_chunk_delay = Duration::from_millis(
            scenario
                .as_ref()
                .and_then(|scenario| scenario.late_chunk_delay_ms)
                .unwrap_or(20),
        );
        let terminal = scenario
            .as_ref()
            .map(|scenario| scenario.terminal)
            .unwrap_or_default();
        let error_message = scenario
            .as_ref()
            .and_then(|scenario| scenario.error_message.clone())
            .unwrap_or_else(|| "Fake provider turn failed by scenario.".to_string());
        let stop_behavior = scenario
            .as_ref()
            .map(|scenario| scenario.stop)
            .unwrap_or_default();
        let scenario_harness = self.scenario_harness.clone();
        let turn_id = self.next_token("fake-turn");
        let user_item_id = self.next_token("fake-user");
        let assistant_item_id = self.next_token("fake-assistant");
        let state = self.state.clone();
        let threads = self.threads.clone();
        let turn_id_for_task = turn_id.clone();

        // Decide up front whether this turn must park on an approval request.
        let needs_approval = scenario
            .as_ref()
            .is_some_and(|scenario| scenario.require_approval)
            || (self.enforce_approvals.load(Ordering::Relaxed)
                && self.approval_policy_for(&thread_id).await != "bypass");
        let approval_request_id = self.next_token("fake-approval");
        let approval_gates = self.approval_gates.clone();
        let turn_stop_behaviors = self.turn_stop_behaviors.clone();
        let stopped_turns = self.stopped_turns.clone();
        turn_stop_behaviors
            .lock()
            .await
            .insert(turn_id.clone(), stop_behavior);

        tokio::spawn(async move {
            let user_entry = TranscriptEntryView {
                item_id: Some(user_item_id.clone()),
                kind: TranscriptEntryKind::UserText,
                text: Some(prompt.clone()),
                status: "completed".to_string(),
                turn_id: Some(turn_id_for_task.clone()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            };
            if let Some(harness) = scenario_harness.as_ref() {
                harness
                    .record_event(
                        "turn_started",
                        &thread_id,
                        &turn_id_for_task,
                        Some(serde_json::json!({ "prompt": prompt })),
                    )
                    .await;
            }
            let assistant_entry = TranscriptEntryView {
                item_id: Some(assistant_item_id.clone()),
                kind: TranscriptEntryKind::AgentText,
                text: Some(reply.clone()),
                status: "completed".to_string(),
                turn_id: Some(turn_id_for_task.clone()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
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
                approval_gates.lock().await.insert(
                    approval_request_id.clone(),
                    FakeApprovalGate {
                        turn_id: turn_id_for_task.clone(),
                        sender: decision_tx,
                    },
                );
                {
                    let mut relay = state.write().await;
                    relay.set_thread_status(
                        &thread_id,
                        "active".to_string(),
                        vec!["waitingOnApproval".to_string()],
                    );
                    relay.add_pending_approval(make_fake_approval(
                        &approval_request_id,
                        &thread_id,
                        &prompt,
                    ));
                    relay.touch_progress(Some("waiting_approval"), None);
                    relay.push_log("approval", "Fake provider requests approval for: Bash");
                    relay.notify();
                }
                if let Some(harness) = scenario_harness.as_ref() {
                    harness
                        .record_event(
                            "approval_requested",
                            &thread_id,
                            &turn_id_for_task,
                            Some(serde_json::json!({ "request_id": approval_request_id })),
                        )
                        .await;
                }

                let decision = decision_rx.await.unwrap_or(ApprovalDecision::Cancel);
                approval_gates.lock().await.remove(&approval_request_id);
                if let Some(harness) = scenario_harness.as_ref() {
                    harness
                        .record_event(
                            "approval_resolved",
                            &thread_id,
                            &turn_id_for_task,
                            Some(serde_json::json!({ "decision": format!("{decision:?}") })),
                        )
                        .await;
                }

                if !matches!(decision, ApprovalDecision::Approve) {
                    let mut relay = state.write().await;
                    relay.remove_pending_approval(&approval_request_id);
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
                    turn_stop_behaviors.lock().await.remove(&turn_id_for_task);
                    stopped_turns.lock().await.remove(&turn_id_for_task);
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

            if pause_after_chunks == Some(0) {
                wait_for_scenario_barrier(
                    &state,
                    scenario_harness.as_ref(),
                    barrier.as_deref(),
                    &thread_id,
                    &turn_id_for_task,
                )
                .await;
            }

            let mut last_delta = None;
            let mut streamed_reply = String::new();
            for (index, chunk) in chunks.into_iter().enumerate() {
                sleep(chunk_delay).await;
                if stopped_turns.lock().await.contains(&turn_id_for_task) {
                    settle_fake_turn(&state, &thread_id, &turn_id_for_task, "idle").await;
                    if let Some(harness) = scenario_harness.as_ref() {
                        harness
                            .record_event("turn_stopped", &thread_id, &turn_id_for_task, None)
                            .await;
                    }
                    turn_stop_behaviors.lock().await.remove(&turn_id_for_task);
                    stopped_turns.lock().await.remove(&turn_id_for_task);
                    return;
                }
                let mut relay = state.write().await;
                if relay.active_thread_id.as_deref() == Some(thread_id.as_str()) {
                    let mutation =
                        relay.append_agent_delta(&assistant_item_id, &chunk, &turn_id_for_task);
                    let pending = PendingTranscriptDelta {
                        thread_id: thread_id.clone(),
                        base_revision: mutation.base_revision,
                        revision: mutation.revision,
                        entry_seq: mutation.entry_seq,
                        server_time: mutation.server_time,
                        item_id: assistant_item_id.clone(),
                        turn_id: Some(turn_id_for_task.clone()),
                        delta: chunk.clone(),
                        kind: TranscriptDeltaKind::AgentText,
                        text_offset: mutation.text_offset,
                    };
                    relay.queue_broker_message(BrokerPendingMessage::TranscriptDelta(
                        pending.clone(),
                    ));
                    if duplicate_chunk_indices.contains(&index) {
                        relay.queue_broker_message(BrokerPendingMessage::TranscriptDelta(
                            pending.clone(),
                        ));
                    }
                    last_delta = Some(pending);
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
                drop(relay);
                streamed_reply.push_str(&chunk);
                if let Some(harness) = scenario_harness.as_ref() {
                    harness
                        .record_event(
                            "delta",
                            &thread_id,
                            &turn_id_for_task,
                            Some(serde_json::json!({ "index": index, "text": chunk })),
                        )
                        .await;
                    if duplicate_chunk_indices.contains(&index) {
                        harness
                            .record_event(
                                "delta_duplicate",
                                &thread_id,
                                &turn_id_for_task,
                                Some(serde_json::json!({ "index": index })),
                            )
                            .await;
                    }
                }

                if pause_after_chunks == Some(index + 1) {
                    wait_for_scenario_barrier(
                        &state,
                        scenario_harness.as_ref(),
                        barrier.as_deref(),
                        &thread_id,
                        &turn_id_for_task,
                    )
                    .await;
                }
            }

            match terminal {
                FakeTerminalBehavior::Complete => {
                    settle_fake_turn(&state, &thread_id, &turn_id_for_task, "idle").await;
                    {
                        let mut relay = state.write().await;
                        relay.complete_agent_message_for_thread(
                            &thread_id,
                            assistant_item_id.clone(),
                            reply.clone(),
                            turn_id_for_task.clone(),
                        );
                        relay.push_log(
                            "info",
                            format!("Fake provider completed turn {turn_id_for_task}."),
                        );
                        relay.notify();
                    }
                    store_fake_turn(
                        &threads,
                        &thread_id,
                        user_entry,
                        Some(assistant_entry),
                        "idle",
                    )
                    .await;
                    record_scenario_event(
                        scenario_harness.as_ref(),
                        "terminal_completed",
                        &thread_id,
                        &turn_id_for_task,
                        None,
                    )
                    .await;
                }
                FakeTerminalBehavior::Error => {
                    settle_fake_turn(&state, &thread_id, &turn_id_for_task, "idle").await;
                    let error_entry = TranscriptEntryView {
                        item_id: Some(format!("fake-error:{turn_id_for_task}")),
                        kind: TranscriptEntryKind::Error,
                        text: Some(error_message.clone()),
                        status: "failed".to_string(),
                        turn_id: Some(turn_id_for_task.clone()),
                        tool: None,
                        content_state: crate::protocol::TranscriptContentState::Full,
                    };
                    {
                        let mut relay = state.write().await;
                        relay.set_transcript_item_status_for_thread(
                            &thread_id,
                            &assistant_item_id,
                            "failed",
                        );
                        relay.upsert_transcript_item_for_thread(
                            &thread_id,
                            error_entry.item_id.clone().unwrap_or_default(),
                            TranscriptEntryKind::Error,
                            Some(error_message.clone()),
                            "failed".to_string(),
                            Some(turn_id_for_task.clone()),
                            None,
                        );
                        relay.push_log("error", error_message.clone());
                        relay.notify();
                    }
                    let partial_entry = (!streamed_reply.is_empty()).then(|| TranscriptEntryView {
                        text: Some(streamed_reply.clone()),
                        status: "failed".to_string(),
                        ..assistant_entry
                    });
                    store_fake_turn(&threads, &thread_id, user_entry, partial_entry, "idle").await;
                    if let Some(thread) = threads.lock().await.get_mut(&thread_id) {
                        thread.transcript.push(error_entry);
                    }
                    record_scenario_event(
                        scenario_harness.as_ref(),
                        "terminal_error",
                        &thread_id,
                        &turn_id_for_task,
                        Some(serde_json::json!({ "message": error_message })),
                    )
                    .await;
                }
                FakeTerminalBehavior::Disconnect => {
                    let mut relay = state.write().await;
                    relay.set_provider_connection("fake", false);
                    relay.fail_in_flight_turns_for_provider("fake");
                    relay.push_log("error", "Fake provider disconnected by scenario.");
                    relay.notify();
                    drop(relay);
                    let partial_entry = (!streamed_reply.is_empty()).then(|| TranscriptEntryView {
                        text: Some(streamed_reply.clone()),
                        status: "failed".to_string(),
                        ..assistant_entry
                    });
                    store_fake_turn(&threads, &thread_id, user_entry, partial_entry, "idle").await;
                    record_scenario_event(
                        scenario_harness.as_ref(),
                        "provider_disconnected",
                        &thread_id,
                        &turn_id_for_task,
                        None,
                    )
                    .await;
                }
                FakeTerminalBehavior::Missing => {
                    let partial_entry = (!streamed_reply.is_empty()).then(|| TranscriptEntryView {
                        text: Some(streamed_reply.clone()),
                        status: "streaming".to_string(),
                        ..assistant_entry
                    });
                    store_fake_turn(&threads, &thread_id, user_entry, partial_entry, "active")
                        .await;
                    record_scenario_event(
                        scenario_harness.as_ref(),
                        "terminal_omitted",
                        &thread_id,
                        &turn_id_for_task,
                        None,
                    )
                    .await;
                }
            }

            for late_chunk in late_chunks {
                sleep(late_chunk_delay).await;
                if let Some(mut pending) = last_delta.clone() {
                    pending.delta = late_chunk.clone();
                    let mut relay = state.write().await;
                    relay.queue_broker_message(BrokerPendingMessage::TranscriptDelta(pending));
                    relay.notify();
                }
                record_scenario_event(
                    scenario_harness.as_ref(),
                    "delta_late",
                    &thread_id,
                    &turn_id_for_task,
                    Some(serde_json::json!({ "text": late_chunk })),
                )
                .await;
            }
            if terminal != FakeTerminalBehavior::Missing {
                turn_stop_behaviors.lock().await.remove(&turn_id_for_task);
                stopped_turns.lock().await.remove(&turn_id_for_task);
            }
        });

        Ok(Some(turn_id))
    }

    async fn request_turn_stop(
        &self,
        thread_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), String> {
        let resolved_turn_id = match turn_id {
            Some(turn_id) => Some(turn_id.to_string()),
            None => self
                .state
                .read()
                .await
                .runtime_for_thread(thread_id)
                .and_then(|runtime| runtime.active_turn_id.clone()),
        };
        let behavior = match resolved_turn_id.as_deref() {
            Some(turn_id) => self
                .turn_stop_behaviors
                .lock()
                .await
                .get(turn_id)
                .copied()
                .unwrap_or_default(),
            None => FakeStopBehavior::Complete,
        };
        if behavior == FakeStopBehavior::Reject {
            if let Some(turn_id) = resolved_turn_id.as_deref() {
                record_scenario_event(
                    self.scenario_harness.as_ref(),
                    "stop_rejected",
                    thread_id,
                    turn_id,
                    None,
                )
                .await;
            }
            return Err("fake provider rejected stop by scenario".to_string());
        }
        if behavior == FakeStopBehavior::Ignore {
            if let Some(turn_id) = resolved_turn_id.as_deref() {
                record_scenario_event(
                    self.scenario_harness.as_ref(),
                    "stop_ignored",
                    thread_id,
                    turn_id,
                    None,
                )
                .await;
            }
            return Ok(());
        }
        if let Some(turn_id) = resolved_turn_id.as_deref() {
            self.stopped_turns.lock().await.insert(turn_id.to_string());
            let request_ids = self
                .approval_gates
                .lock()
                .await
                .iter()
                .filter(|(_, gate)| gate.turn_id == turn_id)
                .map(|(request_id, _)| request_id.clone())
                .collect::<Vec<_>>();
            for request_id in request_ids {
                if let Some(gate) = self.approval_gates.lock().await.remove(&request_id) {
                    let _ = gate.sender.send(ApprovalDecision::Cancel);
                }
            }
            record_scenario_event(
                self.scenario_harness.as_ref(),
                "stop_requested",
                thread_id,
                turn_id,
                None,
            )
            .await;
            self.turn_stop_behaviors.lock().await.remove(turn_id);
        }
        let mut relay = self.state.write().await;
        if relay.active_thread_id.as_deref() == Some(thread_id) {
            relay.set_active_turn(None);
            relay.set_thread_status(thread_id, "idle".to_string(), Vec::new());
        } else {
            relay.bg_set_active_turn(thread_id, None, unix_now());
            relay.bg_set_thread_status(thread_id, "idle".to_string(), Vec::new(), unix_now());
        }
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
        if let Some(gate) = self.approval_gates.lock().await.remove(&pending.request_id) {
            let _ = gate.sender.send(input.decision);
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

async fn settle_fake_turn(
    state: &Arc<RwLock<RelayState>>,
    thread_id: &str,
    turn_id: &str,
    status: &str,
) {
    let mut relay = state.write().await;
    if relay.active_thread_id.as_deref() == Some(thread_id) {
        if relay.active_turn_id.as_deref() == Some(turn_id) {
            relay.set_active_turn(None);
        }
        relay.set_thread_status(thread_id, status.to_string(), Vec::new());
        relay.clear_progress();
    } else {
        let now = unix_now();
        relay.bg_set_active_turn(thread_id, None, now);
        relay.bg_set_thread_status(thread_id, status.to_string(), Vec::new(), now);
    }
    relay.notify();
}

async fn store_fake_turn(
    threads: &Arc<Mutex<HashMap<String, FakeThread>>>,
    thread_id: &str,
    user_entry: TranscriptEntryView,
    assistant_entry: Option<TranscriptEntryView>,
    status: &str,
) {
    if let Some(thread) = threads.lock().await.get_mut(thread_id) {
        thread.summary.preview = user_entry.text.clone().unwrap_or_default();
        thread.summary.status = status.to_string();
        thread.summary.updated_at = unix_now();
        thread.transcript.push(user_entry);
        if let Some(assistant_entry) = assistant_entry {
            thread.transcript.push(assistant_entry);
        }
    }
}

async fn record_scenario_event(
    harness: Option<&FakeScenarioHarness>,
    event: &str,
    thread_id: &str,
    turn_id: &str,
    detail: Option<serde_json::Value>,
) {
    if let Some(harness) = harness {
        harness
            .record_event(event, thread_id, turn_id, detail)
            .await;
    }
}

async fn wait_for_scenario_barrier(
    state: &Arc<RwLock<RelayState>>,
    harness: Option<&FakeScenarioHarness>,
    barrier: Option<&str>,
    thread_id: &str,
    turn_id: &str,
) {
    let (Some(harness), Some(barrier)) = (harness, barrier) else {
        return;
    };
    if let Err(error) = harness.wait_for_barrier(barrier, thread_id, turn_id).await {
        let mut relay = state.write().await;
        relay.push_log("error", error);
        relay.notify();
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
        forked_from: None,
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
                &[],
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
            forked_from: None,
        }
    }

    #[tokio::test]
    async fn background_thread_turn_settles_and_records_reply() {
        // Regression + coverage: the REAL FakeProvider must drive a BACKGROUND
        // (non-active) thread's turn to completion — settling `is_working()` and
        // recording the reply — exactly as it does for the active thread. Workflow
        // and review reviewers run on background threads, but the app-level tests
        // only exercise a MOCK `ProviderBridge`, so the real fake's background path
        // was never covered. `wait_for_step_idle`/`wait_for_thread_idle_outcome`
        // poll `is_working()`; if a background turn never cleared it, the reviewer
        // step would hang forever.
        //
        // NOTE: the fake echoes its prompt one line per 20ms, so a LARGE echoed
        // reply (e.g. a reviewer prompt embedding a multi-thousand-line workspace
        // diff) can take a minute to stream — that is streaming latency, NOT a
        // hang. Here the reply is a single line, so the turn settles promptly.
        let (change_tx, _change_rx) = watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp/project".to_string(),
            change_tx,
            SecurityProfile::private(),
        )));

        // An ACTIVE parent thread, so the reviewer thread below is BACKGROUND.
        {
            let mut relay = state.write().await;
            relay.activate_thread(
                test_thread("active-parent", "/tmp/project"),
                "/tmp/project",
                "fake-echo",
                "never",
                "workspace-write",
                "medium",
                "device-1",
            );
        }

        let bridge = FakeProviderBridge::spawn(state.clone())
            .await
            .expect("fake provider");

        // Spawn a background reviewer thread the way the workflow/review runner does.
        let start = bridge
            .start_thread("/tmp/project", "fake-echo", "never", "read-only", None)
            .await
            .expect("start background reviewer thread");
        let bg_id = start.thread.id.clone();
        {
            let mut relay = state.write().await;
            relay.register_background_thread(
                start.thread,
                "/tmp/project",
                "fake-echo",
                "never",
                "read-only",
                "medium",
            );
        }

        bridge
            .start_turn(
                &bg_id,
                "Reply with exactly: reviewed",
                "fake-echo",
                "medium",
                &[],
            )
            .await
            .expect("background thread should accept a turn");

        // The reply lands on the background thread (the turn ran to completion).
        assert!(
            wait_for_thread_text(&bridge, &bg_id, "reviewed").await,
            "background reviewer reply should be stored"
        );

        // ...and the turn SETTLED: `is_working()` is false, so a reviewer-idle wait
        // on this thread would complete instead of hanging.
        let mut settled = false;
        for _ in 0..100 {
            {
                let relay = state.read().await;
                if !relay
                    .runtime_for_thread(&bg_id)
                    .map(|rt| rt.is_working())
                    .unwrap_or(true)
                {
                    settled = true;
                    break;
                }
            }
            sleep(Duration::from_millis(20)).await;
        }
        assert!(
            settled,
            "background reviewer turn never cleared is_working() — a reviewer-idle wait \
             on this thread would hang forever"
        );
    }

    #[tokio::test]
    async fn scenario_barrier_waits_for_an_explicit_release() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = FakeScenarioHarness {
            config: FakeScenarioConfig {
                prompts: HashMap::new(),
            },
            control_dir: temp.path().to_path_buf(),
            barrier_timeout: Duration::from_secs(2),
            event_seq: Arc::new(AtomicU64::new(1)),
            event_log_lock: Arc::new(Mutex::new(())),
        };
        let waiting_harness = harness.clone();
        let waiter = tokio::spawn(async move {
            waiting_harness
                .wait_for_barrier("turn-a", "thread-a", "turn-a-1")
                .await
        });
        let paused_path = temp.path().join("turn-a.paused.json");
        for _ in 0..100 {
            if paused_path.exists() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        assert!(
            paused_path.exists(),
            "the paused marker should be published"
        );
        assert!(!waiter.is_finished(), "the barrier must wait for release");

        let marker: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&paused_path).expect("read paused marker"))
                .expect("decode paused marker");
        assert_eq!(marker["thread_id"], "thread-a");
        std::fs::write(temp.path().join("turn-a.release"), b"release\n").expect("release barrier");
        waiter
            .await
            .expect("barrier task")
            .expect("barrier should release");
        assert!(
            !paused_path.exists(),
            "the paused marker should be cleaned up"
        );
    }

    #[test]
    fn scenario_barrier_names_cannot_escape_the_control_directory() {
        assert!(validate_barrier_name("thread_A-1").is_ok());
        assert!(validate_barrier_name("../escape").is_err());
        assert!(validate_barrier_name("").is_err());
    }

    fn test_scenario_harness(
        temp: &tempfile::TempDir,
        prompts: HashMap<String, FakeTurnScenario>,
    ) -> FakeScenarioHarness {
        FakeScenarioHarness {
            config: FakeScenarioConfig { prompts },
            control_dir: temp.path().to_path_buf(),
            barrier_timeout: Duration::from_secs(2),
            event_seq: Arc::new(AtomicU64::new(1)),
            event_log_lock: Arc::new(Mutex::new(())),
        }
    }

    async fn wait_for_scenario_event(harness: &FakeScenarioHarness, expected: &str) -> bool {
        for _ in 0..100 {
            let contents = tokio::fs::read_to_string(harness.control_dir.join("events.ndjson"))
                .await
                .unwrap_or_default();
            if contents.lines().any(|line| {
                serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .and_then(|event| event["event"].as_str().map(|value| value == expected))
                    .unwrap_or(false)
            }) {
                return true;
            }
            sleep(Duration::from_millis(10)).await;
        }
        false
    }

    async fn bridge_with_scenarios(
        policy: &str,
        harness: FakeScenarioHarness,
    ) -> (FakeProviderBridge, Arc<RwLock<RelayState>>) {
        let state = relay_with_active_thread(policy).await;
        let mut bridge = FakeProviderBridge::spawn(state.clone())
            .await
            .expect("fake provider");
        bridge.scenario_harness = Some(harness);
        (bridge, state)
    }

    #[tokio::test]
    async fn scenario_records_duplicate_and_late_delta_events() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "scripted".to_string(),
                FakeTurnScenario {
                    chunks: Some(vec!["one".to_string()]),
                    chunk_delay_ms: Some(0),
                    duplicate_chunk_indices: vec![0],
                    late_chunks: vec!["late".to_string()],
                    late_chunk_delay_ms: Some(0),
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;
        // This test asserts transcript deltas are queued for the broker, so a broker
        // must be configured — otherwise deltas are dropped at enqueue (local-only).
        state.write().await.broker_configured = true;

        bridge
            .start_turn(ACTIVE_THREAD, "scripted", "fake-echo", "medium", &[])
            .await
            .expect("turn");
        assert!(
            wait_for_scenario_event(&harness, "delta_late").await,
            "the late event should be recorded"
        );
        let event_log = tokio::fs::read_to_string(temp.path().join("events.ndjson"))
            .await
            .expect("event log");
        assert!(event_log.contains("\"event\":\"delta_duplicate\""));
        assert!(event_log.contains("\"event\":\"terminal_completed\""));
        assert_eq!(
            state.read().await.pending_broker_messages.len(),
            3,
            "original, duplicate, and late broker events should be queued"
        );
    }

    #[tokio::test]
    async fn scenario_error_surfaces_a_failed_transcript_entry() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "fail".to_string(),
                FakeTurnScenario {
                    chunks: Some(vec!["partial".to_string()]),
                    chunk_delay_ms: Some(0),
                    terminal: FakeTerminalBehavior::Error,
                    error_message: Some("scenario failure".to_string()),
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(ACTIVE_THREAD, "fail", "fake-echo", "medium", &[])
            .await
            .expect("turn");
        assert!(wait_for_scenario_event(&harness, "terminal_error").await);
        let snapshot = state.read().await.snapshot();
        assert_eq!(snapshot.active_turn_id, None);
        assert!(snapshot.transcript.iter().any(|entry| {
            entry.kind == TranscriptEntryKind::Error
                && entry.status == "failed"
                && entry.text.as_deref() == Some("scenario failure")
        }));
    }

    #[tokio::test]
    async fn scenario_disconnect_settles_the_turn_and_provider_connection() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "disconnect".to_string(),
                FakeTurnScenario {
                    chunks: Some(Vec::new()),
                    terminal: FakeTerminalBehavior::Disconnect,
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(ACTIVE_THREAD, "disconnect", "fake-echo", "medium", &[])
            .await
            .expect("turn");
        assert!(wait_for_scenario_event(&harness, "provider_disconnected").await);
        let snapshot = state.read().await.snapshot();
        assert_eq!(snapshot.active_turn_id, None);
        assert!(!snapshot.provider_connected);
    }

    #[tokio::test]
    async fn scenario_can_omit_the_terminal_event() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "missing-terminal".to_string(),
                FakeTurnScenario {
                    chunks: Some(vec!["partial".to_string()]),
                    chunk_delay_ms: Some(0),
                    terminal: FakeTerminalBehavior::Missing,
                    stop: FakeStopBehavior::Reject,
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;
        let turn_id = bridge
            .start_turn(
                ACTIVE_THREAD,
                "missing-terminal",
                "fake-echo",
                "medium",
                &[],
            )
            .await
            .expect("turn")
            .expect("turn id");

        assert!(wait_for_scenario_event(&harness, "terminal_omitted").await);
        let snapshot = state.read().await.snapshot();
        assert_eq!(snapshot.active_turn_id.as_deref(), Some(turn_id.as_str()));
        assert_eq!(snapshot.current_status, "active");
        assert!(bridge
            .request_turn_stop(ACTIVE_THREAD, Some(&turn_id))
            .await
            .is_err());
        assert!(wait_for_scenario_event(&harness, "stop_rejected").await);
    }

    #[tokio::test]
    async fn scenario_can_require_approval_even_under_bypass_policy() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "approval".to_string(),
                FakeTurnScenario {
                    reply: Some("approved".to_string()),
                    chunks: Some(vec!["approved".to_string()]),
                    chunk_delay_ms: Some(0),
                    require_approval: true,
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(ACTIVE_THREAD, "approval", "fake-echo", "medium", &[])
            .await
            .expect("turn");
        let pending = wait_for_pending_approval(&state)
            .await
            .expect("scenario approval");
        bridge
            .respond_to_approval(&pending, &decision_input(ApprovalDecision::Approve))
            .await
            .expect("approve");
        assert!(wait_for_scenario_event(&harness, "terminal_completed").await);
        assert!(wait_for_thread_text(&bridge, ACTIVE_THREAD, "approved").await);
    }

    #[tokio::test]
    async fn scenario_controls_stop_acceptance() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([
                (
                    "reject-stop".to_string(),
                    FakeTurnScenario {
                        chunks: Some(vec!["reply".to_string()]),
                        chunk_delay_ms: Some(50),
                        stop: FakeStopBehavior::Reject,
                        ..FakeTurnScenario::default()
                    },
                ),
                (
                    "ignore-stop".to_string(),
                    FakeTurnScenario {
                        chunks: Some(vec!["reply".to_string()]),
                        chunk_delay_ms: Some(50),
                        stop: FakeStopBehavior::Ignore,
                        ..FakeTurnScenario::default()
                    },
                ),
                (
                    "accept-stop".to_string(),
                    FakeTurnScenario {
                        chunks: Some(vec!["must-not-land".to_string()]),
                        chunk_delay_ms: Some(50),
                        stop: FakeStopBehavior::Complete,
                        ..FakeTurnScenario::default()
                    },
                ),
            ]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        let reject_turn = bridge
            .start_turn(ACTIVE_THREAD, "reject-stop", "fake-echo", "medium", &[])
            .await
            .expect("turn")
            .expect("turn id");
        assert!(bridge
            .request_turn_stop(ACTIVE_THREAD, Some(&reject_turn))
            .await
            .is_err());
        assert!(wait_for_scenario_event(&harness, "stop_rejected").await);
        assert!(wait_for_thread_text(&bridge, ACTIVE_THREAD, "reply").await);

        let ignore_turn = bridge
            .start_turn(ACTIVE_THREAD, "ignore-stop", "fake-echo", "medium", &[])
            .await
            .expect("turn")
            .expect("turn id");
        bridge
            .request_turn_stop(ACTIVE_THREAD, Some(&ignore_turn))
            .await
            .expect("ignored stop is acknowledged");
        assert!(wait_for_scenario_event(&harness, "stop_ignored").await);
        sleep(Duration::from_millis(80)).await;
        assert_eq!(state.read().await.snapshot().active_turn_id, None);

        let accept_turn = bridge
            .start_turn(ACTIVE_THREAD, "accept-stop", "fake-echo", "medium", &[])
            .await
            .expect("turn")
            .expect("turn id");
        bridge
            .request_turn_stop(ACTIVE_THREAD, Some(&accept_turn))
            .await
            .expect("accepted stop");
        sleep(Duration::from_millis(80)).await;
        assert_eq!(state.read().await.snapshot().active_turn_id, None);
        assert!(!bridge
            .read_thread(ACTIVE_THREAD)
            .await
            .expect("thread")
            .transcript
            .iter()
            .any(|entry| entry.text.as_deref() == Some("must-not-land")));
        assert!(wait_for_scenario_event(&harness, "stop_requested").await);
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
                &[],
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
                &[],
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
                &[],
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
