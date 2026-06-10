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
pub struct StartThreadResult {
    pub thread: ThreadSummaryView,
    pub consumed_initial_prompt: bool,
    pub initial_user_message: Option<TranscriptEntryView>,
    pub started_turn_id: Option<String>,
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
    async fn resume_thread(
        &self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String>;
    async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String>;
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
) -> HashMap<String, Arc<dyn ProviderBridge>> {
    let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();

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

        match result {
            Ok(bridge) => {
                let name = bridge.provider_name().to_string();
                providers.insert(name, bridge);
            }
            Err(error) => {
                warn!(
                    "Failed to start {} agent provider: {}",
                    entry.display_name, error
                );
            }
        }
    }

    providers
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
