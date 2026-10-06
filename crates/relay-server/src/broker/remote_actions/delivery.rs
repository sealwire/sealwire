//! Everything sent back to the phone about one request: the sealed reply (whole or
//! chunked), refusals, "still running" notices, and waiting on the attempt ahead.

use serde::{Deserialize, Serialize};
use tokio::time::{Duration, Instant};
use tracing::{info, warn};

use super::request::RemoteActionKind;
use crate::{
    broker::{
        crypto::encrypt_json,
        frame_message_for_payload,
        protocol::{frame_bytes_for_payload, OutboundBrokerPayload},
        publish_payload,
        writer::{BrokerWriter, TrainHandoff},
        MAX_BROKER_TEXT_FRAME_BYTES,
    },
    protocol::{
        ApprovalReceipt, AskDetailResponse, AskUserAnswerReceipt, AskUserQuestionDetailResponse,
        ClientErrorCode, DevicesResponse, ModelOptionView, ProjectsResponse, ResolvedWorkspace,
        ReviewsResponse, SessionSnapshot, ThreadEntryDetailResponse, ThreadSettingsView,
        ThreadSkillsView, ThreadTranscriptResponse, ThreadsResponse, WorkflowsResponse,
        WorkspaceDiffResponse, WorkspaceGitContextView,
    },
    state::{
        AppState, CachedRemoteActionResult, RemoteActionWait, RemoteActionWaitSource,
        TranscriptReadError, WaitOutcome,
    },
};

/// How long a reconnected asker waits for an answer someone else is producing.
const REMOTE_ACTION_WAIT_TIMEOUT: Duration = Duration::from_secs(120);
/// How often it repeats "still running" while it waits. Must stay under the client's own
/// deadline (`REMOTE_ACTION_TIMEOUT_MS` in `frontend/remote/actions.js`) or the phone gives
/// up between two of them and reports a failure for a write that is still running.
pub(super) const REMOTE_ACTION_PENDING_NOTICE_INTERVAL: Duration = Duration::from_secs(10);
/// The client-side deadline the interval above has to outpace, mirrored for the test.
#[cfg(test)]
pub(super) const CLIENT_REMOTE_ACTION_DEADLINE: Duration = Duration::from_secs(15);

/// Target size of one chunk, in **characters** of the serialized JSON.
///
/// Characters, not bytes, because a chunk now travels as JSON text rather than base64 —
/// see `split_on_char_boundaries`. For ASCII content (the overwhelming majority of a
/// transcript) the two are the same, and the resulting frame is ~25% smaller than the
/// old double-base64 encoding produced.
const REMOTE_ACTION_RESULT_CHUNK_TARGET_CHARS: usize = 32_768;
const REMOTE_ACTION_RESULT_CHUNK_MIN_CHARS: usize = 1_024;
/// Gap between chunks of one reply.
///
/// This used to be 250ms, chosen when every peer shared a 4-publishes-a-second budget.
/// At that pace 61 chunks take the client's entire 15-second action deadline before the
/// last one lands, so a large-but-legitimate reply — a workspace diff may be megabytes —
/// could never arrive at all. Relays now have their own, far larger allowance, and the
/// writer interleaves ordinary traffic into these gaps rather than being blocked by
/// them, so the gap only needs to be big enough to stay interleavable.
pub(in crate::broker) const REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS: u64 = 50;

#[derive(Debug, Clone, Serialize)]
pub(super) struct RemoteActionResultPlaintext {
    pub(super) kind: RemoteActionResultKind,
    pub(super) action: RemoteActionKind,
    pub(super) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) snapshot: Option<SessionSnapshot>,
    pub(super) receipt: Option<ApprovalReceipt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ask_user_answer_receipt: Option<AskUserAnswerReceipt>,
    pub(super) providers: Option<Vec<String>>,
    pub(super) models: Option<Vec<ModelOptionView>>,
    pub(super) threads: Option<ThreadsResponse>,
    pub(super) thread_entry_detail: Option<ThreadEntryDetailResponse>,
    pub(super) thread_transcript: Option<ThreadTranscriptResponse>,
    pub(super) workspace_diff: Option<WorkspaceDiffResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workspace_git_context: Option<WorkspaceGitContextView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) thread_workspace: Option<ResolvedWorkspace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) thread_settings: Option<ThreadSettingsView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) thread_skills: Option<ThreadSkillsView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reviews: Option<ReviewsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workflows: Option<WorkflowsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) devices: Option<DevicesResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) projects: Option<ProjectsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ask_user_question_detail: Option<AskUserQuestionDetailResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ask_detail: Option<AskDetailResponse>,
    /// The request session a completed claim opens: its id, the boot it belongs to,
    /// and the relay clock at issue, which the phone counts forward from.
    pub(super) session_claim: Option<String>,
    pub(super) session_claim_expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) session_claim_boot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) session_claim_relay_ms: Option<u64>,
    pub(super) claim_challenge_id: Option<String>,
    pub(super) claim_challenge: Option<String>,
    pub(super) claim_challenge_expires_at: Option<u64>,
    pub(super) error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error_code: Option<ClientErrorCode>,
}

/// What a client is told when its reply cannot be queued.
///
/// Deliberately explicit and recoverable: the alternative is silence, and a chunked
/// reply resolves only once every chunk lands, so silence costs the client its full
/// 15-second timeout.
const REMOTE_ACTION_BUSY_ERROR: &str =
    "the relay already has too many large replies in flight; retry this request";

