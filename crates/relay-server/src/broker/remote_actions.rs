//! A phone request: authenticated (`authentication`), admitted atomically, dispatched here,
//! executed once (`execution`), answered to that phone (`delivery`).

use crate::{
    protocol::ClientErrorCode,
    state::{AppState, RemoteActionWait, RequestAdmission},
};

mod authentication;
mod delivery;
mod execution;
mod request;

use self::authentication::{authenticate_signed_request, drop_unauthenticated, handle_claim_step};
#[cfg(test)]
pub(super) use self::delivery::REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS;
use self::delivery::{
    answer_from_attempt_ahead, publish_reauthorize, replay_encrypted_remote_action_result,
    reply_refusal, ALREADY_COMPLETED_ERROR, OUTCOME_UNKNOWN_ERROR,
};
use self::execution::{execute_admitted, run_untracked, AdmittedAttempt};
use self::request::remote_action_class;
pub(super) use self::request::RemoteActionKind;
#[cfg(test)]
pub(super) use self::request::{decrypt_remote_action_with_secret, RemoteActionRequest};

use super::{
    crypto::EncryptedEnvelope,
    request_auth::{request_digest, SignedAttempt},
    writer::BrokerWriter,
    FrameOrigin,
};

/// The signed attempt fields from a frame. `Ok(None)` is a claim step, which carries
/// none of them; a frame with only some of them is malformed.
#[allow(clippy::too_many_arguments)]
pub(super) fn signed_attempt_from_parts(
    action: Option<RemoteActionKind>,
    request_sid: Option<String>,
    request_boot: Option<String>,
    request_seq: Option<u64>,
    request_time: Option<u64>,
    op_boot: Option<String>,
    op_t0: Option<u64>,
    request_signature: Option<String>,
) -> Result<Option<SignedAttempt>, ()> {
    match (
        action,
        request_sid,
        request_boot,
        request_seq,
        request_time,
        op_boot,
        op_t0,
        request_signature,
    ) {
        (None, None, None, None, None, None, None, None) => Ok(None),
        (
            Some(action),
            Some(sid),
            Some(boot_id),
            Some(seq),
            Some(sent_ms),
            Some(op_boot),
            Some(op_t0),
            Some(signature),
        ) => Ok(Some(SignedAttempt {
            action,
            sid,
            boot_id,
            seq,
            sent_ms,
            op_boot,
            op_t0,
            signature,
        })),
        _ => Err(()),
    }
}

pub(super) async fn handle_encrypted_remote_action(
    state: &AppState,
    writer: &BrokerWriter,
    origin: FrameOrigin,
    from_peer_id: String,
    action_id: String,
    device_id: Option<String>,
    signed: Result<Option<SignedAttempt>, ()>,
    envelope: EncryptedEnvelope,
) -> Result<(), String> {
    match signed {
        Ok(Some(attempt)) => {
            handle_signed_remote_action(
                state,
                writer,
                origin,
                from_peer_id,
                action_id,
                device_id,
                attempt,
                envelope,
            )
            .await
        }
        Ok(None) => {
            handle_claim_step(
                state,
                writer,
                origin,
                from_peer_id,
                action_id,
                device_id,
                envelope,
            )
            .await
        }
        Err(()) => {
            drop_unauthenticated(&from_peer_id, &action_id, "incomplete request signature");
            Ok(())
        }
    }
}

