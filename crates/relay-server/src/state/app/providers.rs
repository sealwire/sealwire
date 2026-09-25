use super::*;

use crate::protocol::{ThreadSummaryView, TranscriptEntryView};
use crate::state::PendingApproval;

/// How often the background task re-pulls every provider's model catalog. The
/// catalog only changes when a CLI/SDK is upgraded, so a slow cadence is plenty
/// — this exists so a long-idle relay still picks up new/removed models without
/// a restart (each pass only adopts non-empty results, never blanking the cache).
const MODEL_CATALOG_REFRESH_SECS: u64 = 30 * 60;

impl AppState {
    /// API ingress compatibility: a known provider handle is a legacy alias for
    /// its stable relay session id. Canonicalize before any domain lookup or write.
    pub(crate) async fn canonical_session_id(&self, value: &str) -> Result<String, String> {
        self.relay.read().await.canonical_session_id(value)
    }

    /// Fetch and adopt provider-native list rows before any relay-id keyed merge,
    /// lookup, deletion, reviewer, cwd, or device-scope decision sees them.
    ///
    /// A collision is omitted rather than allowed to enter relay state under an id
    /// that already routes somewhere else. Phase 2c cannot mint the distinct public
    /// id needed to represent it; Phase 3 removes that identity-only limitation.
    pub(crate) async fn list_provider_threads(
        &self,
        provider_name: &str,
        bridge: &Arc<dyn ProviderBridge>,
        limit: usize,
    ) -> Result<Vec<ThreadSummaryView>, String> {
        let rows = bridge.list_threads(limit).await?;
        let mut adopted = Vec::with_capacity(rows.len());
        let mut relay = self.relay.write().await;
        for mut row in rows {
            // Permanent deletion deliberately removes the binding but keeps the
            // tombstone. Providers are eventually consistent, so an identity row can
            // linger after delete; adopting it would recreate the binding before the
            // later visibility filter drops the row. Existing non-identity bindings
            // are checked by their stable id and left intact.
            let bound_session = relay.session_for_provider_handle(provider_name, &row.id);
            let tombstone_id = bound_session.as_deref().unwrap_or(row.id.as_str());
            if relay.thread_is_locally_deleted(tombstone_id) {
                continue;
            }
            match relay.adopt_provider_summary(provider_name, &mut row) {
                Ok(_) => adopted.push(row),
                Err(error) => tracing::warn!(
                    provider = provider_name,
                    provider_handle = row.id,
                    %error,
                    "refused provider thread-list row at the result adoption boundary",
                ),
            }
        }
        Ok(adopted)
    }

    /// The one AppState seam for a provider-created session.
    ///
    /// The bridge contract stays `StartThreadResult`; immediately after it returns,
    /// this records/adopts its raw handle and rewrites the summary to the relay id.
    /// Every ordinary, reviewer, team, workflow, delegation, orchestrator, replay,
    /// and native-fork start goes through the same adoption operation.
    pub(crate) async fn start_provider_thread(
        &self,
        provider_name: &str,
        bridge: &Arc<dyn ProviderBridge>,
        request: StartThreadRequest,
    ) -> Result<AdoptedStartThreadResult, String> {
        let result = bridge.start_thread(request).await?;
        self.adopt_provider_start_result(provider_name, bridge, result)
            .await
    }

    pub(crate) async fn adopt_provider_start_result(
        &self,
        provider_name: &str,
        bridge: &Arc<dyn ProviderBridge>,
        mut result: StartThreadResult,
    ) -> Result<AdoptedStartThreadResult, String> {
        let provider_handle = result.thread.id.clone();
        let provider_thread_id = result.provider_thread_id.clone();
        // Creation paths historically stamp both routing fields. Keep that behavior
        // here so no caller can forget one while adopting the id.
        result.thread.provider = provider_name.to_string();
        result.thread.source = provider_name.to_string();
        let adoption = {
            let mut relay = self.relay.write().await;
            if provider_thread_id.is_some() {
                relay.adopt_provider_summary(provider_name, &mut result.thread)
            } else {
                relay.adopt_deferred_provider_summary(provider_name, &mut result.thread)
            }
        };
        let identity = match adoption {
            Ok(identity) => identity,
            Err(error) => {
                let adoption_error = format!(
                    "could not adopt newly-created {provider_name} session '{}': {error}",
                    provider_handle
                );
                // No binding can safely be registered, so this is the one creation
                // cleanup that must address the exact bridge by its raw handle.
                if let Err(release_error) = bridge.release_thread(&provider_handle).await {
                    self.push_runtime_log(
                        "warn",
                        format!(
                            "Could not release unadopted {provider_name} session \
{provider_handle}: {release_error}"
                        ),
                    )
                    .await;
                }
                return Err(adoption_error);
            }
        };
        Ok(AdoptedStartThreadResult { identity, result })
    }