fn busy_remote_action_result(
    kind: RemoteActionResultKind,
    action: RemoteActionKind,
) -> RemoteActionResultPlaintext {
    RemoteActionResultPlaintext {
        kind,
        action,
        ok: false,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        thread_skills: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        ask_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        session_claim_boot: None,
        session_claim_relay_ms: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: Some(REMOTE_ACTION_BUSY_ERROR.to_string()),
        error_code: None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RemoteActionResultKind {
    RemoteActionAck,
    RemoteApprovalResult,
    RemoteControlResult,
    RemoteSessionResult,
    RemoteThreadsResult,
    RemoteTranscriptResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct RemoteActionResultChunkPlaintext {
    pub(super) action_id: String,
    pub(super) action: RemoteActionKind,
    pub(super) chunk_index: usize,
    pub(super) chunk_count: usize,
    /// A slice of the serialized result as **text**.
    ///
    /// Was `data_base64`. The value being chunked is already JSON, so base64'ing it before
    /// wrapping it in another JSON document (which is then encrypted and base64'd again)
    /// paid for the encoding twice — ~1.78x the payload on the wire instead of ~1.35x.
    pub(super) data: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RemoteActionResultSizeBreakdown {
    pub(super) snapshot_bytes: usize,
    pub(super) receipt_bytes: usize,
    pub(super) threads_bytes: usize,
    pub(super) thread_entry_detail_bytes: usize,
    pub(super) thread_transcript_bytes: usize,
    pub(super) workspace_diff_bytes: usize,
    pub(super) workspace_git_context_bytes: usize,
    pub(super) thread_workspace_bytes: usize,
    pub(super) thread_settings_bytes: usize,
    pub(super) thread_skills_bytes: usize,
    pub(super) reviews_bytes: usize,
    pub(super) workflows_bytes: usize,
    pub(super) devices_bytes: usize,
    pub(super) projects_bytes: usize,
    pub(super) ask_user_question_detail_bytes: usize,
    pub(super) ask_detail_bytes: usize,
    pub(super) session_claim_bytes: usize,
    pub(super) claim_challenge_bytes: usize,
    pub(super) error_bytes: usize,
    pub(super) plaintext_bytes: usize,
}

#[derive(Debug, Default)]
pub(super) struct RemoteActionOutcome {
    pub(super) receipt: Option<ApprovalReceipt>,
    pub(super) ask_user_answer_receipt: Option<AskUserAnswerReceipt>,
    pub(super) providers: Option<Vec<String>>,
    pub(super) models: Option<Vec<ModelOptionView>>,
    pub(super) threads: Option<ThreadsResponse>,
    pub(super) thread_entry_detail: Option<ThreadEntryDetailResponse>,
    pub(super) thread_transcript: Option<ThreadTranscriptResponse>,
    pub(super) workspace_diff: Option<WorkspaceDiffResponse>,
    pub(super) workspace_git_context: Option<WorkspaceGitContextView>,
    pub(super) thread_workspace: Option<ResolvedWorkspace>,
    pub(super) thread_settings: Option<ThreadSettingsView>,
    pub(super) thread_skills: Option<ThreadSkillsView>,
    pub(super) reviews: Option<ReviewsResponse>,
    pub(super) workflows: Option<WorkflowsResponse>,
    pub(super) devices: Option<DevicesResponse>,
    pub(super) projects: Option<ProjectsResponse>,
    pub(super) ask_user_question_detail: Option<AskUserQuestionDetailResponse>,
    pub(super) ask_detail: Option<AskDetailResponse>,
    pub(super) session_claim: Option<String>,
    pub(super) session_claim_expires_at: Option<u64>,
    pub(super) session_claim_boot: Option<String>,
    pub(super) session_claim_relay_ms: Option<u64>,
    pub(super) claim_challenge_id: Option<String>,
    pub(super) claim_challenge: Option<String>,
    pub(super) claim_challenge_expires_at: Option<u64>,
    /// Set only on a refusal a client acts on; see `RemoteActionFailure`.
    pub(super) error_code: Option<ClientErrorCode>,
}

/// A refused action: the message a person reads, and a code a client acts on.
#[derive(Debug)]
pub(super) struct RemoteActionFailure {
    message: String,
    code: Option<ClientErrorCode>,
}

impl From<String> for RemoteActionFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            code: None,
        }
    }
}

impl From<TranscriptReadError> for RemoteActionFailure {
    fn from(error: TranscriptReadError) -> Self {
        Self {
            code: error.client_code(),
            message: error.to_string(),
        }
    }
}

impl std::fmt::Display for RemoteActionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl RemoteActionFailure {
    /// What goes back to the device: no payload, the reason, and its code.
    pub(super) fn into_refusal(self) -> (RemoteActionOutcome, String) {
        (
            RemoteActionOutcome {
                error_code: self.code,
                ..RemoteActionOutcome::default()
            },
            self.message,
        )
    }
}

pub(super) const OUTCOME_UNKNOWN_ERROR: &str =
    "The relay cannot tell whether this ran: it restarted, or the \
first attempt is more than five minutes old. Check the session before doing it again.";
pub(super) const ALREADY_COMPLETED_ERROR: &str =
    "This already ran on the relay, but its reply is no longer kept. Refresh to see the result.";

pub(super) async fn settle(
    state: &AppState,
    action_kind: RemoteActionKind,
    from_peer_id: &str,
    result: Result<RemoteActionOutcome, RemoteActionFailure>,
) -> (bool, RemoteActionOutcome, Option<String>) {
    match result {
        Ok(outcome) => (true, outcome, None),
        Err(failure) => {
            let (outcome, error) = failure.into_refusal();
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
            (false, outcome, Some(error))
        }
    }
}

pub(super) async fn skip_unpaired(
    state: &AppState,
    published: Result<(), String>,
) -> Result<(), String> {
    match published {
        Err(error) if error.contains("device is not paired") => {
            state
                .push_runtime_log(
                    "warn",
                    "Skipped an encrypted broker reply because the device is no longer paired."
                        .to_string(),
                )
                .await;
            Ok(())
        }
        other => other,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn reply_refusal(
    state: &AppState,
    writer: &BrokerWriter,
    target_peer_id: String,
    device_id: String,
    action_id: String,
    action: RemoteActionKind,
    error: String,
    code: Option<ClientErrorCode>,
    lease: u64,
) -> Result<(), String> {
    skip_unpaired(
        state,
        publish_remote_action_result_private(
            state,
            writer,
            target_peer_id,
            device_id,
            action_id,
            action,
            None,
            RemoteActionOutcome {
                error_code: code,
                ..RemoteActionOutcome::default()
            },
            Some(error),
            false,
            None,
            Some(lease),
        )
        .await,
    )
    .await
}

pub(super) async fn publish_reauthorize(
    writer: &BrokerWriter,
    target_peer_id: &str,
    action_id: &str,
) {
    let _ = publish_payload(
        writer,
        OutboundBrokerPayload::RemoteActionReauthorize {
            action_id: action_id.to_string(),
            target_peer_id: target_peer_id.to_string(),
        },
    )
    .await;
}

/// Hand a chunked action reply to the writer, paced but not awaited.
///
/// This used to publish every chunk here, sleeping
/// `REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS` between them. Because
/// `broker.rs` awaits `handle_server_message` INLINE in the `select!` arm that reads
/// the socket, a 21-chunk reply meant ~5 seconds during which the relay read nothing
/// from any surface. The pacing now happens in the writer task, so this returns as
/// soon as the train is queued and the read loop keeps serving everyone else.
pub(super) async fn publish_remote_action_result_chunks(
    state: &AppState,
    writer: &BrokerWriter,
    chunk_payloads: Vec<OutboundBrokerPayload>,
    error_context: &str,
    target_peer_id: &str,
    lease: Option<u64>,
) -> Result<TrainHandoff, String> {
    let chunk_count = chunk_payloads.len();
    info!(
        chunk_count,
        publish_interval_ms = REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS,
        "queueing broker remote action result chunks"
    );
    // A train the writer can never abandon: it only stops one whose surface it was TOLD
    // about, and an already-departed peer is recorded as nobody. So the whole reply paces
    // out at someone who has gone, holding the single train slot the entire time.
    if let Some(lease) = lease {
        if !state.surface_lease_is_current(target_peer_id, lease).await {
            info!(
                chunk_count,
                error_context, "dropping a chunked reply: its surface already left"
            );
            return Ok(TrainHandoff::Dropped);
        }
    }
    let chunks = chunk_payloads
        .iter()
        .map(|payload| frame_message_for_payload(writer, payload))
        .collect::<Vec<_>>();
    // Probe ONCE, here, while we still know the request we are answering just arrived
    // from this peer. Recording "it was here" is what later lets the writer distinguish
    // an observed departure from a presence set that never knew about it.
    let watch_target = state
        .surface_peer_is_online(target_peer_id)
        .await
        .then(|| target_peer_id.to_string());
    let handoff = writer
        .send_train(
            chunks,
            Duration::from_millis(REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS),
            watch_target,
        )
        .map_err(|error| format!("{error_context} publish failed: {error}"))?;
    if handoff == TrainHandoff::Busy {
        warn!(
            chunk_count,
            error_context, "refusing a chunked reply: too many large replies outstanding"
        );
    }
    Ok(handoff)
}

/// Tell the asker its request is still being worked on by an earlier attempt.
///
/// Without it the phone's own deadline decides, and it is shorter than a slow provider
/// call: it reports a failure for a write that is about to land, and the retry the user
/// then makes carries a NEW id that no replay cache can recognise.
async fn publish_remote_action_pending(
    writer: &BrokerWriter,
    target_peer_id: &str,
    action_id: &str,
) {
    let _ = publish_payload(
        writer,
        OutboundBrokerPayload::RemoteActionPending {
            action_id: action_id.to_string(),
            target_peer_id: target_peer_id.to_string(),
        },
    )
    .await;
}

enum WaitResult {
    Result(CachedRemoteActionResult),
    /// A write that ran but whose reply is no longer kept.
    AlreadyCompleted,
    Nothing,
}

async fn await_remote_action_result(
    state: &AppState,
    writer: &BrokerWriter,
    target_peer_id: &str,
    device_id: &str,
    action_id: &str,
    cache_action_id: &str,
    wait: RemoteActionWait,
) -> WaitResult {
    let finished = wait.finished.clone();
    let wake = async move { finished.notified().await };
    let mut wake = std::pin::pin!(wake);
    // Subscribe before reading the cache, or a result stored in between wakes nobody.
    let woken_already = matches!(
        futures_util::poll!(wake.as_mut()),
        std::task::Poll::Ready(())
    );
    if !woken_already {
        // Repeated rather than said once: the asker's own deadline is far shorter than
        // this wait, so a single notice only buys one more window of it.
        let give_up_at = Instant::now() + REMOTE_ACTION_WAIT_TIMEOUT;
        loop {
            publish_remote_action_pending(writer, target_peer_id, action_id).await;
            if tokio::time::timeout(REMOTE_ACTION_PENDING_NOTICE_INTERVAL, wake.as_mut())
                .await
                .is_ok()
            {
                break;
            }
            if Instant::now() >= give_up_at {
                return WaitResult::Nothing;
            }
        }
    }
    // Checked on every path, including the one where the answer was already on file: an
    // earlier asker holds the writer of a session that has since been replaced.
    let outcome = match wait.source {
        RemoteActionWaitSource::ResultCache => {
            state
                .remote_action_wait_outcome(device_id, cache_action_id, wait.ticket)
                .await
        }
        RemoteActionWaitSource::WriteLedger => {
            state
                .remote_write_wait_outcome(device_id, cache_action_id, wait.ticket)
                .await
        }
    };
    match outcome {
        WaitOutcome::Result(result) => WaitResult::Result(result),
        WaitOutcome::AlreadyCompleted => WaitResult::AlreadyCompleted,
        WaitOutcome::Superseded => WaitResult::Nothing,
    }
}

/// Wait for an action someone else is already running, and answer with its reply.
///
/// Answers nothing when a later resend has taken over, or when the outcome was never
/// learned: a provider that stopped mid-write did not necessarily not write.
#[allow(clippy::too_many_arguments)]
pub(super) async fn answer_from_attempt_ahead(
    state: &AppState,
    writer: &BrokerWriter,
    target_peer_id: String,
    device_id: String,
    action_id: String,
    cache_action_id: &str,
    action: RemoteActionKind,
    wait: RemoteActionWait,
    lease: u64,
) {
    match await_remote_action_result(
        state,
        writer,
        &target_peer_id,
        &device_id,
        &action_id,
        cache_action_id,
        wait,
    )
    .await
    {
        WaitResult::Result(cached) => {
            let _ = replay_encrypted_remote_action_result(
                state,
                writer,
                target_peer_id,
                device_id,
                action_id,
                action,
                cached,
                Some(lease),
            )
            .await;
        }
        WaitResult::AlreadyCompleted => {
            let _ = reply_refusal(
                state,
                writer,
                target_peer_id,
                device_id,
                action_id,
                action,
                ALREADY_COMPLETED_ERROR.to_string(),
                Some(ClientErrorCode::AlreadyCompleted),
                lease,
            )
            .await;
        }
        WaitResult::Nothing => {}
    }
}

pub(super) async fn publish_remote_action_result_private(
    state: &AppState,
    writer: &BrokerWriter,
    target_peer_id: String,
    device_id: String,
    action_id: String,
    action: RemoteActionKind,
    snapshot: Option<SessionSnapshot>,
    outcome: RemoteActionOutcome,
    error: Option<String>,
    ok: bool,
    response_secret: Option<&str>,
    lease: Option<u64>,
) -> Result<(), String> {
    // Accepted work may outlive its connection; its reply must not move to a replacement.
    if let Some(lease) = lease {
        if !state.surface_lease_is_current(&target_peer_id, lease).await {
            return Ok(());
        }
    }
    let input_transcript_entries = snapshot
        .as_ref()
        .map(|snapshot| snapshot.transcript.len())
        .unwrap_or(0);
    let input_transcript_truncated = snapshot
        .as_ref()
        .map(|snapshot| snapshot.transcript_truncated)
        .unwrap_or(false);
    let snapshot = match snapshot {
        Some(snapshot) => {
            let compacted =
                snapshot.compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface);
            let scoped = state.snapshot_for_device(&compacted, &device_id).await;
            Some(scoped.unwrap_or(compacted))
        }
        None => None,
    };
    info!(
        action = action.as_str(),
        input_transcript_entries,
        input_transcript_truncated,
        compacted_transcript_entries = snapshot
            .as_ref()
            .map(|snapshot| snapshot.transcript.len())
            .unwrap_or(0),
        compacted_transcript_truncated = snapshot
            .as_ref()
            .map(|snapshot| snapshot.transcript_truncated)
            .unwrap_or(false),
        "publishing encrypted remote action result compacted snapshot"
    );
    let threads = outcome.threads.map(|threads| {
        threads.compact_for(crate::protocol::ThreadsResponseCompactProfile::RemoteSurface)
    });
    let RemoteActionOutcome {
        receipt,
        ask_user_answer_receipt,
        providers,
        models,
        thread_entry_detail,
        thread_transcript,
        workspace_diff,
        workspace_git_context,
        thread_workspace,
        thread_settings,
        thread_skills,
        reviews,
        workflows,
        devices,
        projects,
        ask_user_question_detail,
        ask_detail,
        session_claim,
        session_claim_expires_at,
        session_claim_boot,
        session_claim_relay_ms,
        claim_challenge_id,
        claim_challenge,
        claim_challenge_expires_at,
        error_code,
        ..
    } = outcome;
    let secret = match response_secret {
        Some(secret) => secret.to_string(),
        None => state.paired_device_payload_secret(&device_id).await?,
    };
    let size_breakdown = measure_remote_action_result_sizes(
        action,
        ok,
        snapshot.as_ref(),
        receipt.as_ref(),
        providers.as_ref(),
        models.as_ref(),
        threads.as_ref(),
        thread_entry_detail.as_ref(),
        thread_transcript.as_ref(),
        workspace_diff.as_ref(),
        workspace_git_context.as_ref(),
        thread_workspace.as_ref(),
        thread_settings.as_ref(),
        thread_skills.as_ref(),
        reviews.as_ref(),
        workflows.as_ref(),
        devices.as_ref(),
        projects.as_ref(),
        ask_user_question_detail.as_ref(),
        ask_detail.as_ref(),
        session_claim.as_ref(),
        session_claim_expires_at,
        claim_challenge_id.as_ref(),
        claim_challenge.as_ref(),
        claim_challenge_expires_at,
        error.as_ref(),
        error_code,
    );
    let plaintext = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(action),
        action,
        ok,
        snapshot,
        receipt,
        ask_user_answer_receipt,
        providers,
        models,
        threads,
        thread_entry_detail,
        thread_transcript,
        workspace_diff,
        workspace_git_context,
        thread_workspace,
        thread_settings,
        thread_skills,
        reviews,
        workflows,
        devices,
        projects,
        ask_user_question_detail,
        ask_detail,
        session_claim,
        session_claim_expires_at,
        session_claim_boot,
        session_claim_relay_ms,
        claim_challenge_id,
        claim_challenge,
        claim_challenge_expires_at,
        error,
        error_code,
    };
    let envelope = encrypt_json(&secret, &plaintext)?;
    let envelope_bytes = serialized_json_bytes(&envelope);
    let payload = OutboundBrokerPayload::EncryptedRemoteActionResult {
        action_id: action_id.clone(),
        target_peer_id: target_peer_id.clone(),
        device_id: device_id.clone(),
        envelope,
    };
    let frame_bytes = frame_bytes_for_payload(&payload);
    log_remote_action_result_sizes(
        "encrypted",
        action,
        &size_breakdown,
        Some(envelope_bytes),
        frame_bytes,
    );
    if frame_bytes <= MAX_BROKER_TEXT_FRAME_BYTES {
        return publish_payload(writer, payload)
            .await
            .map_err(|error| format!("encrypted broker action result publish failed: {error}"));
    }

    let chunk_payloads = build_encrypted_remote_action_result_chunk_payloads(
        &action_id,
        &target_peer_id,
        &device_id,
        &secret,
        &plaintext,
    )?;
    info!(
        transport = "encrypted",
        action = action.as_str(),
        action_id,
        chunk_count = chunk_payloads.len(),
        "falling back to chunked remote action result transport"
    );
    if publish_remote_action_result_chunks(
        state,
        writer,
        chunk_payloads,
        "encrypted broker action result chunk",
        &target_peer_id,
        lease,
    )
    .await?
        == TrainHandoff::Busy
    {
        let busy = busy_remote_action_result(plaintext.kind, action);
        let envelope = encrypt_json(&secret, &busy)
            .map_err(|error| format!("failed to seal busy remote action result: {error}"))?;
        return publish_payload(
            writer,
            OutboundBrokerPayload::EncryptedRemoteActionResult {
                action_id,
                target_peer_id,
                device_id,
                envelope,
            },
        )
        .await
        .map_err(|error| format!("busy remote action result publish failed: {error}"));
    }
    Ok(())
}

pub(super) async fn replay_encrypted_remote_action_result(
    state: &AppState,
    writer: &BrokerWriter,
    target_peer_id: String,
    device_id: String,
    action_id: String,
    action: RemoteActionKind,
    cached: CachedRemoteActionResult,
    lease: Option<u64>,
) -> Result<(), String> {
    publish_remote_action_result_private(
        state,
        writer,
        target_peer_id,
        device_id,
        action_id,
        action,
        cached.snapshot,
        RemoteActionOutcome {
            receipt: cached.receipt,
            ask_user_answer_receipt: cached.ask_user_answer_receipt,
            providers: cached.providers,
            models: cached.models,
            threads: cached.threads,
            thread_entry_detail: cached.thread_entry_detail,
            thread_transcript: cached.thread_transcript,
            workspace_diff: cached.workspace_diff,
            workspace_git_context: cached.workspace_git_context,
            thread_workspace: cached.thread_workspace,
            thread_settings: cached.thread_settings,
            thread_skills: cached.thread_skills,
            reviews: cached.reviews,
            workflows: cached.workflows,
            devices: cached.devices,
            projects: cached.projects,
            ask_user_question_detail: cached.ask_user_question_detail,
            ask_detail: cached.ask_detail,
            session_claim: cached.session_claim,
            session_claim_expires_at: cached.session_claim_expires_at,
            session_claim_boot: cached.session_claim_boot,
            session_claim_relay_ms: cached.session_claim_relay_ms,
            claim_challenge_id: cached.claim_challenge_id,
            claim_challenge: cached.claim_challenge,
            claim_challenge_expires_at: cached.claim_challenge_expires_at,
            error_code: cached.error_code,
        },
        cached.error,
        cached.ok,
        cached.response_secret.as_deref(),
        lease,
    )
    .await
}

/// Split `value` into pieces of at most `max_chars` characters without ever splitting a
/// character.
///
/// Chunking used to slice raw bytes, which is safe only because the pieces were then
/// base64'd. Sending the JSON *text* instead removes that encoding — and with it the
/// freedom to cut anywhere, since a byte slice can land mid-character and produce invalid
/// UTF-8 that no client can reassemble.
fn split_on_char_boundaries(value: &str, max_chars: usize) -> Vec<&str> {
    let max_chars = max_chars.max(1);
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut chars_in_piece = 0;
    for (index, _) in value.char_indices() {
        if chars_in_piece == max_chars {
            pieces.push(&value[start..index]);
            start = index;
            chars_in_piece = 0;
        }
        chars_in_piece += 1;
    }
    pieces.push(&value[start..]);
    pieces
}

/// Shrink the chunk size until **every** piece produces a frame within the broker's limit.
///
/// Checking only the first piece would be enough for uniform byte slices, which is what
/// this used to produce. Character-boundary pieces are not uniform: a piece dense in
/// multi-byte characters, or one dense in the quotes and backslashes that JSON escapes,
/// serializes larger than its neighbours. Sampling one and assuming the rest match is how
/// an oversized frame reaches the broker and gets the whole session torn down.
fn fit_chunks<'a, F>(
    serialized: &'a str,
    target_chars: usize,
    mut frame_bytes: F,
) -> Option<Vec<&'a str>>
where
    F: FnMut(&str, usize, usize) -> usize,
{
    let total_chars = serialized.chars().count();
    let mut chunk_chars = total_chars.min(target_chars).max(1);
    loop {
        let pieces = split_on_char_boundaries(serialized, chunk_chars);
        let chunk_count = pieces.len();
        let last_index = chunk_count.saturating_sub(1);
        let largest = pieces
            .iter()
            // The last index, not the first: `chunk_index` is serialized as a number, and
            // a three-digit index is two bytes wider than a one-digit one.
            .map(|piece| frame_bytes(piece, last_index, chunk_count))
            .max()
            .unwrap_or(0);
        if largest <= MAX_BROKER_TEXT_FRAME_BYTES {
            return Some(pieces);
        }
        if chunk_chars <= REMOTE_ACTION_RESULT_CHUNK_MIN_CHARS {
            return None;
        }
        chunk_chars = (chunk_chars / 2).max(REMOTE_ACTION_RESULT_CHUNK_MIN_CHARS);
    }
}