/// Everything but the claim steps. Authenticated before anything is looked up, reserved
/// or answered; admitted atomically before execution.
#[allow(clippy::too_many_arguments)]
async fn handle_signed_remote_action(
    state: &AppState,
    writer: &BrokerWriter,
    origin: FrameOrigin,
    from_peer_id: String,
    action_id: String,
    device_id: Option<String>,
    attempt: SignedAttempt,
    envelope: EncryptedEnvelope,
) -> Result<(), String> {
    let Some(binding) = writer.request_binding() else {
        return Err("relay content signer is not installed; refusing signed requests".to_string());
    };
    let Some(device_id) = device_id else {
        drop_unauthenticated(&from_peer_id, &action_id, "signed request names no device");
        return Ok(());
    };
    let request = match authenticate_signed_request(
        state,
        &binding,
        &from_peer_id,
        &action_id,
        &device_id,
        &attempt,
        &envelope,
    )
    .await
    {
        Ok(request) => request,
        Err(reason) => {
            drop_unauthenticated(&from_peer_id, &action_id, &reason);
            return Ok(());
        }
    };
    let digest = match request_digest(&request) {
        Ok(digest) => digest,
        Err(reason) => {
            drop_unauthenticated(&from_peer_id, &action_id, &reason);
            return Ok(());
        }
    };
    let admitted = AdmittedAttempt {
        origin,
        from_peer_id,
        device_id,
        action_id,
        class: remote_action_class(attempt.action),
        attempt,
        digest,
        request,
    };
    let admission = state
        .admit_signed_request(&admitted.facts(), origin.lease)
        .await;
    dispatch_admission(state, writer, admitted, admission).await
}

async fn dispatch_admission(
    state: &AppState,
    writer: &BrokerWriter,
    admitted: AdmittedAttempt,
    admission: RequestAdmission,
) -> Result<(), String> {
    let action_kind = admitted.attempt.action;
    let lease = admitted.origin.lease;
    match admission {
        RequestAdmission::Reauthorize => {
            publish_reauthorize(writer, &admitted.from_peer_id, &admitted.action_id).await;
            Ok(())
        }
        RequestAdmission::Duplicate => {
            drop_unauthenticated(
                &admitted.from_peer_id,
                &admitted.action_id,
                "attempt was already used",
            );
            Ok(())
        }
        RequestAdmission::Refused(message) => {
            reply_refusal(
                state,
                writer,
                admitted.from_peer_id,
                admitted.device_id,
                admitted.action_id,
                action_kind,
                message.to_string(),
                None,
                lease,
            )
            .await
        }
        RequestAdmission::OutcomeUnknown => {
            reply_refusal(
                state,
                writer,
                admitted.from_peer_id,
                admitted.device_id,
                admitted.action_id,
                action_kind,
                OUTCOME_UNKNOWN_ERROR.to_string(),
                Some(ClientErrorCode::OutcomeUnknown),
                lease,
            )
            .await
        }
        RequestAdmission::AlreadyCompleted => {
            reply_refusal(
                state,
                writer,
                admitted.from_peer_id,
                admitted.device_id,
                admitted.action_id,
                action_kind,
                ALREADY_COMPLETED_ERROR.to_string(),
                Some(ClientErrorCode::AlreadyCompleted),
                lease,
            )
            .await
        }
        RequestAdmission::Replay(cached) => {
            replay_encrypted_remote_action_result(
                state,
                writer,
                admitted.from_peer_id,
                admitted.device_id,
                admitted.action_id,
                action_kind,
                cached,
                Some(lease),
            )
            .await
        }
        RequestAdmission::InFlight(wait) => {
            spawn_waiter(state, writer, admitted, wait);
            Ok(())
        }
        RequestAdmission::Run => run_untracked(state, admitted).await,
        RequestAdmission::Execute(token) => execute_admitted(state, writer, admitted, token).await,
    }
}

fn spawn_waiter(
    state: &AppState,
    writer: &BrokerWriter,
    admitted: AdmittedAttempt,
    wait: RemoteActionWait,
) {
    let state = state.clone();
    let writer = writer.clone();
    tokio::spawn(async move {
        answer_from_attempt_ahead(
            &state,
            &writer,
            admitted.from_peer_id.clone(),
            admitted.device_id.clone(),
            admitted.action_id.clone(),
            &admitted.action_id,
            admitted.attempt.action,
            wait,
            admitted.origin.lease,
        )
        .await;
    });
}

#[cfg(test)]
mod tests;
