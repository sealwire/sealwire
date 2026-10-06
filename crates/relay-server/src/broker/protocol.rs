use relay_broker::protocol::{ClientMessage, BROKER_PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::{PairedDeviceView, ThreadTranscriptResponse};

use super::{crypto::EncryptedEnvelope, remote_actions::RemoteActionKind, RELAY_PROTOCOL_VERSION};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PairingRequestPlaintext {
    pub(super) device_id: Option<String>,
    pub(super) device_label: Option<String>,
    pub(super) device_verify_key: String,
    pub(super) pairing_proof: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum InboundBrokerPayload {
    PairingRequest {
        pairing_id: String,
        envelope: EncryptedEnvelope,
    },
    /// A claim step carries none of the `request_*` fields; every other action carries
    /// all of them, signed by the device key.
    EncryptedRemoteAction {
        action_id: String,
        device_id: Option<String>,
        #[serde(default)]
        action: Option<RemoteActionKind>,
        #[serde(default)]
        request_sid: Option<String>,
        #[serde(default)]
        request_boot: Option<String>,
        #[serde(default)]
        request_seq: Option<u64>,
        #[serde(default)]
        request_time: Option<u64>,
        #[serde(default)]
        op_boot: Option<String>,
        #[serde(default)]
        op_t0: Option<u64>,
        #[serde(default)]
        request_signature: Option<String>,
        envelope: EncryptedEnvelope,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum OutboundBrokerPayload {
    EncryptedTranscriptDelta {
        target_peer_id: String,
        device_id: String,
        envelope: EncryptedEnvelope,
    },
    /// A sealed transcript event; the envelope holds a `TranscriptResyncEvent`.
    EncryptedTranscriptEvent {
        target_peer_id: String,
        device_id: String,
        envelope: EncryptedEnvelope,
    },
    // Carries only routing metadata, never an action result.
    RemoteActionPending {
        action_id: String,
        target_peer_id: String,
    },
    /// The phone signed this attempt, but its request session or clock is not good
    /// here. Nothing ran; the phone claims again and resends the same operation.
    RemoteActionReauthorize {
        action_id: String,
        target_peer_id: String,
    },
    EncryptedSessionSnapshot {
        target_peer_id: String,
        device_id: String,
        envelope: EncryptedEnvelope,
    },
    EncryptedRemoteActionResult {
        action_id: String,
        target_peer_id: String,
        device_id: String,
        envelope: EncryptedEnvelope,
    },
    EncryptedRemoteActionResultChunk {
        action_id: String,
        target_peer_id: String,
        device_id: String,
        action: RemoteActionKind,
        chunk_index: usize,
        chunk_count: usize,
        envelope: EncryptedEnvelope,
    },
    EncryptedPairingResult {
        pairing_id: String,
        target_peer_id: String,
        envelope: EncryptedEnvelope,
    },
    TargetedMessages {
        messages: Vec<TargetedBrokerMessage>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct TargetedBrokerMessage {
    pub(super) target_peer_id: String,
    pub(super) payload: Box<OutboundBrokerPayload>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct PairingResultPlaintext {
    pub(super) ok: bool,
    pub(super) device: Option<PairedDeviceView>,
    pub(super) payload_secret: Option<String>,
    pub(super) relay_id: Option<String>,
    pub(super) relay_label: Option<String>,
    pub(super) client_claim_id: Option<String>,
    pub(super) client_claim_nonce: Option<String>,
    pub(super) client_claim_expires_at: Option<u64>,
    pub(super) device_refresh_token: Option<String>,
    pub(super) device_join_ticket: Option<String>,
    pub(super) device_join_ticket_expires_at: Option<u64>,
    pub(super) error: Option<String>,
}

pub(super) fn parse_inbound_payload(
    payload: Value,
) -> Result<Option<InboundBrokerPayload>, String> {
    let kind = payload.get("kind").and_then(Value::as_str);
    if kind == Some("remote_action") {
        return Err("plaintext remote actions are not supported".to_string());
    }
    if !matches!(kind, Some("pairing_request" | "encrypted_remote_action")) {
        return Ok(None);
    }
    validate_relay_payload_protocol_version(&payload)?;
    serde_json::from_value(payload)
        .map(Some)
        .map_err(|error| format!("invalid broker payload: {error}"))
}

fn validate_relay_payload_protocol_version(payload: &Value) -> Result<(), String> {
    match payload.get("protocol_version") {
        None => Err("relay payload protocol_version is required".to_string()),
        Some(version) => match version.as_u64() {
            Some(RELAY_PROTOCOL_VERSION) => Ok(()),
            Some(version) => Err(format!(
                "unsupported relay payload protocol_version {version}; supported version is {RELAY_PROTOCOL_VERSION}"
            )),
            None => Err("relay payload protocol_version must be a number".to_string()),
        },
    }
}

pub(super) fn validate_broker_protocol_version(protocol_version: u32) -> Result<(), String> {
    if protocol_version == BROKER_PROTOCOL_VERSION {
        return Ok(());
    }
    Err(format!(
        "unsupported broker protocol_version {protocol_version}; supported version is {BROKER_PROTOCOL_VERSION}"
    ))
}

pub(super) fn summarize_thread_transcript_response(page: &ThreadTranscriptResponse) -> String {
    let char_count = page
        .entries
        .iter()
        .map(|entry| entry.text.as_deref().map(str::len).unwrap_or(0))
        .sum::<usize>();
    format!(
        "thread_id={} entries={} chars={} prev_cursor={}",
        page.thread_id,
        page.entries.len(),
        char_count,
        page.prev_cursor
            .as_ref()
            .map_or("-", |cursor| cursor.as_str()),
    )
}

pub(super) fn summarize_outbound_payload(payload: &OutboundBrokerPayload) -> String {
    match payload {
        OutboundBrokerPayload::TargetedMessages { messages } => {
            let inner = messages.iter().map(|message| summarize_outbound_payload(&message.payload)).collect::<Vec<_>>().join(";");
            format!("kind=targeted_messages target_count={} inner={inner}", messages.len())
        }
        OutboundBrokerPayload::RemoteActionPending { action_id, target_peer_id } =>
            format!("kind=remote_action_pending action_id={action_id} target_peer_id={target_peer_id}"),
        OutboundBrokerPayload::RemoteActionReauthorize { action_id, target_peer_id } =>
            format!("kind=remote_action_reauthorize action_id={action_id} target_peer_id={target_peer_id}"),
        OutboundBrokerPayload::EncryptedSessionSnapshot { target_peer_id, device_id, .. } =>
            format!("kind=encrypted_session_snapshot target_peer_id={target_peer_id} device_id={device_id}"),
        OutboundBrokerPayload::EncryptedTranscriptDelta { target_peer_id, device_id, .. } =>
            format!("kind=encrypted_transcript_delta target_peer_id={target_peer_id} device_id={device_id}"),
        OutboundBrokerPayload::EncryptedTranscriptEvent { target_peer_id, device_id, .. } =>
            format!("kind=encrypted_transcript_event target_peer_id={target_peer_id} device_id={device_id}"),
        OutboundBrokerPayload::EncryptedRemoteActionResult { action_id, target_peer_id, device_id, .. } =>
            format!("kind=encrypted_remote_action_result action_id={action_id} target_peer_id={target_peer_id} device_id={device_id}"),
        OutboundBrokerPayload::EncryptedRemoteActionResultChunk { action_id, target_peer_id, device_id, chunk_index, chunk_count, .. } =>
            format!("kind=encrypted_remote_action_result_chunk action_id={action_id} target_peer_id={target_peer_id} device_id={device_id} chunk={}/{}", chunk_index + 1, chunk_count),
        OutboundBrokerPayload::EncryptedPairingResult { pairing_id, target_peer_id, .. } =>
            format!("kind=encrypted_pairing_result pairing_id={pairing_id} target_peer_id={target_peer_id}"),
    }
}

pub(super) fn frame_bytes_for_payload(payload: &OutboundBrokerPayload) -> usize {
    let mut payload_value =
        serde_json::to_value(payload.clone()).expect("broker payload should serialize");
    add_relay_payload_protocol_version(&mut payload_value);
    // Reserve signature, session, and the widest nonce. Measuring must not mint either.
    super::reserved_publish_frame_len(&payload_value)
}

pub(super) fn frame_text_for_json_payload(mut payload: Value) -> String {
    add_relay_payload_protocol_version(&mut payload);
    publish_frame_text(&payload)
}

pub(super) fn frame_text_for_payload(payload: &OutboundBrokerPayload) -> String {
    let mut payload_value =
        serde_json::to_value(payload.clone()).expect("broker payload should serialize");
    add_relay_payload_protocol_version(&mut payload_value);
    publish_frame_text(&payload_value)
}

pub(super) fn publish_frame_text(payload: &Value) -> String {
    let frame = ClientMessage::Publish {
        protocol_version: BROKER_PROTOCOL_VERSION,
        payload: payload.clone(),
    };
    serde_json::to_string(&frame).expect("broker client frame should serialize")
}

pub(super) fn add_relay_payload_protocol_version(payload: &mut Value) {
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "protocol_version".to_string(),
            Value::from(RELAY_PROTOCOL_VERSION),
        );
        if object.get("kind").and_then(Value::as_str) == Some("targeted_messages") {
            if let Some(messages) = object.get_mut("messages").and_then(Value::as_array_mut) {
                for message in messages {
                    if let Some(inner_payload) = message.get_mut("payload") {
                        add_relay_payload_protocol_version(inner_payload);
                    }
                }
            }
        }
    }
}
