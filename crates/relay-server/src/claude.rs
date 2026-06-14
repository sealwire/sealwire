mod protocol;

use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{oneshot, Mutex, RwLock},
    time::{timeout, Duration},
};

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{
        ApprovalDecision, ApprovalDecisionInput, ModelOptionView, ThreadSummaryView, ToolCallView,
        TranscriptEntryKind, TranscriptEntryView,
    },
    provider::{ProviderBridge, StartThreadResult, ThreadSyncData, ThreadTranscriptPageData},
    state::{
        BrokerPendingMessage, PendingApproval, PendingTranscriptDelta, RelayState,
        TranscriptDeltaKind,
    },
};

use self::protocol::{
    bool_at, claude_permission_mode, compact_json, new_user_message_uuid, normalize_id,
    parse_claude_approval, parse_thread_array, parse_thread_summary, string_at, unix_now, value_at,
};

type PendingResponses = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

const CLAUDE_REQUEST_TIMEOUT_SECS: u64 = 30;

/// Configuration captured when a Claude session is created without an initial
/// prompt. The SDK only assigns a `session_id` after it sees the first user
/// message, so we cannot call the worker yet — we hand back a synthetic
/// `claude-pending-…` thread id and use this config on the first turn to
/// promote it to a real session.
#[derive(Clone)]
struct PendingClaudeConfig {
    cwd: String,
    model: String,
    permission_mode: String,
}

/// Bridges the relay to Claude Code via a Node.js worker process that wraps the
/// official `@anthropic-ai/claude-agent-sdk`. The worker speaks a normalized
/// NDJSON protocol so the relay core never sees raw SDK shapes.
pub struct ClaudeCodeBridge {
    _child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending_responses: PendingResponses,
    next_request_id: AtomicU64,
    state: Arc<RwLock<RelayState>>,
    /// Threads created without an initial prompt. In-memory only — never
    /// persisted to disk (placeholder ids would point at a session Anthropic
    /// has never seen). On the first send we promote the thread by swapping
    /// the public id to the real SDK session id, then drop the entry here.
    pending_threads: Arc<Mutex<HashMap<String, PendingClaudeConfig>>>,
    /// One-shot handoff from a deferred-start placeholder to the real SDK id.
    promoted_thread_ids: Arc<Mutex<HashMap<String, String>>>,
    /// In-memory cache of the SDK model catalog. `list_models` is a live worker
    /// round-trip (`supportedModels()`) that is cold/slow right after startup,
    /// which is exactly when the client pulls it after a handshake. We prewarm
    /// this at boot (see `spawn_model_catalog_prewarm`) so the client gets the
    /// full list instantly instead of racing the cold worker. Process-lifetime
    /// only — never persisted, so it is re-warmed on every restart (no stale
    /// catalog surviving across versions).
    cached_models: Arc<RwLock<Option<Vec<ModelOptionView>>>>,
}