pub(super) fn build_encrypted_remote_action_result_chunk_payloads(
    action_id: &str,
    target_peer_id: &str,
    device_id: &str,
    secret: &str,
    plaintext: &RemoteActionResultPlaintext,
) -> Result<Vec<OutboundBrokerPayload>, String> {
    let serialized = serialized_json_string(plaintext)?;
    // Fitting has to encrypt each candidate, because the ciphertext length is what ends up
    // on the wire and only encryption reveals it.
    let mut fit_error: Option<String> = None;
    let pieces = fit_chunks(
        &serialized,
        REMOTE_ACTION_RESULT_CHUNK_TARGET_CHARS,
        |piece, chunk_index, chunk_count| {
            match encrypt_json(
                secret,
                &RemoteActionResultChunkPlaintext {
                    action_id: action_id.to_string(),
                    action: plaintext.action,
                    chunk_index,
                    chunk_count,
                    data: piece.to_string(),
                },
            ) {
                Ok(envelope) => frame_bytes_for_payload(
                    &OutboundBrokerPayload::EncryptedRemoteActionResultChunk {
                        action_id: action_id.to_string(),
                        target_peer_id: target_peer_id.to_string(),
                        device_id: device_id.to_string(),
                        action: plaintext.action,
                        chunk_index,
                        chunk_count,
                        envelope,
                    },
                ),
                Err(error) => {
                    fit_error.get_or_insert(error);
                    // Force the caller to shrink rather than silently accept a size it
                    // could not actually measure.
                    usize::MAX
                }
            }
        },
    );
    if let Some(error) = fit_error {
        return Err(error);
    }
    let pieces = pieces.ok_or_else(|| {
        "encrypted remote action result chunk payload still exceeds broker frame limit".to_string()
    })?;

    let chunk_count = pieces.len();
    pieces
        .into_iter()
        .enumerate()
        .map(|(chunk_index, piece)| {
            let envelope = encrypt_json(
                secret,
                &RemoteActionResultChunkPlaintext {
                    action_id: action_id.to_string(),
                    action: plaintext.action,
                    chunk_index,
                    chunk_count,
                    data: piece.to_string(),
                },
            )?;
            Ok(OutboundBrokerPayload::EncryptedRemoteActionResultChunk {
                action_id: action_id.to_string(),
                target_peer_id: target_peer_id.to_string(),
                device_id: device_id.to_string(),
                action: plaintext.action,
                chunk_index,
                chunk_count,
                envelope,
            })
        })
        .collect()
}

