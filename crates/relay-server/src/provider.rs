use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::RwLock;
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
    ) -> Result<ThreadSummaryView, String>;
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
    async fn interrupt_turn(&self, thread_id: &str, turn_id: &str) -> Result<(), String>;
    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String>;
    fn provider_name(&self) -> &'static str;
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
        .filter(|entry| {
            requested.iter().any(|name| {
                *name == entry.provider_key
                    || *name == entry.binary_name
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
        let result: Result<Arc<dyn ProviderBridge>, String> = match entry.provider_key {
            "claude_code" => match crate::claude::ClaudeCodeBridge::spawn(state.clone()).await {
                Ok(bridge) => Ok(Arc::new(bridge)),
                Err(e) => Err(e),
            },
            _ => match crate::codex::CodexBridge::spawn(
                state.clone(),
                entry.binary_name,
                entry.display_name,
                entry.provider_key,
            )
            .await
            {
                Ok(bridge) => Ok(Arc::new(bridge)),
                Err(e) => Err(e),
            },
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