impl ClaudeCodeBridge {
    pub async fn spawn(state: Arc<RwLock<RelayState>>) -> Result<Self, String> {
        let worker_path = std::env::var("CLAUDE_WORKER_PATH").unwrap_or_else(|_| {
            // Default: resolve relative to this crate's manifest dir, up to workspace root.
            // CARGO_MANIFEST_DIR = .../crates/relay-server, workspace root = ../..
            let crate_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let workspace_root = crate_dir
                .parent()
                .and_then(|p| p.parent())
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| ".".to_string());
            format!("{workspace_root}/claude-worker/worker.mjs")
        });
        Self::spawn_with_worker_path(state, &worker_path).await
    }

    /// Like [`spawn`], but with an explicit worker path. Lets integration tests
    /// point the bridge at a scripted fake worker without mutating the
    /// process-global `CLAUDE_WORKER_PATH` env var (which would race other
    /// tests running in parallel).
    pub async fn spawn_with_worker_path(
        state: Arc<RwLock<RelayState>>,
        worker_path: &str,
    ) -> Result<Self, String> {
        let mut command = Command::new("node");
        command
            .arg(worker_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start claude worker: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture claude worker stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture claude worker stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture claude worker stderr".to_string())?;

        let child = Arc::new(Mutex::new(child));
        let pending_responses = Arc::new(Mutex::new(HashMap::new()));

        spawn_stdout_reader(stdout, pending_responses.clone(), state.clone());
        spawn_stderr_reader(stderr, state.clone());

        let bridge = Self {
            _child: child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending_responses,
            next_request_id: AtomicU64::new(1),
            state,
            pending_threads: Arc::new(Mutex::new(HashMap::new())),
            promoted_thread_ids: Arc::new(Mutex::new(HashMap::new())),
            cached_models: Arc::new(RwLock::new(None)),
        };

        {
            let mut relay = bridge.state.write().await;
            relay.set_provider_connection("claude_code", true);
            relay.set_provider_name("claude_code".to_string());
            relay.push_log("info", "Claude Code worker connected.");
            relay.notify();
        }

        Ok(bridge)
    }

    async fn send_command(&self, value: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let serialized = serde_json::to_string(&value)
            .map_err(|error| format!("failed to encode claude command: {error}"))?;
        stdin
            .write_all(serialized.as_bytes())
            .await
            .map_err(|error| format!("failed to write to claude worker stdin: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("failed to finalize claude worker command: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush claude worker stdin: {error}"))
    }

    async fn send_request(&self, command_type: &str, mut value: Value) -> Result<Value, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request_id_key = request_id.to_string();
        let (sender, receiver) = oneshot::channel();

        self.pending_responses
            .lock()
            .await
            .insert(request_id_key.clone(), sender);

        if let Some(object) = value.as_object_mut() {
            object.insert("type".to_string(), Value::String(command_type.to_string()));
            object.insert("id".to_string(), Value::String(request_id_key.clone()));
        } else {
            self.pending_responses.lock().await.remove(&request_id_key);
            return Err("claude request payload must be an object".to_string());
        }

        if let Err(error) = self.send_command(value).await {
            self.pending_responses.lock().await.remove(&request_id_key);
            return Err(error);
        }

        timeout(Duration::from_secs(CLAUDE_REQUEST_TIMEOUT_SECS), receiver)
            .await
            .map_err(|_| format!("Claude worker timed out waiting for `{command_type}`"))?
            .map_err(|_| {
                format!("Claude worker dropped the response channel for `{command_type}`")
            })?
    }

    async fn cwd_for_thread(&self, thread_id: &str) -> Option<String> {
        let relay = self.state.read().await;
        relay
            .threads
            .iter()
            .find(|thread| thread.id == thread_id && !thread.cwd.is_empty())
            .map(|thread| thread.cwd.clone())
    }

    /// Resolve a public thread id to the SDK's real session id. For
    /// `claude-pending-…` placeholders (no SDK session yet, or a stale id left
    /// over from a restart) returns `None` — callers treat that as a no-op.
    /// Any other id is assumed to be a real Anthropic session id.
    fn resolve_real_session_id(&self, thread_id: &str) -> Option<String> {
        if thread_id.starts_with("claude-pending-") {
            return None;
        }
        Some(thread_id.to_string())
    }

    fn synth_pending_thread_id(&self) -> String {
        format!(
            "claude-pending-{:x}-{}",
            unix_now(),
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    async fn record_local_user_message(
        &self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
    ) {
        let mut relay = self.state.write().await;
        match claude_thread_route(&relay, Some(thread_id)) {
            ClaudeThreadRoute::Active => {
                relay.upsert_user_message(item_id, text, turn_id);
                relay.touch_progress(Some("thinking"), None);
            }
            ClaudeThreadRoute::Background(bg_thread_id) => {
                relay.bg_upsert_user_message(&bg_thread_id, item_id, text, turn_id, unix_now());
            }
            ClaudeThreadRoute::Drop => return,
        }
        relay.notify();
    }
}

#[async_trait]
impl ProviderBridge for ClaudeCodeBridge {
    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        let result = self
            .send_request(
                "list_sessions",
                json!({
                    "limit": limit,
                }),
            )
            .await?;
        parse_thread_array(value_at(&result, &["threads"]))
    }

    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        // Serve the prewarmed catalog if we have it, so the client's
        // post-handshake pull doesn't race the cold worker round-trip.
        if let Some(cached) = self.cached_models.read().await.clone() {
            return Ok(cached);
        }

        let result = self.send_request("model/list", json!({})).await?;
        let data = value_at(&result, &["models"])
            .and_then(Value::as_array)
            .ok_or_else(|| "model/list did not return a models array".to_string())?;

        let mut models = data
            .iter()
            .map(parse_claude_model_option)
            .collect::<Result<Vec<_>, _>>()?;

        if !models.iter().any(|model| model.is_default) {
            if let Some(index) = models
                .iter()
                .position(|model| is_sonnet_model(&model.model))
            {
                models[index].is_default = true;
            } else if let Some(first) = models.first_mut() {
                first.is_default = true;
            }
        }

        // Cache only a non-empty catalog; a transient failure must not pin an
        // empty list for the rest of the process.
        if !models.is_empty() {
            *self.cached_models.write().await = Some(models.clone());
        }

        Ok(models)
    }

    async fn start_thread(
        &self,
        cwd: &str,
        model: &str,
        _approval_policy: &str,
        _sandbox: &str,
        initial_prompt: Option<&str>,
    ) -> Result<StartThreadResult, String> {
        let initial_prompt = initial_prompt
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty());
        let permission_mode = claude_permission_mode(_approval_policy, _sandbox);

        // Deferred start: with no prompt the SDK cannot give us a session_id yet
        // (it is only emitted after the first user message). Hand back a
        // synthetic id so the frontend can open an empty composer; the actual
        // session is created on the first turn via `start_turn`.
        if initial_prompt.is_none() {
            let pending_id = self.synth_pending_thread_id();
            self.pending_threads.lock().await.insert(
                pending_id.clone(),
                PendingClaudeConfig {
                    cwd: cwd.to_string(),
                    model: model.to_string(),
                    permission_mode: permission_mode.to_string(),
                },
            );
            let thread = ThreadSummaryView {
                id: pending_id,
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "claude_code".to_string(),
                status: "active".to_string(),
                model_provider: "anthropic".to_string(),
                provider: "claude_code".to_string(),
            };
            return Ok(StartThreadResult {
                thread,
                consumed_initial_prompt: false,
                initial_user_message: None,
                started_turn_id: None,
            });
        }

        let mut cmd = json!({
            "type": "start",
            "cwd": cwd,
            "model": model,
            "permissionMode": permission_mode,
        });
        if let Some(prompt) = initial_prompt {
            cmd["prompt"] = Value::String(prompt.to_string());
        }
        let result = self.send_request("start", cmd).await?;
        let thread = parse_thread_summary(value_at(&result, &["thread"]).unwrap_or(&Value::Null))?;
        let initial_user_message = value_at(&result, &["initial_user_message"])
            .and_then(|value| serde_json::from_value(value.clone()).ok());
        let started_turn_id = initial_user_message
            .as_ref()
            .and_then(|entry: &TranscriptEntryView| entry.turn_id.clone());
        Ok(StartThreadResult {
            thread,
            consumed_initial_prompt: true,
            initial_user_message,
            started_turn_id,
        })
    }

    async fn resume_thread(
        &self,
        thread_id: &str,
        _approval_policy: &str,
        _sandbox: &str,
    ) -> Result<(), String> {
        let Some(real_session_id) = self.resolve_real_session_id(thread_id) else {
            // Pending thread: no SDK session exists yet. Treat resume as a
            // no-op so the user can re-enter the empty composer view.
            return Ok(());
        };
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "type": "resume",
            "provider_session_id": real_session_id,
            "permissionMode": claude_permission_mode(_approval_policy, _sandbox),
        });
        if let Some(cwd) = cwd {
            if let Some(object) = cmd.as_object_mut() {
                object.insert("cwd".to_string(), Value::String(cwd));
            }
        }
        self.send_request("resume", cmd).await?;
        Ok(())
    }

    async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String> {
        let Some(real_session_id) = self.resolve_real_session_id(thread_id) else {
            // Pending thread: nothing to read from the SDK yet.
            let cwd = self.cwd_for_thread(thread_id).await.unwrap_or_default();
            return Ok(ThreadSyncData {
                thread: ThreadSummaryView {
                    id: thread_id.to_string(),
                    name: None,
                    preview: String::new(),
                    cwd,
                    updated_at: unix_now(),
                    source: "claude_code".to_string(),
                    status: "active".to_string(),
                    model_provider: "anthropic".to_string(),
                    provider: "claude_code".to_string(),
                },
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            });
        };
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "provider_session_id": real_session_id,
        });
        if let Some(cwd) = cwd {
            if let Some(object) = cmd.as_object_mut() {
                object.insert("cwd".to_string(), Value::String(cwd));
            }
        }
        let result = self.send_request("read_session", cmd).await?;
        let mut thread =
            parse_thread_summary(value_at(&result, &["thread"]).unwrap_or(&Value::Null))?;
        // Keep the public thread id stable when the underlying SDK session id
        // differs (i.e. a promoted pending thread).
        thread.id = thread_id.to_string();
        let transcript = value_at(&result, &["transcript"])
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| serde_json::from_value(item.clone()).ok())
                    .collect::<Vec<TranscriptEntryView>>()
            })
            .unwrap_or_default();
        let transcript = inject_turn_diff_entries(transcript);
        Ok(ThreadSyncData {
            thread,
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript,
        })
    }

    async fn read_thread_transcript_page(
        &self,
        thread_id: &str,
        before: Option<usize>,
    ) -> Result<Option<ThreadTranscriptPageData>, String> {
        let Some(real_session_id) = self.resolve_real_session_id(thread_id) else {
            return Ok(None);
        };
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "provider_session_id": real_session_id,
        });
        if let Some(before) = before {
            cmd["before_cursor"] = Value::from(before);
        }
        if let Some(cwd) = cwd {
            cmd["cwd"] = Value::String(cwd);
        }
        let result = self.send_request("read_session_page", cmd).await?;
        let mut thread =
            parse_thread_summary(value_at(&result, &["thread"]).unwrap_or(&Value::Null))?;
        thread.id = thread_id.to_string();
        let transcript = value_at(&result, &["transcript"])
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| serde_json::from_value(item.clone()).ok())
                    .collect::<Vec<TranscriptEntryView>>()
            })
            .unwrap_or_default();
        Ok(Some(ThreadTranscriptPageData {
            sync: ThreadSyncData {
                thread,
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: inject_turn_diff_entries(transcript),
            },
            prev_cursor: value_at(&result, &["prev_cursor"])
                .and_then(Value::as_u64)
                .map(|v| v as usize),
            paged: value_at(&result, &["paged"])
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }))
    }

    async fn read_thread_entry_detail(
        &self,
        _thread_id: &str,
        _item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        Ok(None)
    }

    async fn archive_thread(&self, _thread_id: &str) -> Result<(), String> {
        Err("ClaudeCodeBridge: archive is not supported".to_string())
    }

    async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        // Pending thread never reached Anthropic — just drop our local state.
        if self
            .pending_threads
            .lock()
            .await
            .remove(thread_id)
            .is_some()
        {
            return Ok(LocalThreadDeleteSummary {
                deleted_paths: Vec::new(),
                deleted_thread_row: true,
            });
        }
        let real_session_id = self
            .resolve_real_session_id(thread_id)
            .unwrap_or_else(|| thread_id.to_string());
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "provider_session_id": real_session_id,
        });
        if let Some(cwd) = cwd {
            if let Some(object) = cmd.as_object_mut() {
                object.insert("cwd".to_string(), Value::String(cwd));
            }
        }
        self.send_request("delete_session", cmd).await?;
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
        // Promote a pending (deferred-start) thread to a real Claude session on
        // the first turn. The worker `start` command both spins up the SDK
        // session and sends the first message; the returned thread carries the
        // real Anthropic session_id, which we map to the public thread_id.
        // Pending (deferred-start) thread: promote it now. We send `start` to
        // the worker — that boots the SDK session and uses `text` as the first
        // user message. The worker's session_started event handler swaps the
        // public thread id from the placeholder to the real Anthropic id, so
        // no mapping needs to live past this turn.
        let pending = self.pending_threads.lock().await.remove(thread_id);
        if let Some(config) = pending {
            // Mint the user message's identity up front and hand it to the
            // worker. The `start` command accepts the same
            // `turn_id`/`user_item_id`/`user_message_uuid` triple the `send`
            // path uses (worker.mjs createUserTurn), so the worker stamps the SDK
            // message with our uuid. That lets us record the message locally now
            // with ids the worker will reuse when it later replays `user_message`
            // (and that a history re-read reproduces), collapsing all three into
            // one idempotent transcript entry instead of a duplicate.
            let turn_id = format!(
                "claude-turn-{}",
                self.next_request_id.fetch_add(1, Ordering::Relaxed)
            );
            let user_message_uuid = new_user_message_uuid();
            let user_item_id = format!("user:{user_message_uuid}");
            let cmd = json!({
                "type": "start",
                "cwd": config.cwd,
                "model": config.model,
                "permissionMode": config.permission_mode,
                "pending_thread_id": thread_id,
                "prompt": text,
                "turn_id": turn_id,
                "user_item_id": user_item_id,
                "user_message_uuid": user_message_uuid,
            });
            let result = match self.send_request("start", cmd).await {
                Ok(result) => result,
                Err(error) => {
                    // Restore pending state so a retry can succeed.
                    self.pending_threads
                        .lock()
                        .await
                        .insert(thread_id.to_string(), config);
                    return Err(error);
                }
            };
            // The worker emits `session_started` before the `start` response and
            // the relay reads stdout strictly in order, so by the time this
            // resolves the synthetic pending id has already been promoted to the
            // real SDK session id — which the worker hands back on the response
            // thread. Record the first user message against that real id NOW, so
            // the very next snapshot already carries it instead of waiting on the
            // worker's later async `user_message` replay (the projection window
            // the remote surface had no repair path for).
            let real_session_id =
                string_at(&result, &["thread", "id"]).unwrap_or_else(|| thread_id.to_string());
            if real_session_id != thread_id {
                self.promoted_thread_ids
                    .lock()
                    .await
                    .insert(thread_id.to_string(), real_session_id.clone());
            }
            self.record_local_user_message(
                &real_session_id,
                user_item_id,
                text.to_string(),
                turn_id.clone(),
            )
            .await;
            return Ok(Some(turn_id));
        }

        let turn_id = format!(
            "claude-turn-{}",
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        // The user message's identity must be ONE value shared by both the live
        // stream and any later history re-read. The worker stamps this uuid onto
        // the SDK message, so `getSessionMessages` -> `mapSessionMessages` later
        // reproduces exactly `user:{uuid}` — the same id we record live below.
        //
        // We used to use the relay turn_id (`user:claude-turn-N`) here, which
        // diverged from the SDK's own message uuid. On a thread switch-away-and
        // -back the per-thread runtime merged the live (`user:claude-turn-N`)
        // copy with the fresh history read (`user:<sdk-uuid>`), so the same
        // user message appeared twice. A real, unique uuid keeps the two paths in
        // sync and is collision-safe across relay restarts (unlike the per-process
        // turn counter, which resets to 1).
        let user_message_uuid = new_user_message_uuid();
        let user_item_id = format!("user:{user_message_uuid}");
        let settings = {
            let relay = self.state.read().await;
            relay.thread_settings(thread_id)
        };
        let permission_mode = settings
            .as_ref()
            .map(|settings| claude_permission_mode(&settings.approval_policy, &settings.sandbox))
            .unwrap_or_else(|| claude_permission_mode("default", "workspace-write"));
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "type": "send",
            "provider_session_id": thread_id,
            "prompt": text,
            "turn_id": turn_id,
            "user_item_id": user_item_id,
            "user_message_uuid": user_message_uuid,
            "model": _model,
            "permissionMode": permission_mode,
        });
        if let Some(cwd) = cwd {
            if let Some(object) = cmd.as_object_mut() {
                object.insert("cwd".to_string(), Value::String(cwd));
            }
        }
        self.send_command(cmd).await?;
        self.record_local_user_message(thread_id, user_item_id, text.to_string(), turn_id.clone())
            .await;
        Ok(Some(turn_id))
    }

    async fn resolve_started_thread_id(&self, requested_thread_id: &str) -> String {
        self.promoted_thread_ids
            .lock()
            .await
            .remove(requested_thread_id)
            .unwrap_or_else(|| requested_thread_id.to_string())
    }

    async fn request_turn_stop(
        &self,
        thread_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<(), String> {
        self.send_request(
            "cancel",
            json!({
                "provider_session_id": thread_id,
            }),
        )
        .await
        .map(|_| ())
    }

    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        self.send_request(
            "approval_decision",
            json!({
                "approval_id": pending.request_id,
                "decision": match input.decision {
                    ApprovalDecision::Approve => "approve",
                    ApprovalDecision::Deny => "deny",
                    ApprovalDecision::Cancel => "cancel",
                },
                "scope": match input.scope {
                    Some(crate::protocol::ApprovalScope::Session) => "session",
                    _ => "once",
                },
            }),
        )
        .await
        .map(|_| ())
    }

    async fn respond_to_ask_user_question(
        &self,
        request_id: &str,
        answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        self.send_request(
            "ask_user_question_answer",
            json!({
                "request_id": request_id,
                "answers": Value::Object(answers.clone()),
            }),
        )
        .await
        .map(|_| ())
    }

    fn provider_name(&self) -> &'static str {
        "claude_code"
    }

    fn read_thread_reports_activity_time(&self) -> bool {
        // `read_session` overrides `updated_at` with the transcript's last real
        // message time (worker.mjs), so it is resume-safe and can be max-folded.
        true
    }
}

// --- stdout / stderr readers -----------------------------------------------

fn spawn_stdout_reader(
    stdout: ChildStdout,
    pending_responses: PendingResponses,
    state: Arc<RwLock<RelayState>>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    handle_worker_line(&line, &pending_responses, &state).await;
                }
                Ok(None) => {
                    let mut relay = state.write().await;
                    relay.set_provider_connection("claude_code", false);
                    // The worker is gone; any turn it was running can never complete.
                    // Settle its threads so a ghost active_turn_id doesn't keep them
                    // is_working() forever (blocking reviews) until restart.
                    relay.fail_in_flight_turns_for_provider("claude_code");
                    relay.push_log("error", "Claude worker stdout closed.");
                    relay.notify();
                    break;
                }
                Err(error) => {
                    let mut relay = state.write().await;
                    relay.set_provider_connection("claude_code", false);
                    relay.fail_in_flight_turns_for_provider("claude_code");
                    relay.push_log(
                        "error",
                        format!("Failed to read claude worker stdout: {error}"),
                    );
                    relay.notify();
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_reader(stderr: tokio::process::ChildStderr, state: Arc<RwLock<RelayState>>) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut relay = state.write().await;
            relay.push_log("claude_worker", line);
            relay.notify();
        }
    });
}

fn parse_claude_model_option(model: &Value) -> Result<ModelOptionView, String> {
    let supported_reasoning_efforts = value_at(model, &["supportedReasoningEfforts"])
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(ModelOptionView {
        model: string_at(model, &["model"])
            .ok_or_else(|| "model/list item missing model".to_string())?,
        display_name: string_at(model, &["displayName"])
            .ok_or_else(|| "model/list item missing displayName".to_string())?,
        provider: string_at(model, &["provider"]).unwrap_or_else(|| "anthropic".to_string()),
        supported_reasoning_efforts,
        default_reasoning_effort: string_at(model, &["defaultReasoningEffort"]).unwrap_or_default(),
        hidden: bool_at(model, &["hidden"]).unwrap_or(false),
        is_default: bool_at(model, &["isDefault"]).unwrap_or(false),
    })
}

fn is_sonnet_model(model: &str) -> bool {
    model == "sonnet" || model.starts_with("sonnet[") || model.starts_with("claude-sonnet")
}