pub(super) fn cached_remote_action_result(
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
        snapshot: remote_action_result_snapshot(action, snapshot),
        receipt: outcome.receipt,
        ask_user_answer_receipt: outcome.ask_user_answer_receipt,
        providers: outcome.providers,
        models: outcome.models,
        // Snapshots and thread lists are compacted at the remote-surface publish
        // boundary. Thread transcript responses are already paginated and do not
        // use ThreadsResponseCompactProfile.
        threads: outcome.threads,
        thread_entry_detail: outcome.thread_entry_detail,
        thread_transcript: outcome.thread_transcript,
        workspace_diff: outcome.workspace_diff,
        workspace_git_context: outcome.workspace_git_context,
        thread_workspace: outcome.thread_workspace,
        thread_settings: outcome.thread_settings,
        thread_skills: outcome.thread_skills,
        reviews: outcome.reviews,
        workflows: outcome.workflows,
        devices: outcome.devices,
        projects: outcome.projects,
        ask_user_question_detail: outcome.ask_user_question_detail,
        ask_detail: outcome.ask_detail,
        session_claim: outcome.session_claim,
        session_claim_expires_at: outcome.session_claim_expires_at,
        session_claim_boot: outcome.session_claim_boot,
        session_claim_relay_ms: outcome.session_claim_relay_ms,
        claim_challenge_id: outcome.claim_challenge_id,
        claim_challenge: outcome.claim_challenge,
        claim_challenge_expires_at: outcome.claim_challenge_expires_at,
        response_secret,
        error,
        error_code: outcome.error_code,
    }
}

