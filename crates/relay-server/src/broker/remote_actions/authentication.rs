//! How a phone proves who it is: the two claim steps that open a request session, and the
//! signature every other request carries. Nothing is looked up or reserved before these pass.

use tracing::warn;

use super::{
    delivery::{
        answer_from_attempt_ahead, cached_remote_action_result,
        publish_remote_action_result_private, replay_encrypted_remote_action_result, reply_refusal,
        settle, skip_unpaired, RemoteActionFailure, RemoteActionOutcome,
    },
    request::{
        decrypt_remote_action_with_secret, requires_signed_attempt, RemoteActionKind,
        RemoteActionRequest,
    },
};
use crate::{
    broker::{
        crypto::EncryptedEnvelope,
        request_auth::{
            envelope_digest, remote_request_message, verify_remote_request, RelayRequestBinding,
            SignedAttempt,
        },
        verify_device_claim_challenge_proof, verify_device_claim_init_proof,
        writer::BrokerWriter,
        FrameOrigin,
    },
    state::{AppState, RemoteActionReplayDecision},
};

/// Unauthenticated, replayed or stale-and-unprovable frames get no answer at all: any
/// answer would let a broker settle the phone's real request with it.
pub(super) fn drop_unauthenticated(from_peer_id: &str, action_id: &str, reason: &str) {
    warn!(
        from_peer_id,
        action_id, reason, "dropped a remote action that is not the phone's current request"
    );
}

/// The two claim steps. They carry their own device signatures over the action id,
/// peer and issued challenge, checked before any cache lookup or reservation.
pub(super) async fn handle_claim_step(
    state: &AppState,
    writer: &BrokerWriter,
    origin: FrameOrigin,
    from_peer_id: String,
    action_id: String,
    device_id: Option<String>,
    envelope: EncryptedEnvelope,
) -> Result<(), String> {
    let Some(device_id) = device_id else {
        drop_unauthenticated(&from_peer_id, &action_id, "claim step names no device");
        return Ok(());
    };
    let (action_kind, request, response_secret) =
        match resolve_claim_step(state, &from_peer_id, &action_id, &device_id, &envelope).await {
            Ok(resolved) => resolved,
            Err(ClaimStepError::NotAClaim) => {
                drop_unauthenticated(&from_peer_id, &action_id, "unsigned remote action");
                return Ok(());
            }
            Err(ClaimStepError::Refused(action_kind, error)) => {
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
                return skip_unpaired(
                    state,
                    publish_remote_action_result_private(
                        state,
                        writer,
                        from_peer_id,
                        device_id,
                        action_id,
                        action_kind,
                        None,
                        RemoteActionOutcome::default(),
                        Some(error),
                        false,
                        None,
                        Some(origin.lease),
                    )
                    .await,
                )
                .await;
            }
        };

    // Claims belong to one connection, so their cache is keyed by it.
    let cache_action_id = serde_json::to_string(&(from_peer_id.as_str(), action_id.as_str()))
        .expect("claim cache key should serialize");
    match state
        .reserve_remote_action(&device_id, &cache_action_id, action_kind.as_str())
        .await
    {
        Ok(RemoteActionReplayDecision::Execute) => {}
        Ok(RemoteActionReplayDecision::Replay(cached)) => {
            return replay_encrypted_remote_action_result(
                state,
                writer,
                from_peer_id,
                device_id,
                action_id,
                action_kind,
                cached,
                Some(origin.lease),
            )
            .await;
        }
        Ok(RemoteActionReplayDecision::InFlight(wait)) => {
            let (state, writer) = (state.clone(), writer.clone());
            tokio::spawn(async move {
                answer_from_attempt_ahead(
                    &state,
                    &writer,
                    from_peer_id,
                    device_id,
                    action_id,
                    &cache_action_id,
                    action_kind,
                    wait,
                    origin.lease,
                )
                .await;
            });
            return Ok(());
        }
        // Answered, but never stored: storing it would replace the original's record.
        Err(error) => {
            return reply_refusal(
                state,
                writer,
                from_peer_id,
                device_id,
                action_id,
                action_kind,
                error,
                None,
                origin.lease,
            )
            .await;
        }
    }

    let result: Result<RemoteActionOutcome, RemoteActionFailure> = match request {
        RemoteActionRequest::ClaimChallenge { .. } => {
            issue_claim_challenge_outcome(state, &device_id, &from_peer_id, origin.lease)
                .await
                .map_err(RemoteActionFailure::from)
        }
        RemoteActionRequest::ClaimDevice {
            challenge_id,
            challenge,
            proof: _,
        } => issue_claim_outcome(
            state,
            &device_id,
            &from_peer_id,
            &challenge_id,
            &challenge,
            origin.lease,
        )
        .await
        .map_err(RemoteActionFailure::from),
        _ => Err(RemoteActionFailure::from(
            "only claim steps travel unsigned".to_string(),
        )),
    };
    let snapshot = state.snapshot().await;
    let (ok, outcome, error) = settle(state, action_kind, &from_peer_id, result).await;
    let cached = cached_remote_action_result(
        action_kind,
        snapshot,
        outcome,
        error,
        ok,
        Some(response_secret),
    );
    state
        .store_remote_action_result(&device_id, &cache_action_id, cached.clone())
        .await;
    skip_unpaired(
        state,
        replay_encrypted_remote_action_result(
            state,
            writer,
            from_peer_id,
            device_id,
            action_id,
            action_kind,
            cached,
            Some(origin.lease),
        )
        .await,
    )
    .await
}

