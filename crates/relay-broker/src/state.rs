use std::{collections::HashMap, sync::Arc};

use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::protocol::{PeerRole, PeerSummary, PresenceKind, ServerMessage};

#[derive(Clone, Default)]
pub struct BrokerState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<String, RoomState>,
}

struct RoomState {
    peers: HashMap<String, PeerHandle>,
}

struct PeerHandle {
    role: PeerRole,
    device_id: Option<String>,
    tx: mpsc::UnboundedSender<ServerMessage>,
}

#[derive(Debug)]
pub struct JoinResult {
    pub existing_peers: Vec<PeerSummary>,
    pub receiver: mpsc::UnboundedReceiver<ServerMessage>,
}

impl BrokerState {
    pub async fn join(
        &self,
        channel_id: &str,
        peer_id: &str,
        role: PeerRole,
        device_id: Option<String>,
    ) -> Result<JoinResult, String> {
        let (tx, rx) = mpsc::unbounded_channel();
        let joined_peer = PeerSummary {
            peer_id: peer_id.to_string(),
            role,
            device_id: device_id.clone(),
        };
        let mut inner = self.inner.lock().await;
        let room = inner
            .rooms
            .entry(channel_id.to_string())
            .or_insert_with(RoomState::default);

        if room.peers.contains_key(peer_id) {
            return Err(format!(
                "peer `{peer_id}` is already connected to channel `{channel_id}`"
            ));
        }

        let existing_peers = room
            .peers
            .iter()
            .map(|(peer_id, handle)| PeerSummary {
                peer_id: peer_id.clone(),
                role: handle.role,
                device_id: handle.device_id.clone(),
            })
            .collect::<Vec<_>>();

        for handle in room.peers.values() {
            let _ = handle.tx.send(ServerMessage::Presence {
                channel_id: channel_id.to_string(),
                kind: PresenceKind::Joined,
                peer: joined_peer.clone(),
            });
        }

        room.peers.insert(
            peer_id.to_string(),
            PeerHandle {
                role,
                device_id,
                tx,
            },
        );

        Ok(JoinResult {
            existing_peers,
            receiver: rx,
        })
    }

    pub async fn leave(&self, channel_id: &str, peer_id: &str) {
        let mut inner = self.inner.lock().await;
        let Some(room) = inner.rooms.get_mut(channel_id) else {
            return;
        };

        let Some(handle) = room.peers.remove(peer_id) else {
            return;
        };

        let left_peer = PeerSummary {
            peer_id: peer_id.to_string(),
            role: handle.role,
            device_id: handle.device_id,
        };

        for peer in room.peers.values() {
            let _ = peer.tx.send(ServerMessage::Presence {
                channel_id: channel_id.to_string(),
                kind: PresenceKind::Left,
                peer: left_peer.clone(),
            });
        }

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
        let inner = self.inner.lock().await;
        let Some(room) = inner.rooms.get(channel_id) else {
            return Err(format!("channel `{channel_id}` is not active"));
        };

        if !room.peers.contains_key(from_peer_id) {
            return Err(format!(
                "peer `{from_peer_id}` is not connected to channel `{channel_id}`"
            ));
        }

        let sender_role = room
            .peers
            .get(from_peer_id)
            .expect("sender should exist in room")
            .role;
        let outbound_payload_kind = payload_kind(&payload).to_string();

        if is_targeted_messages_payload(&payload) {
            let targeted = parse_targeted_messages_payload(payload)?;
            let target_count = targeted.messages.len();
            let inner_kinds = targeted
                .messages
                .iter()
                .map(|message| payload_kind(&message.payload).to_string())
                .collect::<Vec<_>>()
                .join(",");
            let mut delivered_count = 0usize;
            let mut skipped_sender_count = 0usize;
            let mut missing_target_count = 0usize;
            let mut failed_count = 0usize;
            for message in targeted.messages {
                if message.target_peer_id == from_peer_id {
                    skipped_sender_count += 1;
                    continue;
                }
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
                    .tx
                    .send(ServerMessage::Message {
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
                        "broker targeted publish receiver is closed"
                    );
                }
            }
            info!(
                channel_id,
                from_peer_id,
                target_count,
                delivered_count,
                skipped_sender_count,
                missing_target_count,
                failed_count,
                inner_kinds = %inner_kinds,
                "broker targeted publish fanout"
            );
            return Ok(());
        }

        let mut recipient_count = 0usize;
        let mut delivered_count = 0usize;
        let mut failed_count = 0usize;
        for (peer_id, handle) in &room.peers {
            if peer_id == from_peer_id {
                continue;
            }

            recipient_count += 1;
            if handle
                .tx
                .send(ServerMessage::Message {
                    channel_id: channel_id.to_string(),
                    from_peer_id: from_peer_id.to_string(),
                    from_role: sender_role,
                    payload: payload.clone(),
                })
                .is_ok()
            {
                delivered_count += 1;
            } else {
                failed_count += 1;
                warn!(
                    channel_id,
                    from_peer_id,
                    target_peer_id = %peer_id,
                    payload_kind = %outbound_payload_kind,
                    "broker publish receiver is closed"
                );
            }
        }
        info!(
            channel_id,
            from_peer_id,
            payload_kind = %outbound_payload_kind,
            recipient_count,
            delivered_count,
            failed_count,
            "broker publish fanout"
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
    let targeted = serde_json::from_value::<TargetedMessagesPayload>(payload)
        .map_err(|error| format!("invalid targeted_messages payload: {error}"))?;
    if targeted
        .messages
        .iter()
        .any(|message| message.target_peer_id.is_empty())
    {
        return Err("invalid targeted_messages payload: target_peer_id is empty".to_string());
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
