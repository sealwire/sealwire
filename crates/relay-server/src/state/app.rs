use std::{collections::HashMap, process::Stdio, sync::Arc};

use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{watch, RwLock},
};
use tracing::warn;

use crate::{
    broker::BrokerConfig,
    codex::split_unified_diff_by_file,
    protocol::{
        AllowedRootsInput, AllowedRootsReceipt, ApplyFileChangeInput, ApplyFileChangeReceipt,
        ApprovalDecision, ApprovalDecisionInput, ApprovalReceipt, BulkRevokeDevicesReceipt,
        FileChangeApplyDirection, FileChangeDiffView, HeartbeatInput, ModelOptionView,
        PairingDecision, PairingDecisionInput, PairingDecisionReceipt, PairingStartInput,
        PairingTicketView, ReadThreadEntriesInput, ReadThreadEntryDetailInput,
        ReadThreadTranscriptInput, ResumeSessionInput, RevokeDeviceReceipt, SendMessageInput,
        SessionSnapshot, StartSessionInput, StopTurnInput, TakeOverInput, ThreadArchiveReceipt,
        ThreadDeleteReceipt, ThreadEntriesResponse, ThreadEntryDetailResponse,
        ThreadTranscriptResponse, ThreadsResponse, UpdateSessionSettingsInput,
        WorkspaceDiffResponse,
    },
    provider::{spawn_providers, ProviderBridge},
};

use super::persistence::{spawn_persistence_task, PersistedRelayState, PersistenceStore};
use super::{
    ensure_path_within_allowed_roots, ensure_path_within_device_scope, expire_controller_if_needed,
    non_empty, normalize_allowed_roots, normalize_cwd, path_within_allowed_roots,
    path_within_device_scope, require_device_id, short_device_id, sort_threads_by_recency,
    unix_now, CachedRemoteActionResult, RelayState, RemoteActionReplayDecision, SecurityProfile,
};

#[derive(Clone)]
pub struct AppState {
    relay: Arc<RwLock<RelayState>>,
    providers: HashMap<String, Arc<dyn ProviderBridge>>,
    change_tx: watch::Sender<u64>,
}

