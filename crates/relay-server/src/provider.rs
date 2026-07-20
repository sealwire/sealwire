use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::{
    sync::RwLock,
    time::{timeout, Duration},
};
use tracing::warn;

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{ApprovalDecisionInput, ModelOptionView, ThreadSummaryView, TranscriptEntryView},
    state::{PendingApproval, RelayState},
};

#[derive(Clone)]
pub struct ThreadSyncData {
    pub thread: ThreadSummaryView,
    pub status: String,
    pub active_flags: Vec<String>,
    pub transcript: Vec<TranscriptEntryView>,
}

#[derive(Clone)]
pub struct ThreadTranscriptPageData {
    pub sync: ThreadSyncData,
    pub prev_cursor: Option<usize>,
    pub paged: bool,
}

#[derive(Clone)]
pub struct StartThreadResult {
    pub thread: ThreadSummaryView,
    pub consumed_initial_prompt: bool,
    pub initial_user_message: Option<TranscriptEntryView>,
    pub started_turn_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderForkCapability {
    pub native_fork: bool,
    pub native_fork_at_message: bool,
}

impl ProviderForkCapability {
    pub const REPLAY_ONLY: Self = Self {
        native_fork: false,
        native_fork_at_message: false,
    };
    /// A native fork that always branches at the thread tip (Codex).
    pub const NATIVE_TIP_ONLY: Self = Self {
        native_fork: true,
        native_fork_at_message: false,
    };
    /// A native fork that accepts a branch point (Claude `upToMessageId`).
    pub const NATIVE_AT_MESSAGE: Self = Self {
        native_fork: true,
        native_fork_at_message: true,
    };
}

pub struct ProviderForkRequest {
    pub source_thread_id: String,
    /// Branch point (transcript item id), inclusive. A bridge that cannot fork
    /// at an arbitrary point must return `Ok(None)` when this is set so the
    /// caller falls back to transcript replay, which truncates correctly.
    pub up_to_item_id: Option<String>,
    pub cwd: String,
    pub model: String,
    pub approval_policy: String,
    pub sandbox: String,
}

#[async_trait]
pub trait ProviderBridge: Send + Sync {
    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String>;
    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String>;
    async fn start_thread(
        &self,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
        initial_prompt: Option<&str>,
    ) -> Result<StartThreadResult, String>;
    async fn fork_thread(
        &self,
        _request: ProviderForkRequest,
    ) -> Result<Option<StartThreadResult>, String> {
        Ok(None)
    }