pub(super) fn measure_remote_action_result_sizes(
    action: RemoteActionKind,
    ok: bool,
    snapshot: Option<&SessionSnapshot>,
    receipt: Option<&ApprovalReceipt>,
    providers: Option<&Vec<String>>,
    models: Option<&Vec<ModelOptionView>>,
    threads: Option<&ThreadsResponse>,
    thread_entry_detail: Option<&ThreadEntryDetailResponse>,
    thread_transcript: Option<&ThreadTranscriptResponse>,
    workspace_diff: Option<&WorkspaceDiffResponse>,
    workspace_git_context: Option<&WorkspaceGitContextView>,
    thread_workspace: Option<&ResolvedWorkspace>,
    thread_settings: Option<&ThreadSettingsView>,
    thread_skills: Option<&ThreadSkillsView>,
    reviews: Option<&ReviewsResponse>,
    workflows: Option<&WorkflowsResponse>,
    devices: Option<&DevicesResponse>,
    projects: Option<&ProjectsResponse>,
    ask_user_question_detail: Option<&AskUserQuestionDetailResponse>,
    ask_detail: Option<&AskDetailResponse>,
    session_claim: Option<&String>,
    session_claim_expires_at: Option<u64>,
    claim_challenge_id: Option<&String>,
    claim_challenge: Option<&String>,
    claim_challenge_expires_at: Option<u64>,
    error: Option<&String>,
    error_code: Option<ClientErrorCode>,
) -> RemoteActionResultSizeBreakdown {
    let plaintext = RemoteActionResultPlaintextRef {
        kind: remote_action_result_kind(action),
        action,
        ok,
        snapshot,
        receipt,
        providers,
        models,
        threads,
        thread_entry_detail,
        thread_transcript,
        workspace_diff,
        workspace_git_context,
        thread_workspace,
        thread_settings,
        thread_skills,
        reviews,
        workflows,
        devices,
        projects,
        ask_user_question_detail,
        ask_detail,
        session_claim,
        session_claim_expires_at,
        claim_challenge_id,
        claim_challenge,
        claim_challenge_expires_at,
        error,
        error_code,
    };
    RemoteActionResultSizeBreakdown {
        snapshot_bytes: maybe_serialized_json_bytes(snapshot),
        receipt_bytes: maybe_serialized_json_bytes(receipt),
        threads_bytes: maybe_serialized_json_bytes(threads),
        thread_entry_detail_bytes: maybe_serialized_json_bytes(thread_entry_detail),
        thread_transcript_bytes: maybe_serialized_json_bytes(thread_transcript),
        workspace_diff_bytes: maybe_serialized_json_bytes(workspace_diff),
        workspace_git_context_bytes: maybe_serialized_json_bytes(workspace_git_context),
        thread_workspace_bytes: maybe_serialized_json_bytes(thread_workspace),
        thread_settings_bytes: maybe_serialized_json_bytes(thread_settings),
        thread_skills_bytes: maybe_serialized_json_bytes(thread_skills),
        reviews_bytes: maybe_serialized_json_bytes(reviews),
        workflows_bytes: maybe_serialized_json_bytes(workflows),
        devices_bytes: maybe_serialized_json_bytes(devices),
        projects_bytes: maybe_serialized_json_bytes(projects),
        ask_user_question_detail_bytes: maybe_serialized_json_bytes(ask_user_question_detail),
        ask_detail_bytes: maybe_serialized_json_bytes(ask_detail),
        session_claim_bytes: session_claim
            .map(|claim| serialized_json_bytes(&(claim, session_claim_expires_at)))
            .unwrap_or(0),
        claim_challenge_bytes: if claim_challenge_id.is_some()
            || claim_challenge.is_some()
            || claim_challenge_expires_at.is_some()
        {
            serialized_json_bytes(&(
                claim_challenge_id,
                claim_challenge,
                claim_challenge_expires_at,
            ))
        } else {
            0
        },
        error_bytes: maybe_serialized_json_bytes(error),
        plaintext_bytes: serialized_json_bytes(&plaintext),
    }
}