    pub(crate) async fn read_adopted_provider_thread(
        &self,
        identity: &AdoptedProviderSession,
        bridge: &Arc<dyn ProviderBridge>,
        cwd: &str,
    ) -> Result<ThreadSyncData, String> {
        let mut data = bridge
            .read_thread_in_cwd(&identity.provider_handle, cwd)
            .await?;
        identity.canonicalize_sync(&mut data);
        Ok(data)
    }

    pub(crate) async fn fork_provider_thread(
        &self,
        source: &SessionTarget,
        up_to_item_id: Option<String>,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<Option<AdoptedStartThreadResult>, String> {
        let Some(result) = source
            .fork_thread_raw(up_to_item_id, cwd, model, approval_policy, sandbox)
            .await?
        else {
            return Ok(None);
        };
        self.adopt_provider_start_result(&source.provider, &source.bridge, result)
            .await
            .map(Some)
    }

    pub async fn provider_models(
        &self,
        provider_name: &str,
    ) -> Result<Vec<ModelOptionView>, String> {
        let (_, bridge) = self.resolve_provider(Some(provider_name))?;
        match bridge.list_models().await {
            // A non-empty live catalog is authoritative: adopt it as the new
            // last-known so future cold reads can fall back to it.
            Ok(models) if !models.is_empty() => {
                self.provider_model_catalogs
                    .write()
                    .await
                    .insert(provider_name.to_string(), models.clone());
                Ok(models)
            }
            // The live query failed (cold/erroring app-server or worker) or
            // answered before it was ready (empty list). Either way, stale beats
            // empty: serve the last-known catalog and NEVER overwrite the warm
            // cache with the empty result. Without this, a single cold pull made
            // the remote model picker vanish for the whole session.
            live => {
                if let Some(cached) = self.cached_provider_model_catalog(provider_name).await {
                    if !cached.is_empty() {
                        return Ok(cached);
                    }
                }
                // Nothing cached to fall back to — surface the original outcome
                // (an honest error, or a genuinely empty catalog).
                live
            }
        }
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

    pub(super) fn require_active_provider(
        &self,
    ) -> Result<(&str, &Arc<dyn ProviderBridge>), String> {
        self.active_provider()
            .ok_or_else(|| "no agent provider available".to_string())
    }

    /// Names the alternatives: the caller is usually an agent that guessed the name.
    fn unknown_provider_error(&self, name: &str) -> String {
        let available = self.available_providers();
        format!(
            "agent provider '{name}' is not available (have: {})",
            if available.is_empty() {
                "none".to_string()
            } else {
                available.join(", ")
            }
        )
    }

    pub(super) fn resolve_provider(
        &self,
        provider_name: Option<&str>,
    ) -> Result<(&str, &Arc<dyn ProviderBridge>), String> {
        match provider_name {
            Some(name) => self
                .providers
                .get_key_value(name)
                .map(|(k, v)| (k.as_str(), v))
                .ok_or_else(|| self.unknown_provider_error(name)),
            None => self.require_active_provider(),
        }
    }

    pub(super) async fn find_thread_provider(
        &self,
        thread_id: &str,
    ) -> Result<(&str, &Arc<dyn ProviderBridge>), String> {
        // First check the relay's cached thread list
        {
            let relay = self.relay.read().await;
            // A live runtime is the authoritative record of a thread's provider, for the
            // active thread AND background threads (e.g. a just-created reviewer thread).
            // Prefer it: a thread-list refresh can transiently drop a background reviewer
            // row from `relay.threads` (it's filtered out of navigation), and a provider's
            // own `list_threads` may not yet include a brand-new thread that has no
            // persisted turn (Codex persists a session on its first turn). Without this,
            // sending the reviewer prompt fails with "not found on any provider".
            if let Some(summary) = relay
                .runtime_for_thread(thread_id)
                .and_then(|runtime| runtime.summary.as_ref())
            {
                for candidate in [&summary.provider, &summary.source, &summary.model_provider] {
                    if let Some((name, bridge)) = self.providers.get_key_value(candidate) {
                        return Ok((name.as_str(), bridge));
                    }
                }
            }
            for thread in &relay.threads {
                if thread.id == thread_id {
                    for candidate in [&thread.provider, &thread.source, &thread.model_provider] {
                        if let Some((name, bridge)) = self.providers.get_key_value(candidate) {
                            return Ok((name.as_str(), bridge));
                        }
                    }
                    if relay.active_thread_id.as_deref() == Some(thread_id) {
                        if let Some((name, bridge)) =
                            self.providers.get_key_value(&relay.provider_name)
                        {
                            return Ok((name.as_str(), bridge));
                        }
                    }
                }
            }
            if relay.active_thread_id.as_deref() == Some(thread_id) {
                if let Some((name, bridge)) = self.providers.get_key_value(&relay.provider_name) {
                    return Ok((name.as_str(), bridge));
                }
            }
            // A searched thread is typically older than the newest page, so it is in
            // neither `relay.threads` nor the 200-row probe below. See
            // `RelayState::search_routing_hints`.
            if let Some(hint) = relay.search_routing_hint(thread_id) {
                for candidate in [&hint.provider, &hint.source, &hint.model_provider] {
                    if let Some((name, bridge)) = self.providers.get_key_value(candidate) {
                        return Ok((name.as_str(), bridge));
                    }
                }
            }
        }
        // Fall back to probing each provider's thread list
        for (name, bridge) in &self.providers {
            match self.list_provider_threads(name, bridge, 200).await {
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

    /// What the registry alone can say about a session, with no discovery fallback.
    ///
    /// Startup restore needs exactly this: `find_thread_provider` short-circuits to
    /// the boot-default provider at boot, and a binding whose handle is not the
    /// session id has nothing to discover with in the first place.
    pub(crate) async fn bound_session_route(&self, session_id: &str) -> BoundSessionRoute {
        let binding = {
            let relay = self.relay.read().await;
            relay.resolve_session_target(session_id)
        };
        let Some(binding) = binding else {
            return BoundSessionRoute::default();
        };
        let is_non_identity = binding.provider_handle != session_id;
        let target = self
            .providers
            .get_key_value(&binding.provider)
            .map(|(provider, bridge)| SessionTarget {
                session_id: binding.session_id.clone(),
                provider: provider.clone(),
                provider_handle: binding.provider_handle.clone(),
                bridge: bridge.clone(),
            });
        BoundSessionRoute {
            provider: Some(binding.provider),
            target,
            is_non_identity,
        }
    }

    /// Session id -> the bridge AND the handle to call it with: the Phase-2
    /// replacement for `find_thread_provider` at every `ProviderBridge` boundary.
    ///
    /// Falls back to discovery for a session no list has adopted yet (a reviewer
    /// thread created this run, a row older than the deepest page), and records the
    /// identity binding so the next call is a map read.
    ///
    /// Resolve BEFORE taking a relay lock: this may take the write lock itself, and
    /// every caller then awaits the provider with no lock held.
    pub(crate) async fn resolve_session_target(
        &self,
        session_id: &str,
    ) -> Result<SessionTarget, String> {
        let session_id = self.canonical_session_id(session_id).await?;
        let route = self.bound_session_route(&session_id).await;
        if let Some(target) = route.target {
            return Ok(target);
        }
        // A binding naming a provider this relay does not run is usually stale
        // routing metadata and discovery below heals it. It cannot be, once the
        // handle is a string the session id does not spell: that binding is the only
        // record of where the session lives, and guessing an identity handle for some
        // other provider would drive an unrelated thread.
        if route.is_non_identity {
            return Err(format!(
                "session '{session_id}' is bound to provider '{}', which is not available",
                route.provider.unwrap_or_default()
            ));
        }

        let (provider, bridge) = {
            let (name, bridge) = self.find_thread_provider(&session_id).await?;
            (name.to_string(), bridge.clone())
        };
        {
            // A refused bind means another session already owns this handle, so the
            // id is not ours to claim. Phase 2a still routes it the way every call
            // site did before rather than inventing a refusal this phase promised
            // not to add; the identity target below is that same behaviour.
            let mut relay = self.relay.write().await;
            let _ = relay.register_identity_session_binding(&provider, &session_id);
        }
        Ok(SessionTarget {
            session_id: session_id.clone(),
            provider,
            provider_handle: session_id,
            bridge,
        })
    }

    /// Like `resolve_session_target`, but for a session whose owning provider was
    /// recorded when it was created (a task seat).
    ///
    /// The recorded owner wins: a binding that names a DIFFERENT provider would
    /// otherwise redirect a delete/release to a bridge that never owned the thread,
    /// and for those two that is the difference between idempotent and destructive.
    pub(crate) async fn resolve_session_target_on_provider(
        &self,
        session_id: &str,
        provider: &str,
    ) -> Result<SessionTarget, String> {
        let (provider, bridge) = self
            .providers
            .get_key_value(provider)
            .ok_or_else(|| self.unknown_provider_error(provider))?;
        let provider_handle = {
            let relay = self.relay.read().await;
            relay
                .resolve_session_target(session_id)
                .filter(|target| &target.provider == provider)
                .map(|target| target.provider_handle)
        };
        Ok(SessionTarget {
            session_id: session_id.to_string(),
            provider: provider.clone(),
            provider_handle: provider_handle.unwrap_or_else(|| session_id.to_string()),
            bridge: bridge.clone(),
        })
    }

    /// Warm every provider's model catalog in the background at startup.
    ///
    /// The remote client pulls each provider's models right after the handshake
    /// — exactly when a worker-backed provider like Claude is coldest. Without a
    /// warm catalog that pull races a slow/failing `supportedModels()` round-trip
    /// and the new-session dialog silently falls back to a single default model.
    /// Prewarming fills each bridge's in-memory cache so the pull is instant.
    /// Best-effort and non-blocking: failures are logged, never fatal.
    pub(super) fn spawn_model_catalog_prewarm(&self) {
        for (name, bridge) in &self.providers {
            let name = name.clone();
            let bridge = bridge.clone();
            let state = self.clone();
            tokio::spawn(async move {
                let _ = state.load_provider_model_catalog(&name, &bridge).await;
            });
        }
    }

    /// Keep every provider's catalog fresh on a slow cadence, so a relay that
    /// has been running for a long time still reflects model changes without a
    /// restart. Best-effort; an empty/failed pull leaves the warm cache intact.
    pub(super) fn spawn_periodic_model_catalog_refresh(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let interval = std::time::Duration::from_secs(MODEL_CATALOG_REFRESH_SECS);
            loop {
                tokio::time::sleep(interval).await;
                let providers: Vec<(String, Arc<dyn ProviderBridge>)> = state
                    .providers
                    .iter()
                    .map(|(name, bridge)| (name.clone(), bridge.clone()))
                    .collect();
                for (name, bridge) in providers {
                    let _ = state.load_provider_model_catalog(&name, &bridge).await;
                }
            }
        });
    }

    pub(super) async fn refresh_model_catalog(&self) {
        let Ok((provider_name, bridge)) = self
            .require_active_provider()
            .map(|(name, bridge)| (name.to_string(), bridge.clone()))
        else {
            return;
        };
        if let Some(models) = self
            .load_provider_model_catalog(&provider_name, &bridge)
            .await
        {
            let mut relay = self.relay.write().await;
            // The active provider may have changed while we awaited the (slow)
            // catalog load — e.g. a concurrent startup restore switching to codex.
            // Writing a now-stale provider's catalog here is exactly the
            // cross-provider model leak (a restored Codex session left showing
            // Claude's models), so only adopt it if our provider is still active.
            if relay.provider_name == provider_name {
                relay.set_available_models(models);
                relay.notify();
            }
        }
    }

    pub(super) fn spawn_initial_model_catalog_refresh(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            state.refresh_model_catalog().await;
        });
    }

    pub(super) async fn load_provider_model_catalog(
        &self,
        provider_name: &str,
        bridge: &Arc<dyn ProviderBridge>,
    ) -> Option<Vec<ModelOptionView>> {
        match bridge.list_models().await {
            Ok(models) if !models.is_empty() => {
                self.provider_model_catalogs
                    .write()
                    .await
                    .insert(provider_name.to_string(), models.clone());
                Some(models)
            }
            // An empty list means the provider answered before it was ready.
            // Treat it as a soft failure: keep the last-known catalog rather than
            // blanking it (a background refresh must never poison a warm cache).
            Ok(_empty) => {
                self.push_runtime_log(
                    "debug",
                    format!(
                        "{provider_name} model/list returned empty; keeping last-known catalog"
                    ),
                )
                .await;
                None
            }
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

    pub(super) async fn cached_provider_model_catalog(
        &self,
        provider_name: &str,
    ) -> Option<Vec<ModelOptionView>> {
        let active_catalog = {
            let relay = self.relay.read().await;
            (relay.provider_name == provider_name && !relay.available_models.is_empty())
                .then(|| relay.available_models.clone())
        };
        if let Some(models) = active_catalog {
            self.provider_model_catalogs
                .write()
                .await
                .insert(provider_name.to_string(), models.clone());
            return Some(models);
        }

        self.provider_model_catalogs
            .read()
            .await
            .get(provider_name)
            .cloned()
    }
}

/// What a session's binding can offer on its own, before any discovery.
#[derive(Default)]
pub(crate) struct BoundSessionRoute {
    /// The provider the binding names, whether or not this build runs it.
    pub(crate) provider: Option<String>,
    /// Callable only when this build runs that provider.
    pub(crate) target: Option<SessionTarget>,
    /// A binding whose handle is not the session's own id is the ONLY record of
    /// where that session lives. Discovery cannot heal it — no provider has ever
    /// heard the session id — so a caller that cannot use it must fail closed rather
    /// than ask another provider about a string it never issued.
    pub(crate) is_non_identity: bool,
}

/// A provider bridge already paired with the handle to call it with.
///
/// The type exists so a call site cannot hold a session id and a bridge at once and
/// pass the wrong one: every id-bearing method here sends `provider_handle`, and the
/// two that return a thread summary put `session_id` back on it before the relay or a
/// client ever sees it (`markdown/STABLE_SESSION_ID_DESIGN.md`, invariants 2 and 3).
pub(crate) struct SessionTarget {
    pub(crate) session_id: String,
    pub(crate) provider: String,
    pub(crate) provider_handle: String,
    bridge: Arc<dyn ProviderBridge>,
}

impl SessionTarget {
    /// The raw bridge, for the calls that name no thread (model catalogs,
    /// capability questions). Anything that takes a thread id belongs below.
    pub(crate) fn bridge(&self) -> &Arc<dyn ProviderBridge> {
        &self.bridge
    }

    pub(crate) async fn read_thread(&self) -> Result<ThreadSyncData, String> {
        let mut data = self.bridge.read_thread(&self.provider_handle).await?;
        self.result_identity().canonicalize_sync(&mut data);
        Ok(data)
    }

    pub(crate) async fn read_thread_in_cwd(&self, cwd: &str) -> Result<ThreadSyncData, String> {
        let mut data = self
            .bridge
            .read_thread_in_cwd(&self.provider_handle, cwd)
            .await?;
        self.result_identity().canonicalize_sync(&mut data);
        Ok(data)
    }

    pub(crate) fn result_identity(&self) -> AdoptedProviderSession {
        AdoptedProviderSession {
            provider: self.provider.clone(),
            provider_handle: self.provider_handle.clone(),
            session_id: self.session_id.clone(),
        }
    }

    pub(crate) async fn resume_thread(
        &self,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String> {
        self.bridge
            .resume_thread(&self.provider_handle, approval_policy, sandbox)
            .await
    }

    pub(crate) async fn start_turn(
        &self,
        text: &str,
        model: &str,
        effort: &str,
        images: &[ProviderImage],
    ) -> Result<Option<String>, String> {
        self.bridge
            .start_turn(&self.provider_handle, text, model, effort, images)
            .await
    }

    pub(crate) async fn start_turn_with_skills(
        &self,
        text: &str,
        model: &str,
        effort: &str,
        images: &[ProviderImage],
        skills: &[crate::provider::SkillInputRef],
    ) -> Result<Option<String>, String> {
        self.bridge
            .start_turn_with_skills(&self.provider_handle, text, model, effort, images, skills)
            .await
    }

    pub(crate) async fn list_skills(
        &self,
        cwd: &str,
    ) -> Result<Option<Vec<crate::protocol::ProviderSkillView>>, String> {
        self.bridge.list_skills(&self.provider_handle, cwd).await
    }

    pub(crate) async fn request_turn_stop(&self, turn_id: Option<&str>) -> Result<(), String> {
        self.bridge
            .request_turn_stop(&self.provider_handle, turn_id)
            .await
    }

    pub(crate) async fn read_thread_transcript_page(
        &self,
        before: Option<usize>,
    ) -> Result<Option<crate::provider::ThreadTranscriptPageData>, String> {
        self.read_thread_transcript_page_in_cwd(before, "").await
    }

    pub(crate) async fn read_thread_transcript_page_in_cwd(
        &self,
        before: Option<usize>,
        cwd: &str,
    ) -> Result<Option<crate::provider::ThreadTranscriptPageData>, String> {
        let page = self
            .bridge
            .read_thread_transcript_page_in_cwd(&self.provider_handle, before, cwd)
            .await?;
        Ok(page.map(|mut page| {
            self.result_identity().canonicalize_sync(&mut page.sync);
            page
        }))
    }

    pub(crate) async fn read_thread_entry_detail(
        &self,
        item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        self.bridge
            .read_thread_entry_detail(&self.provider_handle, item_id)
            .await
    }

    pub(crate) async fn session_can_take_a_turn(&self) -> bool {
        self.bridge
            .session_can_take_a_turn(&self.provider_handle)
            .await
    }

    pub(crate) async fn archive_thread(&self) -> Result<(), String> {
        self.bridge.archive_thread(&self.provider_handle).await
    }

    pub(crate) async fn release_thread(&self) -> Result<(), String> {
        self.bridge.release_thread(&self.provider_handle).await
    }

    pub(crate) async fn delete_thread_permanently(
        &self,
    ) -> Result<crate::codex_local::LocalThreadDeleteSummary, String> {
        self.bridge
            .delete_thread_permanently(&self.provider_handle)
            .await
    }

    pub(crate) async fn delete_owned_thread_permanently(
        &self,
    ) -> Result<Option<crate::codex_local::LocalThreadDeleteSummary>, String> {
        self.bridge
            .delete_owned_thread_permanently(&self.provider_handle)
            .await
    }

    /// The raw source half of a native fork. Only `AppState::fork_provider_thread`
    /// calls this helper, and it adopts the returned provider row immediately.
    async fn fork_thread_raw(
        &self,
        up_to_item_id: Option<String>,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<Option<StartThreadResult>, String> {
        self.bridge
            .fork_thread(ProviderForkRequest {
                source_thread_id: self.provider_handle.clone(),
                up_to_item_id,
                cwd: cwd.to_string(),
                model: model.to_string(),
                approval_policy: approval_policy.to_string(),
                sandbox: sandbox.to_string(),
            })
            .await
    }

    /// A provider-facing COPY of the pending record: the relay's own copy keeps the
    /// stable id, because that is the id its surfaces, locks and logs all name.
    pub(crate) async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        let mut provider_pending = pending.clone();
        provider_pending.thread_id = self.provider_handle.clone();
        self.bridge
            .respond_to_approval(&provider_pending, input)
            .await
    }

    pub(crate) async fn respond_to_ask_user_question(
        &self,
        request_id: &str,
        answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        self.bridge
            .respond_to_ask_user_question(request_id, answers)
            .await
    }
}