pub(super) async fn authenticate_signed_request(
    state: &AppState,
    binding: &RelayRequestBinding,
    from_peer_id: &str,
    action_id: &str,
    device_id: &str,
    attempt: &SignedAttempt,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionRequest, String> {
    if !requires_signed_attempt(attempt.action) {
        return Err("claim steps are not signed requests".to_string());
    }
    let verify_key = state.paired_device_verify_key(device_id).await?;
    let digest = envelope_digest(envelope)?;
    let message = remote_request_message(
        binding,
        device_id,
        from_peer_id,
        action_id,
        attempt,
        &digest,
    )?;
    verify_remote_request(&verify_key, &message, &attempt.signature)?;
    let secret = state.paired_device_payload_secret(device_id).await?;
    let request = decrypt_remote_action_with_secret(&secret, action_id, envelope)?;
    if request.kind() != attempt.action {
        return Err("the signed action kind does not match the sealed request".to_string());
    }
    Ok(request)
}

enum ClaimStepError {
    /// Not a claim step at all: an unsigned action, which gets no answer.
    NotAClaim,
    /// A claim step that failed its own proof; answered as before.
    Refused(RemoteActionKind, String),
}

async fn resolve_claim_step(
    state: &AppState,
    from_peer_id: &str,
    action_id: &str,
    device_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<(RemoteActionKind, RemoteActionRequest, String), ClaimStepError> {
    let refused = |error: String| ClaimStepError::Refused(RemoteActionKind::ClaimDevice, error);
    let response_secret = state
        .paired_device_payload_secret(device_id)
        .await
        .map_err(refused)?;
    let request = decrypt_remote_action_with_secret(&response_secret, action_id, envelope)
        .map_err(refused)?;
    let action_kind = request.kind();
    let refused = |error: String| ClaimStepError::Refused(action_kind, error);
    match &request {
        RemoteActionRequest::ClaimChallenge { proof } => {
            let verify_key = state
                .paired_device_verify_key(device_id)
                .await
                .map_err(refused)?;
            verify_device_claim_init_proof(action_id, device_id, from_peer_id, &verify_key, proof)
                .map_err(refused)?;
        }
        RemoteActionRequest::ClaimDevice {
            challenge_id,
            challenge,
            proof,
        } => {
            verify_remote_device_claim(
                state,
                device_id,
                challenge_id,
                challenge,
                from_peer_id,
                proof,
            )
            .await
            .map_err(refused)?;
        }
        _ => return Err(ClaimStepError::NotAClaim),
    }
    Ok((action_kind, request, response_secret))
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

pub(super) async fn issue_claim_challenge_outcome(
    state: &AppState,
    device_id: &str,
    peer_id: &str,
    lease: u64,
) -> Result<RemoteActionOutcome, String> {
    // A stale broker session must not replace the current connection's challenge.
    state
        .mark_remote_device_seen(device_id, peer_id, Some(lease))
        .await?;
    let challenge = state
        .issue_claim_challenge(device_id, peer_id, lease)
        .await?;
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
    claimed_challenge: &str,
    lease: u64,
) -> Result<RemoteActionOutcome, String> {
    // Signature was checked before reserve; this only binds that nonce to the issued
    // challenge. Peer binding stays inside the write: a separate check is a window a
    // departure can land in, and the session would then fail on the live connection.
    let challenge = state
        .claim_challenge(device_id, challenge_id, peer_id)
        .await?;
    if challenge.challenge != claimed_challenge {
        return Err("claim challenge does not match the issued challenge".to_string());
    }
    let grant = state
        .complete_remote_claim(device_id, &challenge.challenge_id, peer_id, lease)
        .await?;
    Ok(RemoteActionOutcome {
        session_claim: Some(grant.sid),
        session_claim_expires_at: Some(grant.expires_at),
        session_claim_boot: Some(grant.boot_id),
        session_claim_relay_ms: Some(grant.relay_ms),
        ..RemoteActionOutcome::default()
    })
}
