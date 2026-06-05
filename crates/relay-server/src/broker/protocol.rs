use relay_broker::protocol::{ClientMessage, BROKER_PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::{
    ApprovalReceipt, AskUserQuestionDetailResponse, ModelOptionView, PairedDeviceView,
    SessionSnapshot, ThreadEntriesResponse, ThreadEntryDetailResponse, ThreadTranscriptResponse,
    ThreadsResponse,
};

use super::{
    crypto::EncryptedEnvelope,
    remote_actions::{RemoteActionKind, RemoteActionRequest},
    RELAY_PROTOCOL_VERSION,
};

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
    RemoteAction {
        action_id: String,
        session_claim: Option<String>,
        device_id: Option<String>,
        request: RemoteActionRequest,
    },
    EncryptedRemoteAction {
        action_id: String,
        session_claim: Option<String>,
        device_id: Option<String>,
        envelope: EncryptedEnvelope,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum OutboundBrokerPayload {
    SessionSnapshot {
        snapshot: SessionSnapshot,
    },
    TranscriptDelta {
        thread_id: String,
        base_revision: u64,
        revision: u64,
        entry_seq: u64,
        server_time: u64,
        item_id: String,
        turn_id: Option<String>,
        delta: String,
        delta_kind: String,
        text_offset: Option<u64>,
    },
    EncryptedTranscriptDelta {
        target_peer_id: String,
        device_id: String,
        envelope: EncryptedEnvelope,
    },
    RemoteActionAck {
        action_id: String,
        target_peer_id: String,
        action: RemoteActionKind,
        ok: bool,
        error: Option<String>,
    },
    RemoteApprovalResult {
        action_id: String,
        target_peer_id: String,
        action: RemoteActionKind,
        ok: bool,
        receipt: Option<ApprovalReceipt>,
        error: Option<String>,
    },
    RemoteControlResult {
        action_id: String,
        target_peer_id: String,
        action: RemoteActionKind,
        ok: bool,
        session_claim: Option<String>,
        session_claim_expires_at: Option<u64>,
        claim_challenge_id: Option<String>,
        claim_challenge: Option<String>,
        claim_challenge_expires_at: Option<u64>,
        error: Option<String>,
    },
    RemoteSessionResult {
        action_id: String,
        target_peer_id: String,
        action: RemoteActionKind,
        ok: bool,
        snapshot: SessionSnapshot,
        session_claim: Option<String>,
        session_claim_expires_at: Option<u64>,
        error: Option<String>,
    },
    RemoteThreadsResult {
        action_id: String,
        target_peer_id: String,
        action: RemoteActionKind,
        ok: bool,
        providers: Option<Vec<String>>,
        models: Option<Vec<ModelOptionView>>,
        threads: Option<ThreadsResponse>,
        error: Option<String>,
    },
    RemoteTranscriptResult {
        action_id: String,
        target_peer_id: String,
        action: RemoteActionKind,
        ok: bool,
        thread_entries: Option<ThreadEntriesResponse>,
        thread_entry_detail: Option<ThreadEntryDetailResponse>,
        thread_transcript: Option<ThreadTranscriptResponse>,
        workspace_diff: Option<crate::protocol::WorkspaceDiffResponse>,
        ask_user_question_detail: Option<AskUserQuestionDetailResponse>,
        error: Option<String>,
    },
    RemoteActionResultChunk {
        action_id: String,
        target_peer_id: String,
        action: RemoteActionKind,
        chunk_index: usize,
        chunk_count: usize,
        data_base64: String,
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
    pub(super) client_id: Option<String>,
    pub(super) client_refresh_token: Option<String>,
    pub(super) device_refresh_token: Option<String>,
    pub(super) device_join_ticket: Option<String>,
    pub(super) device_join_ticket_expires_at: Option<u64>,
    pub(super) error: Option<String>,
}

pub(super) fn parse_inbound_payload(
    payload: Value,
) -> Result<Option<InboundBrokerPayload>, String> {
    let kind = payload.get("kind").and_then(Value::as_str);
    if !matches!(
        kind,
        Some("remote_action" | "pairing_request" | "encrypted_remote_action")
    ) {
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
        "thread_id={} entries={} chars={} next_cursor={} prev_cursor={}",
        page.thread_id,
        page.entries.len(),
        char_count,
        page.next_cursor
            .map(|cursor| cursor.to_string())
            .unwrap_or_else(|| "-".to_string()),
        page.prev_cursor
            .map(|cursor| cursor.to_string())
            .unwrap_or_else(|| "-".to_string()),
    )
}

pub(super) fn summarize_outbound_payload(payload: &OutboundBrokerPayload) -> String {
    match payload {
        OutboundBrokerPayload::SessionSnapshot { snapshot } => format!(
            "kind=session_snapshot active_thread_id={} transcript_entries={} logs={} status={}",
            snapshot.active_thread_id.as_deref().unwrap_or("-"),
            snapshot.transcript.len(),
            snapshot.logs.len(),
            snapshot.current_status,
        ),
        OutboundBrokerPayload::RemoteActionAck {
            action_id,
            target_peer_id,
            action,
            ok,
            error,
        } => format!(
            "kind=remote_action_ack action={} action_id={} target_peer_id={} ok={} error={}",
            action.as_str(),
            action_id,
            target_peer_id,
            ok,
            error.as_deref().unwrap_or("-"),
        ),
        OutboundBrokerPayload::RemoteApprovalResult {
            action_id,
            target_peer_id,
            action,
            ok,
            error,
            ..
        } => format!(
            "kind=remote_approval_result action={} action_id={} target_peer_id={} ok={} error={}",
            action.as_str(),
            action_id,
            target_peer_id,
            ok,
            error.as_deref().unwrap_or("-"),
        ),
        OutboundBrokerPayload::RemoteControlResult {
            action_id,
            target_peer_id,
            action,
            ok,
            error,
            ..
        } => format!(
            "kind=remote_control_result action={} action_id={} target_peer_id={} ok={} error={}",
            action.as_str(),
            action_id,
            target_peer_id,
            ok,
            error.as_deref().unwrap_or("-"),
        ),
        OutboundBrokerPayload::RemoteSessionResult {
            action_id,
            target_peer_id,
            action,
            ok,
            snapshot,
            error,
            ..
        } => format!(
            "kind=remote_session_result action={} action_id={} target_peer_id={} ok={} active_thread_id={} transcript_entries={} error={}",
            action.as_str(),
            action_id,
            target_peer_id,
            ok,
            snapshot.active_thread_id.as_deref().unwrap_or("-"),
            snapshot.transcript.len(),
            error.as_deref().unwrap_or("-"),
        ),
        OutboundBrokerPayload::RemoteThreadsResult {
            action_id,
            target_peer_id,
            action,
            ok,
            providers,
            models,
            threads,
            error,
        } => format!(
            "kind=remote_threads_result action={} action_id={} target_peer_id={} ok={} providers={} models={} threads={} error={}",
            action.as_str(),
            action_id,
            target_peer_id,
            ok,
            providers.as_ref().map(|items| items.len()).unwrap_or(0),
            models.as_ref().map(|items| items.len()).unwrap_or(0),
            threads.as_ref().map(|response| response.threads.len()).unwrap_or(0),
            error.as_deref().unwrap_or("-"),
        ),
        OutboundBrokerPayload::RemoteTranscriptResult {
            action_id,
            target_peer_id,
            action,
            ok,
            thread_transcript,
            error,
            ..
        } => format!(
            "kind=remote_transcript_result action={} action_id={} target_peer_id={} ok={} {} error={}",
            action.as_str(),
            action_id,
            target_peer_id,
            ok,
            thread_transcript
                .as_ref()
                .map(summarize_thread_transcript_response)
                .unwrap_or_else(|| "thread_transcript=-".to_string()),
            error.as_deref().unwrap_or("-"),
        ),
        OutboundBrokerPayload::RemoteActionResultChunk {
            action_id,
            target_peer_id,
            action,
            chunk_index,
            chunk_count,
            ..
        } => format!(
            "kind=remote_action_result_chunk action={} action_id={} target_peer_id={} chunk={}/{}",
            action.as_str(),
            action_id,
            target_peer_id,
            chunk_index + 1,
            chunk_count
        ),
        OutboundBrokerPayload::EncryptedSessionSnapshot {
            target_peer_id,
            device_id,
            ..
        } => format!(
            "kind=encrypted_session_snapshot target_peer_id={} device_id={}",
            target_peer_id, device_id
        ),
        OutboundBrokerPayload::TranscriptDelta { item_id, delta_kind, .. } => {
            format!("kind=transcript_delta item_id={} delta_kind={}", item_id, delta_kind)
        }
        OutboundBrokerPayload::EncryptedTranscriptDelta {
            target_peer_id,
            device_id,
            ..
        } => format!(
            "kind=encrypted_transcript_delta target_peer_id={} device_id={}",
            target_peer_id, device_id
        ),
        OutboundBrokerPayload::EncryptedRemoteActionResult {
            action_id,
            target_peer_id,
            device_id,
            ..
        } => format!(
            "kind=encrypted_remote_action_result action_id={} target_peer_id={} device_id={}",
            action_id, target_peer_id, device_id
        ),
        OutboundBrokerPayload::EncryptedRemoteActionResultChunk {
            action_id,
            target_peer_id,
            device_id,
            action,
            chunk_index,
            chunk_count,
            ..
        } => format!(
            "kind=encrypted_remote_action_result_chunk action={} action_id={} target_peer_id={} device_id={} chunk={}/{}",
            action.as_str(),
            action_id,
            target_peer_id,
            device_id,
            chunk_index + 1,
            chunk_count
        ),
        OutboundBrokerPayload::EncryptedPairingResult {
            pairing_id,
            target_peer_id,
            ..
        } => format!(
            "kind=encrypted_pairing_result pairing_id={} target_peer_id={}",
            pairing_id, target_peer_id
        ),
        OutboundBrokerPayload::TargetedMessages { messages } => {
            let inner_kinds = messages
                .iter()
                .map(|message| summarize_outbound_payload(&message.payload))
                .collect::<Vec<_>>()
                .join(";");
            format!(
                "kind=targeted_messages target_count={} inner={}",
                messages.len(),
                if inner_kinds.is_empty() {
                    "-"
                } else {
                    inner_kinds.as_str()
                }
            )
        }
    }
}

pub(super) fn frame_bytes_for_payload(payload: &OutboundBrokerPayload) -> usize {
    frame_text_for_payload(payload).len()
}

pub(super) fn frame_text_for_payload(payload: &OutboundBrokerPayload) -> String {
    let mut payload_value =
        serde_json::to_value(payload.clone()).expect("broker payload should serialize");
    add_relay_payload_protocol_version(&mut payload_value);
    let frame = ClientMessage::Publish {
        protocol_version: BROKER_PROTOCOL_VERSION,
        payload: payload_value,
    };
    serde_json::to_string(&frame).expect("broker client frame should serialize")
}

fn add_relay_payload_protocol_version(payload: &mut Value) {
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