fn log_remote_action_result_sizes(
    transport: &str,
    action: RemoteActionKind,
    breakdown: &RemoteActionResultSizeBreakdown,
    envelope_bytes: Option<usize>,
    frame_bytes: usize,
) {
    info!(
        transport,
        action = action.as_str(),
        snapshot_bytes = breakdown.snapshot_bytes,
        receipt_bytes = breakdown.receipt_bytes,
        threads_bytes = breakdown.threads_bytes,
        thread_entry_detail_bytes = breakdown.thread_entry_detail_bytes,
        thread_transcript_bytes = breakdown.thread_transcript_bytes,
        workspace_diff_bytes = breakdown.workspace_diff_bytes,
        reviews_bytes = breakdown.reviews_bytes,
        workflows_bytes = breakdown.workflows_bytes,
        devices_bytes = breakdown.devices_bytes,
        projects_bytes = breakdown.projects_bytes,
        ask_user_question_detail_bytes = breakdown.ask_user_question_detail_bytes,
        ask_detail_bytes = breakdown.ask_detail_bytes,
        session_claim_bytes = breakdown.session_claim_bytes,
        claim_challenge_bytes = breakdown.claim_challenge_bytes,
        error_bytes = breakdown.error_bytes,
        plaintext_bytes = breakdown.plaintext_bytes,
        envelope_bytes = envelope_bytes.unwrap_or(0),
        frame_bytes,
        frame_limit_bytes = MAX_BROKER_TEXT_FRAME_BYTES,
        "remote action result size breakdown"
    );
    if frame_bytes > MAX_BROKER_TEXT_FRAME_BYTES {
        // TODO(remote-action-frame-budget): Use this breakdown to decide which fields should stay
        // in the first response versus move behind detail/chunk loading. In particular, preserve
        // normal agent/user text when possible, but treat large tool payloads
        // (`thread_transcript`, command/tool detail blobs) as candidates for preview-only
        // transport.
        // Once the hotspots are confirmed, pair that policy with broker-level chunk fallback at
        // the final publish boundary so oversized action results never tear down the socket.
        warn!(
            transport,
            action = action.as_str(),
            snapshot_bytes = breakdown.snapshot_bytes,
            receipt_bytes = breakdown.receipt_bytes,
            threads_bytes = breakdown.threads_bytes,
            thread_entry_detail_bytes = breakdown.thread_entry_detail_bytes,
            thread_transcript_bytes = breakdown.thread_transcript_bytes,
            workspace_diff_bytes = breakdown.workspace_diff_bytes,
            ask_user_question_detail_bytes = breakdown.ask_user_question_detail_bytes,
            ask_detail_bytes = breakdown.ask_detail_bytes,
            session_claim_bytes = breakdown.session_claim_bytes,
            claim_challenge_bytes = breakdown.claim_challenge_bytes,
            error_bytes = breakdown.error_bytes,
            plaintext_bytes = breakdown.plaintext_bytes,
            envelope_bytes = envelope_bytes.unwrap_or(0),
            frame_bytes,
            frame_limit_bytes = MAX_BROKER_TEXT_FRAME_BYTES,
            "remote action result exceeds broker websocket frame limit"
        );
    }
}