async fn handle_worker_line(
    line: &str,
    pending_responses: &PendingResponses,
    state: &Arc<RwLock<RelayState>>,
) {
    let payload: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    if payload.get("type").and_then(Value::as_str) == Some("response") {
        let request_id = normalize_id(payload.get("id").unwrap_or(&Value::Null));
        if let Some(sender) = pending_responses.lock().await.remove(&request_id) {
            let result = if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                Ok(payload.get("result").cloned().unwrap_or(Value::Null))
            } else {
                Err(value_at(&payload, &["error", "message"])
                    .and_then(Value::as_str)
                    .unwrap_or("Claude worker returned an unknown error")
                    .to_string())
            };
            let _ = sender.send(result);
        }
        return;
    }

    handle_worker_event(payload, state).await;
}

async fn handle_worker_event(payload: Value, state: &Arc<RwLock<RelayState>>) {
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let event_thread_id = string_at(&payload, &["provider_session_id"]);

    let mut relay = state.write().await;

    match event_type {
        "session_created" | "session_resumed" => {
            if let Some(sid) = payload.get("provider_session_id").and_then(Value::as_str) {
                let pending_thread_id = string_at(&payload, &["pending_thread_id"]);
                let should_activate = relay.active_thread_id.is_none()
                    || relay.active_thread_id.as_deref() == Some(sid)
                    || pending_thread_id.as_deref() == relay.active_thread_id.as_deref();
                if should_activate {
                    relay.active_thread_id = Some(sid.to_string());
                    relay.push_log("info", format!("Claude session: {sid}"));
                }
                relay.set_thread_status(sid, "active".to_string(), Vec::new());
            }
            relay.notify();
        }

        "session_started" => {
            // SDK system/init message — the full session init. When this fires
            // while we are sitting on a synthetic `claude-pending-…` id (the
            // deferred-start placeholder), promote the thread: swap the public
            // id over to the real SDK session id and drop the placeholder row.
            let provider_session_id = payload
                .get("provider_session_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(sid) = provider_session_id.as_deref() {
                let pending_thread_id = string_at(&payload, &["pending_thread_id"]);
                let stale_pending_id = relay
                    .active_thread_id
                    .as_deref()
                    .filter(|id| Some(*id) == pending_thread_id.as_deref())
                    .map(|id| id.to_string());
                if stale_pending_id.is_some() || relay.active_thread_id.as_deref() == Some(sid) {
                    relay.active_thread_id = Some(sid.to_string());
                }
                if let Some(pending_id) = stale_pending_id {
                    relay.promote_background_thread(&pending_id, sid);
                } else if let Some(pending_id) = pending_thread_id.as_deref() {
                    // Promote a non-live pending thread in place so its runtime,
                    // transcript, and any review job reference use the real id.
                    if pending_id != sid {
                        relay.promote_background_thread(pending_id, sid);
                    }
                }
            }
            let is_active_session = provider_session_id
                .as_deref()
                .map_or(false, |sid| relay.active_thread_id.as_deref() == Some(sid));
            let payload_cwd = payload.get("cwd").and_then(Value::as_str);
            if is_active_session {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    // The SDK reports the concrete resolved model (e.g.
                    // "claude-opus-4-8"), but the catalog may expose it via a
                    // stable alias — the "default" entry labelled "Default
                    // (recommended, Opus 4.8)". Adopting the concrete id would
                    // leave session.model unmatched in the model picker and
                    // surface a duplicate "ghost" option that vanishes only
                    // once the user reselects a model. Keep the matchable value
                    // we already have unless the catalog actually offers the
                    // reported id (or hasn't loaded yet).
                    let matches_catalog = relay
                        .available_models
                        .iter()
                        .any(|option| option.model == model);
                    if matches_catalog || relay.available_models.is_empty() {
                        relay.model = model.to_string();
                    }
                }
                if let Some(cwd) = payload_cwd {
                    relay.current_cwd = cwd.to_string();
                }
            }
            if is_active_session {
                relay.set_provider_name("claude_code".to_string());
            }
            let thread_id = provider_session_id
                .clone()
                .or_else(|| relay.active_thread_id.clone())
                .unwrap_or_default();
            let cwd = if is_active_session {
                relay.current_cwd.clone()
            } else {
                payload_cwd.unwrap_or_default().to_string()
            };
            relay.upsert_thread(ThreadSummaryView {
                id: thread_id,
                name: None,
                preview: String::new(),
                cwd,
                updated_at: unix_now(),
                source: "claude_code".to_string(),
                status: "active".to_string(),
                model_provider: "anthropic".to_string(),
                provider: "claude_code".to_string(),
            });
            relay.notify();
        }

        "user_message" => {
            let route = claude_thread_route(&relay, event_thread_id.as_deref());
            if matches!(route, ClaudeThreadRoute::Drop) {
                return;
            }
            if let (Some(item_id), Some(turn_id), Some(text)) = (
                string_at(&payload, &["item_id"]),
                string_at(&payload, &["turn_id"]),
                string_at(&payload, &["text"]),
            ) {
                if let ClaudeThreadRoute::Background(thread_id) = route.clone() {
                    relay.bg_upsert_user_message(
                        &thread_id,
                        item_id,
                        text,
                        turn_id,
                        crate::state::unix_now(),
                    );
                } else {
                    relay.upsert_user_message(item_id, text, turn_id);
                    relay.touch_progress(Some("thinking"), None);
                }
                relay.notify();
            }
        }

        "assistant_message" | "assistant_delta" => {
            let route = claude_thread_route(&relay, event_thread_id.as_deref());
            if matches!(route, ClaudeThreadRoute::Drop) {
                return;
            }
            if let (Some(item_id), Some(turn_id), Some(text)) = (
                string_at(&payload, &["item_id"]).or_else(|| Some("assistant:latest".to_string())),
                string_at(&payload, &["turn_id"]).or_else(|| relay.active_turn_id.clone()),
                string_at(&payload, &["text"]),
            ) {
                let status =
                    string_at(&payload, &["status"]).unwrap_or_else(|| "completed".to_string());
                if let ClaudeThreadRoute::Background(thread_id) = route.clone() {
                    if status == "completed" {
                        relay.bg_complete_agent_message(
                            &thread_id,
                            item_id,
                            text.clone(),
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.bg_append_agent_delta(
                            &thread_id,
                            &item_id,
                            &text,
                            &turn_id,
                            crate::state::unix_now(),
                        );
                    }
                } else {
                    if status == "completed" {
                        relay.complete_agent_message(item_id, text.clone(), turn_id);
                        relay.touch_progress(Some("thinking"), None);
                    } else {
                        relay.touch_progress(Some("streaming"), None);
                        let mutation = relay.append_agent_delta(&item_id, &text, &turn_id);
                        let thread_id = relay.active_thread_id.clone().unwrap_or_default();
                        relay
                            .pending_broker_messages
                            .push(BrokerPendingMessage::TranscriptDelta(
                                PendingTranscriptDelta {
                                    thread_id,
                                    base_revision: mutation.base_revision,
                                    revision: mutation.revision,
                                    entry_seq: mutation.entry_seq,
                                    server_time: mutation.server_time,
                                    item_id,
                                    turn_id: Some(turn_id),
                                    delta: text.clone(),
                                    kind: TranscriptDeltaKind::AgentText,
                                    text_offset: mutation.text_offset,
                                },
                            ));
                    }
                }
                relay.push_log("agent", text);
                relay.notify();
            }
        }

        "tool_call_requested" => {
            let route = claude_thread_route(&relay, event_thread_id.as_deref());
            if matches!(route, ClaudeThreadRoute::Drop) {
                return;
            }
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if let Some(item_id) = string_at(&payload, &["item_id"])
                .or_else(|| string_at(&payload, &["id"]).map(|id| format!("tool:{id}")))
            {
                let turn_id = string_at(&payload, &["turn_id"])
                    .or_else(|| relay.active_turn_id.clone())
                    .unwrap_or_else(|| item_id.clone());
                let tool = payload
                    .get("tool")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<ToolCallView>(value).ok())
                    .unwrap_or_else(|| ToolCallView {
                        item_type: "toolCall".to_string(),
                        name: name.to_string(),
                        title: name.to_string(),
                        detail: None,
                        query: None,
                        path: None,
                        url: None,
                        command: None,
                        input_preview: payload.get("args").map(compact_json),
                        result_preview: None,
                        diff: None,
                        file_changes: Vec::new(),
                        apply_state: None,
                        file_changes_omitted: false,
                    });
                let status =
                    string_at(&payload, &["status"]).unwrap_or_else(|| "running".to_string());
                if let ClaudeThreadRoute::Background(thread_id) = route.clone() {
                    relay.bg_upsert_transcript_item(
                        &thread_id,
                        item_id,
                        TranscriptEntryKind::ToolCall,
                        None,
                        status,
                        Some(turn_id),
                        Some(tool),
                        crate::state::unix_now(),
                    );
                } else {
                    relay.upsert_transcript_item(
                        item_id,
                        TranscriptEntryKind::ToolCall,
                        None,
                        status,
                        Some(turn_id),
                        Some(tool),
                    );
                }
            }
            if matches!(route, ClaudeThreadRoute::Active) {
                relay.touch_progress(Some("tool"), Some(name));
                relay.push_log("tool", format!("Tool call: {name}"));
            }
            relay.notify();
        }

        "tool_call_result" => {
            let route = claude_thread_route(&relay, event_thread_id.as_deref());
            if matches!(route, ClaudeThreadRoute::Drop) {
                return;
            }
            if let Some(item_id) = string_at(&payload, &["id"]).map(|id| format!("tool:{id}")) {
                let mut tool = payload
                    .get("tool")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<ToolCallView>(value).ok())
                    .unwrap_or_else(|| ToolCallView {
                        item_type: String::new(),
                        name: String::new(),
                        title: String::new(),
                        detail: None,
                        query: None,
                        path: None,
                        url: None,
                        command: None,
                        input_preview: None,
                        result_preview: None,
                        diff: None,
                        file_changes: Vec::new(),
                        apply_state: None,
                        file_changes_omitted: false,
                    });
                if tool.result_preview.is_none() {
                    tool.result_preview = string_at(&payload, &["content"]);
                }
                let turn_id =
                    string_at(&payload, &["turn_id"]).or_else(|| relay.active_turn_id.clone());
                let is_file_change = tool.item_type == "fileChange";
                if let ClaudeThreadRoute::Background(thread_id) = route.clone() {
                    relay.bg_upsert_transcript_item(
                        &thread_id,
                        item_id,
                        TranscriptEntryKind::ToolCall,
                        None,
                        "completed".to_string(),
                        turn_id,
                        Some(tool),
                        crate::state::unix_now(),
                    );
                } else {
                    relay.upsert_transcript_item(
                        item_id,
                        TranscriptEntryKind::ToolCall,
                        None,
                        "completed".to_string(),
                        turn_id.clone(),
                        Some(tool),
                    );
                    if is_file_change {
                        if let Some(turn_id) = turn_id {
                            ensure_claude_turn_diff_entry(&mut relay, &turn_id, "running");
                        }
                    }
                }
            }
            // Bump last_progress_at but defer phase changes to the next
            // worker event (or progress_tick) — multiple tools may still
            // be in flight and only the worker knows.
            if matches!(route, ClaudeThreadRoute::Active) {
                relay.touch_progress(None, None);
                relay.push_log("tool", "Tool result received");
            }
            relay.notify();
        }

        "approval_requested" => {
            if let Some(pending) = parse_claude_approval(&payload, &relay) {
                let route = claude_thread_route(&relay, Some(&pending.thread_id));
                relay.set_thread_status(
                    &pending.thread_id,
                    "active".to_string(),
                    vec!["waitingOnApproval".to_string()],
                );
                if let ClaudeThreadRoute::Background(thread_id) = route {
                    relay.bg_set_thread_status(
                        &thread_id,
                        "active".to_string(),
                        vec!["waitingOnApproval".to_string()],
                        crate::state::unix_now(),
                    );
                }
                relay.add_pending_approval(pending.clone());
                if matches!(
                    claude_thread_route(&relay, Some(&pending.thread_id)),
                    ClaudeThreadRoute::Active
                ) {
                    relay.touch_progress(Some("waiting_approval"), None);
                }
            }
            let action = string_at(&payload, &["action"]).unwrap_or_else(|| "unknown".to_string());
            relay.push_log(
                "approval",
                format!("Claude requests approval for: {action}"),
            );
            relay.notify();
        }

        "ask_user_question_requested" => {
            let Some(request_id) = string_at(&payload, &["id"]) else {
                relay.push_log("error", "ask_user_question_requested missing id");
                return;
            };
            let tool_use_id = string_at(&payload, &["tool_use_id"]).unwrap_or_default();
            let thread_id = event_thread_id
                .clone()
                .or_else(|| relay.active_thread_id.clone())
                .unwrap_or_default();
            let questions = crate::state::parse_ask_user_questions(payload.get("questions"));
            let pending = crate::state::PendingAskUserQuestion {
                request_id: request_id.clone(),
                tool_use_id,
                thread_id: thread_id.clone(),
                requested_at: crate::state::unix_now(),
                questions,
            };
            if !thread_id.is_empty() {
                let route = claude_thread_route(&relay, Some(&thread_id));
                relay.set_thread_status(
                    &thread_id,
                    "active".to_string(),
                    vec!["waitingOnAskUser".to_string()],
                );
                if let ClaudeThreadRoute::Background(bg_thread_id) = route {
                    relay.bg_set_thread_status(
                        &bg_thread_id,
                        "active".to_string(),
                        vec!["waitingOnAskUser".to_string()],
                        crate::state::unix_now(),
                    );
                }
            }
            relay.add_pending_ask_user_question(pending);
            if matches!(
                claude_thread_route(&relay, Some(&thread_id)),
                ClaudeThreadRoute::Active
            ) {
                relay.touch_progress(Some("waiting_user"), None);
            }
            relay.push_log(
                "ask_user",
                format!("Claude asked a question ({request_id})."),
            );
            relay.notify();
        }

        "progress_tick" => {
            let phase = string_at(&payload, &["phase"]);
            let tool = string_at(&payload, &["tool"]);
            match claude_thread_route(&relay, event_thread_id.as_deref()) {
                ClaudeThreadRoute::Active => {
                    relay.touch_progress(phase.as_deref(), tool.as_deref());
                }
                ClaudeThreadRoute::Background(thread_id) => {
                    relay.touch_thread_progress(&thread_id, phase.as_deref(), tool.as_deref());
                }
                ClaudeThreadRoute::Drop => return,
            }
            relay.notify();
        }

        "done" | "session_stopped" => {
            let stopped_explicitly = event_type == "session_stopped";
            let event_turn_id = string_at(&payload, &["turn_id"]);
            match claude_thread_route(&relay, event_thread_id.as_deref()) {
                ClaudeThreadRoute::Active => {
                    let tid = relay.active_thread_id.clone().unwrap_or_default();
                    if !completion_matches_turn(
                        relay.active_turn_id.as_deref(),
                        event_turn_id.as_deref(),
                    ) {
                        relay.push_log(
                            "warn",
                            format!(
                                "Ignored stale Claude completion for turn {} on thread {tid}.",
                                event_turn_id.as_deref().unwrap_or("<missing>")
                            ),
                        );
                        relay.notify();
                        return;
                    }
                    let completed_turn_id = relay.active_turn_id.clone();
                    relay.set_active_turn(None);
                    relay.set_thread_status(&tid, "idle".to_string(), Vec::new());
                    relay.clear_progress();
                    relay.push_log(
                        "info",
                        if stopped_explicitly {
                            "Claude session stopped."
                        } else {
                            "Claude turn completed."
                        },
                    );
                    if let Some(turn_id) = completed_turn_id.as_deref() {
                        relay.set_transcript_item_status(
                            &format!("turn-diff:{turn_id}"),
                            "completed",
                        );
                    }
                    // A failed terminal must leave a DURABLE, visible failure in
                    // the transcript: operator-only logs are stripped from
                    // broker-bound snapshots, so a log line alone would let a
                    // remote/mobile client see the failed turn settle as a clean
                    // success. The reason is the worker's sanitized, subtype-only
                    // string (no provider content).
                    if let Some(reason) = claude_failed_turn_reason(&payload) {
                        let turn_id = completed_turn_id.or_else(|| event_turn_id.clone());
                        relay.upsert_transcript_item_for_thread(
                            &tid,
                            claude_turn_error_item_id(turn_id.as_deref()),
                            TranscriptEntryKind::Error,
                            Some(reason),
                            "failed".to_string(),
                            turn_id,
                            None,
                        );
                    }
                }
                ClaudeThreadRoute::Background(thread_id) => {
                    let completed_turn_id = relay
                        .runtime_for_thread(&thread_id)
                        .and_then(|runtime| runtime.active_turn_id.clone());
                    if !completion_matches_turn(
                        completed_turn_id.as_deref(),
                        event_turn_id.as_deref(),
                    ) {
                        relay.push_log(
                            "warn",
                            format!(
                                "Ignored stale Claude completion for turn {} on thread {thread_id}.",
                                event_turn_id.as_deref().unwrap_or("<missing>")
                            ),
                        );
                        relay.notify();
                        return;
                    }
                    let now = crate::state::unix_now();
                    relay.bg_set_active_turn(&thread_id, None, now);
                    relay.bg_set_thread_status(&thread_id, "idle".to_string(), Vec::new(), now);
                    relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
                    // Same failure-visibility guarantee for BACKGROUND turns: the
                    // entry lands on that thread's runtime so it is present when
                    // the user later switches back to it (and in its broker-bound
                    // snapshot). See the active-route note above.
                    if let Some(reason) = claude_failed_turn_reason(&payload) {
                        let turn_id = completed_turn_id.or_else(|| event_turn_id.clone());
                        relay.bg_upsert_transcript_item(
                            &thread_id,
                            claude_turn_error_item_id(turn_id.as_deref()),
                            TranscriptEntryKind::Error,
                            Some(reason),
                            "failed".to_string(),
                            turn_id,
                            None,
                            now,
                        );
                    }
                }
                ClaudeThreadRoute::Drop => {
                    // A terminal event that routes to Drop clears NOTHING: the
                    // thread that owns the turn keeps active_turn_id, so the UI
                    // stays "streaming". This is otherwise silent — log it so the
                    // "ended but still streaming" investigation can see it.
                    let active_thread = relay.active_thread_id.clone();
                    relay.push_log(
                        "warn",
                        format!(
                            "Dropped Claude {event_type} for turn {} (session {}); \
                             no matching thread (active_thread={:?}).",
                            event_turn_id.as_deref().unwrap_or("<missing>"),
                            event_thread_id.as_deref().unwrap_or("<missing>"),
                            active_thread.as_deref(),
                        ),
                    );
                    relay.notify();
                    return;
                }
            }
            relay.notify();
        }

        "status_changed" => {
            let status = string_at(&payload, &["state"]).unwrap_or_else(|| "active".to_string());
            let flags = if status == "requires_action" {
                vec!["waitingOnApproval".to_string()]
            } else {
                Vec::new()
            };
            match claude_thread_route(&relay, event_thread_id.as_deref()) {
                ClaudeThreadRoute::Active => {
                    let tid = relay.active_thread_id.clone().unwrap_or_default();
                    relay.set_thread_status(&tid, status, flags);
                }
                ClaudeThreadRoute::Background(thread_id) => {
                    let now = crate::state::unix_now();
                    relay.bg_set_thread_status(&thread_id, status.clone(), flags.clone(), now);
                    relay.set_thread_status(&thread_id, status, flags);
                }
                ClaudeThreadRoute::Drop => return,
            }
            relay.notify();
        }

        "error" => {
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            relay.push_log("error", format!("Claude worker error: {message}"));
            relay.notify();
        }

        _ => {}
    }
}

