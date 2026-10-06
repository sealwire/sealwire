use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use tokio::sync::{mpsc, Mutex, Notify, OwnedSemaphorePermit, Semaphore};
use tracing::{info, warn};

use crate::events::{UsageEvent, UsageEventKind, UsageEventSink};
use crate::protocol::{
    PeerRole, PeerSummary, PresenceKind, ServerMessage, MAX_TARGETED_MESSAGES_PER_PUBLISH,
};

const OUTBOUND_QUEUE_CAPACITY: usize = 256;
const OUTBOUND_QUEUE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct OutboundMessage {
    pub(crate) text: String,
    _permit: OwnedSemaphorePermit,
}

#[derive(Clone, Default)]
pub struct BrokerState {
    inner: Arc<Mutex<Inner>>,
    /// Optional usage event stream. `None` disables usage logging (the default,
    /// e.g. in tests and when the env var is unset).
    events: Option<Arc<dyn UsageEventSink>>,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<String, RoomState>,
    next_connection_id: u64,
    /// Process-global room-access epoch (constant cardinality). Bumped by every
    /// [`BrokerState::force_close_room`], including when the room is empty, so a
    /// join that captured an older epoch cannot seat after access release.
    access_epoch: u64,
}

struct RoomState {
    peers: HashMap<String, PeerHandle>,
}

struct PeerHandle {
    connection_id: u64,
    role: PeerRole,
    device_id: Option<String>,
    /// Set when this peer was seated by a pairing join ticket. One ticket may hold
    /// at most one seat at a time (see [`BrokerState::join`]).
    pairing_id: Option<String>,
    tx: mpsc::Sender<OutboundMessage>,
    budget: Arc<Semaphore>,
    overflow: Arc<Notify>,
}

impl PeerHandle {
    fn enqueue(&self, message: ServerMessage) -> Result<(), ()> {
        let text = serde_json::to_string(&message).expect("server messages should serialize");
        if text.len() > OUTBOUND_QUEUE_BYTES {
            self.overflow.notify_one();
            return Err(());
        }
        let permit = Arc::clone(&self.budget)
            .try_acquire_many_owned(text.len() as u32)
            .map_err(|_| self.overflow.notify_one())?;
        self.tx
            .try_send(OutboundMessage {
                text,
                _permit: permit,
            })
            .map_err(|error| {
                if matches!(error, mpsc::error::TrySendError::Full(_)) {
                    self.overflow.notify_one();
                }
            })
    }
}

#[derive(Debug)]
pub struct JoinResult {
    pub connection_id: u64,
    pub existing_peers: Vec<PeerSummary>,
    pub receiver: mpsc::Receiver<OutboundMessage>,
    pub overflow: Arc<Notify>,
}

impl BrokerState {
    /// Build state that records usage events to the given sink.
    pub fn with_event_sink(sink: Arc<dyn UsageEventSink>) -> Self {
        Self {
            inner: Arc::default(),
            events: Some(sink),
        }
    }

    /// Build state, enabling usage event logging when the environment
    /// configures it (see [`crate::events::USAGE_EVENTS_PATH_ENV`]).
    pub async fn from_env() -> Self {
        match crate::events::usage_event_sink_from_env().await {
            Some(sink) => Self::with_event_sink(sink),
            None => Self::default(),
        }
    }

    fn record_event(&self, event: UsageEvent) {
        if let Some(sink) = &self.events {
            sink.record(event);
        }
    }

    /// Snapshot the process-global access epoch before an async access check.
    pub async fn access_epoch(&self) -> u64 {
        self.inner.lock().await.access_epoch
    }

    /// Seat a peer in a channel.
    ///
    /// `pairing_id` is set for a surface admitted by a pairing join ticket — the
    /// credential encoded in a QR code. Ticket verification is stateless HMAC, so
    /// nothing stops the same ticket from being replayed by any number of clients;
    /// a ticket therefore holds at most ONE seat here, and a later join supersedes
    /// the earlier holder. That keeps a bystander who photographed the QR from
    /// sitting silently in the room alongside the device being paired, while still
    /// letting the real device's reconnect (the remote client retries the pairing
    /// ticket automatically after a network blip) reclaim its own seat.
    pub async fn join(
        &self,
        channel_id: &str,
        peer_id: &str,
        role: PeerRole,
        device_id: Option<String>,
        pairing_id: Option<String>,
    ) -> Result<JoinResult, String> {
        self.join_with_access_epoch(channel_id, peer_id, role, device_id, pairing_id, None)
            .await
    }

