use std::{collections::HashMap, sync::Arc};

use tokio::sync::{mpsc, Mutex};

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

        for (peer_id, handle) in &room.peers {
            if peer_id == from_peer_id {
                continue;
            }

            let _ = handle.tx.send(ServerMessage::Message {
                channel_id: channel_id.to_string(),
                from_peer_id: from_peer_id.to_string(),
                from_role: sender_role,
                payload: payload.clone(),
            });
        }

        Ok(())
    }
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
