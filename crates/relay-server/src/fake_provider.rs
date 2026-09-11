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
        ApprovalDecision, ApprovalDecisionInput, AskUserOptionView, AskUserQuestionView,
        ModelOptionView, ThreadSummaryView, ToolCallView, TranscriptEntryKind, TranscriptEntryView,
    },
    provider::{
        ProviderBridge, ProviderImage, StartThreadRequest, StartThreadResult, ThreadSyncData,
    },
    state::{
        ApprovalKind, BrokerPendingMessage, PendingApproval, PendingAskUserQuestion,
        PendingTranscriptDelta, RelayState, TranscriptDeltaKind,
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
    /// Ordered fallbacks for prompts that CANNOT be matched exactly.
    ///
    /// Exact keying works only while a caller controls the whole prompt. Anything
    /// the relay composes — a workspace diff, a provisioned worktree path, a
    /// generated sub-task id — makes the prompt unknowable in advance, and those
    /// are exactly the flows worth driving end to end. First matcher whose every
    /// `contains` substring is present wins, so order them most specific first.
    #[serde(default)]
    matchers: Vec<FakeScenarioMatcher>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct FakeScenarioMatcher {
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    scenario: FakeTurnScenario,
}

/// Either shape a scenario may use for `ask_user`.
///
/// Untagged so the two e2e suites that arrived at this feature independently keep
/// their own wire spelling: `true` for "just ask something", an object when the
/// test asserts on the question itself.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum FakeAskUserSpec {
    Enabled(bool),
    Detailed(FakeAskUser),
}

impl FakeAskUserSpec {
    fn is_enabled(&self) -> bool {
        !matches!(self, Self::Enabled(false))
    }