    /// Like [`Self::join`], but fails if `expected_epoch` no longer matches the
    /// process-global access epoch (a concurrent access release won the race).
    pub async fn join_if_access_epoch(
        &self,
        channel_id: &str,
        peer_id: &str,
        role: PeerRole,
        device_id: Option<String>,
        pairing_id: Option<String>,
        expected_epoch: u64,
    ) -> Result<JoinResult, String> {
        self.join_with_access_epoch(
            channel_id,
            peer_id,
            role,
            device_id,
            pairing_id,
            Some(expected_epoch),
        )
        .await
    }

    async fn join_with_access_epoch(
        &self,
        channel_id: &str,
        peer_id: &str,
        role: PeerRole,
        device_id: Option<String>,
        pairing_id: Option<String>,
        expected_epoch: Option<u64>,
    ) -> Result<JoinResult, String> {
        let (tx, rx) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
        let overflow = Arc::new(Notify::new());
        let joined_peer = PeerSummary {
            peer_id: peer_id.to_string(),
            role,
            device_id: device_id.clone(),
        };
        let mut inner = self.inner.lock().await;
        if let Some(expected_epoch) = expected_epoch {
            if inner.access_epoch != expected_epoch {
                return Err("access epoch changed; join rejected".to_string());
            }
        }
        inner.next_connection_id = inner.next_connection_id.wrapping_add(1).max(1);
        let connection_id = inner.next_connection_id;
        let room = inner
            .rooms
            .entry(channel_id.to_string())
            .or_insert_with(RoomState::default);

        let replacing_relay = match room.peers.get(peer_id) {
            Some(existing) if existing.role == PeerRole::Relay && role == PeerRole::Relay => {
                info!(
                    channel_id,
                    peer_id,
                    old_connection_id = existing.connection_id,
                    new_connection_id = connection_id,
                    "broker relay peer connection replaced"
                );
                true
            }
            Some(_) => {
                return Err(format!(
                    "peer `{peer_id}` is already connected to channel `{channel_id}`"
                ));
            }
            None => false,
        };

        if replacing_relay {
            let existing = room
                .peers
                .get(peer_id)
                .expect("replaced relay should still be present");
            self.record_event(UsageEvent::new(
                UsageEventKind::Disconnect,
                channel_id,
                peer_id,
                existing.role,
                existing.device_id.clone(),
            ));
        }

        // One pairing ticket, one seat: evict any earlier holder before the new peer
        // is announced, so it never appears in this peer's `existing_peers` and the
        // room cannot contain two surfaces admitted by the same QR.
        let superseded = match pairing_id.as_deref() {
            Some(pairing_id) => room
                .peers
                .iter()
                .filter(|(existing_peer_id, handle)| {
                    existing_peer_id.as_str() != peer_id
                        && handle.pairing_id.as_deref() == Some(pairing_id)
                })
                .map(|(existing_peer_id, _)| existing_peer_id.clone())
                .collect::<Vec<_>>(),
            None => Vec::new(),
        };
        for superseded_peer_id in &superseded {
            let Some(handle) = room.peers.remove(superseded_peer_id) else {
                continue;
            };
            info!(
                channel_id,
                peer_id,
                superseded_peer_id = %superseded_peer_id,
                "broker surface superseded by a later join on the same pairing ticket"
            );
            let _ = handle.enqueue(ServerMessage::Error {
                code: "pairing_ticket_superseded".to_string(),
                message: "another client joined with this pairing ticket".to_string(),
            });
            let left_peer = PeerSummary {
                peer_id: superseded_peer_id.clone(),
                role: handle.role,
                device_id: handle.device_id.clone(),
            };
            for remaining in room.peers.values() {
                let _ = remaining.enqueue(ServerMessage::Presence {
                    channel_id: channel_id.to_string(),
                    kind: PresenceKind::Left,
                    peer: left_peer.clone(),
                });
            }
            self.record_event(UsageEvent::new(
                UsageEventKind::Disconnect,
                channel_id,
                superseded_peer_id,
                handle.role,
                handle.device_id,
            ));
        }

        let existing_peers = room
            .peers
            .iter()
            .filter(|(existing_peer_id, _)| existing_peer_id.as_str() != peer_id)
            .map(|(peer_id, handle)| PeerSummary {
                peer_id: peer_id.clone(),
                role: handle.role,
                device_id: handle.device_id.clone(),
            })
            .collect::<Vec<_>>();

        for (existing_peer_id, handle) in &room.peers {
            if existing_peer_id == peer_id {
                continue;
            }
            let _ = handle.enqueue(ServerMessage::Presence {
                channel_id: channel_id.to_string(),
                kind: PresenceKind::Joined,
                peer: joined_peer.clone(),
            });
        }

        room.peers.insert(
            peer_id.to_string(),
            PeerHandle {
                connection_id,
                role,
                device_id,
                pairing_id,
                tx,
                budget: Arc::new(Semaphore::new(OUTBOUND_QUEUE_BYTES)),
                overflow: Arc::clone(&overflow),
            },
        );

        self.record_event(UsageEvent::new(
            UsageEventKind::Connect,
            channel_id,
            peer_id,
            role,
            joined_peer.device_id,
        ));

        Ok(JoinResult {
            connection_id,
            existing_peers,
            receiver: rx,
            overflow,
        })
    }