    /// Must agree with `fork_thread`: the default impl replays, so the default
    /// capability claims nothing. A bridge that implements one without the
    /// other makes the UI lie about whether context is preserved.
    fn fork_capability(&self) -> ProviderForkCapability {
        ProviderForkCapability::REPLAY_ONLY
    }
    async fn resume_thread(
        &self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String>;
    async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String>;
    async fn read_thread_transcript_page(
        &self,
        _thread_id: &str,
        _before: Option<usize>,
    ) -> Result<Option<ThreadTranscriptPageData>, String> {
        Ok(None)
    }
    async fn read_thread_entry_detail(
        &self,
        thread_id: &str,
        item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String>;
    async fn archive_thread(&self, thread_id: &str) -> Result<(), String>;
    async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String>;
    async fn start_turn(
        &self,
        thread_id: &str,
        text: &str,
        model: &str,
        effort: &str,
    ) -> Result<Option<String>, String>;
    /// Resolve the public thread id after `start_turn`. Providers whose first
    /// turn promotes a placeholder id (Claude deferred start) override this.
    async fn resolve_started_thread_id(&self, requested_thread_id: &str) -> String {
        requested_thread_id.to_string()
    }
    /// Request that the provider stop the in-flight work for `thread_id`.
    ///
    /// Providers with turn-scoped cancellation (Codex) require `turn_id`.
    /// Providers with session-scoped cancellation (Claude) may stop by thread
    /// alone. Acceptance is not proof of completion; provider lifecycle events
    /// remain the source of truth for relay runtime state.
    async fn request_turn_stop(&self, thread_id: &str, turn_id: Option<&str>)
        -> Result<(), String>;
    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String>;
    /// Submit an answer to a pending AskUserQuestion. The `answers` map is
    /// keyed by question text (matching the SDK's expected
    /// `updatedInput.answers` shape). Providers that don't support
    /// AskUserQuestion should return an error rather than silently no-op.
    async fn respond_to_ask_user_question(
        &self,
        request_id: &str,
        answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String>;
    fn provider_name(&self) -> &'static str;

    /// Whether this provider's `read_thread` reports an `updated_at` that is the
    /// thread's genuine last-activity time (resume-safe) rather than a session
    /// file mtime that a no-prompt resume bumps to ~now. Claude derives it from
    /// the transcript (see the worker's `read_session`), so the relay can
    /// max-fold it into the activity sort key — which also heals activity the
    /// relay never witnessed (e.g. the session used via the CLI between views).
    /// Providers that report a bumpable mtime return `false`; the relay then
    /// freezes their first observation (or-insert) so repeated selection can't
    /// creep the thread up the list.
    fn read_thread_reports_activity_time(&self) -> bool {
        false
    }
}

struct ProviderEntry {
    binary_name: &'static str,
    display_name: &'static str,
    provider_key: &'static str,
}

/// Static per-provider identity captured while spawning, one entry per
/// *configured* provider (in configured order). `spawn_error` is `None` when
/// the bridge spawned OK, or the raw error string when the spawn attempt
/// failed — the string that used to be dropped on the floor at the `warn!`
/// site. The relay pairs this with the live connection map to derive a
/// `ProviderStatusView` on every snapshot.
#[derive(Debug, Clone)]
pub struct ProviderStatusBase {
    pub provider_key: String,
    pub display_name: String,
    pub spawn_error: Option<String>,
}

/// Best-effort classification of a spawn-error string into "the binary isn't
/// there" vs. "it's there but failed". Heuristic on purpose: it keys off the
/// OS ENOENT wording that `Command::spawn` surfaces, and reflects whatever
/// binary actually failed to exec (e.g. `node` for the Claude worker), which
/// is the most honest signal available without a separate PATH probe.
pub fn classify_spawn_error(reason: &str) -> crate::protocol::ProviderStatusKind {
    let low = reason.to_ascii_lowercase();
    if low.contains("no such file")
        || low.contains("os error 2")
        || low.contains("not found")
        || low.contains("cannot find")
    {
        crate::protocol::ProviderStatusKind::NotInstalled
    } else {
        crate::protocol::ProviderStatusKind::Failed
    }
}

const DEFAULT_PROVIDERS: &[ProviderEntry] = &[
    ProviderEntry {
        binary_name: "codex",
        display_name: "Codex",
        provider_key: "codex",
    },
    ProviderEntry {
        binary_name: "claude",
        display_name: "Claude Code",
        provider_key: "claude_code",
    },
];

const FAKE_PROVIDER: ProviderEntry = ProviderEntry {
    binary_name: "fake",
    display_name: "Fake",
    provider_key: "fake",
};

const PROVIDER_START_TIMEOUT_SECS: u64 = 30;

fn provider_start_timeout_secs() -> u64 {
    std::env::var("AGENT_RELAY_PROVIDER_START_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(PROVIDER_START_TIMEOUT_SECS)
}

fn configured_providers() -> Vec<&'static ProviderEntry> {
    let names = std::env::var("AGENT_PROVIDERS")
        .ok()
        .and_then(|v| if v.trim().is_empty() { None } else { Some(v) })
        .unwrap_or_else(|| String::new());

    if names.is_empty() {
        return DEFAULT_PROVIDERS.iter().collect();
    }

    let requested: Vec<&str> = names
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    DEFAULT_PROVIDERS
        .iter()
        .chain(std::iter::once(&FAKE_PROVIDER))
        .filter(|entry| {
            requested.iter().any(|name| {
                *name == entry.provider_key
                    || *name == entry.binary_name
                    || *name == "fake" && entry.provider_key == "fake"
                    || *name == "claude-code" && entry.provider_key == "claude_code"
                    || *name == "claude_code" && entry.provider_key == "claude_code"
                    || *name == "claude" && entry.provider_key == "claude_code"
            })
        })
        .collect()
}

pub async fn spawn_providers(
    state: Arc<RwLock<RelayState>>,
) -> (
    HashMap<String, Arc<dyn ProviderBridge>>,
    Vec<ProviderStatusBase>,
) {
    let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
    // One entry per *configured* provider, in configured order, whether or not
    // it spawned — so the status panel can show failed providers too.
    let mut status_base: Vec<ProviderStatusBase> = Vec::new();

    for entry in configured_providers() {
        let timeout_secs = provider_start_timeout_secs();
        let result = match timeout(
            Duration::from_secs(timeout_secs),
            spawn_provider(entry, state.clone()),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(format!(
                "timed out after {timeout_secs}s while starting {}",
                entry.display_name
            )),
        };

        let spawn_error = match result {
            Ok(bridge) => {
                let name = bridge.provider_name().to_string();
                providers.insert(name, bridge);
                None
            }
            Err(error) => {
                warn!(
                    "Failed to start {} agent provider: {}",
                    entry.display_name, error
                );
                Some(error)
            }
        };
        status_base.push(ProviderStatusBase {
            provider_key: entry.provider_key.to_string(),
            display_name: entry.display_name.to_string(),
            spawn_error,
        });
    }

    (providers, status_base)
}

async fn spawn_provider(
    entry: &'static ProviderEntry,
    state: Arc<RwLock<RelayState>>,
) -> Result<Arc<dyn ProviderBridge>, String> {
    match entry.provider_key {
        "fake" => bridge_arc(crate::fake_provider::FakeProviderBridge::spawn(state).await),
        "claude_code" => bridge_arc(crate::claude::ClaudeCodeBridge::spawn(state).await),
        _ => bridge_arc(
            crate::codex::CodexBridge::spawn(
                state,
                entry.binary_name,
                entry.display_name,
                entry.provider_key,
            )
            .await,
        ),
    }
}

fn bridge_arc<T>(result: Result<T, String>) -> Result<Arc<dyn ProviderBridge>, String>
where
    T: ProviderBridge + 'static,
{
    result.map(|bridge| Arc::new(bridge) as Arc<dyn ProviderBridge>)
}