/// The sanitized failure reason if a Claude terminal reported a FAILED turn.
/// Only the worker's failed `result` sets `failed: true` (mapped onto `done`),
/// carrying a bounded, subtype-only `reason`; a clean `done` and an explicit
/// `session_stopped` (user cancel) do not. Returns `None` for non-failures, so
/// the failure entry is injected exactly for genuine turn failures.
fn claude_failed_turn_reason(payload: &Value) -> Option<String> {
    if !payload
        .get("failed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    Some(
        string_at(payload, &["reason"])
            .filter(|reason| !reason.is_empty())
            .unwrap_or_else(|| "Claude turn failed.".to_string()),
    )
}

/// Stable per-turn id for the synthetic failure entry so a re-delivered terminal
/// upserts (never duplicates) the same entry.
fn claude_turn_error_item_id(turn_id: Option<&str>) -> String {
    format!("turn-error:{}", turn_id.unwrap_or("unknown"))
}

fn completion_matches_turn(active_turn_id: Option<&str>, event_turn_id: Option<&str>) -> bool {
    match (active_turn_id, event_turn_id) {
        (Some(active), Some(completed)) => active == completed,
        (Some(_), None) => false,
        (None, _) => true,
    }
}

/// Walk a hydrated Claude transcript and insert a synthetic
/// `turn-diff:<turn_id>` entry at the end of every turn that contains at
/// least one `fileChange` tool item. Mirrors what codex `parse_transcript`
/// does at hydration time so reopening an old thread shows the same
/// per-turn diff summary that lived on the wire.
fn inject_turn_diff_entries(transcript: Vec<TranscriptEntryView>) -> Vec<TranscriptEntryView> {
    let mut out: Vec<TranscriptEntryView> = Vec::with_capacity(transcript.len() + 4);
    let mut current_turn: Option<String> = None;
    let mut current_changes: Vec<crate::protocol::FileChangeDiffView> = Vec::new();

    fn flush(
        out: &mut Vec<TranscriptEntryView>,
        turn_id: Option<String>,
        mut changes: Vec<crate::protocol::FileChangeDiffView>,
    ) {
        let Some(turn_id) = turn_id else { return };
        if changes.is_empty() {
            return;
        }
        let mut merged: Vec<crate::protocol::FileChangeDiffView> = Vec::new();
        for change in changes.drain(..) {
            crate::file_changes::merge_file_change_view(&mut merged, change);
        }
        let entry = crate::codex::build_turn_diff_entry_with_fallback(
            turn_id,
            None,
            "completed",
            merged,
            "Claude",
        );
        out.push(entry);
    }

    for entry in transcript {
        if current_turn.as_deref() != entry.turn_id.as_deref() {
            flush(
                &mut out,
                current_turn.take(),
                std::mem::take(&mut current_changes),
            );
            current_turn = entry.turn_id.clone();
        }
        if let Some(tool) = entry.tool.as_ref() {
            if tool.item_type == "fileChange" {
                current_changes.extend(tool.file_changes.iter().cloned());
                if current_changes.is_empty() {
                    if let Some(path) = tool.path.clone() {
                        current_changes.push(crate::protocol::FileChangeDiffView {
                            path,
                            change_type: "update".to_string(),
                            diff: String::new(),
                        });
                    }
                }
            }
        }
        out.push(entry);
    }
    flush(&mut out, current_turn, current_changes);
    out
}

/// Build (or refresh) the synthetic `turn-diff:<turn_id>` transcript entry
/// for the current Claude turn. Mirrors the codex flow but synthesizes the
/// entry from `fileChange` tool results since Claude does not emit a
/// dedicated `turn/diff/updated` notification. No-op if the turn has no
/// file-change tools yet.
fn ensure_claude_turn_diff_entry(relay: &mut RelayState, turn_id: &str, status: &str) -> bool {
    let fallback_file_changes = relay.turn_file_change_summary(turn_id);
    if fallback_file_changes.is_empty() {
        return false;
    }

    let turn_diff_item_id = format!("turn-diff:{turn_id}");
    let existing_diff = relay
        .snapshot()
        .transcript
        .into_iter()
        .find(|entry| entry.item_id.as_deref() == Some(turn_diff_item_id.as_str()))
        .and_then(|entry| entry.tool)
        .and_then(|tool| tool.diff);

    let entry = crate::codex::build_turn_diff_entry_with_fallback(
        turn_id.to_string(),
        existing_diff,
        status,
        fallback_file_changes,
        "Claude",
    );
    let Some(item_id) = entry.item_id.clone() else {
        return false;
    };
    relay.upsert_transcript_item(
        item_id,
        entry.kind,
        entry.text,
        entry.status,
        entry.turn_id,
        entry.tool,
    );
    true
}