    /// Force-close every peer currently seated in `channel_id` (relay and
    /// surfaces). Always bumps the process-global access epoch (even when the
    /// room is empty) so in-flight joins that captured an older epoch cannot
    /// seat after access release. Sends a terminal error frame, records
    /// disconnects, and drops the room. Returns how many peers were closed.
    pub async fn force_close_room(&self, channel_id: &str, code: &str, message: &str) -> usize {
        let mut inner = self.inner.lock().await;
        inner.access_epoch = inner.access_epoch.saturating_add(1);
        let Some(room) = inner.rooms.remove(channel_id) else {
            return 0;
        };
        let mut closed = 0usize;
        for (peer_id, handle) in room.peers {
            let _ = handle.enqueue(ServerMessage::Error {
                code: code.to_string(),
                message: message.to_string(),
            });
            self.record_event(UsageEvent::new(
                UsageEventKind::Disconnect,
                channel_id,
                &peer_id,
                handle.role,
                handle.device_id,
            ));
            closed = closed.saturating_add(1);
        }
        closed
    }

    /// Test/helper: how many peers are seated in `channel_id`.
    #[cfg(test)]
    pub async fn room_peer_count(&self, channel_id: &str) -> usize {
        let inner = self.inner.lock().await;
        inner
            .rooms
            .get(channel_id)
            .map(|room| room.peers.len())
            .unwrap_or(0)
    }

    /// Test/helper: current access epoch.
    #[cfg(test)]
    pub async fn access_epoch_for_test(&self) -> u64 {
        self.access_epoch().await
    }

    pub async fn leave(&self, channel_id: &str, peer_id: &str) {
        self.leave_inner(channel_id, peer_id, None).await;
    }

    pub async fn leave_connection(&self, channel_id: &str, peer_id: &str, connection_id: u64) {
        self.leave_inner(channel_id, peer_id, Some(connection_id))
            .await;
    }

    async fn leave_inner(
        &self,
        channel_id: &str,
        peer_id: &str,
        expected_connection_id: Option<u64>,
    ) {
        let mut inner = self.inner.lock().await;
        let Some(room) = inner.rooms.get_mut(channel_id) else {
            return;
        };

        if let Some(expected_connection_id) = expected_connection_id {
            let Some(handle) = room.peers.get(peer_id) else {
                return;
            };
            if handle.connection_id != expected_connection_id {
                return;
            }
        }

        let Some(handle) = room.peers.remove(peer_id) else {
            return;
        };

        let left_peer = PeerSummary {
            peer_id: peer_id.to_string(),
            role: handle.role,
            device_id: handle.device_id,
        };

        for peer in room.peers.values() {
            let _ = peer.enqueue(ServerMessage::Presence {
                channel_id: channel_id.to_string(),
                kind: PresenceKind::Left,
                peer: left_peer.clone(),
            });
        }

        self.record_event(UsageEvent::new(
            UsageEventKind::Disconnect,
            channel_id,
            peer_id,
            left_peer.role,
            left_peer.device_id,
        ));

        if room.peers.is_empty() {
            inner.rooms.remove(channel_id);
        }
    }

    pub async fn publish(
        &self,
        channel_id: &str,
        from_peer_id: &str,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        self.publish_inner(channel_id, from_peer_id, None, payload)
            .await
    }

    pub async fn publish_connection(
        &self,
        channel_id: &str,
        from_peer_id: &str,
        connection_id: u64,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        self.publish_inner(channel_id, from_peer_id, Some(connection_id), payload)
            .await
    }

