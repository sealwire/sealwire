use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BROKER_PROTOCOL_VERSION: u32 = 2;
pub const MAX_TARGETED_MESSAGES_PER_PUBLISH: usize = 128;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PeerRole {
    Relay,
    Surface,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerSummary {
    pub peer_id: String,
    pub role: PeerRole,
    /// Transport metadata only; the relay authenticates devices with their signing keys.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PresenceKind {
    Joined,
    Left,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Publish {
        protocol_version: u32,
        payload: Value,
    },
    /// Proof that this socket holds the relay identity key for the fresh join challenge.
    RelayJoinProof {
        challenge_id: String,
        signature: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Sent to a relay before it is seated. The socket has no room content yet.
    RelayJoinChallenge {
        challenge_id: String,
        challenge: String,
        broker_origin: String,
        relay_id: String,
        broker_room_id: String,
        relay_peer_id: String,
        ticket_sha256: String,
        relay_verify_key: String,
    },
    Welcome {
        protocol_version: u32,
        channel_id: String,
        peer_id: String,
        peers: Vec<PeerSummary>,
    },
    Presence {
        channel_id: String,
        kind: PresenceKind,
        peer: PeerSummary,
    },
    Message {
        channel_id: String,
        from_peer_id: String,
        from_role: PeerRole,
        payload: Value,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectQuery {
    pub peer_id: Option<String>,
    pub role: PeerRole,
    pub join_ticket: Option<String>,
    pub client_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub broker_auth_mode: String,
    pub join_auth_ready: bool,
    pub minimum_relay_version: String,
    pub broker_protocol_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_monitoring: Option<PublicBrokerMonitoring>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct PublicBrokerMonitoring {
    pub relay_ws_token_refresh_successes: u64,
    pub relay_ws_token_refresh_failures: u64,
    pub device_ws_token_refresh_successes: u64,
    pub device_ws_token_refresh_failures: u64,
    pub invalid_refresh_token_uses: u64,
    pub repeated_invalid_refresh_token_uses: u64,
    pub environment_mutation_events: u64,
}
