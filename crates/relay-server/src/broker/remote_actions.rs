use futures_util::stream::SplitSink;
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message;
use tracing::info;

use crate::{
    protocol::{
        ApprovalDecisionInput, ApprovalReceipt, HeartbeatInput, ReadThreadEntriesInput,
        ReadThreadTranscriptInput, ResumeSessionInput, SendMessageInput, SessionSnapshot,
        StartSessionInput, TakeOverInput, ThreadEntriesResponse, ThreadTranscriptResponse,
        ThreadsQuery, ThreadsResponse,
    },
    state::{AppState, ApprovalError, CachedRemoteActionResult, RemoteActionReplayDecision},
};

use super::{
    crypto::{decrypt_json, encrypt_json, EncryptedEnvelope},
    issue_session_claim, publish_payload, verify_device_claim_challenge_proof,
    verify_device_claim_init_proof, verify_session_claim, BrokerSocket, OutboundBrokerPayload,
};

const SESSION_CONTROL_REQUIRED_ERROR: &str =
    "broker transport auth only grants room access; session claim is missing or expired";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum RemoteActionRequest {
    ClaimChallenge {
        proof: String,
    },
    ClaimDevice {
        challenge_id: String,
        proof: String,
    },
    StartSession {
        input: StartSessionInput,
    },
    ResumeSession {
        input: ResumeSessionInput,
    },
    SendMessage {
        input: SendMessageInput,
    },
    TakeOver {
        input: TakeOverInput,
    },
    Heartbeat {
        input: HeartbeatInput,
    },
    ListThreads {
        query: ThreadsQuery,
    },
    FetchThreadEntries {
        input: ReadThreadEntriesInput,
    },
    FetchThreadTranscript {
        input: ReadThreadTranscriptInput,
    },
    DecideApproval {
        request_id: String,
        input: ApprovalDecisionInput,
    },
}

impl RemoteActionRequest {
    pub(super) fn kind(&self) -> RemoteActionKind {
        match self {
            Self::ClaimChallenge { .. } => RemoteActionKind::ClaimChallenge,
            Self::ClaimDevice { .. } => RemoteActionKind::ClaimDevice,
            Self::StartSession { .. } => RemoteActionKind::StartSession,
            Self::ResumeSession { .. } => RemoteActionKind::ResumeSession,
            Self::SendMessage { .. } => RemoteActionKind::SendMessage,
            Self::TakeOver { .. } => RemoteActionKind::TakeOver,
            Self::Heartbeat { .. } => RemoteActionKind::Heartbeat,
            Self::ListThreads { .. } => RemoteActionKind::ListThreads,
            Self::FetchThreadEntries { .. } => RemoteActionKind::FetchThreadEntries,
            Self::FetchThreadTranscript { .. } => RemoteActionKind::FetchThreadTranscript,
            Self::DecideApproval { .. } => RemoteActionKind::DecideApproval,
        }
    }