    async fn publish_inner(
        &self,
        channel_id: &str,
        from_peer_id: &str,
        expected_connection_id: Option<u64>,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        let inner = self.inner.lock().await;
        let Some(room) = inner.rooms.get(channel_id) else {
            return Err(format!("channel `{channel_id}` is not active"));
        };

        if !room.peers.contains_key(from_peer_id) {
            return Err(format!(
                "peer `{from_peer_id}` is not connected to channel `{channel_id}`"
            ));
        }

        let sender_handle = room
            .peers
            .get(from_peer_id)
            .expect("sender should exist in room");
        if expected_connection_id
            .is_some_and(|connection_id| sender_handle.connection_id != connection_id)
        {
            return Err(format!(
                "peer `{from_peer_id}` connection has been replaced in channel `{channel_id}`"
            ));
        }
        let sender_role = sender_handle.role;
        let sender_device_id = sender_handle.device_id.clone();
        let outbound_payload_kind = payload_kind(&payload).to_string();

        // Built now (while the sender is known) but only recorded once the
        // publish is accepted below, so the usage stream counts delivered
        // activity rather than malformed frames that fail validation.
        let publish_event = UsageEvent::new(
            UsageEventKind::Publish,
            channel_id,
            from_peer_id,
            sender_role,
            sender_device_id,
        )
        .with_payload_kind(outbound_payload_kind.clone());

        if sender_role == PeerRole::Surface && is_targeted_messages_payload(&payload) {
            return Err("surfaces must publish a single payload to a relay".to_string());
        }
        let targeted = parse_targeted_messages_payload(payload)?;
        for message in &targeted.messages {
            if room
                .peers
                .get(&message.target_peer_id)
                .is_some_and(|handle| handle.role == sender_role)
            {
                return Err("broker payload must target the opposite peer role".to_string());
            }
        }
        self.record_event(publish_event);
        let target_count = targeted.messages.len();
        let inner_kinds = targeted
            .messages
            .iter()
            .map(|message| payload_kind(&message.payload).to_string())
            .collect::<Vec<_>>()
            .join(",");
        let mut delivered_count = 0usize;
        let mut missing_target_count = 0usize;
        let mut failed_count = 0usize;
        for message in targeted.messages {
            let Some(handle) = room.peers.get(&message.target_peer_id) else {
                missing_target_count += 1;
                warn!(
                    channel_id,
                    from_peer_id,
                    target_peer_id = %message.target_peer_id,
                    "broker targeted publish target is not connected"
                );
                continue;
            };
            if handle
                .enqueue(ServerMessage::Message {
                    channel_id: channel_id.to_string(),
                    from_peer_id: from_peer_id.to_string(),
                    from_role: sender_role,
                    payload: message.payload,
                })
                .is_ok()
            {
                delivered_count += 1;
            } else {
                failed_count += 1;
                warn!(
                    channel_id,
                    from_peer_id,
                    target_peer_id = %message.target_peer_id,
                    "broker targeted publish queue is full or closed"
                );
            }
        }
        info!(
            channel_id,
            from_peer_id,
            target_count,
            delivered_count,
            missing_target_count,
            failed_count,
            inner_kinds = %inner_kinds,
            "broker targeted publish fanout"
        );
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct TargetedMessagesPayload {
    messages: Vec<TargetedMessagePayload>,
}

#[derive(serde::Deserialize)]
struct TargetedMessagePayload {
    target_peer_id: String,
    payload: serde_json::Value,
}

fn is_targeted_messages_payload(payload: &serde_json::Value) -> bool {
    payload.get("kind").and_then(serde_json::Value::as_str) == Some("targeted_messages")
}

fn payload_kind(payload: &serde_json::Value) -> &str {
    payload
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-")
}

fn parse_targeted_messages_payload(
    payload: serde_json::Value,
) -> Result<TargetedMessagesPayload, String> {
    let targeted = if is_targeted_messages_payload(&payload) {
        serde_json::from_value::<TargetedMessagesPayload>(payload)
            .map_err(|error| format!("invalid targeted_messages payload: {error}"))?
    } else {
        let target_peer_id = payload
            .get("target_peer_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "broker payload target_peer_id is required".to_string())?
            .to_string();
        TargetedMessagesPayload {
            messages: vec![TargetedMessagePayload {
                target_peer_id,
                payload,
            }],
        }
    };
    if targeted.messages.len() > MAX_TARGETED_MESSAGES_PER_PUBLISH {
        return Err(format!(
            "targeted_messages exceeds {MAX_TARGETED_MESSAGES_PER_PUBLISH} messages"
        ));
    }
    let mut targets = HashSet::new();
    // Validate the whole batch before any delivery, so malformed routing cannot leak a prefix.
    for message in &targeted.messages {
        if message.target_peer_id.trim().is_empty() {
            return Err("broker payload target_peer_id is empty".to_string());
        }
        if !targets.insert(&message.target_peer_id) {
            return Err("targeted_messages repeats a target_peer_id".to_string());
        }
        if let Some(inner_target) = message.payload.get("target_peer_id") {
            if inner_target.as_str() != Some(message.target_peer_id.as_str()) {
                return Err("targeted message target_peer_id does not match payload".to_string());
            }
        }
    }
    Ok(targeted)
}

impl Default for RoomState {
    fn default() -> Self {
        Self {
            peers: HashMap::new(),
        }
    }
}

#[cfg(test)]
mod tests;