fn serialized_json_bytes<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

/// The serialized result as text, so it can be chunked on character boundaries and sent
/// without a base64 layer.
fn serialized_json_string<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("serialize remote action result failed: {error}"))
}

fn maybe_serialized_json_bytes<T: Serialize>(value: Option<&T>) -> usize {
    value.map(serialized_json_bytes).unwrap_or(0)
}

#[derive(Serialize)]
struct RemoteActionResultPlaintextRef<'a> {
    kind: RemoteActionResultKind,
    action: RemoteActionKind,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<&'a SessionSnapshot>,
    receipt: Option<&'a ApprovalReceipt>,
    providers: Option<&'a Vec<String>>,
    models: Option<&'a Vec<ModelOptionView>>,
    threads: Option<&'a ThreadsResponse>,
    thread_entry_detail: Option<&'a ThreadEntryDetailResponse>,
    thread_transcript: Option<&'a ThreadTranscriptResponse>,
    workspace_diff: Option<&'a WorkspaceDiffResponse>,
    workspace_git_context: Option<&'a WorkspaceGitContextView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_workspace: Option<&'a ResolvedWorkspace>,
    thread_settings: Option<&'a ThreadSettingsView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_skills: Option<&'a ThreadSkillsView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reviews: Option<&'a ReviewsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workflows: Option<&'a WorkflowsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    devices: Option<&'a DevicesResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    projects: Option<&'a ProjectsResponse>,
    ask_user_question_detail: Option<&'a AskUserQuestionDetailResponse>,
    ask_detail: Option<&'a AskDetailResponse>,
    session_claim: Option<&'a String>,
    session_claim_expires_at: Option<u64>,
    claim_challenge_id: Option<&'a String>,
    claim_challenge: Option<&'a String>,
    claim_challenge_expires_at: Option<u64>,
    error: Option<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<ClientErrorCode>,
}

