use super::*;

impl AppState {
    /// Store the handle to the running broker task, aborting any previous one so
    /// two broker loops never run concurrently after a hot restart.
    pub(crate) async fn set_broker_task(&self, handle: tokio::task::JoinHandle<()>) {
        let mut slot = self.broker_task.lock().await;
        if let Some(previous) = slot.replace(handle) {
            previous.abort();
        }
    }

    /// Stop the running broker task (if any) and clear broker presence/target so
    /// status reflects "no broker". Returns whether a broker task was stopped.
    /// Hot broker switching calls this to tear the old broker down before starting
    /// a new one, or when switching to local-only.
    #[allow(dead_code)] // consumed by the config-watcher wiring (next Phase 2 step)
    pub(crate) async fn stop_broker(&self) -> bool {
        let handle = self.broker_task.lock().await.take();
        let had_broker = handle.is_some();
        if let Some(handle) = handle {
            handle.abort();
        }
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