    fn detail(&self) -> Option<&FakeAskUser> {
        match self {
            Self::Detailed(detail) => Some(detail),
            Self::Enabled(_) => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct FakeAskUser {
    question: String,
    #[serde(default)]
    header: String,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    multi_select: bool,
    /// Questions after the first. One question is the one-tap quick path; two or
    /// more is the wizard (pick, Continue, Send), which is a different UI.
    #[serde(default)]
    more: Vec<FakeAskUser>,
}

#[derive(Clone, Debug, Deserialize)]
struct FakeFileWrite {
    path: String,
    #[serde(default)]
    contents: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct FakeTurnScenario {
    reply: Option<String>,
    chunks: Option<Vec<String>>,
    chunk_delay_ms: Option<u64>,
    /// Number of fake Bash tool calls to emit, one at a time, before the
    /// assistant text begins. Each call is first inserted as `running`, then
    /// patched to `completed` after `tool_call_delay_ms`.
    #[serde(default)]
    tool_calls: usize,
    tool_call_delay_ms: Option<u64>,
    /// Kind the fake `tool_calls` are emitted as. `tool_call` (default) mirrors
    /// Claude tool uses; `command` mirrors Codex shell commands
    /// (`TranscriptEntryKind::Command`, no `ToolCallView`), so e2e can exercise
    /// command-group folding.
    #[serde(default)]
    tool_kind: FakeToolKind,
    /// A reasoning entry after each tool call — the Cursor/Codex shape.
    #[serde(default)]
    reasoning_between_tools: bool,
    pause_after_chunks: Option<usize>,
    barrier: Option<String>,
    /// Files to write into the thread's OWN cwd before the reply is emitted,
    /// relative paths only. Without this the fake can talk about work but never
    /// do any, so every flow whose next step reads a workspace diff — a review, a
    /// merge gate, a commit — is unreachable end to end.
    #[serde(default)]
    write_files: Vec<FakeFileWrite>,
    #[serde(default)]
    duplicate_chunk_indices: Vec<usize>,
    #[serde(default)]
    late_chunks: Vec<String>,
    late_chunk_delay_ms: Option<u64>,
    #[serde(default)]
    require_approval: bool,
    /// Hold the approval request back for this long after the user message
    /// lands. Real providers ask for approval only once they have started
    /// working, so the reader has usually scrolled somewhere by then; with the
    /// request arriving in the same beat as the user message, a test can only
    /// ever observe the send's own jump-to-bottom. Lets an e2e escape upward
    /// first and then assert the arriving request is still brought into view.
    approval_delay_ms: Option<u64>,
    /// Park the turn on a real AskUserQuestion request: emit the tool-call
    /// transcript entry, publish a pending question, block until an answer
    /// arrives through `respond_to_ask_user_question`, and then CONTINUE the same
    /// turn. The continuation is the point: a parked turn is not stopped, it is
    /// blocked inside the provider's tool callback, and a double that ended the
    /// turn would make the feature look like it needs machinery it does not have.
    ///
    /// `true` asks the canned question; an object supplies the text. A scenario
    /// driving a whole pipeline needs to assert on what was asked, while a
    /// scroll/pinning test only needs A question to exist.
    #[serde(default)]
    ask_user: Option<FakeAskUserSpec>,
    /// Same purpose as `approval_delay_ms`, for the question.
    ask_user_delay_ms: Option<u64>,
    /// Emit this assistant text AFTER the question's tool call but before
    /// parking, so the pending question is NOT the last entry. Models a turn
    /// that issued the question alongside other tool uses — the case where the
    /// transcript has to PIN the unanswered question to the bottom rather than
    /// leave it buried mid-thread.
    ask_user_trailing_text: Option<String>,
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

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum FakeToolKind {
    #[default]
    ToolCall,
    Command,
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

/// Ask-user request ids answered through the bridge.
///
/// A parked turn watches THIS rather than the pending map: cleanup empties that
/// map too, and a turn that was drained must not behave as though someone had
/// answered it.
type AnsweredAsks = Arc<Mutex<std::collections::HashSet<String>>>;

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
        for matcher in &config.matchers {
            // An empty matcher matches every prompt, which is never what anyone
            // meant and would silently swallow the whole run.
            if matcher.contains.iter().all(|needle| needle.is_empty()) {
                return Err(
                    "fake-provider scenario matcher needs at least one non-empty `contains`"
                        .to_string(),
                );
            }
            for path in &matcher.scenario.write_files {
                validate_relative_write_path(&path.path)?;
            }
        }
        for scenario in config
            .prompts
            .values()
            .chain(config.matchers.iter().map(|matcher| &matcher.scenario))
        {
            if scenario.pause_after_chunks.is_some() {
                let barrier = scenario.barrier.as_deref().ok_or_else(|| {
                    "fake-provider scenario pause_after_chunks requires barrier".to_string()
                })?;
                validate_barrier_name(barrier)?;
            }
        }
        for scenario in config.prompts.values() {
            for path in &scenario.write_files {
                validate_relative_write_path(&path.path)?;
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
        if let Some(scenario) = self.config.prompts.get(prompt) {
            return Some(scenario.clone());
        }
        self.config
            .matchers
            .iter()
            .find(|matcher| {
                matcher
                    .contains
                    .iter()
                    .all(|needle| prompt.contains(needle))
            })
            .map(|matcher| matcher.scenario.clone())
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

struct FakeAskUserGate {
    turn_id: String,
    sender: oneshot::Sender<serde_json::Map<String, serde_json::Value>>,
}

/// A scenario write must stay inside the thread's own workspace.
///
/// The fake provider is only ever a test double, but it is handed paths from a
/// JSON file and runs as the relay user; an absolute path or a `..` segment here
/// would let a scenario write anywhere on the machine.
fn validate_relative_write_path(path: &str) -> Result<(), String> {
    let candidate = Path::new(path);
    if path.is_empty()
        || candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!(
            "fake-provider scenario write_files paths must be relative and free of '..': {path:?}"
        ));
    }
    Ok(())
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
    /// Threads handed back via `release_thread`, in call order, so a test can
    /// assert the pool checkout actually returned.
    released_threads: Arc<Mutex<Vec<String>>>,
    next_id: AtomicU64,
    // When set, a non-`bypass` turn parks on an approval request (a fake Bash
    // command) until respond_to_approval resolves it — letting tests exercise
    // the real permission-modal path. Off by default so existing fake e2e
    // suites (which send turns under various policies) stay unaffected; flipped
    // on via FAKE_PROVIDER_ENFORCE_APPROVALS for the permission-mode e2e.
    enforce_approvals: Arc<AtomicBool>,
    // The vendor, label, and size the fake model catalog reports. Defaults to
    // `fake` / `Fake Echo` / one model. `FAKE_PROVIDER_VENDOR`,
    // `FAKE_PROVIDER_MODEL_LABEL`, and `FAKE_PROVIDER_MODEL_COUNT`
    // let the double impersonate a real vendor, so surfaces that key off
    // `ModelOptionView::provider` (the picker's mark — `providerIconKey` maps
    // `anthropic`/`openai` onto the shipped icons) exercise their real render
    // path instead of the no-icon fallback, and let layout tests request a long
    // deterministic catalog without depending on locally installed providers.
    // Nothing branches on "is this the fake provider"; it just answers the
    // catalog question differently.
    model_vendor: String,
    model_label: String,
    model_count: usize,
    /// Milliseconds `start_thread` sleeps before answering. Zero by default, so
    /// nothing that does not ask for it is affected. It exists because a race in
    /// a check-then-act window cannot be tested against a double that answers
    /// instantly: with no await that actually yields, two concurrent callers
    /// simply take turns and the window is never open.
    start_thread_delay_ms: Arc<AtomicU64>,
    approval_gates: Arc<Mutex<HashMap<String, FakeApprovalGate>>>,
    ask_user_gates: Arc<Mutex<HashMap<String, FakeAskUserGate>>>,
    turn_stop_behaviors: Arc<Mutex<HashMap<String, FakeStopBehavior>>>,
    stopped_turns: Arc<Mutex<HashSet<String>>>,
    scenario_harness: Option<FakeScenarioHarness>,
    /// `(cwd, system_prompt)` for every thread opened with a persona. The fake
    /// has no model to feed it to, so recording is the whole point: it lets a
    /// test assert the relay ASKED for a persona without standing up a real
    /// provider to observe that it arrived.
    system_prompts: Arc<Mutex<Vec<(String, String)>>>,
}

impl FakeProviderBridge {
    /// Make `start_thread` take `ms` to answer.
    ///
    /// A test seam with one purpose: a check-then-act race needs both callers
    /// inside the window at the same time, and a double that answers without
    /// ever yielding lets them take turns instead.
    pub(crate) fn set_start_thread_delay_ms(&self, ms: u64) {
        self.start_thread_delay_ms.store(ms, Ordering::Relaxed);
    }

    /// `(cwd, system_prompt)` for every thread opened with a persona.
    /// Threads handed back via `release_thread`, in call order.
    pub async fn released_threads(&self) -> Vec<String> {
        self.released_threads.lock().await.clone()
    }

    pub async fn recorded_system_prompts(&self) -> Vec<(String, String)> {
        self.system_prompts.lock().await.clone()
    }

    pub async fn spawn(state: Arc<RwLock<RelayState>>) -> Result<Self, String> {
        let threads = Arc::new(Mutex::new(restore_threads_from_relay(&state).await));
        {
            let mut relay = state.write().await;
            relay.set_provider_connection("fake", true);
            relay.push_log("info", "Connected to fake agent provider.");
            relay.notify();
        }

        let enforce_approvals = std::env::var("FAKE_PROVIDER_ENFORCE_APPROVALS")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let scenario_harness = FakeScenarioHarness::from_env()?;
        let model_vendor =
            non_empty_env("FAKE_PROVIDER_VENDOR").unwrap_or_else(|| "fake".to_string());
        let model_label =
            non_empty_env("FAKE_PROVIDER_MODEL_LABEL").unwrap_or_else(|| "Fake Echo".to_string());
        let model_count = non_empty_env("FAKE_PROVIDER_MODEL_COUNT")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1)
            .clamp(1, 32);

        Ok(Self {
            released_threads: Arc::new(Mutex::new(Vec::new())),
            state,
            threads,
            next_id: AtomicU64::new(1),
            enforce_approvals: Arc::new(AtomicBool::new(enforce_approvals)),
            model_vendor,
            model_label,
            model_count,
            start_thread_delay_ms: Arc::new(AtomicU64::new(0)),
            approval_gates: Arc::new(Mutex::new(HashMap::new())),
            ask_user_gates: Arc::new(Mutex::new(HashMap::new())),
            turn_stop_behaviors: Arc::new(Mutex::new(HashMap::new())),
            stopped_turns: Arc::new(Mutex::new(HashSet::new())),
            scenario_harness,
            system_prompts: Arc::new(Mutex::new(Vec::new())),
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
        Ok((0..self.model_count)
            .map(|index| ModelOptionView {
                model: if index == 0 {
                    "fake-echo".to_string()
                } else {
                    format!("fake-echo-{}", index + 1)
                },
                display_name: if index == 0 {
                    self.model_label.clone()
                } else {
                    format!("{} {}", self.model_label, index + 1)
                },
                provider: self.model_vendor.clone(),
                supported_reasoning_efforts: vec![
                    "low".to_string(),
                    "medium".to_string(),
                    "high".to_string(),
                ],
                default_reasoning_effort: "medium".to_string(),
                hidden: false,
                is_default: index == 0,
            })
            .collect())
    }

    /// Records `system_prompt` so a test can assert the relay asked for a persona
    /// without needing a real provider to prove it.
    async fn start_thread(&self, request: StartThreadRequest) -> Result<StartThreadResult, String> {
        // Holds the check-then-act window open for a test that needs two callers
        // inside it at once. Zero unless a test asked.
        let delay = self.start_thread_delay_ms.load(Ordering::Relaxed);
        if delay > 0 {
            sleep(Duration::from_millis(delay)).await;
        }
        let cwd = request.cwd.as_str();
        if let Some(prompt) = request.system_prompt.as_deref() {
            self.system_prompts
                .lock()
                .await
                .push((cwd.to_string(), prompt.to_string()));
        }
        let thread = ThreadSummaryView {
            workspace_trusted: false,
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
            renamed: false,
            flagged: false,
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

    // The test double stands in for a provider that CAN archive (Codex), so the
    // archive paths stay exercisable without a real one.
    fn supports_archive(&self) -> bool {
        true
    }

    async fn release_thread(&self, thread_id: &str) -> Result<(), String> {
        self.released_threads
            .lock()
            .await
            .push(thread_id.to_string());
        Ok(())
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
        let tool_call_count = scenario
            .as_ref()
            .map(|scenario| scenario.tool_calls)
            .unwrap_or_default();
        let tool_kind = scenario
            .as_ref()
            .map(|scenario| scenario.tool_kind)
            .unwrap_or_default();
        let reasoning_between_tools = scenario
            .as_ref()
            .map(|scenario| scenario.reasoning_between_tools)
            .unwrap_or_default();
        let tool_call_delay = Duration::from_millis(
            scenario
                .as_ref()
                .and_then(|scenario| scenario.tool_call_delay_ms)
                .unwrap_or(40),
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
        let write_files = scenario
            .as_ref()
            .map(|scenario| scenario.write_files.clone())
            .unwrap_or_default();
        if !write_files.is_empty() {
            let cwd = self
                .threads
                .lock()
                .await
                .get(&thread_id)
                .map(|thread| thread.summary.cwd.clone())
                .unwrap_or_default();
            for file in &write_files {
                // Validated at load time; re-checked here because the cwd is only
                // known now and a join is where a bad path would actually escape.
                if validate_relative_write_path(&file.path).is_err() || cwd.is_empty() {
                    continue;
                }
                let target = Path::new(&cwd).join(&file.path);
                if let Some(parent) = target.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(&target, file.contents.as_bytes()).await;
            }
        }
        let scenario_harness = self.scenario_harness.clone();
        let turn_id = self.next_token("fake-turn");
        let user_item_id = self.next_token("fake-user");
        let assistant_item_id = self.next_token("fake-assistant");
        let tool_item_ids = (0..tool_call_count)
            .map(|_| self.next_token("fake-tool"))
            .collect::<Vec<_>>();
        let reasoning_item_ids = (0..tool_call_count)
            .map(|_| self.next_token("fake-reasoning"))
            .collect::<Vec<_>>();
        let state = self.state.clone();
        let threads = self.threads.clone();
        let turn_id_for_task = turn_id.clone();

        // Decide up front whether this turn must park on an approval request.
        let needs_approval = scenario
            .as_ref()
            .is_some_and(|scenario| scenario.require_approval)
            || (self.enforce_approvals.load(Ordering::Relaxed)
                && self.approval_policy_for(&thread_id).await != "bypass");
        let approval_delay = scenario
            .as_ref()
            .and_then(|scenario| scenario.approval_delay_ms)
            .map(Duration::from_millis);
        let ask_user_spec = scenario
            .as_ref()
            .and_then(|scenario| scenario.ask_user.clone())
            .filter(FakeAskUserSpec::is_enabled);
        let ask_user_detail = ask_user_spec
            .as_ref()
            .and_then(FakeAskUserSpec::detail)
            .cloned();
        let ask_user = ask_user_spec.is_some();
        // Was anyone LOOKING at this thread when the turn began?
        //
        // The publish rule below is "don't publish if the reader walked away",
        // not "don't publish to a background thread" — and the difference is the
        // whole Task team feature. Every team seat is background-started and must
        // still be able to ask; a foreground thread the user switched away from
        // mid-delay must not leave a question behind. Both fall out of comparing
        // against the state at turn start rather than against `active` alone.
        let ask_user_started_foreground =
            self.state.read().await.active_thread_id.as_deref() == Some(thread_id.as_str());
        let ask_user_delay = scenario
            .as_ref()
            .and_then(|scenario| scenario.ask_user_delay_ms)
            .map(Duration::from_millis);
        let ask_user_trailing_text = scenario
            .as_ref()
            .and_then(|scenario| scenario.ask_user_trailing_text.clone());
        let ask_user_request_id = self.next_token("fake-ask");
        let ask_user_tool_use_id = self.next_token("fake-ask-tool");
        let ask_user_trailing_item_id = self.next_token("fake-ask-trailing");
        let ask_user_gates = self.ask_user_gates.clone();
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
                // Numbered when it becomes a runtime record; raw provider parses carry none.
                order_seq: None,
                withdrawn: false,
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
                // Numbered when it becomes a runtime record; raw provider parses carry none.
                order_seq: None,
                withdrawn: false,
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
            //
            // Optional: let the user message settle on screen (and the reader move)
            // before the request appears. See `approval_delay_ms`.
            if needs_approval {
                if let Some(delay) = approval_delay {
                    sleep(delay).await;
                }

                let (decision_tx, decision_rx) = oneshot::channel();
                // Read the stop flag and register the gate under ONE hold of the
                // gate map. `request_turn_stop` sets the flag and THEN scans this
                // map, so holding it across both makes the interleavings exclusive:
                // either we observe the stop and never park, or the stop finds our
                // gate and cancels it. A plain check-then-insert leaves a window
                // where NEITHER happens — the stop scans an empty map, we register
                // afterwards, and the turn waits on a channel nobody will ever fire.
                // (Lock order is gates -> stopped_turns; `request_turn_stop` never
                // holds stopped_turns across a gate acquisition, so there is no
                // cycle. Nothing anywhere holds a gate lock across a state lock.)
                let registered = {
                    let mut gates = approval_gates.lock().await;
                    if stopped_turns.lock().await.contains(&turn_id_for_task) {
                        false
                    } else {
                        gates.insert(
                            approval_request_id.clone(),
                            FakeApprovalGate {
                                turn_id: turn_id_for_task.clone(),
                                sender: decision_tx,
                            },
                        );
                        true
                    }
                };
                if !registered {
                    settle_fake_turn(&state, &thread_id, &turn_id_for_task, "idle").await;
                    record_scenario_event(
                        scenario_harness.as_ref(),
                        "turn_stopped",
                        &thread_id,
                        &turn_id_for_task,
                        None,
                    )
                    .await;
                    turn_stop_behaviors.lock().await.remove(&turn_id_for_task);
                    stopped_turns.lock().await.remove(&turn_id_for_task);
                    return;
                }

                // Publish while HOLDING the write lock that re-confirms the thread
                // is still foreground. "Only foreground turns gate" has to hold at
                // the moment the request becomes visible, not when the turn started
                // — the reader can switch threads at any await before this.
                let published = {
                    let mut relay = state.write().await;
                    if relay.active_thread_id.as_deref() == Some(thread_id.as_str()) {
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
                        true
                    } else {
                        false
                    }
                };
                if !published {
                    // Backgrounded while the request was held back: give the gate
                    // back and stream like any other background turn.
                    approval_gates.lock().await.remove(&approval_request_id);
                } else {
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

                    // A stop that raced us here already sent Cancel into this
                    // channel, so this resolves immediately and unwinds below.
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
                        drop(relay);
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
            }

            // 2b. Park on an AskUserQuestion when the scenario asks for one.
            //
            // Ordering here is a hard contract, not style: `set_thread_status`
            // with a SETTLED status runs `drop_pending_requests_for_thread`, so
            // the thread must be marked active WITH the waiting flag BEFORE the
            // pending question is added, and the turn must never settle while it
            // is outstanding.
            //
            // NOTHING is written to the transcript until we know we are going to
            // publish. Emitting the question first and checking afterwards left a
            // ghost `running` tool card behind whenever a stop landed inside
            // `ask_user_delay_ms`, or whenever the thread went background.
            let mut ask_user_entries: Vec<TranscriptEntryView> = Vec::new();
            if ask_user {
                if let Some(delay) = ask_user_delay {
                    sleep(delay).await;
                }

                let ask_item_id = format!("tool:{ask_user_tool_use_id}");
                let (answer_tx, answer_rx) = oneshot::channel();
                // Same stop-safety shape as the approval gate: read the stop flag
                // and register the gate under ONE hold of the gate map, so a stop
                // either is seen here or finds this gate to cancel.
                let registered = {
                    let mut gates = ask_user_gates.lock().await;
                    if stopped_turns.lock().await.contains(&turn_id_for_task) {
                        false
                    } else {
                        gates.insert(
                            ask_user_request_id.clone(),
                            FakeAskUserGate {
                                turn_id: turn_id_for_task.clone(),
                                sender: answer_tx,
                            },
                        );
                        true
                    }
                };
                if !registered {
                    settle_fake_turn(&state, &thread_id, &turn_id_for_task, "idle").await;
                    record_scenario_event(
                        scenario_harness.as_ref(),
                        "turn_stopped",
                        &thread_id,
                        &turn_id_for_task,
                        None,
                    )
                    .await;
                    turn_stop_behaviors.lock().await.remove(&turn_id_for_task);
                    stopped_turns.lock().await.remove(&turn_id_for_task);
                    return;
                }

                // ONE write-lock section, so the question's tool card, the
                // trailing message and the pending request all appear together.
                //
                // Deliberately NOT gated on the thread being foreground. It was,
                // to avoid leaving a `running` tool card behind when a thread went
                // background mid-delay — but a background thread asking is the
                // whole point for a Task team: every seat is background-started,
                // and `submit_ask_user_answer` skips its active-thread check
                // precisely so a parked dev can still be answered. The card is not
                // a ghost while the question is genuinely pending; the answer path
                // and the cancel path below both settle it.
                let published = {
                    let mut relay = state.write().await;
                    let reader_left = ask_user_started_foreground
                        && relay.active_thread_id.as_deref() != Some(thread_id.as_str());
                    if reader_left {
                        false
                    } else {
                        relay.upsert_transcript_item_for_thread(
                            &thread_id,
                            ask_item_id.clone(),
                            TranscriptEntryKind::ToolCall,
                            None,
                            "running".to_string(),
                            Some(turn_id_for_task.clone()),
                            Some(fake_ask_user_tool_view(None, ask_user_detail.as_ref())),
                        );
                        // Optional: something AFTER the question, so the
                        // transcript has to pin it to the bottom instead of
                        // leaving it buried.
                        if let Some(text) = ask_user_trailing_text.clone() {
                            relay.upsert_transcript_item_for_thread(
                                &thread_id,
                                ask_user_trailing_item_id.clone(),
                                TranscriptEntryKind::AgentText,
                                Some(text),
                                "completed".to_string(),
                                Some(turn_id_for_task.clone()),
                                None,
                            );
                        }
                        relay.set_thread_status(
                            &thread_id,
                            "active".to_string(),
                            vec!["waitingOnAskUser".to_string()],
                        );
                        relay.add_pending_ask_user_question(PendingAskUserQuestion {
                            request_id: ask_user_request_id.clone(),
                            arrival_seq: 0,
                            tool_use_id: ask_user_tool_use_id.clone(),
                            thread_id: thread_id.clone(),
                            requested_at: unix_now(),
                            questions: fake_ask_user_questions(ask_user_detail.as_ref()),
                        });
                        relay.touch_progress(Some("waiting_user"), None);
                        relay.push_log("info", "Fake provider asked the user a question.");
                        relay.notify();
                        true
                    }
                };
                if !published {
                    ask_user_gates.lock().await.remove(&ask_user_request_id);
                } else {
                    record_scenario_event(
                        scenario_harness.as_ref(),
                        "ask_user_question_requested",
                        &thread_id,
                        &turn_id_for_task,
                        Some(serde_json::json!({ "request_id": ask_user_request_id })),
                    )
                    .await;

                    // `Ok(answers)` = a real answer; `Err` = the sender was
                    // dropped, i.e. the turn was stopped. Never conflate the two:
                    // recording a cancelled question as answered would put words
                    // in the user's mouth in the saved history.
                    let answers = answer_rx.await.ok();
                    ask_user_gates.lock().await.remove(&ask_user_request_id);
                    record_scenario_event(
                        scenario_harness.as_ref(),
                        "ask_user_question_resolved",
                        &thread_id,
                        &turn_id_for_task,
                        Some(serde_json::json!({ "answered": answers.is_some() })),
                    )
                    .await;

                    let Some(answers) = answers else {
                        // Cancelled. Mark the card terminal WITHOUT a result, so
                        // it never claims an answer nobody gave.
                        {
                            let mut relay = state.write().await;
                            relay.upsert_transcript_item_for_thread(
                                &thread_id,
                                ask_item_id.clone(),
                                TranscriptEntryKind::ToolCall,
                                None,
                                "failed".to_string(),
                                Some(turn_id_for_task.clone()),
                                Some(fake_ask_user_tool_view(None, ask_user_detail.as_ref())),
                            );
                            relay.notify();
                        }
                        settle_fake_turn(&state, &thread_id, &turn_id_for_task, "idle").await;
                        turn_stop_behaviors.lock().await.remove(&turn_id_for_task);
                        stopped_turns.lock().await.remove(&turn_id_for_task);
                        return;
                    };

                    // Answered: echo back what was ACTUALLY chosen. This is also
                    // what un-pins the card back to its place in the conversation.
                    let answered_tool =
                        fake_ask_user_tool_view(Some(&answers), ask_user_detail.as_ref());
                    {
                        let mut relay = state.write().await;
                        relay.upsert_transcript_item_for_thread(
                            &thread_id,
                            ask_item_id.clone(),
                            TranscriptEntryKind::ToolCall,
                            None,
                            "completed".to_string(),
                            Some(turn_id_for_task.clone()),
                            Some(answered_tool.clone()),
                        );
                        relay.notify();
                    }

                    // Persist both entries with the turn, so the question and the
                    // message after it survive a thread re-read / switch-away —
                    // which is what makes "returns to its original position"
                    // true beyond the live snapshot.
                    ask_user_entries.push(TranscriptEntryView {
                        // Numbered when it becomes a runtime record; raw provider parses carry none.
                        order_seq: None,
                        withdrawn: false,
                        item_id: Some(ask_item_id.clone()),
                        kind: TranscriptEntryKind::ToolCall,
                        text: None,
                        status: "completed".to_string(),
                        turn_id: Some(turn_id_for_task.clone()),
                        tool: Some(answered_tool),
                        content_state: crate::protocol::TranscriptContentState::Full,
                    });
                    if let Some(text) = ask_user_trailing_text.clone() {
                        ask_user_entries.push(TranscriptEntryView {
                            // Numbered when it becomes a runtime record; raw provider parses carry none.
                            order_seq: None,
                            withdrawn: false,
                            item_id: Some(ask_user_trailing_item_id.clone()),
                            kind: TranscriptEntryKind::AgentText,
                            text: Some(text),
                            status: "completed".to_string(),
                            turn_id: Some(turn_id_for_task.clone()),
                            tool: None,
                            content_state: crate::protocol::TranscriptContentState::Full,
                        });
                    }
                }
            }

            // 3. Stream tool-call lifecycle entries before the agent reply.
            // This mirrors the Claude worker's `tool_call_requested` /
            // `tool_call_result` sequence closely enough for browser tests to
            // exercise live grouping, virtualization, and scroll following.
            let mut tool_entries = Vec::with_capacity(tool_item_ids.len() + ask_user_entries.len());
            tool_entries.append(&mut ask_user_entries);
            for (index, tool_item_id) in tool_item_ids.into_iter().enumerate() {
                if stopped_turns.lock().await.contains(&turn_id_for_task) {
                    settle_fake_turn(&state, &thread_id, &turn_id_for_task, "idle").await;
                    record_scenario_event(
                        scenario_harness.as_ref(),
                        "turn_stopped",
                        &thread_id,
                        &turn_id_for_task,
                        None,
                    )
                    .await;
                    turn_stop_behaviors.lock().await.remove(&turn_id_for_task);
                    stopped_turns.lock().await.remove(&turn_id_for_task);
                    return;
                }

                let tool_number = index + 1;
                let is_command = matches!(tool_kind, FakeToolKind::Command);
                let entry_kind = if is_command {
                    TranscriptEntryKind::Command
                } else {
                    TranscriptEntryKind::ToolCall
                };
                let command_text = format!("echo fake-command-{tool_number}");
                let running_tool = fake_tool_call_view(tool_number, false);
                {
                    let mut relay = state.write().await;
                    relay.upsert_transcript_item_for_thread(
                        &thread_id,
                        tool_item_id.clone(),
                        entry_kind,
                        if is_command {
                            Some(command_text.clone())
                        } else {
                            None
                        },
                        "running".to_string(),
                        Some(turn_id_for_task.clone()),
                        if is_command {
                            None
                        } else {
                            Some(running_tool.clone())
                        },
                    );
                    if relay.active_thread_id.as_deref() == Some(thread_id.as_str()) {
                        relay.touch_progress(Some("tool"), Some(&running_tool.name));
                        relay.push_log(
                            "tool",
                            format!("Fake tool call started: {}", running_tool.title),
                        );
                    }
                    relay.notify();
                }
                record_scenario_event(
                    scenario_harness.as_ref(),
                    "tool_call_started",
                    &thread_id,
                    &turn_id_for_task,
                    Some(serde_json::json!({
                        "index": index,
                        "item_id": tool_item_id,
                    })),
                )
                .await;

                sleep(tool_call_delay).await;

                let completed_tool = fake_tool_call_view(tool_number, true);
                {
                    let mut relay = state.write().await;
                    relay.upsert_transcript_item_for_thread(
                        &thread_id,
                        tool_item_id.clone(),
                        entry_kind,
                        if is_command {
                            Some(command_text.clone())
                        } else {
                            None
                        },
                        "completed".to_string(),
                        Some(turn_id_for_task.clone()),
                        if is_command {
                            None
                        } else {
                            Some(completed_tool.clone())
                        },
                    );
                    if relay.active_thread_id.as_deref() == Some(thread_id.as_str()) {
                        relay.touch_progress(None, None);
                        relay.push_log(
                            "tool",
                            format!("Fake tool call completed: {}", completed_tool.title),
                        );
                    }
                    relay.notify();
                }
                record_scenario_event(
                    scenario_harness.as_ref(),
                    "tool_call_completed",
                    &thread_id,
                    &turn_id_for_task,
                    Some(serde_json::json!({
                        "index": index,
                        "item_id": tool_item_id,
                    })),
                )
                .await;
                tool_entries.push(TranscriptEntryView {
                    // Numbered when it becomes a runtime record; raw provider parses carry none.
                    order_seq: None,
                    withdrawn: false,
                    item_id: Some(tool_item_id),
                    kind: entry_kind,
                    text: if is_command {
                        Some(command_text.clone())
                    } else {
                        None
                    },
                    status: "completed".to_string(),
                    turn_id: Some(turn_id_for_task.clone()),
                    tool: if is_command {
                        None
                    } else {
                        Some(completed_tool)
                    },
                    content_state: crate::protocol::TranscriptContentState::Full,
                });
                // After the tool in both arrays, or a reload reorders the turn.
                if reasoning_between_tools {
                    let reasoning_item_id = reasoning_item_ids[index].clone();
                    let reasoning_text =
                        format!("Reasoning step {tool_number}: what to do after the last call.");
                    {
                        let mut relay = state.write().await;
                        relay.upsert_transcript_item_for_thread(
                            &thread_id,
                            reasoning_item_id.clone(),
                            TranscriptEntryKind::Reasoning,
                            Some(reasoning_text.clone()),
                            "completed".to_string(),
                            Some(turn_id_for_task.clone()),
                            None,
                        );
                        relay.notify();
                    }
                    tool_entries.push(TranscriptEntryView {
                        // Numbered when it becomes a runtime record; raw provider parses carry none.
                        order_seq: None,
                        withdrawn: false,
                        item_id: Some(reasoning_item_id),
                        kind: TranscriptEntryKind::Reasoning,
                        text: Some(reasoning_text),
                        status: "completed".to_string(),
                        turn_id: Some(turn_id_for_task.clone()),
                        tool: None,
                        content_state: crate::protocol::TranscriptContentState::Full,
                    });
                }
            }

            // 4. Begin the agent reply.
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
                        order_seq: mutation.order_seq,
                        server_time: mutation.server_time,
                        item_id: mutation.row_id.clone(),
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
                    tool_entries.push(assistant_entry);
                    store_fake_turn(&threads, &thread_id, user_entry, tool_entries, "idle").await;
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
                        // Numbered when it becomes a runtime record; raw provider parses carry none.
                        order_seq: None,
                        withdrawn: false,
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
                    if let Some(partial_entry) = partial_entry {
                        tool_entries.push(partial_entry);
                    }
                    store_fake_turn(&threads, &thread_id, user_entry, tool_entries, "idle").await;
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
                    if let Some(partial_entry) = partial_entry {
                        tool_entries.push(partial_entry);
                    }
                    store_fake_turn(&threads, &thread_id, user_entry, tool_entries, "idle").await;
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
                    if let Some(partial_entry) = partial_entry {
                        tool_entries.push(partial_entry);
                    }
                    store_fake_turn(&threads, &thread_id, user_entry, tool_entries, "active").await;
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
            // Same for a parked question: dropping the sender makes the turn's
            // `answer_rx.await` resolve as cancelled instead of hanging forever.
            let ask_request_ids = self
                .ask_user_gates
                .lock()
                .await
                .iter()
                .filter(|(_, gate)| gate.turn_id == turn_id)
                .map(|(request_id, _)| request_id.clone())
                .collect::<Vec<_>>();
            for request_id in ask_request_ids {
                self.ask_user_gates.lock().await.remove(&request_id);
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
        request_id: &str,
        answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        // The fake reply does not depend on WHAT was answered, but an empty
        // answer map still means the caller skipped the wizard — reject it the
        // way a real provider would rather than silently unblocking.
        if answers.is_empty() {
            return Err("fake provider received no answers".to_string());
        }
        match self.ask_user_gates.lock().await.remove(request_id) {
            // The app layer clears the pending question after this returns.
            Some(gate) => {
                // Hand the ACTUAL answers to the parked turn so it can echo them
                // back, rather than inventing a canned one.
                let _ = gate.sender.send(answers.clone());
                Ok(())
            }
            None => Err(format!(
                "fake provider has no pending question for {request_id}"
            )),
        }
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
    mut turn_entries: Vec<TranscriptEntryView>,
    status: &str,
) {
    if let Some(thread) = threads.lock().await.get_mut(thread_id) {
        thread.summary.preview = user_entry.text.clone().unwrap_or_default();
        thread.summary.status = status.to_string();
        thread.summary.updated_at = unix_now();
        thread.transcript.push(user_entry);
        thread.transcript.append(&mut turn_entries);
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
        workspace_trusted: false,
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
        renamed: false,
        flagged: false,
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

/// Read an env var, treating "set but blank" as unset so an empty value can't
/// blank out a display name or a vendor key.
fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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

fn fake_tool_call_view(index: usize, completed: bool) -> ToolCallView {
    ToolCallView {
        item_type: "toolCall".to_string(),
        name: "Bash".to_string(),
        title: format!("Fake Bash call {index}"),
        kind: None,
        detail: Some(format!("Synthetic streaming tool call {index}")),
        query: None,
        path: None,
        url: None,
        command: Some(format!("printf 'fake tool call {index}\\n'")),
        input_preview: Some(format!("{{\"index\":{index}}}")),
        result_preview: completed.then(|| format!("fake tool result {index}")),
        diff: None,
        file_changes: Vec::new(),
        apply_state: None,
        file_changes_omitted: false,
        can_apply: None,
    }
}

/// The question fixture the fake provider asks. One single-select question, so
/// an e2e can answer it with a single option click (the wizard's quick path).
/// The question the fake asks. `None` gives the canned one, which is all a
/// scroll/pinning test needs; a scenario that asserts on what was asked supplies
/// its own.
fn fake_ask_user_questions(detail: Option<&FakeAskUser>) -> Vec<AskUserQuestionView> {
    let Some(detail) = detail else {
        return vec![AskUserQuestionView {
            question: "Which approach should we take?".to_string(),
            header: "Approach".to_string(),
            multi_select: false,
            options: vec![
                AskUserOptionView {
                    label: "Option A".to_string(),
                    description: "Take the direct route".to_string(),
                },
                AskUserOptionView {
                    label: "Option B".to_string(),
                    description: "Take the careful route".to_string(),
                },
            ],
        }];
    };
    std::iter::once(detail)
        .chain(detail.more.iter())
        .map(fake_ask_user_question)
        .collect()
}

fn fake_ask_user_question(detail: &FakeAskUser) -> AskUserQuestionView {
    AskUserQuestionView {
        question: detail.question.clone(),
        header: if detail.header.is_empty() {
            "Question".to_string()
        } else {
            detail.header.clone()
        },
        multi_select: detail.multi_select,
        options: detail
            .options
            .iter()
            .map(|label| AskUserOptionView {
                label: label.clone(),
                description: String::new(),
            })
            .collect(),
    }
}

fn fake_ask_user_input_preview(detail: Option<&FakeAskUser>) -> String {
    serde_json::json!({
        "questions": fake_ask_user_questions(detail)
            .into_iter()
            .map(|question| serde_json::json!({
                "question": question.question,
                "header": question.header,
                "multiSelect": question.multi_select,
                "options": question.options
                    .into_iter()
                    .map(|option| serde_json::json!({
                        "label": option.label,
                        "description": option.description,
                    }))
                    .collect::<Vec<_>>(),
            }))
            .collect::<Vec<_>>(),
    })
    .to_string()
}

/// Render one answer value the way a provider would echo it back:
/// `string` verbatim, `[a, b]` joined. Anything else falls back to its JSON.
fn render_ask_user_answer(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .map(render_ask_user_answer)
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_string(),
    }
}

/// The question's tool card. `answers` is `None` while it is unanswered (or when
/// it was cancelled) and `Some(..)` once a real answer arrived — the result
/// preview is built FROM that answer, never hardcoded, so picking Option B or
/// typing free text is not later reported back as Option A.
fn fake_ask_user_tool_view(
    answers: Option<&serde_json::Map<String, serde_json::Value>>,
    detail: Option<&FakeAskUser>,
) -> ToolCallView {
    let result_preview = answers.map(|answers| {
        let rendered = answers
            .iter()
            .map(|(question, value)| {
                format!("\"{question}\"=\"{}\"", render_ask_user_answer(value))
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("Your questions have been answered: {rendered}. You can now continue.")
    });
    ToolCallView {
        item_type: "toolCall".to_string(),
        name: "AskUserQuestion".to_string(),
        title: "AskUserQuestion".to_string(),
        kind: None,
        detail: None,
        query: None,
        path: None,
        url: None,
        command: None,
        input_preview: Some(fake_ask_user_input_preview(detail)),
        result_preview,
        diff: None,
        file_changes: Vec::new(),
        apply_state: None,
        file_changes_omitted: false,
        can_apply: None,
    }
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
            workspace_trusted: false,
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
            renamed: false,
            flagged: false,
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
            .start_thread(StartThreadRequest::new(
                "/tmp/project",
                "fake-echo",
                "never",
                "read-only",
            ))
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
                ..Default::default()
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
            config: FakeScenarioConfig {
                prompts,
                ..Default::default()
            },
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
    async fn repeated_reasoning_turns_mint_fresh_ids_and_keep_tool_before_thought() {
        // Two runs on one thread: reused ids would update turn 1 instead of
        // appending, and the saved order could diverge from the live one.
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "interleave".to_string(),
                FakeTurnScenario {
                    chunks: Some(vec!["done".to_string()]),
                    chunk_delay_ms: Some(0),
                    tool_calls: 2,
                    tool_call_delay_ms: Some(0),
                    reasoning_between_tools: true,
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        for turn in 1..=2 {
            bridge
                .start_turn(ACTIVE_THREAD, "interleave", "fake-echo", "medium", &[])
                .await
                .expect("turn");
            let want = turn * 2;
            let mut seen = 0;
            for _ in 0..200 {
                seen = state
                    .read()
                    .await
                    .runtime_for_thread(ACTIVE_THREAD)
                    .map(|runtime| {
                        runtime
                            .transcript
                            .iter()
                            .filter(|entry| entry.kind == TranscriptEntryKind::Reasoning)
                            .count()
                    })
                    .unwrap_or(0);
                if seen >= want {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            assert_eq!(
                seen, want,
                "turn {turn} should have added two reasoning entries"
            );

            // Reasoning lands mid-turn; starting the next one before this
            // settles leaves the interleaving to the scheduler.
            let mut settled = false;
            for _ in 0..200 {
                settled = state
                    .read()
                    .await
                    .runtime_for_thread(ACTIVE_THREAD)
                    .is_some_and(|runtime| runtime.active_turn_id.is_none());
                if settled {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            assert!(settled, "turn {turn} never settled");
        }

        let relay = state.read().await;
        let runtime = relay.runtime_for_thread(ACTIVE_THREAD).expect("runtime");
        let reasoning: Vec<&str> = runtime
            .transcript
            .iter()
            .filter(|entry| entry.kind == TranscriptEntryKind::Reasoning)
            .map(|entry| entry.row_id.as_str())
            .collect();
        assert_eq!(
            reasoning.len(),
            4,
            "two turns of two reasoning entries must all survive, got {reasoning:?}"
        );
        let unique: std::collections::HashSet<&&str> = reasoning.iter().collect();
        assert_eq!(unique.len(), reasoning.len(), "ids collided: {reasoning:?}");

        let live_kinds = work_kinds(runtime.transcript.iter().map(|entry| entry.kind));
        assert_thought_follows_tool(&live_kinds, "live");
        drop(relay);

        // A separate array from the live upserts, so it needs its own assertion.
        let saved = bridge
            .read_thread(ACTIVE_THREAD)
            .await
            .expect("read_thread");
        let saved_reasoning: Vec<&str> = saved
            .transcript
            .iter()
            .filter(|entry| entry.kind == TranscriptEntryKind::Reasoning)
            .filter_map(|entry| entry.item_id.as_deref())
            .collect();
        assert_eq!(
            saved_reasoning.len(),
            4,
            "the saved transcript must hold both turns, got {saved_reasoning:?}"
        );
        let saved_unique: std::collections::HashSet<&&str> = saved_reasoning.iter().collect();
        assert_eq!(
            saved_unique.len(),
            saved_reasoning.len(),
            "saved ids collided: {saved_reasoning:?}"
        );
        assert_thought_follows_tool(
            &work_kinds(saved.transcript.iter().map(|entry| entry.kind)),
            "saved",
        );
    }

    fn work_kinds(kinds: impl Iterator<Item = TranscriptEntryKind>) -> Vec<TranscriptEntryKind> {
        kinds
            .filter(|kind| {
                matches!(
                    kind,
                    TranscriptEntryKind::ToolCall | TranscriptEntryKind::Reasoning
                )
            })
            .collect()
    }

    fn assert_thought_follows_tool(kinds: &[TranscriptEntryKind], label: &str) {
        assert!(!kinds.is_empty(), "{label}: nothing to check");
        for pair in kinds.windows(2) {
            if pair[1] == TranscriptEntryKind::Reasoning {
                assert_eq!(
                    pair[0],
                    TranscriptEntryKind::ToolCall,
                    "{label}: a thought must follow its tool call, got {kinds:?}"
                );
            }
        }
        assert_eq!(
            kinds[0],
            TranscriptEntryKind::ToolCall,
            "{label}: the run must open with a tool, got {kinds:?}"
        );
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
    async fn scenario_streams_tool_call_lifecycle_before_the_reply() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "tools".to_string(),
                FakeTurnScenario {
                    reply: Some("done".to_string()),
                    chunks: Some(vec!["done".to_string()]),
                    chunk_delay_ms: Some(0),
                    tool_calls: 2,
                    tool_call_delay_ms: Some(200),
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(ACTIVE_THREAD, "tools", "fake-echo", "medium", &[])
            .await
            .expect("turn");
        assert!(
            wait_for_scenario_event(&harness, "tool_call_started").await,
            "the first tool call should start"
        );
        let live_snapshot = state.read().await.snapshot();
        assert!(live_snapshot.transcript.iter().any(|entry| {
            entry.kind == TranscriptEntryKind::ToolCall && entry.status == "running"
        }));
        assert_eq!(live_snapshot.current_phase.as_deref(), Some("tool"));
        assert_eq!(live_snapshot.current_tool.as_deref(), Some("Bash"));

        assert!(
            wait_for_scenario_event(&harness, "terminal_completed").await,
            "the turn should settle after both tool calls"
        );
        let stored = bridge.read_thread(ACTIVE_THREAD).await.expect("thread");
        let tools = stored
            .transcript
            .iter()
            .filter(|entry| entry.kind == TranscriptEntryKind::ToolCall)
            .collect::<Vec<_>>();
        assert_eq!(tools.len(), 2);
        assert!(tools.iter().all(|entry| entry.status == "completed"));
        assert!(tools.iter().all(|entry| {
            entry
                .tool
                .as_ref()
                .and_then(|tool| tool.result_preview.as_deref())
                .is_some()
        }));
        assert_eq!(
            stored
                .transcript
                .last()
                .and_then(|entry| entry.text.as_deref()),
            Some("done"),
            "the assistant reply should follow the streamed tool calls"
        );

        let event_log = tokio::fs::read_to_string(temp.path().join("events.ndjson"))
            .await
            .expect("event log");
        let events = event_log
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .collect::<Vec<_>>();
        assert_eq!(
            events
                .iter()
                .filter(|event| event["event"] == "tool_call_started")
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event["event"] == "tool_call_completed")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn scenario_emits_command_kind_entries_when_tool_kind_is_command() {
        // Mirrors the Codex shell path: `tool_kind: command` must emit
        // `TranscriptEntryKind::Command` entries (with a command in `text` and
        // no `ToolCallView`) rather than `ToolCall`, so the frontend can fold
        // them into the collapsible tool-group.
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "commands".to_string(),
                FakeTurnScenario {
                    reply: Some("done".to_string()),
                    chunks: Some(vec!["done".to_string()]),
                    chunk_delay_ms: Some(0),
                    tool_calls: 2,
                    tool_call_delay_ms: Some(0),
                    tool_kind: FakeToolKind::Command,
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, _state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(ACTIVE_THREAD, "commands", "fake-echo", "medium", &[])
            .await
            .expect("turn");
        assert!(
            wait_for_scenario_event(&harness, "terminal_completed").await,
            "the turn should settle after both commands"
        );

        let stored = bridge.read_thread(ACTIVE_THREAD).await.expect("thread");
        let commands = stored
            .transcript
            .iter()
            .filter(|entry| entry.kind == TranscriptEntryKind::Command)
            .collect::<Vec<_>>();
        assert_eq!(commands.len(), 2, "both commands should be recorded");
        assert!(
            commands.iter().all(|entry| entry.status == "completed"),
            "commands settle as completed"
        );
        assert!(
            commands.iter().all(|entry| entry.tool.is_none()),
            "command entries carry no ToolCallView"
        );
        assert!(
            commands.iter().all(|entry| entry
                .text
                .as_deref()
                .is_some_and(|t| t.contains("fake-command"))),
            "the command text drives the CommandEntry preview"
        );
        assert!(
            !stored
                .transcript
                .iter()
                .any(|entry| entry.kind == TranscriptEntryKind::ToolCall),
            "no tool_call entries when tool_kind is command"
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
    async fn stopping_during_an_approval_delay_does_not_resurrect_the_request() {
        // `approval_delay_ms` holds the request back so a browser test can scroll
        // away before it lands. The stop path can only cancel an approval gate that
        // ALREADY EXISTS, so a stop arriving inside that window has nothing to
        // cancel: if the delayed turn then went ahead and parked, it would re-arm
        // `waitingOnApproval` over an idle thread and wait for a decision forever.
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "delayed-approval".to_string(),
                FakeTurnScenario {
                    reply: Some("approved".to_string()),
                    chunks: Some(vec!["approved".to_string()]),
                    chunk_delay_ms: Some(0),
                    require_approval: true,
                    approval_delay_ms: Some(200),
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        let turn_id = bridge
            .start_turn(
                ACTIVE_THREAD,
                "delayed-approval",
                "fake-echo",
                "medium",
                &[],
            )
            .await
            .expect("turn")
            .expect("turn id");
        // Inside the delay: no request has been published yet.
        sleep(Duration::from_millis(50)).await;
        assert!(
            state.read().await.pending_approvals.is_empty(),
            "precondition: the request must still be held back by the delay"
        );

        bridge
            .request_turn_stop(ACTIVE_THREAD, Some(&turn_id))
            .await
            .expect("stop");

        // Well past the delay: the turn must have given up, not parked.
        sleep(Duration::from_millis(400)).await;
        let snapshot = state.read().await;
        assert!(
            snapshot.pending_approvals.is_empty(),
            "a stopped turn must not publish its delayed approval request"
        );
        assert!(
            snapshot.active_turn_id.is_none(),
            "the stopped turn must stay settled, not re-arm itself"
        );
        assert!(
            !snapshot
                .active_flags
                .iter()
                .any(|flag| flag == "waitingOnApproval"),
            "the thread must not be left waiting on an approval nobody can answer"
        );
    }

    #[tokio::test]
    async fn a_stop_racing_the_approval_publish_never_leaves_a_gateless_request() {
        // The nastier half of the delayed-approval race, and the one a timed stop
        // cannot reach: `request_turn_stop` sets the stop flag and THEN scans the
        // gate map, so a stop that scans while the turn sits BETWEEN its stop-flag
        // check and its gate registration finds nothing to cancel — and the turn
        // then parks on a channel nobody will ever fire.
        //
        // Forced deterministically rather than with a lucky sleep: holding the
        // state write lock parks the turn exactly in that gap (it has to read state
        // to decide whether it is still foreground), so the stop is guaranteed to
        // scan an empty gate map. Whatever order the two then resume in, the thread
        // must converge to idle with no pending request.
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "delayed-approval".to_string(),
                FakeTurnScenario {
                    reply: Some("approved".to_string()),
                    chunks: Some(vec!["approved".to_string()]),
                    chunk_delay_ms: Some(0),
                    require_approval: true,
                    approval_delay_ms: Some(200),
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        let turn_id = bridge
            .start_turn(
                ACTIVE_THREAD,
                "delayed-approval",
                "fake-echo",
                "medium",
                &[],
            )
            .await
            .expect("turn")
            .expect("turn id");

        // Let the turn publish its user message first (that needs the write lock),
        // then take the lock so the turn parks the moment its delay elapses.
        sleep(Duration::from_millis(50)).await;
        let guard = state.write().await;

        let stopper = async {
            // t≈250ms: past the 200ms delay, so the turn is parked in the gap.
            sleep(Duration::from_millis(200)).await;
            bridge
                .request_turn_stop(ACTIVE_THREAD, Some(&turn_id))
                .await
        };
        let releaser = async {
            // t≈300ms: the stop has already scanned the (empty) gate map.
            sleep(Duration::from_millis(250)).await;
            drop(guard);
        };
        let (stop_result, ()) = tokio::join!(stopper, releaser);
        stop_result.expect("stop");

        sleep(Duration::from_millis(400)).await;
        let snapshot = state.read().await;
        assert!(
            snapshot.pending_approvals.is_empty(),
            "a stop that raced the publish must not leave a request parked with no gate"
        );
        assert!(
            snapshot.active_turn_id.is_none(),
            "the stopped turn must settle, not hang on an uncancellable channel"
        );
        assert!(
            !snapshot
                .active_flags
                .iter()
                .any(|flag| flag == "waitingOnApproval"),
            "the thread must not be left waiting on an approval nobody can answer"
        );
    }

    #[tokio::test]
    async fn switching_threads_during_an_approval_delay_does_not_gate_a_background_turn() {
        // "Only foreground turns gate" has to hold when the request is PUBLISHED,
        // not when the turn started. The delay makes that gap wide enough to walk
        // through: switch the active thread while the request is held back.
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = test_scenario_harness(
            &temp,
            HashMap::from([(
                "delayed-approval".to_string(),
                FakeTurnScenario {
                    reply: Some("approved".to_string()),
                    chunks: Some(vec!["approved".to_string()]),
                    chunk_delay_ms: Some(0),
                    require_approval: true,
                    approval_delay_ms: Some(200),
                    ..FakeTurnScenario::default()
                },
            )]),
        );
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(
                ACTIVE_THREAD,
                "delayed-approval",
                "fake-echo",
                "medium",
                &[],
            )
            .await
            .expect("turn")
            .expect("turn id");

        // Inside the delay: the reader moves to another thread.
        sleep(Duration::from_millis(50)).await;
        {
            let mut relay = state.write().await;
            relay.activate_thread(
                test_thread("fake-thread-other", "/tmp/project"),
                "/tmp/project",
                "fake-echo",
                "bypass",
                "workspace-write",
                "medium",
                "device-1",
            );
        }

        sleep(Duration::from_millis(400)).await;
        let snapshot = state.read().await;
        assert!(
            snapshot.pending_approvals.is_empty(),
            "a backgrounded turn must not publish an approval request"
        );
        assert!(
            !snapshot
                .active_flags
                .iter()
                .any(|flag| flag == "waitingOnApproval"),
            "the newly-active thread must not inherit a waiting flag"
        );
    }

    async fn wait_for_pending_ask_user(
        state: &Arc<RwLock<RelayState>>,
    ) -> Option<PendingAskUserQuestion> {
        for _ in 0..100 {
            if let Some(pending) = state
                .read()
                .await
                .pending_ask_user_questions
                .values()
                .next()
                .cloned()
            {
                return Some(pending);
            }
            sleep(Duration::from_millis(10)).await;
        }
        None
    }

    fn ask_user_scenario(temp: &tempfile::TempDir, extra_trailing: bool) -> FakeScenarioHarness {
        test_scenario_harness(
            temp,
            HashMap::from([(
                "ask".to_string(),
                FakeTurnScenario {
                    reply: Some("done".to_string()),
                    chunks: Some(vec!["done".to_string()]),
                    chunk_delay_ms: Some(0),
                    ask_user: Some(FakeAskUserSpec::Enabled(true)),
                    ask_user_trailing_text: extra_trailing
                        .then(|| "Meanwhile, here is some context.".to_string()),
                    ..FakeTurnScenario::default()
                },
            )]),
        )
    }

    #[tokio::test]
    async fn a_scenario_can_park_the_turn_on_a_real_ask_user_question() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = ask_user_scenario(&temp, true);
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(ACTIVE_THREAD, "ask", "fake-echo", "medium", &[])
            .await
            .expect("turn");

        let pending = wait_for_pending_ask_user(&state)
            .await
            .expect("scenario question");
        assert_eq!(pending.thread_id, ACTIVE_THREAD);
        assert_eq!(pending.questions.len(), 1);
        assert_eq!(pending.questions[0].options.len(), 2);

        let snapshot = state.read().await.snapshot();
        assert!(
            snapshot
                .active_flags
                .iter()
                .any(|flag| flag == "waitingOnAskUser"),
            "a parked question must raise the waiting flag"
        );
        assert!(
            snapshot.active_turn_id.is_some(),
            "the turn stays in flight while the question is outstanding"
        );

        // The tool entry the frontend matches on, by `tool:<tool_use_id>`.
        let ask_item_id = format!("tool:{}", pending.tool_use_id);
        let ask_index = snapshot
            .transcript
            .iter()
            .position(|entry| entry.item_id.as_deref() == Some(ask_item_id.as_str()))
            .expect("ask-user tool entry");
        let trailing_index = snapshot
            .transcript
            .iter()
            .position(|entry| {
                entry
                    .text
                    .as_deref()
                    .is_some_and(|text| text.contains("Meanwhile"))
            })
            .expect("trailing entry");
        // The SERVER keeps natural conversation order — pinning the unanswered
        // question to the bottom is purely a render-time decision, so that the
        // entry can drop back into place the moment it is answered.
        assert!(
            ask_index < trailing_index,
            "the server must not reorder the transcript; the pin is a frontend concern"
        );

        // Answering releases the turn.
        let mut answers = serde_json::Map::new();
        answers.insert(
            "Which approach should we take?".to_string(),
            serde_json::json!("Option A"),
        );
        bridge
            .respond_to_ask_user_question(&pending.request_id, &answers)
            .await
            .expect("answer accepted");

        for _ in 0..100 {
            if state.read().await.active_turn_id.is_none() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        assert!(
            state.read().await.active_turn_id.is_none(),
            "answering the question must let the turn finish"
        );
    }

    #[tokio::test]
    async fn an_empty_answer_map_is_rejected_rather_than_silently_unblocking() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = ask_user_scenario(&temp, false);
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(ACTIVE_THREAD, "ask", "fake-echo", "medium", &[])
            .await
            .expect("turn");
        let pending = wait_for_pending_ask_user(&state)
            .await
            .expect("scenario question");

        assert!(
            bridge
                .respond_to_ask_user_question(&pending.request_id, &serde_json::Map::new())
                .await
                .is_err(),
            "an empty answer map means the wizard was skipped"
        );
        assert!(
            !state.read().await.pending_ask_user_questions.is_empty(),
            "the question stays outstanding after a rejected answer"
        );
    }

    #[tokio::test]
    async fn stopping_a_turn_parked_on_a_question_settles_it() {
        // Same hazard as the approval gate: a parked question must be cancellable,
        // or `stop` leaves the turn waiting on a channel nobody will ever fire.
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = ask_user_scenario(&temp, false);
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        let turn_id = bridge
            .start_turn(ACTIVE_THREAD, "ask", "fake-echo", "medium", &[])
            .await
            .expect("turn")
            .expect("turn id");
        wait_for_pending_ask_user(&state)
            .await
            .expect("scenario question");

        bridge
            .request_turn_stop(ACTIVE_THREAD, Some(&turn_id))
            .await
            .expect("stop");

        for _ in 0..100 {
            if state.read().await.active_turn_id.is_none() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        let snapshot = state.read().await;
        assert!(
            snapshot.active_turn_id.is_none(),
            "a stopped turn must not hang on an unanswerable question"
        );
        assert!(
            !snapshot
                .active_flags
                .iter()
                .any(|flag| flag == "waitingOnAskUser"),
            "the waiting flag must be cleared by the stop"
        );
    }

    fn delayed_ask_user_scenario(temp: &tempfile::TempDir) -> FakeScenarioHarness {
        test_scenario_harness(
            temp,
            HashMap::from([(
                "ask".to_string(),
                FakeTurnScenario {
                    reply: Some("done".to_string()),
                    chunks: Some(vec!["done".to_string()]),
                    chunk_delay_ms: Some(0),
                    ask_user: Some(FakeAskUserSpec::Enabled(true)),
                    ask_user_delay_ms: Some(200),
                    ask_user_trailing_text: Some("Meanwhile, here is some context.".to_string()),
                    ..FakeTurnScenario::default()
                },
            )]),
        )
    }

    #[tokio::test]
    async fn stopping_inside_the_ask_user_delay_leaves_no_ghost_question_card() {
        // Writing the question's tool card before checking the stop flag left a
        // `running` card (and its trailing message) behind on a turn that had
        // already been told to stop — content resurrected after cancellation.
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = delayed_ask_user_scenario(&temp);
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        let turn_id = bridge
            .start_turn(ACTIVE_THREAD, "ask", "fake-echo", "medium", &[])
            .await
            .expect("turn")
            .expect("turn id");
        sleep(Duration::from_millis(50)).await;
        bridge
            .request_turn_stop(ACTIVE_THREAD, Some(&turn_id))
            .await
            .expect("stop");

        sleep(Duration::from_millis(400)).await;
        let snapshot = state.read().await.snapshot();
        assert!(
            snapshot.pending_ask_user_questions.is_empty(),
            "a stopped turn must not publish its delayed question"
        );
        assert!(
            !snapshot.transcript.iter().any(|entry| entry
                .tool
                .as_ref()
                .is_some_and(|tool| tool.name == "AskUserQuestion")),
            "no ghost question card may be left in the transcript"
        );
        assert!(
            !snapshot.transcript.iter().any(|entry| entry
                .text
                .as_deref()
                .is_some_and(|t| t.contains("Meanwhile"))),
            "the trailing message must not appear either"
        );
        assert!(snapshot.active_turn_id.is_none(), "the turn must settle");
    }

    #[tokio::test]
    async fn switching_threads_inside_the_ask_user_delay_publishes_nothing() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = delayed_ask_user_scenario(&temp);
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(ACTIVE_THREAD, "ask", "fake-echo", "medium", &[])
            .await
            .expect("turn");
        sleep(Duration::from_millis(50)).await;
        {
            let mut relay = state.write().await;
            relay.activate_thread(
                test_thread("fake-thread-other", "/tmp/project"),
                "/tmp/project",
                "fake-echo",
                "bypass",
                "workspace-write",
                "medium",
                "device-1",
            );
        }

        sleep(Duration::from_millis(400)).await;
        let snapshot = state.read().await.snapshot();
        assert!(
            snapshot.pending_ask_user_questions.is_empty(),
            "a backgrounded turn must not publish a question"
        );
        assert!(
            !snapshot.transcript.iter().any(|entry| entry
                .tool
                .as_ref()
                .is_some_and(|tool| tool.name == "AskUserQuestion")),
            "and must not leave a question card stuck on `running`"
        );
    }

    #[tokio::test]
    async fn the_answer_that_was_actually_given_is_what_gets_recorded() {
        // The result preview used to be hardcoded to Option A, so choosing
        // anything else was misreported in the saved history.
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = ask_user_scenario(&temp, false);
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(ACTIVE_THREAD, "ask", "fake-echo", "medium", &[])
            .await
            .expect("turn");
        let pending = wait_for_pending_ask_user(&state)
            .await
            .expect("scenario question");

        let mut answers = serde_json::Map::new();
        answers.insert(
            "Which approach should we take?".to_string(),
            serde_json::json!("Option B — actually, let us reconsider"),
        );
        bridge
            .respond_to_ask_user_question(&pending.request_id, &answers)
            .await
            .expect("answer accepted");

        for _ in 0..100 {
            if state.read().await.active_turn_id.is_none() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        let snapshot = state.read().await.snapshot();
        let ask_entry = snapshot
            .transcript
            .iter()
            .find(|entry| {
                entry
                    .tool
                    .as_ref()
                    .is_some_and(|tool| tool.name == "AskUserQuestion")
            })
            .expect("ask-user entry");
        let preview = ask_entry
            .tool
            .as_ref()
            .and_then(|tool| tool.result_preview.as_deref())
            .unwrap_or_default();
        assert!(
            preview.contains("Option B — actually, let us reconsider"),
            "the recorded answer must be the one that was given, got: {preview}"
        );
        assert!(
            !preview.contains("Option A"),
            "an answer that was never chosen must not be recorded, got: {preview}"
        );
    }

    #[tokio::test]
    async fn a_cancelled_question_is_never_recorded_as_answered() {
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = ask_user_scenario(&temp, false);
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        let turn_id = bridge
            .start_turn(ACTIVE_THREAD, "ask", "fake-echo", "medium", &[])
            .await
            .expect("turn")
            .expect("turn id");
        wait_for_pending_ask_user(&state)
            .await
            .expect("scenario question");
        bridge
            .request_turn_stop(ACTIVE_THREAD, Some(&turn_id))
            .await
            .expect("stop");

        sleep(Duration::from_millis(300)).await;
        let snapshot = state.read().await.snapshot();
        let ask_entry = snapshot
            .transcript
            .iter()
            .find(|entry| {
                entry
                    .tool
                    .as_ref()
                    .is_some_and(|tool| tool.name == "AskUserQuestion")
            })
            .expect("ask-user entry");
        assert_eq!(
            ask_entry
                .tool
                .as_ref()
                .and_then(|tool| tool.result_preview.clone()),
            None,
            "a cancelled question must carry no answer at all"
        );
        assert_eq!(
            ask_entry.status, "failed",
            "and must be terminal rather than stuck on running"
        );
    }

    #[tokio::test]
    async fn an_answered_question_and_its_trailing_message_persist_with_the_turn() {
        // They were only written to the live RelayState, so a thread re-read (or
        // switching away and back) dropped both — which is exactly the history
        // that "an answered question returns to its original position" relies on.
        let temp = tempfile::tempdir().expect("temporary control directory");
        let harness = ask_user_scenario(&temp, true);
        let (bridge, state) = bridge_with_scenarios("bypass", harness.clone()).await;

        bridge
            .start_turn(ACTIVE_THREAD, "ask", "fake-echo", "medium", &[])
            .await
            .expect("turn");
        let pending = wait_for_pending_ask_user(&state)
            .await
            .expect("scenario question");
        let mut answers = serde_json::Map::new();
        answers.insert(
            "Which approach should we take?".to_string(),
            serde_json::json!("Option A"),
        );
        bridge
            .respond_to_ask_user_question(&pending.request_id, &answers)
            .await
            .expect("answer accepted");

        for _ in 0..100 {
            if state.read().await.active_turn_id.is_none() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }

        let stored = bridge
            .read_thread(ACTIVE_THREAD)
            .await
            .expect("read thread");
        let ask_index = stored
            .transcript
            .iter()
            .position(|entry| {
                entry
                    .tool
                    .as_ref()
                    .is_some_and(|tool| tool.name == "AskUserQuestion")
            })
            .expect("the answered question must persist");
        let trailing_index = stored
            .transcript
            .iter()
            .position(|entry| {
                entry
                    .text
                    .as_deref()
                    .is_some_and(|t| t.contains("Meanwhile"))
            })
            .expect("the trailing message must persist");
        assert!(
            ask_index < trailing_index,
            "persisted history keeps natural conversation order (the pin is render-only)"
        );
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