fn remote_action_result_snapshot(
    action: RemoteActionKind,
    snapshot: SessionSnapshot,
) -> Option<SessionSnapshot> {
    remote_action_result_allows_snapshot(action).then_some(snapshot)
}

pub(super) fn remote_action_result_kind(action: RemoteActionKind) -> RemoteActionResultKind {
    match action {
        RemoteActionKind::StartSession
        | RemoteActionKind::ForkSession
        | RemoteActionKind::ResumeSession
        | RemoteActionKind::UpdateSessionSettings => RemoteActionResultKind::RemoteSessionResult,
        RemoteActionKind::ClaimChallenge
        | RemoteActionKind::ClaimDevice
        | RemoteActionKind::Heartbeat
        | RemoteActionKind::WatchThreads
        | RemoteActionKind::StopTurn
        | RemoteActionKind::TakeOver => RemoteActionResultKind::RemoteControlResult,
        RemoteActionKind::ListProviders
        | RemoteActionKind::ListThreads
        | RemoteActionKind::ListProviderModels => RemoteActionResultKind::RemoteThreadsResult,
        RemoteActionKind::FetchThreadEntryDetail
        | RemoteActionKind::FetchThreadTranscript
        | RemoteActionKind::FetchThreadRows
        | RemoteActionKind::FetchWorkspaceDiff
        | RemoteActionKind::FetchWorkspaceGitContext
        | RemoteActionKind::FetchThreadWorkspace
        | RemoteActionKind::SetThreadWorkspace
        | RemoteActionKind::FetchThreadSettings
        | RemoteActionKind::FetchThreadSkills
        | RemoteActionKind::FetchReviews
        | RemoteActionKind::FetchWorkflows
        | RemoteActionKind::FetchDevices
        | RemoteActionKind::RecheckSignedOutProviders
        | RemoteActionKind::FetchProjects
        | RemoteActionKind::FetchAskUserQuestionDetail
        | RemoteActionKind::FetchAsk => RemoteActionResultKind::RemoteTranscriptResult,
        RemoteActionKind::DecideApproval
        | RemoteActionKind::SubmitAskUserAnswer
        | RemoteActionKind::DecideModelRequest => RemoteActionResultKind::RemoteApprovalResult,
        RemoteActionKind::SendMessage
        | RemoteActionKind::ApplyFileChange
        | RemoteActionKind::ProjectAction
        | RemoteActionKind::RenameThread
        | RemoteActionKind::SetThreadFlag
        | RemoteActionKind::RepairWorkspace
        | RemoteActionKind::RequestReview
        | RemoteActionKind::StartWorkflow
        | RemoteActionKind::ResolveReview
        | RemoteActionKind::ResolveWorkflow
        | RemoteActionKind::DeleteReview
        | RemoteActionKind::AcceptReview
        | RemoteActionKind::Delegate
        | RemoteActionKind::Handover
        | RemoteActionKind::AckHandover
        | RemoteActionKind::SetGoal
        | RemoteActionKind::StopGoal
        | RemoteActionKind::GoalCard
        | RemoteActionKind::RegisterPushSubscription
        | RemoteActionKind::UnregisterPushSubscription => RemoteActionResultKind::RemoteActionAck,
    }
}

fn remote_action_result_allows_snapshot(action: RemoteActionKind) -> bool {
    matches!(
        action,
        RemoteActionKind::StartSession
            | RemoteActionKind::ForkSession
            | RemoteActionKind::ResumeSession
            | RemoteActionKind::UpdateSessionSettings
    )
}