impl AppState {
    pub async fn new() -> Result<Self, String> {
        let security = SecurityProfile::from_env()?;
        let cwd = std::env::current_dir()
            .map_err(|error| format!("failed to resolve current directory: {error}"))?
            .canonicalize()
            .map_err(|error| format!("failed to canonicalize current directory: {error}"))?;
        let persistence = PersistenceStore::resolve(&cwd);
        let restored_state = match persistence.load().await {
            Ok(state) => state,
            Err(error) => {
                warn!(
                    "failed to load relay state from {}: {}",
                    persistence.path().display(),
                    error
                );
                None
            }
        };
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.display().to_string(),
            change_tx.clone(),
            security,
        )));

        if let Some(ref persisted) = restored_state {
            let mut relay = relay.write().await;
            relay.apply_persisted(persisted);
            relay.push_log(
                "info",
                format!(
                    "Loaded persisted relay state from {}.",
                    persistence.path().display()
                ),
            );
            relay.notify();
        }

        {
            let mut relay = relay.write().await;
            relay.push_log("info", security.summary());
        }

        let providers = spawn_providers(relay.clone()).await;
        spawn_persistence_task(relay.clone(), change_tx.subscribe(), persistence.clone());

        if providers.is_empty() {
            return Err(
                "no agent providers are available; install codex or claude CLI".to_string(),
            );
        }

        {
            let provider_names: Vec<&String> = providers.keys().collect();
            let mut relay = relay.write().await;
            relay.push_log(
                "info",
                format!("Agent providers initialized: {:?}", provider_names),
            );
            relay.notify();
        }

        let state = Self {
            relay,
            providers,
            change_tx,
        };

        state.refresh_model_catalog().await;

        if let Some(persisted) = restored_state {
            state.restore_persisted_session(persisted).await;
        }

        crate::broker::spawn_broker_task(state.clone()).await?;

        Ok(state)
    }

    pub async fn snapshot(&self) -> SessionSnapshot {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        relay.snapshot()
    }

    pub fn available_providers(&self) -> Vec<String> {
        let mut providers: Vec<String> = self.providers.keys().cloned().collect();
        providers.sort_by(|left, right| match (left.as_str(), right.as_str()) {
            ("codex", "codex") => std::cmp::Ordering::Equal,
            ("codex", _) => std::cmp::Ordering::Less,
            (_, "codex") => std::cmp::Ordering::Greater,
            _ => left.cmp(right),
        });
        providers
    }

    pub async fn provider_models(
        &self,
        provider_name: &str,
    ) -> Result<Vec<ModelOptionView>, String> {
        let (_, bridge) = self.resolve_provider(Some(provider_name))?;
        bridge.list_models().await
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.change_tx.subscribe()
    }

    fn active_provider(&self) -> Option<(&str, &Arc<dyn ProviderBridge>)> {
        let name = {
            self.relay.try_read().ok().and_then(|r| {
                if r.provider_name.is_empty() {
                    None
                } else {
                    Some(r.provider_name.clone())
                }
            })
        };
        match name {
            Some(name) => self
                .providers
                .get_key_value(&name)
                .map(|(k, v)| (k.as_str(), v)),
            None => self.providers.iter().next().map(|(k, v)| (k.as_str(), v)),
        }
    }

    fn require_active_provider(&self) -> Result<(&str, &Arc<dyn ProviderBridge>), String> {
        self.active_provider()
            .ok_or_else(|| "no agent provider available".to_string())
    }

    fn resolve_provider(
        &self,
        provider_name: Option<&str>,
    ) -> Result<(&str, &Arc<dyn ProviderBridge>), String> {
        match provider_name {
            Some(name) => self
                .providers
                .get_key_value(name)
                .map(|(k, v)| (k.as_str(), v))
                .ok_or_else(|| format!("agent provider '{name}' is not available")),
            None => self.require_active_provider(),
        }
    }

    async fn find_thread_provider(
        &self,
        thread_id: &str,
    ) -> Result<(&str, &Arc<dyn ProviderBridge>), String> {
        // First check the relay's cached thread list
        {
            let relay = self.relay.read().await;
            for thread in &relay.threads {
                if thread.id == thread_id {
                    if let Some((name, bridge)) = self.providers.get_key_value(&thread.provider) {
                        return Ok((name.as_str(), bridge));
                    }
                }
            }
        }
        // Fall back to probing each provider's thread list
        for (name, bridge) in &self.providers {
            match bridge.list_threads(200).await {
                Ok(threads) => {
                    if threads.iter().any(|t| t.id == thread_id) {
                        return Ok((name.as_str(), bridge));
                    }
                }
                Err(_) => continue,
            }
        }
        Err(format!(
            "thread '{thread_id}' was not found on any provider"
        ))
    }

    pub async fn list_threads(
        &self,
        limit: usize,
        device_id: Option<String>,
    ) -> Result<ThreadsResponse, String> {
        let mut all_threads = Vec::new();
        for (provider_name, bridge) in &self.providers {
            match bridge.list_threads(limit).await {
                Ok(mut threads) => {
                    for thread in &mut threads {
                        thread.provider = provider_name.clone();
                    }
                    all_threads.extend(threads);
                }
                Err(error) => {
                    self.push_runtime_log(
                        "warn",
                        format!("Failed to list {provider_name} threads: {error}"),
                    )
                    .await;
                }
            }
        }
        let mut relay = self.relay.write().await;
        let allowed_roots = relay.allowed_roots.clone();
        let device_scope = device_id
            .as_deref()
            .map(|id| relay.device_path_scope(id))
            .unwrap_or_default();
        let mut threads = relay
            .filter_deleted_threads(all_threads)
            .into_iter()
            .filter(|thread| path_within_device_scope(&thread.cwd, &device_scope, &allowed_roots))
            .collect::<Vec<_>>();
        sort_threads_by_recency(&mut threads);
        threads.truncate(limit);
        let response_threads = threads.clone();
        relay.threads = threads;
        relay.notify();
        Ok(ThreadsResponse {
            threads: response_threads,
        })
    }

    pub async fn update_allowed_roots(
        &self,
        input: AllowedRootsInput,
    ) -> Result<AllowedRootsReceipt, String> {
        let allowed_roots = normalize_allowed_roots(input.allowed_roots)?;
        let mut relay = self.relay.write().await;
        let changed = relay.set_allowed_roots(allowed_roots.clone());

        if changed {
            let current_cwd = relay.current_cwd.clone();
            relay.push_log(
                "info",
                if allowed_roots.is_empty() {
                    "Cleared relay workspace restrictions. Any workspace can be started or resumed."
                        .to_string()
                } else {
                    format!("Updated relay allowed roots: {}.", allowed_roots.join(", "))
                },
            );
            if relay.active_thread_id.is_some()
                && !path_within_allowed_roots(&current_cwd, &allowed_roots)
            {
                relay.push_log(
                    "warn",
                    format!(
                        "Current session workspace {} is outside the configured allowed roots. New sends, starts, and resumes will be blocked until you switch back to an allowed directory.",
                        current_cwd
                    ),
                );
            }
            relay.notify();
        }

        Ok(AllowedRootsReceipt {
            allowed_roots,
            message: if changed {
                "Relay workspace restrictions saved.".to_string()
            } else {
                "Relay workspace restrictions were already up to date.".to_string()
            },
        })
    }

    pub async fn archive_thread(&self, thread_id: &str) -> Result<ThreadArchiveReceipt, String> {
        let archived_active_thread = {
            let relay = self.relay.read().await;
            relay.can_archive_thread(thread_id)?
        };

        self.find_thread_provider(thread_id)
            .await?
            .1
            .archive_thread(thread_id)
            .await?;

        {
            let mut relay = self.relay.write().await;
            let removed = relay.remove_thread(thread_id);
            if archived_active_thread {
                relay.clear_active_session();
            }
            relay.push_log(
                "info",
                if archived_active_thread {
                    format!("Archived active thread {thread_id} from local history and cleared the current session.")
                } else {
                    format!("Archived thread {thread_id} from local history.")
                },
            );
            if removed {
                relay.notify();
            }
        }

        let _ = self.list_threads(20, None).await;

        Ok(ThreadArchiveReceipt {
            thread_id: thread_id.to_string(),
            message: "Session archived and removed from local history.".to_string(),
        })
    }

    pub async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<ThreadDeleteReceipt, String> {
        let deleted_active_thread = {
            let relay = self.relay.read().await;
            relay.can_delete_thread(thread_id)?
        };

        let delete_summary = self
            .find_thread_provider(thread_id)
            .await?
            .1
            .delete_thread_permanently(thread_id)
            .await?;

        {
            let mut relay = self.relay.write().await;
            if deleted_active_thread {
                relay.clear_active_session();
            }
            relay.mark_thread_deleted(thread_id);
            relay.push_log(
                "info",
                format!(
                    "{} local thread {thread_id} from provider storage ({} rollout file{} removed, provider row removed: {}).",
                    if deleted_active_thread {
                        "Permanently deleted active"
                    } else {
                        "Permanently deleted"
                    },
                    delete_summary.deleted_paths.len(),
                    if delete_summary.deleted_paths.len() == 1 { "" } else { "s" },
                    delete_summary.deleted_thread_row
                ),
            );
            relay.notify();
        }

        let _ = self.list_threads(20, None).await;

        Ok(ThreadDeleteReceipt {
            thread_id: thread_id.to_string(),
            message: if deleted_active_thread {
                "Active session permanently deleted from local provider storage.".to_string()
            } else {
                "Session permanently deleted from local provider storage.".to_string()
            },
        })
    }

    pub async fn start_session(&self, input: StartSessionInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let defaults = self.defaults().await;
        let cwd = normalize_cwd(&non_empty(input.cwd).unwrap_or(defaults.current_cwd));
        {
            let relay = self.relay.read().await;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(&cwd, &device_scope, &relay.allowed_roots)?;
        }
        let requested_model = non_empty(input.model);
        let approval_policy = non_empty(input.approval_policy).unwrap_or(defaults.approval_policy);
        let sandbox = non_empty(input.sandbox).unwrap_or(defaults.sandbox);
        let (provider_name, bridge) = self.resolve_provider(input.provider.as_deref())?;
        let provider_models = self
            .load_provider_model_catalog(provider_name, bridge)
            .await;
        let model = requested_model
            .or_else(|| preferred_model(&provider_models).map(|model| model.model.clone()))
            .unwrap_or_else(|| defaults.model.clone());
        let effort = non_empty(input.effort)
            .or_else(|| default_effort_for_model(&provider_models, &model))
            .unwrap_or(defaults.reasoning_effort);
        let initial_prompt = non_empty(input.initial_prompt);

        let start_result = bridge
            .start_thread(
                &cwd,
                &model,
                &approval_policy,
                &sandbox,
                initial_prompt.as_deref(),
            )
            .await?;

        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(provider_name.to_string());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
            }
            relay.activate_thread(
                start_result.thread,
                &cwd,
                &model,
                &approval_policy,
                &sandbox,
                &effort,
                &device_id,
            );
            relay.push_log(
                "info",
                format!(
                    "Started a new {provider_name} thread in {cwd}. Control is now on {}.",
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        if let Some(initial_prompt) =
            initial_prompt.filter(|_| !start_result.consumed_initial_prompt)
        {
            return self
                .send_message(SendMessageInput {
                    text: initial_prompt,
                    model: Some(model),
                    effort: Some(effort),
                    device_id: Some(device_id),
                })
                .await;
        }

        let _ = self.list_threads(20, Some(device_id.clone())).await;
        Ok(self.snapshot().await)
    }

    pub async fn resume_session(
        &self,
        input: ResumeSessionInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let defaults = self.defaults().await;
        let approval_policy = non_empty(input.approval_policy).unwrap_or(defaults.approval_policy);
        let sandbox = non_empty(input.sandbox).unwrap_or(defaults.sandbox);

        let (provider_name, bridge) = self.find_thread_provider(&input.thread_id).await?;
        let provider_models = self
            .load_provider_model_catalog(provider_name, bridge)
            .await;
        let effort = non_empty(input.effort)
            .or_else(|| default_effort_for_model(&provider_models, &defaults.model))
            .unwrap_or(defaults.reasoning_effort);
        let preview = bridge.read_thread(&input.thread_id).await?;
        {
            let relay = self.relay.read().await;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &preview.thread.cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
        }

        bridge
            .resume_thread(&input.thread_id, &approval_policy, &sandbox)
            .await?;

        let thread_data = bridge.read_thread(&input.thread_id).await?;
        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(provider_name.to_string());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
            }
            relay.load_thread_data(thread_data, &approval_policy, &sandbox, &effort, &device_id);
            relay.push_log(
                "info",
                format!(
                    "Resumed thread {}. Control is now on {}.",
                    input.thread_id,
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        let _ = self.list_threads(20, None).await;
        Ok(self.snapshot().await)
    }

    pub async fn update_session_settings(
        &self,
        input: UpdateSessionSettingsInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        self.expire_stale_controller_if_needed().await;

        let (thread_id, next_approval_policy, next_sandbox) = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;

            if relay.active_turn_id.is_some() {
                return Err(
                    "cannot change session settings while a turn is in progress".to_string()
                );
            }
            if !relay.pending_approvals.is_empty() {
                return Err(
                    "cannot change session settings while approvals are pending".to_string()
                );
            }
            if relay.current_status != "idle" {
                return Err(format!(
                    "cannot change session settings while agent is `{}`",
                    relay.current_status
                ));
            }

            let thread_id = relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active thread to update".to_string())?;
            let next_approval_policy =
                non_empty(input.approval_policy).unwrap_or_else(|| relay.approval_policy.clone());
            let next_sandbox = non_empty(input.sandbox).unwrap_or_else(|| relay.sandbox.clone());

            if next_approval_policy == relay.approval_policy && next_sandbox == relay.sandbox {
                return Ok(relay.snapshot());
            }

            (thread_id, next_approval_policy, next_sandbox)
        };

        let (_provider_name, bridge) = self.find_thread_provider(&thread_id).await?;
        bridge
            .resume_thread(&thread_id, &next_approval_policy, &next_sandbox)
            .await?;

        {
            let mut relay = self.relay.write().await;
            relay.approval_policy = next_approval_policy.clone();
            relay.sandbox = next_sandbox.clone();
            relay.assign_active_controller(&device_id, unix_now());
            relay.push_log(
                "info",
                format!(
                    "Updated session settings on thread {thread_id}: approval={next_approval_policy}, sandbox={next_sandbox} (from {}).",
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        Ok(self.snapshot().await)
    }

    pub async fn read_thread_transcript(
        &self,
        input: ReadThreadTranscriptInput,
    ) -> Result<ThreadTranscriptResponse, String> {
        {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            if relay.active_thread_id.as_deref() == Some(input.thread_id.as_str()) {
                ensure_path_within_device_scope(
                    &relay.current_cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
                let transcript = relay
                    .transcript
                    .iter()
                    .map(|entry| entry.to_view())
                    .collect::<Vec<_>>();
                let revision = relay.transcript_revision();

                if input.before.is_some() {
                    return Ok(ThreadTranscriptResponse::from_transcript_before(
                        input.thread_id,
                        transcript,
                        input.before,
                        revision,
                    ));
                }

                return Ok(ThreadTranscriptResponse::from_transcript_tail(
                    input.thread_id,
                    transcript,
                    revision,
                ));
            }
        }

        let thread_data = self
            .find_thread_provider(&input.thread_id)
            .await?
            .1
            .read_thread(&input.thread_id)
            .await?;
        {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            ensure_path_within_device_scope(
                &thread_data.thread.cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
        }

        if input.before.is_some() {
            return Ok(ThreadTranscriptResponse::from_transcript_before(
                input.thread_id,
                thread_data.transcript,
                input.before,
                0,
            ));
        }

        Ok(ThreadTranscriptResponse::from_transcript_tail(
            input.thread_id,
            thread_data.transcript,
            0,
        ))
    }

    pub async fn read_thread_entries(
        &self,
        input: ReadThreadEntriesInput,
    ) -> Result<ThreadEntriesResponse, String> {
        {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            if relay.active_thread_id.as_deref() == Some(input.thread_id.as_str()) {
                ensure_path_within_device_scope(
                    &relay.current_cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
                let transcript = relay
                    .transcript
                    .iter()
                    .map(|entry| entry.to_view())
                    .collect::<Vec<_>>();

                return Ok(ThreadEntriesResponse::from_item_ids(
                    input.thread_id,
                    transcript,
                    input.item_ids,
                ));
            }
        }

        let thread_data = self
            .find_thread_provider(&input.thread_id)
            .await?
            .1
            .read_thread(&input.thread_id)
            .await?;
        {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            ensure_path_within_device_scope(
                &thread_data.thread.cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
        }

        Ok(ThreadEntriesResponse::from_item_ids(
            input.thread_id,
            thread_data.transcript,
            input.item_ids,
        ))
    }

    pub async fn read_thread_entry_detail(
        &self,
        input: ReadThreadEntryDetailInput,
    ) -> Result<ThreadEntryDetailResponse, String> {
        let relay_entry = {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            if relay.active_thread_id.as_deref() == Some(input.thread_id.as_str()) {
                ensure_path_within_device_scope(
                    &relay.current_cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
                relay
                    .transcript
                    .iter()
                    .find(|entry| entry.item_id == input.item_id)
                    .filter(|entry| entry.kind != crate::protocol::TranscriptEntryKind::ToolCall)
                    .map(|entry| entry.to_view())
            } else {
                None
            }
        };

        let entry = if let Some(entry) = relay_entry {
            entry
        } else {
            let thread_data = self
                .find_thread_provider(&input.thread_id)
                .await?
                .1
                .read_thread(&input.thread_id)
                .await?;
            {
                let relay = self.relay.read().await;
                let device_scope = input
                    .device_id
                    .as_deref()
                    .map(|id| relay.device_path_scope(id))
                    .unwrap_or_default();
                ensure_path_within_device_scope(
                    &thread_data.thread.cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
            }

            self.find_thread_provider(&input.thread_id)
                .await?
                .1
                .read_thread_entry_detail(&input.thread_id, &input.item_id)
                .await?
                .ok_or_else(|| {
                    format!(
                        "thread entry `{}` was not found in thread `{}`",
                        input.item_id, input.thread_id
                    )
                })?
        };

        if let Some(field) = input.field.as_deref() {
            return ThreadEntryDetailResponse::from_entry_chunk(
                input.thread_id,
                &entry,
                field,
                input.cursor.unwrap_or_default(),
            );
        }

        ThreadEntryDetailResponse::from_entry(input.thread_id, entry)
    }

    pub async fn send_message(&self, input: SendMessageInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        self.expire_stale_controller_if_needed().await;
        let defaults = self.defaults().await;
        let text = non_empty(Some(input.text))
            .ok_or_else(|| "message text cannot be empty".to_string())?;
        let model = non_empty(input.model).unwrap_or(defaults.model);
        let effort = non_empty(input.effort).unwrap_or(defaults.reasoning_effort);
        let thread_id = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active Codex thread to send to".to_string())?
        };

        let turn_id = self
            .require_active_provider()?
            .1
            .start_turn(&thread_id, &text, &model, &effort)
            .await?;
        {
            let mut relay = self.relay.write().await;
            relay.assign_active_controller(&device_id, unix_now());
            relay.active_turn_id = turn_id;
            relay.model = model.clone();
            relay.reasoning_effort = effort.clone();
            relay.push_log(
                "info",
                format!("Sent a prompt to thread {thread_id} with {model} / {effort}."),
            );
            relay.notify();
        }

        Ok(self.snapshot().await)
    }

    pub async fn stop_active_turn(&self, input: StopTurnInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        self.expire_stale_controller_if_needed().await;
        let (thread_id, turn_id) = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            let thread_id = relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active Codex thread to stop".to_string())?;
            let turn_id = relay
                .active_turn_id
                .clone()
                .ok_or_else(|| "there is no running Codex turn to stop".to_string())?;
            (thread_id, turn_id)
        };

        self.require_active_provider()?
            .1
            .interrupt_turn(&thread_id, &turn_id)
            .await?;

        {
            let mut relay = self.relay.write().await;
            relay.assign_active_controller(&device_id, unix_now());
            if relay.active_thread_id.as_deref() == Some(thread_id.as_str())
                && relay.active_turn_id.as_deref() == Some(turn_id.as_str())
            {
                relay.set_active_turn(None);
                relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
            }
            relay.push_log(
                "info",
                format!(
                    "Stop requested for turn {turn_id} in thread {thread_id} from {}.",
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        Ok(self.snapshot().await)
    }

    pub async fn heartbeat_session(
        &self,
        input: HeartbeatInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        relay.refresh_controller_lease(&device_id, unix_now());
        Ok(relay.snapshot())
    }

    pub async fn take_over_control(&self, input: TakeOverInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        if relay.active_thread_id.is_none() {
            return Err("there is no active session to take over".to_string());
        }

        let changed = relay.set_active_controller(&device_id);
        if changed {
            relay.push_log(
                "info",
                format!("Control moved to {}.", short_device_id(&device_id)),
            );
            relay.notify();
        }

        Ok(relay.snapshot())
    }

    pub async fn decide_approval(
        &self,
        request_id: &str,
        input: ApprovalDecisionInput,
    ) -> Result<ApprovalReceipt, ApprovalError> {
        let device_id =
            require_device_id(input.device_id.clone()).map_err(ApprovalError::Bridge)?;
        let pending = {
            let relay = self.relay.read().await;
            relay
                .ensure_device_can_approve(&device_id)
                .map_err(ApprovalError::Bridge)?;
            relay
                .pending_approvals
                .get(request_id)
                .cloned()
                .ok_or(ApprovalError::NoPendingRequest)?
        };

        self.require_active_provider()
            .map_err(ApprovalError::Bridge)?
            .1
            .respond_to_approval(&pending, &input)
            .await
            .map_err(ApprovalError::Bridge)?;

        let mut relay = self.relay.write().await;
        relay.pending_approvals.remove(request_id);
        relay.push_log(
            "info",
            format!(
                "Responded to approval {request_id} with {:?} from {}.",
                input.decision,
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        Ok(ApprovalReceipt {
            request_id: request_id.to_string(),
            decision: input.decision,
            resulting_state: "approval_response_sent".to_string(),
            message: match input.decision {
                ApprovalDecision::Approve => "Remote approval sent to Codex.".to_string(),
                ApprovalDecision::Deny => "Remote denial sent to Codex.".to_string(),
                ApprovalDecision::Cancel => "Remote cancel sent to Codex.".to_string(),
            },
        })
    }

    pub async fn workspace_diff(
        &self,
        device_id: Option<String>,
    ) -> Result<WorkspaceDiffResponse, String> {
        let cwd = {
            let relay = self.relay.read().await;
            let device_scope = device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            relay.current_cwd.clone()
        };
        collect_workspace_diff(&cwd).await
    }

    pub async fn apply_file_change(
        &self,
        item_id: &str,
        input: ApplyFileChangeInput,
    ) -> Result<ApplyFileChangeReceipt, String> {
        let device_id = require_device_id(input.device_id)?;
        let (cwd, diff) = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            let entry = relay
                .transcript
                .iter()
                .find(|entry| entry.item_id == item_id)
                .ok_or_else(|| format!("file change `{item_id}` was not found"))?;
            let tool = entry
                .tool
                .as_ref()
                .ok_or_else(|| format!("entry `{item_id}` is not a file change"))?;
            let diff = tool
                .diff
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    let parts = tool
                        .file_changes
                        .iter()
                        .filter(|change| !change.diff.trim().is_empty())
                        .map(|change| change.diff.clone())
                        .collect::<Vec<_>>();
                    (!parts.is_empty()).then(|| parts.join("\n"))
                })
                .ok_or_else(|| format!("file change `{item_id}` has no diff to apply"))?;
            (relay.current_cwd.clone(), diff)
        };

        apply_unified_diff(&cwd, &diff, input.direction).await?;

        let mut relay = self.relay.write().await;
        relay.set_file_change_apply_state(
            item_id,
            match input.direction {
                FileChangeApplyDirection::Rollback => {
                    crate::protocol::FileChangeApplyState::RolledBack
                }
                FileChangeApplyDirection::Reapply => crate::protocol::FileChangeApplyState::Applied,
            },
        );
        relay.push_log(
            "info",
            format!(
                "{} file change {item_id} from {}.",
                match input.direction {
                    FileChangeApplyDirection::Rollback => "Rolled back",
                    FileChangeApplyDirection::Reapply => "Reapplied",
                },
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        Ok(ApplyFileChangeReceipt {
            item_id: item_id.to_string(),
            direction: input.direction,
            resulting_state: "diff_applied".to_string(),
            message: match input.direction {
                FileChangeApplyDirection::Rollback => "File change rolled back.".to_string(),
                FileChangeApplyDirection::Reapply => "File change reapplied.".to_string(),
            },
        })
    }

    pub async fn start_pairing(
        &self,
        input: PairingStartInput,
    ) -> Result<PairingTicketView, String> {
        let broker = BrokerConfig::from_env().await?.ok_or_else(|| {
            "broker pairing is unavailable because RELAY_BROKER_URL is not configured".to_string()
        })?;
        let path_scope = normalize_allowed_roots(input.path_scope.unwrap_or_default())?;
        {
            let relay = self.relay.read().await;
            for root in &path_scope {
                ensure_path_within_allowed_roots(root, &relay.allowed_roots).map_err(|err| {
                    format!("pairing path scope {root} cannot exceed relay allowed roots: {err}")
                })?;
            }
        }
        let prepared = {
            let mut relay = self.relay.write().await;
            relay.prepare_pairing_ticket(input.expires_in_seconds, path_scope)?
        };
        let pairing_credential = match broker
            .pairing_join_credential(&prepared.pairing_id, prepared.expires_at)
            .await
        {
            Ok(credential) => credential,
            Err(error) => {
                let mut relay = self.relay.write().await;
                relay.pending_pairings.remove(&prepared.pairing_id);
                return Err(error);
            }
        };
        let mut relay = self.relay.write().await;
        let ticket = relay.render_pairing_ticket_view(
            &prepared,
            broker.public_base_url(),
            broker.broker_room_id(),
            &pairing_credential.token,
            broker.relay_peer_id(),
        );
        relay.push_log(
            "info",
            format!(
                "Started pairing ticket {} for broker channel {}.",
                ticket.pairing_id, ticket.broker_channel_id
            ),
        );
        relay.notify();
        Ok(ticket)
    }

    pub async fn revoke_device(&self, device_id: &str) -> Result<RevokeDeviceReceipt, String> {
        let broker = BrokerConfig::from_env().await?;
        let mut relay = self.relay.write().await;
        let revoked = relay.revoke_paired_device(device_id, unix_now());
        if revoked {
            relay.push_log("info", format!("Revoked paired device {device_id}."));
            relay.notify();
        }
        drop(relay);
        if revoked {
            if let Some(broker) = broker {
                if let Err(error) = broker.revoke_device_credential(device_id).await {
                    self.push_runtime_log(
                        "warn",
                        format!(
                            "Local revoke for {device_id} succeeded, but broker credential revoke failed: {error}"
                        ),
                    )
                    .await;
                }
            }
        }
        Ok(RevokeDeviceReceipt {
            device_id: device_id.to_string(),
            revoked,
        })
    }

    pub async fn revoke_other_devices(
        &self,
        keep_device_id: &str,
    ) -> Result<BulkRevokeDevicesReceipt, String> {
        let broker = BrokerConfig::from_env().await?;
        let mut relay = self.relay.write().await;
        let revoked_device_ids =
            relay.revoke_all_other_paired_devices(keep_device_id, unix_now())?;
        if !revoked_device_ids.is_empty() {
            relay.push_log(
                "info",
                format!(
                    "Revoked {} paired device(s) and kept {}.",
                    revoked_device_ids.len(),
                    keep_device_id
                ),
            );
            relay.notify();
        }
        drop(relay);
        if !revoked_device_ids.is_empty() {
            if let Some(broker) = broker {
                if let Err(error) = broker.revoke_other_device_credentials(keep_device_id).await {
                    self.push_runtime_log(
                        "warn",
                        format!(
                            "Local bulk revoke kept {keep_device_id}, but broker credential revoke failed: {error}"
                        ),
                    )
                    .await;
                }
            }
        }
        Ok(BulkRevokeDevicesReceipt {
            kept_device_id: keep_device_id.to_string(),
            revoked_count: revoked_device_ids.len(),
            revoked_device_ids,
        })
    }

    pub async fn decide_pairing_request(
        &self,
        pairing_id: &str,
        input: PairingDecisionInput,
    ) -> Result<PairingDecisionReceipt, String> {
        let broker = BrokerConfig::from_env().await?.ok_or_else(|| {
            "broker pairing is unavailable because RELAY_BROKER_URL is not configured".to_string()
        })?;
        let now = unix_now();
        let approved = matches!(input.decision, PairingDecision::Approve);
        let pending_request = if approved {
            Some({
                let relay = self.relay.read().await;
                relay
                    .pending_pairing_requests
                    .get(pairing_id)
                    .map(|request| {
                        (
                            request.device_id.clone(),
                            request.label.clone(),
                            request.device_verify_key.clone(),
                        )
                    })
                    .ok_or_else(|| "pairing request is not waiting for approval".to_string())?
            })
        } else {
            None
        };
        let broker_credential = if let Some((device_id, _, _)) = pending_request.as_ref() {
            Some(
                broker
                    .device_broker_credential(
                        device_id,
                        broker.predicted_device_join_expires_at(now),
                    )
                    .await?,
            )
        } else {
            None
        };
        let client_grant =
            if let Some((device_id, device_label, device_verify_key)) = pending_request.as_ref() {
                broker
                    .client_broker_grant(device_id, device_verify_key, Some(device_label.clone()))
                    .await?
            } else {
                None
            };
        let mut relay = self.relay.write().await;
        let mut result = match relay.decide_pairing_request(
            pairing_id,
            approved,
            broker_credential
                .as_ref()
                .and_then(|credential| credential.join_credential.expires_at),
            now,
        ) {
            Ok(result) => result,
            Err(error) => {
                drop(relay);
                if let Some((device_id, _, _)) = pending_request.as_ref() {
                    let _ = broker.revoke_device_credential(device_id).await;
                }
                return Err(error);
            }
        };
        if let Some(credential) = broker_credential {
            relay.attach_pairing_broker_credential(
                pairing_id,
                credential.refresh_token.clone(),
                credential.join_credential.token.clone(),
                credential.join_credential.expires_at,
                now,
            )?;
            result.device_refresh_token = credential.refresh_token;
            result.device_join_ticket = Some(credential.join_credential.token);
            result.device_join_ticket_expires_at = credential.join_credential.expires_at;
        }
        if let Some(grant) = client_grant {
            relay.attach_pairing_client_grant(
                pairing_id,
                Some(grant.relay_id.clone()),
                grant.relay_label.clone(),
                Some(grant.client_id.clone()),
                Some(grant.refresh_token.clone()),
            )?;
            result.relay_id = Some(grant.relay_id);
            result.relay_label = grant.relay_label;
            result.client_id = Some(grant.client_id);
            result.client_refresh_token = Some(grant.refresh_token);
        }
        let message = match input.decision {
            PairingDecision::Approve => {
                relay.push_log(
                    "info",
                    format!(
                        "Approved pairing request {pairing_id} for {}.",
                        result
                            .device
                            .as_ref()
                            .map(|device| device.device_id.as_str())
                            .unwrap_or("unknown-device")
                    ),
                );
                "Pairing request approved on the local relay.".to_string()
            }
            PairingDecision::Reject => {
                relay.push_log("info", format!("Rejected pairing request {pairing_id}."));
                "Pairing request rejected on the local relay.".to_string()
            }
        };
        relay
            .pending_broker_messages
            .push(super::BrokerPendingMessage::PairingResult(result));
        relay.notify();
        Ok(PairingDecisionReceipt {
            pairing_id: pairing_id.to_string(),
            decision: input.decision,
            resulting_state: match input.decision {
                PairingDecision::Approve => "approved".to_string(),
                PairingDecision::Reject => "rejected".to_string(),
            },
            message,
        })
    }

    async fn defaults(&self) -> SessionDefaults {
        let relay = self.relay.read().await;
        SessionDefaults {
            current_cwd: relay.current_cwd.clone(),
            model: relay.model.clone(),
            approval_policy: relay.approval_policy.clone(),
            sandbox: relay.sandbox.clone(),
            reasoning_effort: relay.reasoning_effort.clone(),
        }
    }

    async fn refresh_model_catalog(&self) {
        match self.require_active_provider() {
            Ok((provider_name, bridge)) => {
                if let Some(models) = self
                    .load_provider_model_catalog(provider_name, bridge)
                    .await
                {
                    let mut relay = self.relay.write().await;
                    relay.set_available_models(models);
                    relay.notify();
                }
            }
            Err(_) => {}
        }
    }

    async fn load_provider_model_catalog(
        &self,
        provider_name: &str,
        bridge: &Arc<dyn ProviderBridge>,
    ) -> Option<Vec<ModelOptionView>> {
        match bridge.list_models().await {
            Ok(models) => Some(models),
            Err(error) => {
                self.push_runtime_log(
                    "warn",
                    format!("Failed to load {provider_name} model catalog: {error}"),
                )
                .await;
                None
            }
        }
    }

    async fn expire_stale_controller_if_needed(&self) {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
    }

    async fn restore_persisted_session(&self, persisted: PersistedRelayState) {
        let Some(thread_id) = persisted.active_thread_id.clone() else {
            return;
        };

        let (provider_name, bridge) = match self.find_thread_provider(&thread_id).await {
            Ok(found) => found,
            Err(_) => return,
        };

        let restore_result = match bridge
            .resume_thread(&thread_id, &persisted.approval_policy, &persisted.sandbox)
            .await
        {
            Ok(()) => bridge.read_thread(&thread_id).await,
            Err(error) => Err(error),
        };

        match restore_result {
            Ok(thread_data) => {
                let provider_models = self
                    .load_provider_model_catalog(provider_name, bridge)
                    .await;
                let mut relay = self.relay.write().await;
                relay.set_provider_name(provider_name.to_string());
                if let Some(models) = provider_models {
                    relay.set_available_models(models);
                }
                relay.restore_thread_data(thread_data, &persisted);
                expire_controller_if_needed(&mut relay);
                relay.push_log(
                    "info",
                    format!("Restored persisted session for thread {thread_id}."),
                );
                relay.notify();
            }
            Err(error) => {
                let mut relay = self.relay.write().await;
                relay.clear_active_session();
                relay.push_log(
                    "warn",
                    format!("Failed to restore persisted session for thread {thread_id}: {error}"),
                );
                relay.notify();
            }
        }
    }

    pub(crate) async fn set_broker_channel(
        &self,
        channel_id: Option<String>,
        peer_id: Option<String>,
    ) {
        let mut relay = self.relay.write().await;
        relay.set_broker_target(channel_id, peer_id);
        relay.notify();
    }

    pub(crate) async fn set_broker_connection(&self, connected: bool) {
        let mut relay = self.relay.write().await;
        if relay.broker_connected == connected {
            return;
        }
        relay.set_broker_connection(connected);
        relay.notify();
    }

    pub(crate) async fn update_surface_presence(&self, peer_id: &str, connected: bool) -> bool {
        let mut relay = self.relay.write().await;
        if connected {
            relay.mark_surface_peer_online(peer_id)
        } else {
            relay.mark_surface_peer_offline(peer_id)
        }
    }

    pub(crate) async fn replace_online_surface_peers<I>(&self, peer_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        let mut relay = self.relay.write().await;
        relay.replace_online_surface_peers(peer_ids);
    }

    pub(crate) async fn push_runtime_log(&self, kind: &'static str, message: String) {
        let mut relay = self.relay.write().await;
        relay.push_log(kind, message);
        relay.notify();
    }

    pub(crate) async fn complete_pairing(
        &self,
        pairing_id: &str,
        requested_device_id: Option<String>,
        device_label: Option<String>,
        device_verify_key: String,
        peer_id: &str,
    ) -> Result<crate::protocol::PendingPairingRequestView, String> {
        let mut relay = self.relay.write().await;
        let request = relay.register_pairing_request(
            pairing_id,
            requested_device_id,
            device_label,
            peer_id,
            device_verify_key,
            unix_now(),
        )?;
        relay.push_log(
            "info",
            format!(
                "Registered pending pairing request {} from broker peer {}.",
                pairing_id, peer_id
            ),
        );
        relay.notify();
        Ok(request)
    }

    pub(crate) async fn drain_pending_broker_messages(&self) -> Vec<super::BrokerPendingMessage> {
        let mut relay = self.relay.write().await;
        relay.drain_pending_broker_messages()
    }

    pub(crate) async fn pending_pairing_secret(&self, pairing_id: &str) -> Result<String, String> {
        let mut relay = self.relay.write().await;
        relay.pending_pairing_secret(pairing_id, unix_now())
    }

    pub(crate) async fn completed_pairing_result(
        &self,
        pairing_id: &str,
        device_verify_key: &str,
        peer_id: &str,
    ) -> Result<Option<super::PendingPairingResult>, String> {
        let mut relay = self.relay.write().await;
        relay.completed_pairing_result(pairing_id, device_verify_key, peer_id, unix_now())
    }

    pub(crate) async fn paired_device_payload_secret(
        &self,
        device_id: &str,
    ) -> Result<String, String> {
        let relay = self.relay.read().await;
        relay.paired_device_payload_secret(device_id)
    }

    pub(crate) async fn paired_device_verify_key(&self, device_id: &str) -> Result<String, String> {
        let relay = self.relay.read().await;
        relay.paired_device_verify_key(device_id)
    }

    pub(crate) async fn issue_claim_challenge(
        &self,
        device_id: &str,
        peer_id: &str,
    ) -> Result<super::IssuedClaimChallenge, String> {
        let mut relay = self.relay.write().await;
        relay.issue_claim_challenge(device_id, peer_id, unix_now())
    }

    pub(crate) async fn claim_challenge(
        &self,
        device_id: &str,
        challenge_id: &str,
        peer_id: &str,
    ) -> Result<super::ClaimChallenge, String> {
        let mut relay = self.relay.write().await;
        relay.claim_challenge(device_id, challenge_id, peer_id, unix_now())
    }

    pub(crate) async fn complete_remote_claim(
        &self,
        device_id: &str,
        challenge_id: &str,
        peer_id: &str,
    ) -> Result<super::CompletedRemoteClaim, String> {
        let mut relay = self.relay.write().await;
        let claim = relay.complete_remote_claim(device_id, challenge_id, peer_id, unix_now())?;
        relay.notify();
        Ok(claim)
    }

    pub(crate) async fn mark_remote_device_seen(
        &self,
        device_id: &str,
        peer_id: &str,
    ) -> Result<(), String> {
        let mut relay = self.relay.write().await;
        relay.mark_paired_device_seen(device_id, peer_id, unix_now())?;
        Ok(())
    }

    pub(crate) async fn broker_can_read_content(&self) -> bool {
        let relay = self.relay.read().await;
        relay.snapshot().broker_can_read_content
    }

    pub(crate) async fn broker_targets(&self) -> Vec<BrokerTarget> {
        let relay = self.relay.read().await;
        relay
            .broker_targets()
            .into_iter()
            .map(|(device_id, peer_id, payload_secret)| BrokerTarget {
                device_id,
                peer_id,
                payload_secret,
            })
            .collect()
    }

    pub(crate) async fn reserve_remote_action(
        &self,
        device_id: &str,
        action_id: &str,
        action_kind: &str,
    ) -> Result<RemoteActionReplayDecision, String> {
        let mut relay = self.relay.write().await;
        relay.reserve_remote_action(device_id, action_id, action_kind, unix_now())
    }

    pub(crate) async fn store_remote_action_result(
        &self,
        device_id: &str,
        action_id: &str,
        result: CachedRemoteActionResult,
    ) {
        let mut relay = self.relay.write().await;
        relay.store_remote_action_result(device_id, action_id, result, unix_now());
    }
}

async fn apply_unified_diff(
    cwd: &str,
    diff: &str,
    direction: FileChangeApplyDirection,
) -> Result<(), String> {
    let mut command = Command::new("git");
    command
        .arg("apply")
        .arg("--whitespace=nowarn")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if matches!(direction, FileChangeApplyDirection::Rollback) {
        command.arg("--reverse");
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start git apply: {error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(diff.as_bytes())
            .await
            .map_err(|error| format!("failed to send diff to git apply: {error}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("failed to wait for git apply: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        "git apply failed".to_string()
    } else {
        format!("git apply failed: {message}")
    })
}

const WORKSPACE_DIFF_MAX_BYTES: usize = 4 * 1024 * 1024;
const WORKSPACE_DIFF_UNTRACKED_MAX_BYTES: usize = 64 * 1024;

async fn collect_workspace_diff(cwd: &str) -> Result<WorkspaceDiffResponse, String> {
    let generated_at = unix_now();
    let inside = run_git_capture(cwd, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !inside.status.success() {
        return Ok(WorkspaceDiffResponse {
            cwd: cwd.to_string(),
            file_changes: Vec::new(),
            diff: String::new(),
            truncated: false,
            not_a_git_repo: true,
            generated_at,
        });
    }

    let tracked = run_git_capture(cwd, &["diff", "--no-color", "HEAD"]).await?;
    if !tracked.status.success() {
        let stderr = String::from_utf8_lossy(&tracked.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git diff HEAD failed".to_string()
        } else {
            format!("git diff HEAD failed: {stderr}")
        });
    }
    let (tracked_diff, tracked_truncated) =
        truncate_to_char_boundary(tracked.stdout, WORKSPACE_DIFF_MAX_BYTES);
    let mut file_changes = split_unified_diff_by_file(&tracked_diff);

    let untracked_listing =
        run_git_capture(cwd, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
    let mut untracked_truncated = false;
    if untracked_listing.status.success() {
        for raw_path in untracked_listing.stdout.split(|byte| *byte == 0) {
            if raw_path.is_empty() {
                continue;
            }
            let path = match std::str::from_utf8(raw_path) {
                Ok(value) => value.to_string(),
                Err(_) => continue,
            };
            match synthesize_untracked_diff(cwd, &path).await {
                Ok((diff, file_truncated)) => {
                    if file_truncated {
                        untracked_truncated = true;
                    }
                    file_changes.push(FileChangeDiffView {
                        path,
                        change_type: "add".to_string(),
                        diff,
                    });
                }
                Err(_) => {
                    file_changes.push(FileChangeDiffView {
                        path,
                        change_type: "add".to_string(),
                        diff: String::new(),
                    });
                }
            }
        }
    }

    Ok(WorkspaceDiffResponse {
        cwd: cwd.to_string(),
        diff: tracked_diff,
        file_changes,
        truncated: tracked_truncated || untracked_truncated,
        not_a_git_repo: false,
        generated_at,
    })
}

async fn run_git_capture(cwd: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("failed to run git {}: {error}", args.join(" ")))
}

fn truncate_to_char_boundary(mut bytes: Vec<u8>, limit: usize) -> (String, bool) {
    if bytes.len() <= limit {
        return (String::from_utf8_lossy(&bytes).into_owned(), false);
    }
    bytes.truncate(limit);
    while !bytes.is_empty() && std::str::from_utf8(&bytes).is_err() {
        bytes.pop();
    }
    (String::from_utf8_lossy(&bytes).into_owned(), true)
}

async fn synthesize_untracked_diff(cwd: &str, rel_path: &str) -> Result<(String, bool), String> {
    use tokio::io::AsyncReadExt;

    let abs = std::path::Path::new(cwd).join(rel_path);
    let metadata = tokio::fs::metadata(&abs)
        .await
        .map_err(|error| format!("stat failed for {rel_path}: {error}"))?;
    if !metadata.is_file() {
        return Ok((String::new(), false));
    }
    let mut file = tokio::fs::File::open(&abs)
        .await
        .map_err(|error| format!("open failed for {rel_path}: {error}"))?;
    let mut buf = Vec::with_capacity(
        metadata
            .len()
            .min(WORKSPACE_DIFF_UNTRACKED_MAX_BYTES as u64) as usize,
    );
    let mut take = (&mut file).take(WORKSPACE_DIFF_UNTRACKED_MAX_BYTES as u64);
    take.read_to_end(&mut buf)
        .await
        .map_err(|error| format!("read failed for {rel_path}: {error}"))?;
    let truncated = (metadata.len() as usize) > buf.len();
    if buf.contains(&0) {
        return Ok((String::new(), truncated));
    }
    let text = match std::str::from_utf8(&buf) {
        Ok(value) => value,
        Err(_) => return Ok((String::new(), truncated)),
    };
    let mut lines: Vec<&str> = text.split('\n').collect();
    let trailing_newline = matches!(lines.last(), Some(&""));
    if trailing_newline {
        lines.pop();
    }
    let line_count = lines.len();

    let mut diff = String::new();
    diff.push_str(&format!("diff --git a/{rel_path} b/{rel_path}\n"));
    diff.push_str("new file mode 100644\n");
    diff.push_str("--- /dev/null\n");
    diff.push_str(&format!("+++ b/{rel_path}\n"));
    if line_count > 0 {
        diff.push_str(&format!("@@ -0,0 +1,{line_count} @@\n"));
        for (idx, line) in lines.iter().enumerate() {
            diff.push('+');
            diff.push_str(line);
            if idx + 1 < line_count || trailing_newline {
                diff.push('\n');
            }
        }
        if !trailing_newline {
            diff.push_str("\n\\ No newline at end of file\n");
        }
    }
    Ok((diff, truncated))
}

#[derive(Debug)]
pub enum ApprovalError {
    NoPendingRequest,
    Bridge(String),
}

#[derive(Clone)]
struct SessionDefaults {
    current_cwd: String,
    model: String,
    approval_policy: String,
    sandbox: String,
    reasoning_effort: String,
}

fn preferred_model(models: &Option<Vec<ModelOptionView>>) -> Option<&ModelOptionView> {
    let models = models.as_ref()?;
    models
        .iter()
        .find(|model| model.is_default)
        .or_else(|| models.first())
}

fn default_effort_for_model(
    models: &Option<Vec<ModelOptionView>>,
    model_name: &str,
) -> Option<String> {
    models
        .as_ref()?
        .iter()
        .find(|model| model.model == model_name)
        .map(|model| model.default_reasoning_effort.clone())
        .or_else(|| preferred_model(models).map(|model| model.default_reasoning_effort.clone()))
}

#[derive(Clone)]
pub(crate) struct BrokerTarget {
    pub(crate) device_id: String,
    pub(crate) peer_id: String,
    pub(crate) payload_secret: String,
}

#[cfg(test)]
mod workspace_diff_tests {
    use super::{collect_workspace_diff, synthesize_untracked_diff, truncate_to_char_boundary};
    use tempfile::TempDir;
    use tokio::process::Command;

    async fn run(cmd: &mut Command) {
        let output = cmd.output().await.expect("git command should run");
        assert!(
            output.status.success(),
            "git failed: stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    async fn init_repo() -> TempDir {
        let dir = TempDir::new().expect("tmpdir");
        let path = dir.path().to_path_buf();
        run(Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(&path))
        .await;
        run(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&path))
        .await;
        run(Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&path))
        .await;
        std::fs::write(path.join("seed.txt"), "line1\nline2\n").unwrap();
        run(Command::new("git")
            .args(["add", "seed.txt"])
            .current_dir(&path))
        .await;
        run(Command::new("git")
            .args(["commit", "-q", "-m", "seed"])
            .current_dir(&path))
        .await;
        dir
    }

    #[test]
    fn truncate_caps_and_marks_truncated() {
        let bytes = vec![b'a'; 10];
        let (text, truncated) = truncate_to_char_boundary(bytes, 4);
        assert_eq!(text, "aaaa");
        assert!(truncated);
    }

    #[test]
    fn truncate_under_limit_is_not_truncated() {
        let (text, truncated) = truncate_to_char_boundary(b"hello".to_vec(), 100);
        assert_eq!(text, "hello");
        assert!(!truncated);
    }

    #[test]
    fn truncate_respects_utf8_boundary() {
        // "héllo" — 'é' is 2 bytes (0xC3 0xA9). Limit 2 should drop into mid-char,
        // then back off to "h".
        let bytes = "héllo".as_bytes().to_vec();
        let (text, truncated) = truncate_to_char_boundary(bytes, 2);
        assert_eq!(text, "h");
        assert!(truncated);
    }

    #[tokio::test]
    async fn synthesize_untracked_emits_added_lines() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("new.txt"), "alpha\nbeta\n").unwrap();
        let (diff, truncated) = synthesize_untracked_diff(&dir.path().to_string_lossy(), "new.txt")
            .await
            .unwrap();
        assert!(!truncated);
        assert!(diff.contains("new file mode 100644"));
        assert!(diff.contains("+++ b/new.txt"));
        assert!(diff.contains("@@ -0,0 +1,2 @@"));
        assert!(diff.contains("+alpha"));
        assert!(diff.contains("+beta"));
    }

    #[tokio::test]
    async fn synthesize_untracked_skips_binary() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("blob.bin"), [0u8, 1, 2, 3, 0]).unwrap();
        let (diff, _truncated) =
            synthesize_untracked_diff(&dir.path().to_string_lossy(), "blob.bin")
                .await
                .unwrap();
        assert_eq!(diff, "");
    }

    #[tokio::test]
    async fn collect_returns_not_a_git_repo_outside_git() {
        let dir = TempDir::new().unwrap();
        let response = collect_workspace_diff(&dir.path().to_string_lossy())
            .await
            .unwrap();
        assert!(response.not_a_git_repo);
        assert!(response.file_changes.is_empty());
    }

    #[tokio::test]
    async fn collect_shows_tracked_modification() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("seed.txt"), "line1\nLINE2\n").unwrap();
        let response = collect_workspace_diff(&dir.path().to_string_lossy())
            .await
            .unwrap();
        assert!(!response.not_a_git_repo);
        assert_eq!(response.file_changes.len(), 1);
        let change = &response.file_changes[0];
        assert_eq!(change.path, "seed.txt");
        assert_eq!(change.change_type, "update");
        assert!(change.diff.contains("-line2"));
        assert!(change.diff.contains("+LINE2"));
    }

    #[tokio::test]
    async fn collect_includes_untracked_files_as_adds() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("fresh.txt"), "hello\nworld\n").unwrap();
        let response = collect_workspace_diff(&dir.path().to_string_lossy())
            .await
            .unwrap();
        let fresh = response
            .file_changes
            .iter()
            .find(|change| change.path == "fresh.txt")
            .expect("fresh.txt should appear");
        assert_eq!(fresh.change_type, "add");
        assert!(fresh.diff.contains("+hello"));
        assert!(fresh.diff.contains("+world"));
    }

    #[tokio::test]
    async fn collect_clean_tree_returns_no_changes() {
        let dir = init_repo().await;
        let response = collect_workspace_diff(&dir.path().to_string_lossy())
            .await
            .unwrap();
        assert!(!response.not_a_git_repo);
        assert!(response.file_changes.is_empty());
    }
}
