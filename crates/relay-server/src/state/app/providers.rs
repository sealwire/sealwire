use super::*;

/// How often the background task re-pulls every provider's model catalog. The
/// catalog only changes when a CLI/SDK is upgraded, so a slow cadence is plenty
/// — this exists so a long-idle relay still picks up new/removed models without
/// a restart (each pass only adopts non-empty results, never blanking the cache).
const MODEL_CATALOG_REFRESH_SECS: u64 = 30 * 60;

impl AppState {
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

    pub(super) fn resolve_provider(
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
