use super::*;

impl AppState {
    pub async fn provider_models(
        &self,
        provider_name: &str,
    ) -> Result<Vec<ModelOptionView>, String> {
        let (_, bridge) = self.resolve_provider(Some(provider_name))?;
        bridge.list_models().await
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
            let relay = self.relay.clone();
            tokio::spawn(async move {
                if let Err(error) = bridge.list_models().await {
                    let mut relay = relay.write().await;
                    relay.push_log(
                        "warn",
                        format!("Model catalog prewarm for {name} failed: {error}"),
                    );
                    relay.notify();
                }
            });
        }
    }

    pub(super) async fn refresh_model_catalog(&self) {
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
}
