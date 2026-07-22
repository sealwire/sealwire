use super::*;

impl AppState {
    /// Store the handle to the running broker task, aborting AND awaiting any
    /// previous one so two broker loops never run concurrently after a hot restart
    /// and the old loop can't write broker state after the new one is installed.
    pub(crate) async fn set_broker_task(&self, handle: tokio::task::JoinHandle<()>) {
        let previous = self.broker_task.lock().await.replace(handle);
        abort_and_join(previous).await;
    }

    /// Enable or disable the configured broker at runtime WITHOUT restarting the
    /// relay core. Enabling re-runs the exact startup path (`spawn_broker_task`), so
    /// it reuses the same env-derived config, credentials, and enrollment — a switch
    /// can never send one broker's credentials to another origin, because the origin
    /// never changes (changing WHICH broker is a restart, not this). Disabling tears
    /// the publishing task down. The enabled flag's Mutex is held across the whole
    /// transition, so concurrent toggles serialize and never leave torn broker state.
    /// Returns Err only if enabling fails to resolve the configured broker (bad env);
    /// the flag then stays disabled.
    #[allow(dead_code)] // consumed by the broker control HTTP API (next narrow brick)
    pub(crate) async fn set_broker_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut flag = self.broker_enabled.lock().await;
        if *flag == enabled {
            return Ok(());
        }
        if enabled {
            crate::broker::spawn_broker_task(self.clone()).await?;
        } else {
            self.stop_broker().await;
        }
        *flag = enabled;
        Ok(())
    }

    /// Whether the configured broker is currently enabled (publishing).
    #[allow(dead_code)] // consumed by the broker control HTTP API (next narrow brick)
    pub(crate) async fn broker_enabled(&self) -> bool {
        *self.broker_enabled.lock().await
    }

    /// Stop the running broker task (if any) and clear broker presence/target so
    /// status reflects "no broker". Returns whether a broker task was stopped.
    /// Hot broker switching calls this to tear the old broker down before starting
    /// a new one, or when switching to local-only.
    #[allow(dead_code)] // consumed by the broker control HTTP API (next narrow brick)
    pub(crate) async fn stop_broker(&self) -> bool {
        let handle = self.broker_task.lock().await.take();
        let had_broker = handle.is_some();
        // Await the aborted task so its future is fully dropped before we clear and
        // return — the old reconnect loop cannot write broker status/channel after
        // this point, so a switch never leaves stale state (no generation guard
        // needed). Safe from deadlock: never called from within the broker task.
        abort_and_join(handle).await;
        if had_broker {
            self.set_broker_connection(false).await;
            self.set_broker_channel(None, None).await;
            self.push_runtime_log("info", "Broker publishing stopped.".to_string())
                .await;
        }
        had_broker
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

    pub(crate) async fn drain_pending_broker_messages(&self) -> Vec<super::BrokerPendingMessage> {
        let mut relay = self.relay.write().await;
        relay.drain_pending_broker_messages()
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

/// Abort a broker task and await its teardown so its future is fully dropped
/// before the caller proceeds. `None` is a no-op. The `JoinError` from a
/// cancelled task is expected and ignored.
async fn abort_and_join(handle: Option<tokio::task::JoinHandle<()>>) {
    if let Some(handle) = handle {
        handle.abort();
        let _ = handle.await;
    }
}