    fn bind_device(self, device_id: String) -> Self {
        match self {
            Self::ClaimChallenge { proof } => Self::ClaimChallenge { proof },
            Self::ClaimDevice {
                challenge_id,
                proof,
            } => Self::ClaimDevice {
                challenge_id,
                proof,
            },
            Self::StartSession { mut input } => {
                input.device_id = Some(device_id);
                Self::StartSession { input }
            }
            Self::ResumeSession { mut input } => {
                input.device_id = Some(device_id);
                Self::ResumeSession { input }
            }
            Self::SendMessage { mut input } => {
                input.device_id = Some(device_id);
                Self::SendMessage { input }
            }
            Self::TakeOver { mut input } => {
                input.device_id = Some(device_id);
                Self::TakeOver { input }
            }
            Self::Heartbeat { mut input } => {
                input.device_id = Some(device_id);
                Self::Heartbeat { input }
            }
            Self::ListThreads { query } => Self::ListThreads { query },
            Self::FetchThreadEntries { input } => Self::FetchThreadEntries { input },
            Self::FetchThreadTranscript { input } => Self::FetchThreadTranscript { input },
            Self::DecideApproval {
                request_id,
                mut input,
            } => {
                input.device_id = Some(device_id);
                Self::DecideApproval { request_id, input }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum RemoteActionKind {
    ClaimChallenge,
    ClaimDevice,
    StartSession,
    ResumeSession,
    SendMessage,
    TakeOver,
    Heartbeat,
    ListThreads,
    FetchThreadEntries,
    FetchThreadTranscript,
    DecideApproval,
}

impl RemoteActionKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::ClaimChallenge { .. } => "claim_challenge",
            Self::ClaimDevice { .. } => "claim_device",
            Self::StartSession => "start_session",
            Self::ResumeSession => "resume_session",
            Self::SendMessage => "send_message",
            Self::TakeOver => "take_over",
            Self::Heartbeat => "heartbeat",
            Self::ListThreads => "list_threads",
            Self::FetchThreadEntries => "fetch_thread_entries",
            Self::FetchThreadTranscript => "fetch_thread_transcript",
            Self::DecideApproval => "decide_approval",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct RemoteActionResultPlaintext {
    action: RemoteActionKind,
    ok: bool,
    snapshot: SessionSnapshot,
    receipt: Option<ApprovalReceipt>,
    threads: Option<ThreadsResponse>,
    thread_entries: Option<ThreadEntriesResponse>,
    thread_transcript: Option<ThreadTranscriptResponse>,
    session_claim: Option<String>,
    session_claim_expires_at: Option<u64>,
    claim_challenge_id: Option<String>,
    claim_challenge: Option<String>,
    claim_challenge_expires_at: Option<u64>,
    error: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct RemoteActionOutcome {
    pub(super) receipt: Option<ApprovalReceipt>,
    pub(super) threads: Option<ThreadsResponse>,
    pub(super) thread_entries: Option<ThreadEntriesResponse>,
    pub(super) thread_transcript: Option<ThreadTranscriptResponse>,
    pub(super) session_claim: Option<String>,
    pub(super) session_claim_expires_at: Option<u64>,
    pub(super) claim_challenge_id: Option<String>,
    pub(super) claim_challenge: Option<String>,
    pub(super) claim_challenge_expires_at: Option<u64>,
}

pub(super) async fn handle_remote_action(
    state: &AppState,
    sender: &mut SplitSink<BrokerSocket, Message>,
    from_peer_id: String,
    action_id: String,
    session_claim: Option<String>,
    device_id: Option<String>,
    request: RemoteActionRequest,
) -> Result<(), String> {
    if !state.broker_can_read_content().await {
        return Err("plaintext remote actions are disabled in private mode".to_string());
    }
    let action_kind = request.kind();
    state
        .push_runtime_log(
            "info",
            format!(
                "Broker action `{}` received from {}.",
                action_kind.as_str(),
                from_peer_id
            ),
        )
        .await;

    let resolved_device_id = match resolve_plain_remote_device(
        state,
        &from_peer_id,
        &action_id,
        session_claim.as_deref(),
        device_id.as_deref(),
        &request,
    )
    .await
    {
        Ok(device_id) => device_id,
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            let snapshot = state.snapshot().await;
            let result_device_id = device_id.unwrap_or_else(|| "unknown-device".to_string());
            return publish_plain_remote_action_result(
                sender,
                from_peer_id,
                action_id,
                action_kind,
                snapshot,
                RemoteActionOutcome::default(),
                Some(error),
                false,
                result_device_id,
            )
            .await;
        }
    };
    match state
        .reserve_remote_action(&resolved_device_id, &action_id, action_kind.as_str())
        .await
    {
        Ok(RemoteActionReplayDecision::Execute) => {}
        Ok(RemoteActionReplayDecision::Replay(cached)) => {
            return replay_plain_remote_action_result(
                sender,
                from_peer_id,
                action_id,
                action_kind,
                cached,
            )
            .await;
        }
        Ok(RemoteActionReplayDecision::InFlight) => {
            state
                .push_runtime_log(
                    "info",
                    format!(
                        "Ignored duplicate broker action `{}` from {} while the original request is still running.",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            return Ok(());
        }
        Err(error) => {
            let snapshot = state.snapshot().await;
            let cached = cached_remote_action_result(
                action_kind,
                snapshot,
                RemoteActionOutcome::default(),
                Some(error),
                false,
                None,
            );
            state
                .store_remote_action_result(&resolved_device_id, &action_id, cached.clone())
                .await;
            return replay_plain_remote_action_result(
                sender,
                from_peer_id,
                action_id,
                action_kind,
                cached,
            )
            .await;
        }
    }

    let result = match request {
        RemoteActionRequest::ClaimChallenge { .. } => {
            issue_claim_challenge_outcome(state, &resolved_device_id, &from_peer_id).await
        }
        RemoteActionRequest::ClaimDevice {
            challenge_id,
            proof,
        } => {
            issue_claim_outcome(
                state,
                &resolved_device_id,
                &from_peer_id,
                &challenge_id,
                &proof,
            )
            .await
        }
        request => attach_session_claim_if_needed(
            action_kind,
            &resolved_device_id,
            &from_peer_id,
            execute_remote_action(state, request.bind_device(resolved_device_id.clone())).await?,
        ),
    };
    let snapshot = state.snapshot().await;
    info!(
        action = action_kind.as_str(),
        active_thread_id = snapshot.active_thread_id.as_deref().unwrap_or("-"),
        active_turn_id = snapshot.active_turn_id.as_deref().unwrap_or("-"),
        transcript_entries = snapshot.transcript.len(),
        transcript_truncated = snapshot.transcript_truncated,
        logs = snapshot.logs.len(),
        "publishing plaintext remote action result snapshot"
    );

    let (ok, outcome, error) = match result {
        Ok(outcome) => (true, outcome, None),
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            (false, RemoteActionOutcome::default(), Some(error))
        }
    };
    let cached = cached_remote_action_result(action_kind, snapshot, outcome, error, ok, None);
    state
        .store_remote_action_result(&resolved_device_id, &action_id, cached.clone())
        .await;
    replay_plain_remote_action_result(sender, from_peer_id, action_id, action_kind, cached).await
}

pub(super) async fn handle_encrypted_remote_action(
    state: &AppState,
    sender: &mut SplitSink<BrokerSocket, Message>,
    from_peer_id: String,
    action_id: String,
    session_claim: Option<String>,
    device_id: Option<String>,
    envelope: EncryptedEnvelope,
) -> Result<(), String> {
    let hinted_device_id = device_id.clone();
    let ResolvedEncryptedAction {
        device_id,
        action_kind,
        request,
        response_secret,
    } = match resolve_encrypted_action_context(
        state,
        &from_peer_id,
        session_claim.as_deref(),
        device_id.as_deref(),
        &envelope,
    )
    .await
    {
        Ok(context) => context,
        Err(error) => {
            let Some(device_id) = hinted_device_id else {
                return Err(error);
            };
            let action_kind = decrypt_remote_action_kind(state, &device_id, &envelope)
                .await
                .unwrap_or(RemoteActionKind::ClaimDevice);
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Encrypted broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            let snapshot = state.snapshot().await;
            if let Err(publish_error) = publish_remote_action_result_private(
                state,
                sender,
                from_peer_id,
                device_id,
                action_id,
                action_kind,
                snapshot,
                RemoteActionOutcome::default(),
                Some(error),
                false,
                None,
            )
            .await
            {
                if publish_error.contains("device is not paired") {
                    state
                        .push_runtime_log(
                            "warn",
                            "Skipped encrypted broker error reply because the device is no longer paired."
                                .to_string(),
                        )
                        .await;
                    return Ok(());
                }
                return Err(publish_error);
            }
            return Ok(());
        }
    };
    state
        .push_runtime_log(
            "info",
            format!(
                "Encrypted broker action `{}` received from {}.",
                action_kind.as_str(),
                from_peer_id
            ),
        )
        .await;

    match state
        .reserve_remote_action(&device_id, &action_id, action_kind.as_str())
        .await
    {
        Ok(RemoteActionReplayDecision::Execute) => {}
        Ok(RemoteActionReplayDecision::Replay(cached)) => {
            return replay_encrypted_remote_action_result(
                state,
                sender,
                from_peer_id,
                device_id,
                action_id,
                action_kind,
                cached,
            )
            .await;
        }
        Ok(RemoteActionReplayDecision::InFlight) => {
            state
                .push_runtime_log(
                    "info",
                    format!(
                        "Ignored duplicate encrypted broker action `{}` from {} while the original request is still running.",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            return Ok(());
        }
        Err(error) => {
            let snapshot = state.snapshot().await;
            let cached = cached_remote_action_result(
                action_kind,
                snapshot,
                RemoteActionOutcome::default(),
                Some(error),
                false,
                None,
            );
            state
                .store_remote_action_result(&device_id, &action_id, cached.clone())
                .await;
            return replay_encrypted_remote_action_result(
                state,
                sender,
                from_peer_id,
                device_id,
                action_id,
                action_kind,
                cached,
            )
            .await;
        }
    }

    let result = match request {
        RemoteActionRequest::ClaimChallenge { .. } => {
            issue_claim_challenge_outcome(state, &device_id, &from_peer_id).await
        }
        RemoteActionRequest::ClaimDevice {
            challenge_id,
            proof,
        } => issue_claim_outcome(state, &device_id, &from_peer_id, &challenge_id, &proof).await,
        request => {
            state
                .mark_remote_device_seen(&device_id, &from_peer_id)
                .await?;
            attach_session_claim_if_needed(
                action_kind,
                &device_id,
                &from_peer_id,
                execute_remote_action(state, request.bind_device(device_id.clone())).await?,
            )
        }
    };

    let snapshot = state.snapshot().await;
    info!(
        action = action_kind.as_str(),
        active_thread_id = snapshot.active_thread_id.as_deref().unwrap_or("-"),
        active_turn_id = snapshot.active_turn_id.as_deref().unwrap_or("-"),
        transcript_entries = snapshot.transcript.len(),
        transcript_truncated = snapshot.transcript_truncated,
        logs = snapshot.logs.len(),
        "publishing encrypted remote action result snapshot"
    );
    let (ok, outcome, error) = match result {
        Ok(outcome) => (true, outcome, None),
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Encrypted broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            (false, RemoteActionOutcome::default(), Some(error))
        }
    };
    let cached = cached_remote_action_result(
        action_kind,
        snapshot,
        outcome,
        error,
        ok,
        Some(response_secret.clone()),
    );
    state
        .store_remote_action_result(&device_id, &action_id, cached.clone())
        .await;

    match replay_encrypted_remote_action_result(
        state,
        sender,
        from_peer_id,
        device_id,
        action_id,
        action_kind,
        cached,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(publish_error) if publish_error.contains("device is not paired") => {
            state
                .push_runtime_log(
                    "warn",
                    "Skipped encrypted broker action result because the device is no longer paired."
                        .to_string(),
                )
                .await;
            Ok(())
        }
        Err(publish_error) => Err(publish_error),
    }
}

struct ResolvedEncryptedAction {
    device_id: String,
    action_kind: RemoteActionKind,
    request: RemoteActionRequest,
    response_secret: String,
}

async fn execute_remote_action(
    state: &AppState,
    request: RemoteActionRequest,
) -> Result<RemoteActionOutcome, String> {
    match request {
        RemoteActionRequest::ClaimChallenge { .. } | RemoteActionRequest::ClaimDevice { .. } => {
            Err("claim actions must be handled before generic action execution".to_string())
        }
        RemoteActionRequest::StartSession { input } => state
            .start_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ResumeSession { input } => state
            .resume_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::SendMessage { input } => state
            .send_message(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::TakeOver { input } => state
            .take_over_control(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::Heartbeat { input } => state
            .heartbeat_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ListThreads { query } => state
            .list_threads(query.limit.unwrap_or(80).clamp(1, 200), query.cwd)
            .await
            .map(|threads| RemoteActionOutcome {
                receipt: None,
                threads: Some(threads),
                thread_entries: None,
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadEntries { input } => state
            .read_thread_entries(input)
            .await
            .map(|thread_entries| RemoteActionOutcome {
                receipt: None,
                threads: None,
                thread_entries: Some(thread_entries),
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadTranscript { input } => {
            info!(
                thread_id = %input.thread_id,
                cursor = ?input.cursor,
                before = ?input.before,
                "executing remote transcript fetch"
            );
            state
                .read_thread_transcript(input)
                .await
                .map(|thread_transcript| RemoteActionOutcome {
                    receipt: None,
                    threads: None,
                    thread_entries: None,
                    thread_transcript: Some(thread_transcript),
                    session_claim: None,
                    session_claim_expires_at: None,
                    ..RemoteActionOutcome::default()
                })
        }
        RemoteActionRequest::DecideApproval { request_id, input } => state
            .decide_approval(&request_id, input)
            .await
            .map(|receipt| RemoteActionOutcome {
                receipt: Some(receipt),
                threads: None,
                thread_entries: None,
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            })
            .map_err(approval_error_message),
    }
}

fn requires_session_claim(action: RemoteActionKind) -> bool {
    matches!(action, RemoteActionKind::SendMessage)
}

fn issues_session_claim(action: RemoteActionKind) -> bool {
    matches!(
        action,
        RemoteActionKind::StartSession
            | RemoteActionKind::ResumeSession
            | RemoteActionKind::TakeOver
    )
}

async fn decrypt_remote_action_kind(
    state: &AppState,
    device_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionKind, String> {
    let request = decrypt_remote_action(state, device_id, envelope).await?;
    Ok(request.kind())
}

async fn decrypt_remote_action(
    state: &AppState,
    device_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionRequest, String> {
    let secret = state.paired_device_payload_secret(device_id).await?;
    decrypt_remote_action_with_secret(&secret, envelope)
}

fn decrypt_remote_action_with_secret(
    secret: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionRequest, String> {
    decrypt_json(secret, envelope)
}

async fn resolve_plain_remote_device(
    state: &AppState,
    from_peer_id: &str,
    action_id: &str,
    session_claim: Option<&str>,
    device_id: Option<&str>,
    request: &RemoteActionRequest,
) -> Result<String, String> {
    if let Some(claim) = session_claim {
        return verify_session_claim(state, claim, from_peer_id).await;
    }

    let action_kind = request.kind();
    let device_id = device_id.map(str::to_string).ok_or_else(|| {
        if requires_session_claim(action_kind) {
            SESSION_CONTROL_REQUIRED_ERROR.to_string()
        } else {
            format!("{} requires device_id", action_kind.as_str())
        }
    })?;

    if requires_session_claim(action_kind) {
        return Err(SESSION_CONTROL_REQUIRED_ERROR.to_string());
    }

    if let RemoteActionRequest::ClaimChallenge { proof } = request {
        verify_remote_device_claim_init(state, &device_id, action_id, from_peer_id, proof).await?;
    }

    Ok(device_id)
}

async fn resolve_encrypted_action_context(
    state: &AppState,
    from_peer_id: &str,
    session_claim: Option<&str>,
    device_id: Option<&str>,
    envelope: &EncryptedEnvelope,
) -> Result<ResolvedEncryptedAction, String> {
    if let Some(claim) = session_claim {
        let device_id = verify_session_claim(state, claim, from_peer_id).await?;
        let response_secret = state.paired_device_payload_secret(&device_id).await?;
        let request = decrypt_remote_action_with_secret(&response_secret, envelope)?;
        let action_kind = request.kind();
        return Ok(ResolvedEncryptedAction {
            device_id,
            action_kind,
            request,
            response_secret,
        });
    }

    let device_id = device_id
        .map(str::to_string)
        .ok_or_else(|| "encrypted remote action is missing device_id".to_string())?;
    let response_secret = state.paired_device_payload_secret(&device_id).await?;
    let request = decrypt_remote_action_with_secret(&response_secret, envelope)?;
    let action_kind = request.kind();
    if requires_session_claim(action_kind) {
        return Err(SESSION_CONTROL_REQUIRED_ERROR.to_string());
    }
    Ok(ResolvedEncryptedAction {
        device_id,
        action_kind,
        request,
        response_secret,
    })
}

async fn verify_remote_device_claim(
    state: &AppState,
    device_id: &str,
    challenge_id: &str,
    challenge: &str,
    peer_id: &str,
    proof: &str,
) -> Result<(), String> {
    let verify_key = state.paired_device_verify_key(device_id).await?;
    verify_device_claim_challenge_proof(
        challenge_id,
        challenge,
        device_id,
        peer_id,
        &verify_key,
        proof,
    )
}

async fn verify_remote_device_claim_init(
    state: &AppState,
    device_id: &str,
    action_id: &str,
    peer_id: &str,
    proof: &str,
) -> Result<(), String> {
    let verify_key = state.paired_device_verify_key(device_id).await?;
    verify_device_claim_init_proof(action_id, device_id, peer_id, &verify_key, proof)
}

async fn issue_claim_challenge_outcome(
    state: &AppState,
    device_id: &str,
    peer_id: &str,
) -> Result<RemoteActionOutcome, String> {
    state.mark_remote_device_seen(device_id, peer_id).await?;
    let challenge = state.issue_claim_challenge(device_id, peer_id).await?;
    Ok(RemoteActionOutcome {
        claim_challenge_id: Some(challenge.challenge_id),
        claim_challenge: Some(challenge.challenge),
        claim_challenge_expires_at: Some(challenge.expires_at),
        ..RemoteActionOutcome::default()
    })
}

async fn issue_claim_outcome(
    state: &AppState,
    device_id: &str,
    peer_id: &str,
    challenge_id: &str,
    proof: &str,
) -> Result<RemoteActionOutcome, String> {
    let challenge = state
        .claim_challenge(device_id, challenge_id, peer_id)
        .await?;
    verify_remote_device_claim(
        state,
        device_id,
        &challenge.challenge_id,
        &challenge.challenge,
        peer_id,
        proof,
    )
    .await?;
    let completed = state
        .complete_remote_claim(device_id, &challenge.challenge_id, peer_id)
        .await?;
    let claim = issue_session_claim(device_id, peer_id)?;
    let _ = completed;
    Ok(RemoteActionOutcome {
        receipt: None,
        threads: None,
        session_claim: Some(claim.token),
        session_claim_expires_at: Some(claim.expires_at),
        ..RemoteActionOutcome::default()
    })
}

fn attach_session_claim_if_needed(
    action: RemoteActionKind,
    device_id: &str,
    peer_id: &str,
    mut outcome: RemoteActionOutcome,
) -> Result<RemoteActionOutcome, String> {
    if !issues_session_claim(action) {
        return Ok(outcome);
    }

    let claim = issue_session_claim(device_id, peer_id)?;
    outcome.session_claim = Some(claim.token);
    outcome.session_claim_expires_at = Some(claim.expires_at);
    Ok(outcome)
}

fn approval_error_message(error: ApprovalError) -> String {
    match error {
        ApprovalError::NoPendingRequest => {
            "there is no approval request waiting for a remote decision".to_string()
        }
        ApprovalError::Bridge(message) => message,
    }
}

async fn publish_plain_remote_action_result(
    sender: &mut SplitSink<BrokerSocket, Message>,
    target_peer_id: String,
    action_id: String,
    action: RemoteActionKind,
    snapshot: SessionSnapshot,
    outcome: RemoteActionOutcome,
    error: Option<String>,
    ok: bool,
    _device_id: String,
) -> Result<(), String> {
    let input_transcript_entries = snapshot.transcript.len();
    let input_transcript_truncated = snapshot.transcript_truncated;
    let snapshot =
        snapshot.compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface);
    info!(
        action = action.as_str(),
        input_transcript_entries,
        input_transcript_truncated,
        compacted_transcript_entries = snapshot.transcript.len(),
        compacted_transcript_truncated = snapshot.transcript_truncated,
        "publishing plaintext remote action result compacted snapshot"
    );
    let threads = outcome.threads.map(|threads| {
        threads.compact_for(crate::protocol::ThreadsResponseCompactProfile::RemoteSurface)
    });
    publish_payload(
        sender,
        OutboundBrokerPayload::RemoteActionResult {
            action_id,
            target_peer_id,
            action,
            ok,
            snapshot,
            receipt: outcome.receipt,
            threads,
            thread_entries: outcome.thread_entries,
            thread_transcript: outcome.thread_transcript,
            session_claim: outcome.session_claim,
            session_claim_expires_at: outcome.session_claim_expires_at,
            claim_challenge_id: outcome.claim_challenge_id,
            claim_challenge: outcome.claim_challenge,
            claim_challenge_expires_at: outcome.claim_challenge_expires_at,
            error,
        },
    )
    .await
    .map_err(|error| format!("broker action result publish failed: {error}"))
}

async fn replay_plain_remote_action_result(
    sender: &mut SplitSink<BrokerSocket, Message>,
    target_peer_id: String,
    action_id: String,
    action: RemoteActionKind,
    cached: CachedRemoteActionResult,
) -> Result<(), String> {
    publish_plain_remote_action_result(
        sender,
        target_peer_id,
        action_id,
        action,
        cached.snapshot,
        RemoteActionOutcome {
            receipt: cached.receipt,
            threads: cached.threads,
            thread_entries: cached.thread_entries,
            thread_transcript: cached.thread_transcript,
            session_claim: cached.session_claim,
            session_claim_expires_at: cached.session_claim_expires_at,
            claim_challenge_id: cached.claim_challenge_id,
            claim_challenge: cached.claim_challenge,
            claim_challenge_expires_at: cached.claim_challenge_expires_at,
        },
        cached.error,
        cached.ok,
        "cached-device".to_string(),
    )
    .await
}

async fn publish_remote_action_result_private(
    state: &AppState,
    sender: &mut SplitSink<BrokerSocket, Message>,
    target_peer_id: String,
    device_id: String,
    action_id: String,
    action: RemoteActionKind,
    snapshot: SessionSnapshot,
    outcome: RemoteActionOutcome,
    error: Option<String>,
    ok: bool,
    response_secret: Option<&str>,
) -> Result<(), String> {
    let input_transcript_entries = snapshot.transcript.len();
    let input_transcript_truncated = snapshot.transcript_truncated;
    let snapshot =
        snapshot.compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface);
    info!(
        action = action.as_str(),
        input_transcript_entries,
        input_transcript_truncated,
        compacted_transcript_entries = snapshot.transcript.len(),
        compacted_transcript_truncated = snapshot.transcript_truncated,
        "publishing encrypted remote action result compacted snapshot"
    );
    let threads = outcome.threads.map(|threads| {
        threads.compact_for(crate::protocol::ThreadsResponseCompactProfile::RemoteSurface)
    });
    let secret = match response_secret {
        Some(secret) => secret.to_string(),
        None => state.paired_device_payload_secret(&device_id).await?,
    };
    let envelope = encrypt_json(
        &secret,
        &RemoteActionResultPlaintext {
            action,
            ok,
            snapshot,
            receipt: outcome.receipt,
            threads,
            thread_entries: outcome.thread_entries,
            thread_transcript: outcome.thread_transcript,
            session_claim: outcome.session_claim,
            session_claim_expires_at: outcome.session_claim_expires_at,
            claim_challenge_id: outcome.claim_challenge_id,
            claim_challenge: outcome.claim_challenge,
            claim_challenge_expires_at: outcome.claim_challenge_expires_at,
            error,
        },
    )?;

    publish_payload(
        sender,
        OutboundBrokerPayload::EncryptedRemoteActionResult {
            action_id,
            target_peer_id,
            device_id,
            envelope,
        },
    )
    .await
    .map_err(|error| format!("encrypted broker action result publish failed: {error}"))
}

async fn replay_encrypted_remote_action_result(
    state: &AppState,
    sender: &mut SplitSink<BrokerSocket, Message>,
    target_peer_id: String,
    device_id: String,
    action_id: String,
    action: RemoteActionKind,
    cached: CachedRemoteActionResult,
) -> Result<(), String> {
    publish_remote_action_result_private(
        state,
        sender,
        target_peer_id,
        device_id,
        action_id,
        action,
        cached.snapshot,
        RemoteActionOutcome {
            receipt: cached.receipt,
            threads: cached.threads,
            thread_entries: cached.thread_entries,
            thread_transcript: cached.thread_transcript,
            session_claim: cached.session_claim,
            session_claim_expires_at: cached.session_claim_expires_at,
            claim_challenge_id: cached.claim_challenge_id,
            claim_challenge: cached.claim_challenge,
            claim_challenge_expires_at: cached.claim_challenge_expires_at,
        },
        cached.error,
        cached.ok,
        cached.response_secret.as_deref(),
    )
    .await
}

fn cached_remote_action_result(
    action: RemoteActionKind,
    snapshot: SessionSnapshot,
    outcome: RemoteActionOutcome,
    error: Option<String>,
    ok: bool,
    response_secret: Option<String>,
) -> CachedRemoteActionResult {
    CachedRemoteActionResult {
        action_kind: action.as_str().to_string(),
        ok,
        snapshot,
        receipt: outcome.receipt,
        // Snapshots and thread lists are compacted at the remote-surface publish
        // boundary. Thread transcript responses are already paginated and do not
        // use ThreadsResponseCompactProfile.
        threads: outcome.threads,
        thread_entries: outcome.thread_entries,
        thread_transcript: outcome.thread_transcript,
        session_claim: outcome.session_claim,
        session_claim_expires_at: outcome.session_claim_expires_at,
        claim_challenge_id: outcome.claim_challenge_id,
        claim_challenge: outcome.claim_challenge,
        claim_challenge_expires_at: outcome.claim_challenge_expires_at,
        response_secret,
        error,
    }
}

#[cfg(test)]
mod tests;