#[derive(Debug, Clone)]
enum ClaudeThreadRoute {
    Active,
    Background(String),
    Drop,
}

fn claude_thread_route(relay: &RelayState, thread_id: Option<&str>) -> ClaudeThreadRoute {
    match (relay.active_thread_id.as_deref(), thread_id) {
        (None, None) => ClaudeThreadRoute::Active,
        (Some(active), None) if thread_belongs_to_claude(relay, active) => {
            ClaudeThreadRoute::Active
        }
        (_, None) => ClaudeThreadRoute::Drop,
        (None, Some(_)) => ClaudeThreadRoute::Drop,
        (Some(active), Some(thread_id)) if active == thread_id => ClaudeThreadRoute::Active,
        (Some(_), Some(thread_id)) => ClaudeThreadRoute::Background(thread_id.to_string()),
    }
}

fn thread_belongs_to_claude(relay: &RelayState, thread_id: &str) -> bool {
    if let Some(thread) = relay.threads.iter().find(|thread| thread.id == thread_id) {
        return thread.provider == "claude_code" || thread.source == "claude_code";
    }

    relay.provider_name.is_empty() || relay.provider_name == "claude_code"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn new_user_message_uuid_is_rfc4122_v4() {
        // The SDK accepts the uuid we stamp onto the user message and persists it
        // verbatim, so it must be a valid RFC 4122 v4 string (not the old
        // `claude-turn-N`). If this layout drifts, the live id and the
        // history-read id can diverge again.
        let id = new_user_message_uuid();
        let groups: Vec<&str> = id.split('-').collect();
        assert_eq!(groups.len(), 5, "uuid needs five groups: {id}");
        assert_eq!(
            groups.iter().map(|g| g.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12],
            "uuid groups must be 8-4-4-4-12: {id}"
        );
        assert!(
            id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'),
            "uuid must be hex + dashes: {id}"
        );
        assert_eq!(
            groups[2].as_bytes()[0],
            b'4',
            "version nibble must be 4: {id}"
        );
        assert!(
            matches!(groups[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'),
            "variant nibble must be RFC 4122: {id}"
        );
        assert_ne!(
            new_user_message_uuid(),
            new_user_message_uuid(),
            "two draws must differ"
        );
    }

    async fn spawn_or_skip() -> Option<(ClaudeCodeBridge, Arc<RwLock<RelayState>>)> {
        let (tx, _) = tokio::sync::watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp".to_string(),
            tx,
            crate::state::SecurityProfile::private(),
        )));
        match ClaudeCodeBridge::spawn(state.clone()).await {
            Ok(b) => Some((b, state)),
            Err(_) => {
                eprintln!("skipping: claude worker not available (node or SDK missing)");
                None
            }
        }
    }

    async fn wait_for_log(
        state: &Arc<RwLock<RelayState>>,
        contains: &str,
        timeout_secs: u64,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            {
                let relay = state.read().await;
                let snapshot = relay.snapshot();
                for log in &snapshot.logs {
                    if log.message.contains(contains) {
                        return true;
                    }
                }
            }
            if tokio::time::Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn wait_for_threads_idle(
        state: &Arc<RwLock<RelayState>>,
        thread_ids: &[String],
        timeout_secs: u64,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            {
                let relay = state.read().await;
                let all_idle = thread_ids.iter().all(|thread_id| {
                    relay
                        .threads
                        .iter()
                        .find(|thread| thread.id == *thread_id)
                        .map(|thread| thread.status == "idle")
                        .unwrap_or(false)
                });
                if all_idle {
                    return true;
                }
            }
            if tokio::time::Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    async fn wait_for_thread_agent_text(
        bridge: &ClaudeCodeBridge,
        thread_id: &str,
        contains: &str,
        timeout_secs: u64,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            if let Ok(data) = bridge.read_thread(thread_id).await {
                let found = data.transcript.iter().any(|entry| {
                    entry.kind == TranscriptEntryKind::AgentText
                        && entry
                            .text
                            .as_deref()
                            .map(|text| text.contains(contains))
                            .unwrap_or(false)
                });
                if found {
                    return true;
                }
            }
            if tokio::time::Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    fn claude_auth_unavailable(snapshot: &crate::protocol::SessionSnapshot) -> bool {
        snapshot
            .logs
            .iter()
            .any(|log| log.message.contains("Not logged in"))
    }

    fn live_claude_e2e_enabled() -> bool {
        std::env::var("AGENT_RELAY_LIVE_CLAUDE_E2E")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }

    fn live_claude_e2e_timeout_secs(default_secs: u64) -> u64 {
        std::env::var("AGENT_RELAY_LIVE_CLAUDE_E2E_TIMEOUT_SECS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(default_secs)
    }

    async fn activate_test_thread(
        state: &Arc<RwLock<RelayState>>,
        thread: ThreadSummaryView,
        device_id: &str,
    ) {
        let cwd = if thread.cwd.is_empty() {
            "/tmp".to_string()
        } else {
            thread.cwd.clone()
        };
        let mut relay = state.write().await;
        relay.activate_thread(
            thread,
            &cwd,
            "claude-sonnet-4-6",
            "never",
            "workspace-write",
            "high",
            device_id,
        );
        relay.notify();
    }

    fn test_thread(id: &str, cwd: &str) -> ThreadSummaryView {
        ThreadSummaryView {
            id: id.to_string(),
            name: None,
            preview: String::new(),
            cwd: cwd.to_string(),
            updated_at: 1,
            source: "claude_code".to_string(),
            status: "idle".to_string(),
            model_provider: "anthropic".to_string(),
            provider: "claude_code".to_string(),
        }
    }

    async fn test_relay_with_active_b() -> Arc<RwLock<RelayState>> {
        let (tx, _) = tokio::sync::watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp/b".to_string(),
            tx,
            crate::state::SecurityProfile::private(),
        )));
        {
            let mut relay = state.write().await;
            relay.upsert_thread(test_thread("thread-a", "/tmp/a"));
            relay.activate_thread(
                test_thread("thread-b", "/tmp/b"),
                "/tmp/b",
                "sonnet",
                "default",
                "workspace-write",
                "medium",
                "device-1",
            );
        }
        state
    }

    // --- bridge <-> scripted fake worker integration (B-layer) ---------------
    //
    // These spawn the REAL ClaudeCodeBridge against fake-claude-worker.mjs (via
    // spawn_with_worker_path, no real SDK / API key). The fake echoes every
    // command it receives to stderr, which lands in relay logs — so we can pin
    // exactly what the bridge sent across settings changes. They need `node` on
    // PATH and skip gracefully otherwise.

    fn fake_worker_path() -> String {
        let crate_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace_root = crate_dir
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| ".".to_string());
        format!("{workspace_root}/claude-worker/fake-claude-worker.mjs")
    }

    // Faithful pending-promotion fake: unlike the dumb fake above it replays the
    // first user message asynchronously (after the start response), so it can
    // reproduce the timing window the remote "first message invisible" bug needs.
    fn pending_repro_worker_path() -> String {
        let crate_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace_root = crate_dir
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| ".".to_string());
        format!("{workspace_root}/claude-worker/fake-claude-worker-pending-repro.mjs")
    }

    async fn spawn_fake_bridge() -> Option<(ClaudeCodeBridge, Arc<RwLock<RelayState>>)> {
        let (tx, _) = tokio::sync::watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp".to_string(),
            tx,
            crate::state::SecurityProfile::private(),
        )));
        match ClaudeCodeBridge::spawn_with_worker_path(state.clone(), &fake_worker_path()).await {
            Ok(bridge) => Some((bridge, state)),
            Err(_) => {
                eprintln!("skipping bridge<->fake-worker test: node not available");
                None
            }
        }
    }

    #[tokio::test]
    async fn start_turn_sends_the_threads_current_permission_mode() {
        // This is the Rust-side guard for the YOLO-still-prompts bug: a turn must
        // carry the thread's *current* settings, freshly read, not a stale mode.
        let Some((bridge, state)) = spawn_fake_bridge().await else {
            return;
        };
        {
            let mut relay = state.write().await;
            relay.activate_thread(
                test_thread("sess-1", "/tmp/x"),
                "/tmp/x",
                "claude-sonnet-4-6",
                "bypass",
                "workspace-write",
                "high",
                "device-1",
            );
        }

        bridge
            .start_turn("sess-1", "hello", "claude-sonnet-4-6", "high")
            .await
            .expect("start_turn should send");
        assert!(
            wait_for_log(&state, "type=send permissionMode=bypassPermissions", 5).await,
            "first turn must reach the worker as bypassPermissions",
        );

        // The user flips the thread out of YOLO; the very next turn must carry the
        // new mode, proving settings are re-read per turn rather than cached.
        {
            let mut relay = state.write().await;
            relay.remember_thread_settings(
                "sess-1",
                "untrusted",
                "workspace-write",
                "high",
                "claude-sonnet-4-6",
            );
        }
        bridge
            .start_turn("sess-1", "again", "claude-sonnet-4-6", "high")
            .await
            .expect("second start_turn should send");
        assert!(
            wait_for_log(&state, "type=send permissionMode=default", 5).await,
            "after flipping to untrusted the next turn must reach the worker as default",
        );
    }

    #[tokio::test]
    async fn start_turn_immediately_records_the_user_message_for_existing_session() {
        let Some((bridge, state)) = spawn_fake_bridge().await else {
            return;
        };
        let prompt = "long Claude follow-up ".repeat(512);
        {
            let mut relay = state.write().await;
            relay.activate_thread(
                test_thread("sess-1", "/tmp/x"),
                "/tmp/x",
                "claude-sonnet-4-6",
                "default",
                "workspace-write",
                "high",
                "device-1",
            );
        }

        let turn_id = bridge
            .start_turn("sess-1", &prompt, "claude-sonnet-4-6", "high")
            .await
            .expect("start_turn should send")
            .expect("claude turn id");

        let snapshot = state.read().await.snapshot();
        let user_entry = snapshot
            .transcript
            .iter()
            .find(|entry| {
                entry.kind == TranscriptEntryKind::UserText
                    && entry.turn_id.as_deref() == Some(turn_id.as_str())
            })
            .expect("the user's message should be visible before worker replay events");
        assert_eq!(user_entry.text.as_deref(), Some(prompt.as_str()));
        assert_eq!(user_entry.status, "completed");
    }

    #[tokio::test]
    async fn resume_thread_sends_its_mapped_permission_mode() {
        let Some((bridge, state)) = spawn_fake_bridge().await else {
            return;
        };
        {
            let mut relay = state.write().await;
            relay.upsert_thread(test_thread("sess-7", "/tmp/y"));
        }

        bridge
            .resume_thread("sess-7", "bypass", "workspace-write")
            .await
            .expect("resume should succeed");
        assert!(
            wait_for_log(
                &state,
                "type=resume permissionMode=bypassPermissions model=- session=sess-7",
                5,
            )
            .await,
            "resume must map its policy to bypassPermissions for the right session",
        );
    }

    #[tokio::test]
    async fn deferred_start_promotes_with_its_permission_mode() {
        // A thread started without a prompt promotes on the first turn via a
        // `start` command — that command must carry the mode chosen at creation.
        let Some((bridge, state)) = spawn_fake_bridge().await else {
            return;
        };

        let result = bridge
            .start_thread(
                "/tmp/d",
                "claude-sonnet-4-6",
                "bypass",
                "workspace-write",
                None,
            )
            .await
            .expect("deferred start");
        let pending_id = result.thread.id.clone();
        assert!(
            pending_id.starts_with("claude-pending-"),
            "deferred start should yield a pending id, got {pending_id}",
        );

        bridge
            .start_turn(&pending_id, "first message", "claude-sonnet-4-6", "high")
            .await
            .expect("first turn promotes the thread");
        assert!(
            wait_for_log(&state, "type=start permissionMode=bypassPermissions", 5).await,
            "promotion `start` must carry the deferred thread's mode",
        );
        assert!(
            wait_for_log(&state, "prompt=yes", 5).await,
            "promotion `start` must include the first user message",
        );
    }

    #[tokio::test]
    async fn blank_new_claude_session_sends_its_first_message_through_appstate() {
        // Reproduces the browser flow for a "blank new session": the UI starts a
        // Claude thread with no initial prompt (deferred start -> pending id),
        // then the user types the first message into the composer and hits send,
        // which POSTs /api/session/message -> AppState::send_message. This must
        // route to the claude bridge by the active pending thread and succeed.
        use std::collections::HashMap;

        let (tx, _rx) = tokio::sync::watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            "/tmp".to_string(),
            tx.clone(),
            crate::state::SecurityProfile::private(),
        )));
        let bridge = match ClaudeCodeBridge::spawn_with_worker_path(
            relay.clone(),
            &pending_repro_worker_path(),
        )
        .await
        {
            Ok(bridge) => bridge,
            Err(_) => {
                eprintln!("skipping: claude worker not available (node missing)");
                return;
            }
        };
        let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> =
            HashMap::new();
        providers.insert("claude_code".to_string(), Arc::new(bridge));
        let app = crate::state::AppState::from_parts(relay.clone(), providers, tx);

        // 1. Blank new session: deferred start with no initial prompt.
        let start = app
            .start_session(crate::protocol::StartSessionInput {
                cwd: Some("/tmp".to_string()),
                initial_prompt: None,
                model: None,
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("claude_code".to_string()),
            })
            .await
            .expect("deferred start should succeed");
        let pending_id = start
            .active_thread_id
            .clone()
            .expect("a blank session must leave a pending active thread");
        assert!(
            pending_id.starts_with("claude-pending-"),
            "blank start should yield a pending id, got {pending_id}",
        );

        // Regression: the blank conversation must show up in the thread list even
        // though the claude bridge can't list a not-yet-promoted pending session
        // (the fake worker returns no sessions). Without preserving the active
        // thread, `list_threads` would overwrite it away and the new session would
        // "never appear" in the sidebar.
        let listed = app
            .list_threads(50, Some("device-1".to_string()))
            .await
            .expect("list_threads should succeed");
        assert!(
            listed.threads.iter().any(|thread| thread.id == pending_id),
            "blank/pending claude session must remain in the thread list, got {:?}",
            listed
                .threads
                .iter()
                .map(|thread| thread.id.as_str())
                .collect::<Vec<_>>(),
        );

        // Open another blank thread first so the original pending thread is no
        // longer the relay's live projection. Its first send must still promote
        // and focus the correct real Claude session.
        let second = app
            .start_session(crate::protocol::StartSessionInput {
                cwd: Some("/tmp".to_string()),
                initial_prompt: None,
                model: None,
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("claude_code".to_string()),
            })
            .await
            .expect("second deferred start should succeed");
        let second_pending_id = second
            .active_thread_id
            .expect("second blank session must become live");

        // 2. Type the first message into the original blank composer and send it.
        let result = app
            .send_message(crate::protocol::SendMessageInput {
                text: "first message".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: pending_id.clone(),
            })
            .await
            .expect("sending the first message to a background blank session should succeed");

        let promoted_id = result
            .active_thread_id
            .expect("targeted send should focus the promoted real session");
        assert_ne!(promoted_id, second_pending_id);
        assert_ne!(promoted_id, pending_id);
        assert!(
            result
                .transcript
                .iter()
                .any(|entry| entry.text.as_deref() == Some("first message")),
            "the focused promoted session must contain the targeted first message"
        );
    }

    // ----------------------------------------------------------------------
    // Regression for the Claude remote "first message invisible until refresh"
    // bug. See CLAUDE_REMOTE_PENDING_MESSAGE_VISIBILITY.md. The pending path now
    // records the first user message synchronously (like an existing-session
    // send), so it is in the very first snapshot rather than only arriving via
    // the worker's async replay. The faithful fake worker still replays the
    // message afterwards, which lets us prove the live record and the replay
    // collapse to ONE idempotent entry.
    // ----------------------------------------------------------------------

    /// The pending first message is projected the instant `send_message`
    /// returns — and the worker's later `user_message` replay does not duplicate
    /// it, because both carry the relay-minted ids.
    #[tokio::test]
    async fn pending_first_message_is_recorded_synchronously_without_duplicate() {
        use std::collections::HashMap;

        let (tx, _rx) = tokio::sync::watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            "/tmp".to_string(),
            tx.clone(),
            crate::state::SecurityProfile::private(),
        )));
        let bridge = match ClaudeCodeBridge::spawn_with_worker_path(
            relay.clone(),
            &pending_repro_worker_path(),
        )
        .await
        {
            Ok(bridge) => bridge,
            Err(_) => {
                eprintln!("skipping: claude worker not available (node missing)");
                return;
            }
        };
        let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> =
            HashMap::new();
        providers.insert("claude_code".to_string(), Arc::new(bridge));
        let app = crate::state::AppState::from_parts(relay.clone(), providers, tx);

        // Blank new session -> pending id (no initial prompt).
        let start = app
            .start_session(crate::protocol::StartSessionInput {
                cwd: Some("/tmp".to_string()),
                initial_prompt: None,
                model: None,
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("claude_code".to_string()),
            })
            .await
            .expect("deferred start should succeed");
        let pending_id = start
            .active_thread_id
            .clone()
            .expect("a blank session must leave a pending active thread");
        assert!(
            pending_id.starts_with("claude-pending-"),
            "blank start should yield a pending id, got {pending_id}",
        );

        // The user types a LONG first message (their empirical trigger) and sends.
        let first_message = "This is the user's first long message. ".repeat(64);
        assert!(first_message.chars().count() > 1_200);
        app.send_message(crate::protocol::SendMessageInput {
            text: first_message.clone(),
            model: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            thread_id: pending_id.clone(),
        })
        .await
        .expect("sending the first message should succeed");

        // FIXED: the very first snapshot after send already carries the user's
        // message — no waiting on the worker's async replay, no refresh.
        let immediate = relay.read().await.snapshot();
        let immediate_match = immediate.transcript.iter().find(|entry| {
            entry.kind == TranscriptEntryKind::UserText
                && entry.text.as_deref().map(str::trim) == Some(first_message.trim())
        });
        let immediate_turn_id = immediate_match
            .expect(
                "REGRESSION: the pending first message must be projected \
                 synchronously, in the snapshot available the moment send returns",
            )
            .turn_id
            .clone();

        // It carries the relay-minted turn id (claude-turn-N), matching the
        // active turn — not the worker's own replay id. (Fixes the divergence
        // the investigation flagged as doc finding #2.)
        assert!(
            immediate_turn_id
                .as_deref()
                .is_some_and(|id| id.starts_with("claude-turn-")),
            "the projected message must carry the relay turn id, got {immediate_turn_id:?}",
        );

        // Let the worker's async `user_message` replay land, then prove it did
        // NOT create a second copy: same ids in -> one idempotent entry.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let after_replay = relay.read().await.snapshot();
        let user_entries = after_replay
            .transcript
            .iter()
            .filter(|entry| {
                entry.kind == TranscriptEntryKind::UserText
                    && entry.text.as_deref().map(str::trim) == Some(first_message.trim())
            })
            .count();
        assert_eq!(
            user_entries, 1,
            "the worker's replay must upsert onto the live entry, not duplicate it",
        );
    }

    fn relay_with_active_thread() -> RelayState {
        let (tx, _rx) = tokio::sync::watch::channel(0_u64);
        let mut relay = RelayState::new(
            "/tmp".to_string(),
            tx,
            crate::state::SecurityProfile::private(),
        );
        relay.activate_thread(
            test_thread("sess-1", "/tmp"),
            "/tmp",
            "claude-sonnet-4-6",
            "default",
            "workspace-write",
            "high",
            "device-1",
        );
        relay
    }

    /// The length amplifier, fixed: a long user message used to be clipped to a
    /// 1200-char "…"-preview in the remote snapshot (so it depended on a
    /// follow-up hydration fetch, the second leg of the disappearance). Now the
    /// remote-surface compaction ships the user's own text in full, so the phone
    /// shows it straight from the snapshot — short OR long.
    #[tokio::test]
    async fn remote_surface_keeps_user_message_text_in_full() {
        let mut relay = relay_with_active_thread();

        let short_message = "hi there, one quick question about the build".to_string();
        // Well over the old 1200-char per-entry cap, but small enough that the
        // whole snapshot still fits the remote byte budget.
        let long_message = "word ".repeat(400); // 2000 chars
        assert!(short_message.chars().count() < 1_200);
        assert!(long_message.chars().count() > 1_200);

        relay.upsert_user_message(
            "user:short".to_string(),
            short_message.clone(),
            "turn-short".to_string(),
        );
        relay.upsert_user_message(
            "user:long".to_string(),
            long_message.clone(),
            "turn-long".to_string(),
        );

        let remote = relay
            .snapshot()
            .compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface);

        let short_entry = remote
            .transcript
            .iter()
            .find(|entry| entry.item_id.as_deref() == Some("user:short"))
            .expect("short entry present");
        let long_entry = remote
            .transcript
            .iter()
            .find(|entry| entry.item_id.as_deref() == Some("user:long"))
            .expect("long entry present");

        assert_eq!(
            short_entry.text.as_deref(),
            Some(short_message.as_str()),
            "short user message must reach the remote surface intact",
        );
        assert_eq!(
            long_entry.text.as_deref(),
            Some(long_message.as_str()),
            "FIX: a long user message must now reach the remote surface in full, \
             not as a clipped preview",
        );
        assert!(
            !remote.transcript_truncated,
            "with only (full) user messages the remote snapshot is not truncated, \
             so the phone needs no hydration to show them",
        );
    }

    /// Backstop: the byte-budget pass still bounds a pathologically large user
    /// message, so exempting user text from the per-entry cap can't blow the
    /// remote frame. Such a giant message clips and flags the snapshot truncated
    /// (the phone then hydrates the rest) — the honesty invariant holds.
    #[tokio::test]
    async fn remote_surface_still_bounds_a_pathologically_long_user_message() {
        let mut relay = relay_with_active_thread();

        let giant_message = "word ".repeat(8_000); // 40k chars, far over the byte budget
        relay.upsert_user_message(
            "user:giant".to_string(),
            giant_message.clone(),
            "turn-giant".to_string(),
        );

        let remote = relay
            .snapshot()
            .compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface);
        let giant_entry = remote
            .transcript
            .iter()
            .find(|entry| entry.item_id.as_deref() == Some("user:giant"))
            .expect("giant entry present");

        assert!(
            giant_entry.text.as_deref().map(str::len).unwrap_or(0) < giant_message.len(),
            "an over-budget user message must still be clipped by the byte-budget backstop",
        );
        assert!(
            remote.transcript_truncated,
            "clipping the giant message must flag the snapshot truncated so the \
             phone hydrates the remainder",
        );
    }

    #[tokio::test]
    async fn start_thread_with_prompt_sends_start_and_returns_a_thread() {
        let Some((bridge, state)) = spawn_fake_bridge().await else {
            return;
        };

        let result = bridge
            .start_thread(
                "/tmp/z",
                "claude-sonnet-4-6",
                "bypass",
                "workspace-write",
                Some("hi there"),
            )
            .await
            .expect("start_thread with prompt");
        assert!(!result.thread.id.is_empty());
        assert!(
            wait_for_log(&state, "type=start permissionMode=bypassPermissions", 5).await,
            "an immediate start must reach the worker as a `start` with the mapped mode",
        );
    }

    #[tokio::test]
    async fn background_claude_assistant_delta_does_not_mutate_active_transcript() {
        let state = test_relay_with_active_b().await;

        handle_worker_event(
            json!({
                "type": "assistant_delta",
                "provider_session_id": "thread-a",
                "item_id": "assistant-a",
                "turn_id": "turn-a",
                "text": "background text",
                "status": "streaming"
            }),
            &state,
        )
        .await;

        let snapshot = state.read().await.snapshot();
        assert_eq!(snapshot.active_thread_id.as_deref(), Some("thread-b"));
        assert!(
            snapshot.transcript.is_empty(),
            "active thread should not receive background Claude text: {:?}",
            snapshot.transcript
        );
    }

    #[tokio::test]
    async fn background_claude_progress_tick_refreshes_its_own_turn_liveness() {
        let state = test_relay_with_active_b().await;
        {
            let mut relay = state.write().await;
            relay.bg_set_active_turn("thread-a", Some("turn-a".to_string()), 100);
            let runtime = relay
                .runtime_for_thread("thread-a")
                .cloned()
                .expect("background runtime");
            assert_eq!(runtime.last_progress_at, Some(100));
            relay.expire_stale_turn_liveness(100 + crate::state::STALE_TURN_PROGRESS_TIMEOUT_SECS);
            assert!(
                relay
                    .runtime_for_thread("thread-a")
                    .is_some_and(|runtime| runtime.liveness_timed_out),
                "precondition: background turn is timed out"
            );
        }

        handle_worker_event(
            json!({
                "type": "progress_tick",
                "provider_session_id": "thread-a",
                "phase": "tool",
                "tool": "Bash"
            }),
            &state,
        )
        .await;

        let relay = state.read().await;
        let background = relay
            .runtime_for_thread("thread-a")
            .expect("background runtime");
        assert!(!background.liveness_timed_out);
        assert_eq!(background.current_phase.as_deref(), Some("tool"));
        assert_eq!(background.current_tool.as_deref(), Some("Bash"));
        assert_eq!(
            relay.active_thread_id.as_deref(),
            Some("thread-b"),
            "background heartbeat must not steal focus"
        );
        assert_eq!(relay.current_phase, None);
        assert_eq!(relay.current_tool, None);
    }

    #[tokio::test]
    async fn background_claude_session_started_does_not_steal_active_provider() {
        let (tx, _) = tokio::sync::watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp/codex".to_string(),
            tx,
            crate::state::SecurityProfile::private(),
        )));
        {
            let mut relay = state.write().await;
            relay.set_provider_name("codex".to_string());
            relay.activate_thread(
                ThreadSummaryView {
                    id: "codex-thread".to_string(),
                    name: None,
                    preview: String::new(),
                    cwd: "/tmp/codex".to_string(),
                    updated_at: 1,
                    source: "codex".to_string(),
                    status: "active".to_string(),
                    model_provider: "codex".to_string(),
                    provider: "codex".to_string(),
                },
                "/tmp/codex",
                "gpt-5.5",
                "default",
                "workspace-write",
                "medium",
                "device-1",
            );
        }

        handle_worker_event(
            json!({
                "type": "session_started",
                "provider_session_id": "claude-thread",
                "cwd": "/tmp/claude"
            }),
            &state,
        )
        .await;

        let snapshot = state.read().await.snapshot();
        assert_eq!(snapshot.provider, "codex");
        assert_eq!(snapshot.active_thread_id.as_deref(), Some("codex-thread"));
    }

    #[tokio::test]
    async fn background_claude_approval_keeps_thread_id() {
        let state = test_relay_with_active_b().await;

        handle_worker_event(
            json!({
                "type": "approval_requested",
                "provider_session_id": "thread-a",
                "id": "approval-a",
                "tool_name": "Bash",
                "action": "Run command",
                "input": {"command": "echo hi"}
            }),
            &state,
        )
        .await;

        let snapshot = state.read().await.snapshot();
        assert_eq!(snapshot.active_thread_id.as_deref(), Some("thread-b"));
        assert_eq!(snapshot.current_status, "idle");
        assert_eq!(snapshot.pending_approvals.len(), 1);
        let relay = state.read().await;
        let pending = relay
            .pending_approvals
            .get("approval-a")
            .expect("approval should be stored");
        assert_eq!(pending.thread_id, "thread-a");
    }

    #[test]
    fn never_policy_accepts_edits_instead_of_auto_denying() {
        assert_eq!(
            claude_permission_mode("never", "workspace-write"),
            "acceptEdits"
        );
    }

    #[test]
    fn interactive_policies_use_default_claude_permissions() {
        assert_eq!(
            claude_permission_mode("on-request", "workspace-write"),
            "default"
        );
        assert_eq!(
            claude_permission_mode("on-failure", "workspace-write"),
            "default"
        );
    }

    #[test]
    fn review_read_only_policy_maps_to_the_reviewer_sentinel() {
        // The reviewer thread runs read-only; the worker translates this sentinel to
        // bypassPermissions + a write-tool denylist so the non-interactive review can
        // inspect freely without prompting and still can't edit.
        assert_eq!(
            claude_permission_mode("review_read_only", "workspace-write"),
            "reviewer-read-only"
        );
    }

    #[test]
    fn bypass_policy_maps_to_bypass_permissions() {
        // The unified "Full access" UI option must reach the SDK as
        // `bypassPermissions` so Bash and every other tool runs without a
        // prompt. Sandbox is ignored in this mode.
        assert_eq!(
            claude_permission_mode("bypass", "workspace-write"),
            "bypassPermissions"
        );
        assert_eq!(
            claude_permission_mode("bypass", "danger-full-access"),
            "bypassPermissions"
        );
    }

    fn new_test_state() -> Arc<RwLock<RelayState>> {
        let (tx, _) = tokio::sync::watch::channel(0);
        Arc::new(RwLock::new(RelayState::new(
            "/tmp".to_string(),
            tx,
            crate::state::SecurityProfile::private(),
        )))
    }

    #[tokio::test]
    async fn progress_tick_sets_phase_and_tool_and_last_progress_at() {
        let state = new_test_state();
        handle_worker_event(
            json!({ "type": "progress_tick", "phase": "tool", "tool": "Bash" }),
            &state,
        )
        .await;

        let relay = state.read().await;
        assert_eq!(relay.current_phase.as_deref(), Some("tool"));
        assert_eq!(relay.current_tool.as_deref(), Some("Bash"));
        assert!(relay.last_progress_at.is_some());
    }

    #[tokio::test]
    async fn done_event_clears_progress_fields() {
        let state = new_test_state();
        handle_worker_event(
            json!({ "type": "progress_tick", "phase": "thinking" }),
            &state,
        )
        .await;
        assert!(state.read().await.last_progress_at.is_some());

        handle_worker_event(json!({ "type": "done" }), &state).await;
        let relay = state.read().await;
        assert_eq!(relay.current_phase, None);
        assert_eq!(relay.current_tool, None);
        assert_eq!(relay.last_progress_at, None);
    }

    #[tokio::test]
    async fn session_stopped_event_is_the_authoritative_cancel_completion() {
        let state = new_test_state();
        {
            let mut relay = state.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some("claude-thread".to_string());
            relay.active_turn_id = Some("claude-turn".to_string());
            relay.current_status = "active".to_string();
        }

        handle_worker_event(
            json!({
                "type": "session_stopped",
                "provider_session_id": "claude-thread",
                "turn_id": "claude-turn"
            }),
            &state,
        )
        .await;

        let relay = state.read().await;
        assert_eq!(relay.active_turn_id, None);
        assert_eq!(relay.current_status, "idle");
        assert!(relay
            .snapshot()
            .logs
            .iter()
            .any(|entry| entry.message == "Claude session stopped."));
    }

    #[tokio::test]
    async fn stale_completion_cannot_clear_a_newer_claude_turn() {
        let state = new_test_state();
        {
            let mut relay = state.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some("claude-thread".to_string());
            relay.set_active_turn(Some("turn-new".to_string()));
            relay.set_thread_status("claude-thread", "active".to_string(), Vec::new());
        }

        handle_worker_event(
            json!({
                "type": "done",
                "provider_session_id": "claude-thread",
                "turn_id": "turn-old"
            }),
            &state,
        )
        .await;
        assert_eq!(
            state.read().await.active_turn_id.as_deref(),
            Some("turn-new")
        );

        handle_worker_event(
            json!({
                "type": "done",
                "provider_session_id": "claude-thread",
                "turn_id": "turn-new"
            }),
            &state,
        )
        .await;
        assert_eq!(state.read().await.active_turn_id, None);
    }

    #[tokio::test]
    async fn completion_without_turn_id_cannot_clear_an_active_claude_turn() {
        let state = new_test_state();
        {
            let mut relay = state.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some("claude-thread".to_string());
            relay.set_active_turn(Some("turn-active".to_string()));
            relay.set_thread_status("claude-thread", "active".to_string(), Vec::new());
        }

        handle_worker_event(
            json!({
                "type": "done",
                "provider_session_id": "claude-thread"
            }),
            &state,
        )
        .await;

        let relay = state.read().await;
        assert_eq!(relay.active_turn_id.as_deref(), Some("turn-active"));
        assert_eq!(relay.current_status, "active");
    }

    #[tokio::test]
    async fn failed_done_records_a_transcript_failure_visible_in_broker_snapshot() {
        // A failed turn must terminate (never hang) AND remain visibly a failure
        // on remote/mobile surfaces. Operator-only logs are stripped from
        // broker-bound snapshots, so the failure has to live in the TRANSCRIPT.
        let state = new_test_state();
        {
            let mut relay = state.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some("claude-thread".to_string());
            relay.set_active_turn(Some("turn-1".to_string()));
            relay.set_thread_status("claude-thread", "active".to_string(), Vec::new());
        }

        handle_worker_event(
            json!({
                "type": "done",
                "provider_session_id": "claude-thread",
                "turn_id": "turn-1",
                "failed": true,
                "reason": "Claude turn failed: error_during_execution"
            }),
            &state,
        )
        .await;

        let relay = state.read().await;
        // Terminates.
        assert_eq!(relay.active_turn_id, None);
        // Survives broker compaction and is unmistakably a failure.
        let remote = relay
            .snapshot()
            .compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface);
        let failure = remote
            .transcript
            .iter()
            .find(|entry| entry.kind == TranscriptEntryKind::Error)
            .expect("a failed turn must leave an Error entry in the broker snapshot");
        assert_eq!(failure.status, "failed");
        assert_eq!(failure.turn_id.as_deref(), Some("turn-1"));
        assert!(failure
            .text
            .as_deref()
            .unwrap_or_default()
            .contains("error_during_execution"));
    }

    #[tokio::test]
    async fn failed_background_done_surfaces_failure_after_switching_back() {
        // A turn that fails while its thread is in the BACKGROUND must still
        // surface the failure when the user later switches back to that thread.
        let state = new_test_state();
        let now = crate::state::unix_now();
        {
            let mut relay = state.write().await;
            relay.set_provider_name("claude_code".to_string());
            // A different thread is active; the failing turn runs in the background.
            relay.active_thread_id = Some("active-thread".to_string());
            relay.bg_set_active_turn("bg-thread", Some("turn-bg".to_string()), now);
        }

        handle_worker_event(
            json!({
                "type": "done",
                "provider_session_id": "bg-thread",
                "turn_id": "turn-bg",
                "failed": true,
                "reason": "Claude turn failed: error_max_turns"
            }),
            &state,
        )
        .await;

        // While a different thread is active, the failure is not in view.
        {
            let relay = state.read().await;
            let remote = relay
                .snapshot()
                .compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface);
            assert!(
                !remote
                    .transcript
                    .iter()
                    .any(|entry| entry.kind == TranscriptEntryKind::Error),
                "the background failure must not leak onto the active thread"
            );
        }

        // Switch back to the failed background thread.
        {
            let mut relay = state.write().await;
            relay.active_thread_id = Some("bg-thread".to_string());
            relay.sync_selected_runtime_to_fields();
        }

        let relay = state.read().await;
        let remote = relay
            .snapshot()
            .compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface);
        assert!(
            remote.transcript.iter().any(|entry| {
                entry.kind == TranscriptEntryKind::Error
                    && entry.status == "failed"
                    && entry
                        .text
                        .as_deref()
                        .unwrap_or_default()
                        .contains("error_max_turns")
            }),
            "switching back to the failed background thread must show the failure"
        );
    }

    #[tokio::test]
    async fn clean_done_records_no_failure_entry() {
        // A clean completion must NOT fabricate a failure entry.
        let state = new_test_state();
        {
            let mut relay = state.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some("claude-thread".to_string());
            relay.set_active_turn(Some("turn-ok".to_string()));
            relay.set_thread_status("claude-thread", "active".to_string(), Vec::new());
        }

        handle_worker_event(
            json!({
                "type": "done",
                "provider_session_id": "claude-thread",
                "turn_id": "turn-ok"
            }),
            &state,
        )
        .await;

        let relay = state.read().await;
        assert_eq!(relay.active_turn_id, None);
        assert!(
            !relay
                .snapshot()
                .transcript
                .iter()
                .any(|entry| entry.kind == TranscriptEntryKind::Error),
            "a clean done must not create an Error entry"
        );
    }

    #[tokio::test]
    async fn tool_call_requested_marks_phase_and_records_tool() {
        let state = new_test_state();
        handle_worker_event(
            json!({
                "type": "tool_call_requested",
                "id": "t1",
                "name": "Read",
                "args": {}
            }),
            &state,
        )
        .await;

        let relay = state.read().await;
        assert_eq!(relay.current_phase.as_deref(), Some("tool"));
        assert_eq!(relay.current_tool.as_deref(), Some("Read"));
        assert!(relay.last_progress_at.is_some());
    }

    #[tokio::test]
    async fn session_started_keeps_model_matched_to_catalog() {
        let state = new_test_state();
        {
            let mut relay = state.write().await;
            // Catalog exposes a stable "default" alias (shown in the picker as
            // "Default (recommended, Opus 4.8)") alongside concrete ids.
            relay.set_available_models(vec![
                ModelOptionView {
                    model: "default".to_string(),
                    display_name: "Default (recommended, Opus 4.8)".to_string(),
                    provider: "anthropic".to_string(),
                    supported_reasoning_efforts: vec!["high".to_string(), "max".to_string()],
                    default_reasoning_effort: "high".to_string(),
                    hidden: false,
                    is_default: true,
                },
                ModelOptionView {
                    model: "claude-sonnet-4-6".to_string(),
                    display_name: "Sonnet 4.6".to_string(),
                    provider: "anthropic".to_string(),
                    supported_reasoning_efforts: vec!["high".to_string()],
                    default_reasoning_effort: "high".to_string(),
                    hidden: false,
                    is_default: false,
                },
            ]);
            // User is on the default alias — a catalog value the picker matches.
            relay.model = "default".to_string();
            relay.active_thread_id = Some("sid-1".to_string());
        }

        // SDK init reports the concrete resolved model, which is NOT a catalog
        // value (the catalog exposes it via the "default" alias instead).
        handle_worker_event(
            json!({ "type": "session_started", "model": "claude-opus-4-8" }),
            &state,
        )
        .await;

        let relay = state.read().await;
        // session.model must stay matchable so the model picker doesn't sprout
        // a duplicate "ghost" row for the concrete id.
        assert!(
            relay
                .available_models
                .iter()
                .any(|option| option.model == relay.model),
            "session model {:?} should match a catalog option, catalog = {:?}",
            relay.model,
            relay
                .available_models
                .iter()
                .map(|option| option.model.clone())
                .collect::<Vec<_>>(),
        );
        crate::state::assert_settings_invariants(&relay.snapshot(), "after session_started");
    }

    #[test]
    fn provider_name_is_claude_code() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let bridge = rt.block_on(async {
            let (tx, _) = tokio::sync::watch::channel(0);
            let state = Arc::new(RwLock::new(RelayState::new(
                "/tmp".to_string(),
                tx,
                crate::state::SecurityProfile::private(),
            )));
            ClaudeCodeBridge::spawn(state).await
        });
        if let Ok(b) = bridge {
            assert_eq!(b.provider_name(), "claude_code");
        }
    }

    #[tokio::test]
    async fn e2e_simple_prompt() {
        if !live_claude_e2e_enabled() {
            eprintln!("skipping live Claude e2e; set AGENT_RELAY_LIVE_CLAUDE_E2E=1 to run");
            return;
        }
        let Some((bridge, state)) = spawn_or_skip().await else {
            return;
        };

        // Send a start command with a simple prompt
        bridge
            .send_command(json!({
                "type": "start",
                "cwd": "/tmp",
                "model": "claude-sonnet-4-6",
                "prompt": "say hello"
            }))
            .await
            .expect("send_command should succeed");

        // Wait for the worker to process and emit done
        let done = wait_for_log(&state, "Claude turn completed", 30).await;

        // Debug: dump all logs to understand what happened
        let relay = state.read().await;
        let snap = relay.snapshot();
        eprintln!("=== all logs ({} total) ===", snap.logs.len());
        for log in &snap.logs {
            eprintln!("  [{}] {}", log.kind, log.message);
        }
        eprintln!("=== active_thread_id: {:?} ===", relay.active_thread_id);

        assert!(done, "expected 'Claude turn completed' log within 30s");
        if claude_auth_unavailable(&snap) {
            eprintln!("skipping live Claude assertions: Claude is not logged in");
            return;
        }

        // Verify we have agent logs (assistant_delta events)
        let agent_logs: Vec<_> = snap.logs.iter().filter(|l| l.kind == "agent").collect();
        assert!(
            !agent_logs.is_empty(),
            "should have at least one agent log from assistant_delta"
        );
    }

    #[tokio::test]
    async fn e2e_multi_turn() {
        if !live_claude_e2e_enabled() {
            eprintln!("skipping live Claude e2e; set AGENT_RELAY_LIVE_CLAUDE_E2E=1 to run");
            return;
        }
        let Some((bridge, state)) = spawn_or_skip().await else {
            return;
        };

        // Turn 1: start session with a prompt
        bridge
            .send_command(json!({
                "type": "start",
                "prompt": "reply with just the number 1"
            }))
            .await
            .expect("turn 1 send should succeed");

        let done1 = wait_for_log(&state, "Claude turn completed", 30).await;
        assert!(done1, "turn 1 should complete");

        // Brief pause to let worker loop settle
        tokio::time::sleep(Duration::from_millis(500)).await;

        // Turn 2: same session
        bridge
            .send_command(json!({
                "type": "send",
                "prompt": "multiply that number by 2, reply with just the result"
            }))
            .await
            .expect("turn 2 send should succeed");

        let done2 = wait_for_log(&state, "Claude turn completed", 30).await;

        let relay = state.read().await;
        let snap = relay.snapshot();
        eprintln!("=== multi-turn logs ({} total) ===", snap.logs.len());
        for log in &snap.logs {
            eprintln!("  [{}] {}", log.kind, log.message);
        }

        if claude_auth_unavailable(&snap) {
            eprintln!("skipping live Claude assertions: Claude is not logged in");
            return;
        }

        assert!(done2, "turn 2 should complete");

        let worker_logs: Vec<_> = snap
            .logs
            .iter()
            .filter(|l| l.kind == "claude_worker")
            .map(|l| &l.message)
            .collect();
        eprintln!("worker stderr logs: {:?}", worker_logs);

        let agent_logs: Vec<_> = snap
            .logs
            .iter()
            .filter(|l| l.kind == "agent")
            .map(|l| &l.message)
            .collect();
        assert!(
            agent_logs.len() >= 2,
            "should have at least 2 agent responses"
        );
    }

    #[tokio::test]
    async fn e2e_concurrent_long_outputs_complete_without_pending_requests() {
        if !live_claude_e2e_enabled() {
            eprintln!("skipping live Claude e2e; set AGENT_RELAY_LIVE_CLAUDE_E2E=1 to run");
            return;
        }
        let Some((bridge, state)) = spawn_or_skip().await else {
            return;
        };

        let prompt_a = "Do not use tools or commands. Write exactly 160 numbered lines. Every line must contain AGENT_RELAY_CONCURRENCY_A and its line number. No markdown, no summary.";
        let start_a = match bridge
            .start_thread(
                "/tmp",
                "claude-sonnet-4-6",
                "never",
                "workspace-write",
                Some(prompt_a),
            )
            .await
        {
            Ok(result) => result,
            Err(error) if error.to_ascii_lowercase().contains("not logged in") => {
                eprintln!("skipping live Claude concurrency e2e: Claude is not logged in");
                return;
            }
            Err(error) => panic!("failed to start concurrent Claude thread A: {error}"),
        };
        let thread_a = start_a.thread.clone();
        activate_test_thread(&state, thread_a.clone(), "device-a").await;

        let prompt_b = "Do not use tools or commands. Write exactly 160 numbered lines. Every line must contain AGENT_RELAY_CONCURRENCY_B and its line number. No markdown, no summary.";
        let start_b = match bridge
            .start_thread(
                "/tmp",
                "claude-sonnet-4-6",
                "never",
                "workspace-write",
                Some(prompt_b),
            )
            .await
        {
            Ok(result) => result,
            Err(error) if error.to_ascii_lowercase().contains("not logged in") => {
                eprintln!("skipping live Claude concurrency e2e: Claude is not logged in");
                return;
            }
            Err(error) => panic!("failed to start concurrent Claude thread B: {error}"),
        };
        let thread_b = start_b.thread.clone();
        activate_test_thread(&state, thread_b.clone(), "device-a").await;

        {
            let relay = state.read().await;
            let snapshot = relay.snapshot();
            if claude_auth_unavailable(&snapshot) {
                eprintln!("skipping live Claude concurrency e2e: Claude is not logged in");
                return;
            }
            assert!(
                snapshot.pending_approvals.is_empty(),
                "concurrency prompt should not create approval requests: {:?}",
                snapshot.pending_approvals
            );
            assert!(
                snapshot.pending_ask_user_questions.is_empty(),
                "concurrency prompt should not create AskUserQuestion requests: {:?}",
                snapshot.pending_ask_user_questions
            );
        }

        let timeout_secs = live_claude_e2e_timeout_secs(120);
        let both_idle = wait_for_threads_idle(
            &state,
            &[thread_a.id.clone(), thread_b.id.clone()],
            timeout_secs,
        )
        .await;
        {
            let relay = state.read().await;
            let snapshot = relay.snapshot();
            if claude_auth_unavailable(&snapshot) {
                eprintln!("skipping live Claude concurrency e2e: Claude is not logged in");
                return;
            }
            assert!(
                both_idle,
                "both concurrent Claude threads should reach idle within {timeout_secs}s; statuses = {:?}; logs = {:?}",
                relay
                    .threads
                    .iter()
                    .filter(|thread| thread.id == thread_a.id || thread.id == thread_b.id)
                    .map(|thread| (thread.id.clone(), thread.status.clone()))
                    .collect::<Vec<_>>(),
                snapshot.logs
            );
            assert!(
                snapshot.pending_approvals.is_empty(),
                "no approval requests should remain after concurrent text-only turns"
            );
            assert!(
                snapshot.pending_ask_user_questions.is_empty(),
                "no AskUserQuestion requests should remain after concurrent text-only turns"
            );
        }

        assert!(
            wait_for_thread_agent_text(&bridge, &thread_a.id, "AGENT_RELAY_CONCURRENCY_A", 20)
                .await,
            "thread A should persist an assistant response with its marker"
        );
        assert!(
            wait_for_thread_agent_text(&bridge, &thread_b.id, "AGENT_RELAY_CONCURRENCY_B", 20)
                .await,
            "thread B should persist an assistant response with its marker"
        );
    }

    #[tokio::test]
    async fn e2e_cancel_sends_interrupt() {
        if !live_claude_e2e_enabled() {
            eprintln!("skipping live Claude e2e; set AGENT_RELAY_LIVE_CLAUDE_E2E=1 to run");
            return;
        }
        let Some((bridge, state)) = spawn_or_skip().await else {
            return;
        };

        // Start a session without a prompt (just creates the session)
        bridge
            .send_command(json!({
                "type": "start",
                "cwd": "/tmp",
                "model": "claude-sonnet-4-6"
            }))
            .await
            .expect("start should succeed");

        // Send a cancel command
        bridge
            .send_command(json!({"type": "cancel"}))
            .await
            .expect("cancel should succeed");

        // A successful cancel reports the distinct stopped lifecycle event.
        let _stopped = wait_for_log(&state, "Claude session stopped", 5).await;
        // The live provider may have no promoted session yet; just verify no crash.
        let relay = state.read().await;
        let snap = relay.snapshot();
        assert!(!snap
            .logs
            .iter()
            .any(|l| l.kind == "error" && l.message.contains("crash")));
    }
}
