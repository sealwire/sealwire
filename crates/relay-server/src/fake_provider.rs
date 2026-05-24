use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use tokio::{
    sync::{Mutex, RwLock},
    time::{sleep, Duration},
};

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{
        ApprovalDecisionInput, ModelOptionView, ThreadSummaryView, TranscriptEntryKind,
        TranscriptEntryView,
    },
    provider::{ProviderBridge, StartThreadResult, ThreadSyncData},
    state::{
        BrokerPendingMessage, PendingApproval, PendingTranscriptDelta, RelayState,
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

        Ok(Self {
            state,
            threads,
            next_id: AtomicU64::new(1),
        })
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

            {
                let mut relay = state.write().await;
                relay.set_active_turn(Some(turn_id_for_task.clone()));
                relay.set_thread_status(&thread_id, "active".to_string(), Vec::new());
                relay.upsert_user_message(user_item_id, prompt, turn_id_for_task.clone());
                relay.start_agent_message(assistant_item_id.clone(), turn_id_for_task.clone());
                relay.notify();
            }

            for chunk in reply_chunks(&reply) {
                sleep(Duration::from_millis(20)).await;
                let mut relay = state.write().await;
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
                relay.notify();
            }

            {
                let mut relay = state.write().await;
                relay.complete_agent_message(assistant_item_id, reply, turn_id_for_task.clone());
                relay.set_active_turn(None);
                relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
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
        _pending: &PendingApproval,
        _input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        Err("fake provider does not request approvals".to_string())
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

    let preview = snapshot
        .transcript
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
            transcript: snapshot.transcript,
        },
    )])
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
}
