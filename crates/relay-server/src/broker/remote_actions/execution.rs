//! Running an accepted request and recording its outcome for later retries.

use tokio::time::Instant;
use tracing::{info, warn};

use super::{
    delivery::{
        cached_remote_action_result, replay_encrypted_remote_action_result, settle, skip_unpaired,
        RemoteActionFailure, RemoteActionOutcome,
    },
    request::{remote_action_emits_info_log, RemoteActionRequest},
};
use crate::{
    broker::{request_auth::SignedAttempt, writer::BrokerWriter, FrameOrigin},
    protocol::WorkflowActionInput,
    state::{
        AppState, ApprovalError, AskUserAnswerError, RequestClass, ReservationToken,
        SignedRequestFacts, ThreadWorkspaceError,
    },
};

const REMOTE_ACTION_SLOW_WARN_MILLIS: u128 = 1_000;

#[derive(Clone)]
pub(super) struct AdmittedAttempt {
    pub(super) origin: FrameOrigin,
    pub(super) from_peer_id: String,
    pub(super) device_id: String,
    pub(super) action_id: String,
    pub(super) attempt: SignedAttempt,
    pub(super) class: RequestClass,
    pub(super) digest: String,
    pub(super) request: RemoteActionRequest,
}

impl AdmittedAttempt {
    pub(super) fn facts(&self) -> SignedRequestFacts<'_> {
        SignedRequestFacts {
            device_id: &self.device_id,
            peer_id: &self.from_peer_id,
            sid: &self.attempt.sid,
            boot_id: &self.attempt.boot_id,
            seq: self.attempt.seq,
            sent_ms: self.attempt.sent_ms,
            action_id: &self.action_id,
            action_kind: self.attempt.action.as_str(),
            class: self.class,
            digest: &self.digest,
            op_boot: &self.attempt.op_boot,
            op_t0: self.attempt.op_t0,
        }
    }
}

pub(super) async fn run_untracked(
    state: &AppState,
    admitted: AdmittedAttempt,
) -> Result<(), String> {
    let origin = admitted.origin;
    let request =
        admitted
            .request
            .bind_device(admitted.device_id.clone(), &admitted.from_peer_id, origin);
    if let Err(error) = execute_remote_action(state, request, origin.ingress).await {
        warn!(
            action = admitted.attempt.action.as_str(),
            peer_id = %admitted.from_peer_id,
            %error,
            "fire-and-forget broker action failed"
        );
    }
    Ok(())
}

pub(super) async fn execute_admitted(
    state: &AppState,
    writer: &BrokerWriter,
    admitted: AdmittedAttempt,
    token: ReservationToken,
) -> Result<(), String> {
    let action_kind = admitted.attempt.action;
    let origin = admitted.origin;
    let action_started_at = Instant::now();
    info!(
        transport = "encrypted",
        action = action_kind.as_str(),
        action_id = admitted.action_id,
        from_peer_id = admitted.from_peer_id,
        device_id = admitted.device_id,
        "broker remote action handling started"
    );
    if remote_action_emits_info_log(action_kind) {
        state
            .push_runtime_log(
                "info",
                format!(
                    "Encrypted broker action `{}` received from {}.",
                    action_kind.as_str(),
                    admitted.from_peer_id
                ),
            )
            .await;
    }
    let result = run_remote_action(
        state,
        admitted.request.clone().bind_device(
            admitted.device_id.clone(),
            &admitted.from_peer_id,
            origin,
        ),
        origin.ingress,
    )
    .await;
    // A write is saved before its result is recorded, so a device is never told "done"
    // about a change a restart would lose.
    let result = match (admitted.class, result) {
        (RequestClass::Write, Ok(outcome)) => match state.commit_core().await {
            Ok(()) => Ok(outcome),
            Err(error) => {
                warn!(%error, action = action_kind.as_str(), "remote write could not be saved");
                Err(RemoteActionFailure::from(format!(
                    "the change was made but could not be saved: {error}"
                )))
            }
        },
        (_, result) => result,
    };

    let AdmittedAttempt {
        from_peer_id,
        device_id,
        action_id,
        class,
        ..
    } = admitted;
    let snapshot = state.snapshot().await;
    let (ok, outcome, error) = settle(state, action_kind, &from_peer_id, result).await;
    let response_secret = state.paired_device_payload_secret(&device_id).await.ok();
    let cached =
        cached_remote_action_result(action_kind, snapshot, outcome, error, ok, response_secret);
    match class {
        RequestClass::Write => {
            state
                .complete_remote_write(&device_id, &action_id, &token, cached.clone())
                .await
        }
        _ => {
            state
                .store_remote_action_result(&device_id, &action_id, cached.clone())
                .await
        }
    }
    let replay_result = replay_encrypted_remote_action_result(
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
    let elapsed_ms = action_started_at.elapsed().as_millis();
    if elapsed_ms >= REMOTE_ACTION_SLOW_WARN_MILLIS {
        warn!(
            transport = "encrypted",
            action = action_kind.as_str(),
            elapsed_ms,
            "broker remote action handling was slow"
        );
    }
    skip_unpaired(state, replay_result).await
}

/// `execute_remote_action`, with a fall-over turned into an ordinary refusal.
///
/// A panic here would otherwise leave the reserved action id "still running" for every
/// later resend, with nobody left to finish it and nothing said to the device that asked.
async fn run_remote_action(
    state: &AppState,
    request: RemoteActionRequest,
    ingress: u64,
) -> Result<RemoteActionOutcome, RemoteActionFailure> {
    match futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(
        execute_remote_action(state, request, ingress),
    ))
    .await
    {
        Ok(result) => result,
        // Deliberately not "it failed": a provider that fell over mid-write may well have
        // written. Saying so is what stops a retry being sent under a fresh id.
        Err(_) => Err(RemoteActionFailure::from(
            "the relay fell over running this; check before trying again".to_string(),
        )),
    }
}

pub(super) async fn execute_remote_action(
    state: &AppState,
    request: RemoteActionRequest,
    ingress: u64,
) -> Result<RemoteActionOutcome, RemoteActionFailure> {
    let result = match request {
        RemoteActionRequest::ClaimChallenge { .. } | RemoteActionRequest::ClaimDevice { .. } => {
            Err("claim actions must be handled before generic action execution".to_string())
        }
        RemoteActionRequest::StartSession { input } => state
            .start_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ForkSession { input } => state
            .fork_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ResumeSession { input } => state
            .resume_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::UpdateSessionSettings { input } => state
            .update_session_settings(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::SendMessage { input, skill } => state
            .send_message_with_skill(input, Vec::new(), skill)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::RequestReview { input } => state
            .request_review(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::StartWorkflow { input } => state
            .start_code_workflow(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ResolveReview {
            review_job_id,
            device_id,
        } => state
            .cancel_review(review_job_id, device_id)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ResolveWorkflow {
            workflow_run_id,
            device_id,
        } => state
            .resolve_blocked_workflow(WorkflowActionInput {
                workflow_run_id,
                device_id,
            })
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::DeleteReview {
            review_id,
            device_id,
        } => state
            .delete_review(review_id, device_id)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::AcceptReview {
            review_id,
            device_id,
        } => state
            .accept_review(review_id, device_id)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::StopTurn { input } => state
            .stop_active_turn(input)
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
        RemoteActionRequest::WatchThreads { input } => state
            .set_watched_threads(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ListProviders => Ok(RemoteActionOutcome {
            receipt: None,
            providers: Some(state.available_providers()),
            models: None,
            threads: None,
            thread_entry_detail: None,
            thread_transcript: None,
            session_claim: None,
            session_claim_expires_at: None,
            ..RemoteActionOutcome::default()
        }),
        RemoteActionRequest::ListThreads { query } => state
            // `q` rides the same struct the HTTP route uses, so a paired device gets
            // the identical search: matched after the rename overlay, before the
            // truncate, over a deeper provider scan. Dropping it here would have left
            // the phone silently filtering only the page it already had.
            .list_threads_matching(
                query.limit.unwrap_or(80).clamp(1, 200),
                query.device_id.clone(),
                query.q.as_deref(),
                query.ids.as_deref(),
            )
            .await
            .map(|threads| RemoteActionOutcome {
                receipt: None,
                models: None,
                threads: Some(threads),
                thread_entry_detail: None,
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::ListProviderModels { provider } => state
            .provider_models(&provider)
            .await
            .map(|models| RemoteActionOutcome {
                receipt: None,
                models: Some(models),
                threads: None,
                thread_entry_detail: None,
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadEntryDetail { input } => state
            .read_thread_entry_detail(input)
            .await
            .map(|thread_entry_detail| RemoteActionOutcome {
                receipt: None,
                threads: None,
                thread_entry_detail: Some(thread_entry_detail),
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadTranscript { input } => {
            info!(
                thread_id = %input.thread_id,
                before = ?input.before,
                "executing remote transcript fetch"
            );
            return state
                .read_thread_transcript(input)
                .await
                .map(|thread_transcript| RemoteActionOutcome {
                    thread_transcript: Some(thread_transcript),
                    ..RemoteActionOutcome::default()
                })
                .map_err(RemoteActionFailure::from);
        }
        RemoteActionRequest::FetchThreadRows { input } => {
            return state
                .read_thread_transcript_rows(input)
                .await
                .map(|thread_transcript| RemoteActionOutcome {
                    thread_transcript: Some(thread_transcript),
                    ..RemoteActionOutcome::default()
                })
                .map_err(RemoteActionFailure::from);
        }
        RemoteActionRequest::DecideApproval { request_id, input } => state
            .decide_approval(&request_id, input)
            .await
            .map(|receipt| RemoteActionOutcome {
                receipt: Some(receipt),
                threads: None,
                thread_entry_detail: None,
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            })
            .map_err(approval_error_message),
        RemoteActionRequest::ApplyFileChange { item_id, input } => state
            .apply_file_change(&item_id, input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ProjectAction { input } => state
            .project_action(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        // The receipt is dropped (this is an ack-only action, like ProjectAction). The
        // phone repaints from its own optimistic update, and every OTHER client learns
        // about the rename from the bumped `threads_revision` on the next snapshot.
        RemoteActionRequest::RenameThread { thread_id, input } => state
            .rename_thread(&thread_id, input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        // Ack-only, like RenameThread: the phone repaints from its own optimistic
        // update, and every other client learns about the flag from the bumped
        // threads_revision on the next snapshot.
        RemoteActionRequest::SetThreadFlag { thread_id, input } => state
            .set_thread_flag(&thread_id, input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        // Ack-only, like RenameThread: the repair's own receipt is the fresh snapshot,
        // which every client is about to be sent anyway.
        RemoteActionRequest::RepairWorkspace { thread_id, input } => state
            .repair_thread_workspace(&thread_id, input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::FetchWorkspaceDiff {
            device_id,
            thread_id,
            view_root,
        } => state
            .workspace_diff(device_id, thread_id, view_root)
            .await
            .map(|workspace_diff| RemoteActionOutcome {
                workspace_diff: Some(workspace_diff),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadWorkspace {
            device_id,
            thread_id,
            roots_status,
        } => {
            let mut thread_workspace = state
                .resolve_thread_workspace(&thread_id, device_id.as_deref())
                .await
                .map_err(ThreadWorkspaceError::into_message)?;
            if roots_status {
                // After resolution, so the measured set is exactly the device-scoped
                // roots this device may see — never a tree outside its path scope.
                crate::state::app::measure_root_changes(state, &mut thread_workspace.roots).await;
            }
            Ok(RemoteActionOutcome {
                thread_workspace: Some(thread_workspace),
                ..RemoteActionOutcome::default()
            })
        }
        RemoteActionRequest::SetThreadWorkspace { input, .. } => state
            .pin_thread_workspace(input)
            .await
            .map(|thread_workspace| RemoteActionOutcome {
                thread_workspace: Some(thread_workspace),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadSettings {
            device_id,
            thread_id,
        } => state
            .thread_settings_view(device_id, &thread_id)
            .await
            .map(|thread_settings| RemoteActionOutcome {
                thread_settings: Some(thread_settings),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadSkills {
            device_id,
            thread_id,
        } => state
            .thread_skills(device_id, &thread_id)
            .await
            .map(|thread_skills| RemoteActionOutcome {
                thread_skills: Some(thread_skills),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchWorkspaceGitContext { device_id, cwd } => state
            .workspace_git_context(device_id, cwd.unwrap_or_default())
            .await
            .map(|workspace_git_context| RemoteActionOutcome {
                workspace_git_context: Some(workspace_git_context),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchReviews { device_id } => Ok(RemoteActionOutcome {
            // The dedicated, UNCOMPACTED reviewer-panel payload (cards + reviewer threads +
            // revision). Read-only; not gated on a session claim, but SCOPED to the
            // requesting device's workspace (like fetch_workspace_diff / transcripts).
            reviews: Some(state.reviews(device_id).await),
            ..RemoteActionOutcome::default()
        }),
        // A person typing `/delegate` on a phone, so their words are expanded into a brief
        // first — the peer starts from nothing and cannot see the conversation.
        RemoteActionRequest::Delegate {
            thread_id,
            message,
            agent,
            provider,
            model,
            effort,
            device_id,
        } => state
            .delegate_detached(
                &thread_id,
                relay_api::delegation::AskRequest {
                    started_by: relay_api::delegation::StartedBy::Person,
                    device_id: Some(device_id.ok_or_else(|| "missing device id".to_string())?),
                    peer_thread_id: agent,
                    provider,
                    model,
                    effort,
                    message,
                },
            )
            .await
            .map(|_| RemoteActionOutcome::default())
            .map_err(|error| error.message()),
        // A person typing `/handover` on a phone. The summary is written by the SOURCE
        // session and nothing is handed back, so unlike a delegate this records no ask
        // and the source is never woken.
        RemoteActionRequest::Handover {
            thread_id,
            note,
            agent,
            provider,
            model,
            effort,
            device_id,
        } => state
            .handover_detached(
                &thread_id,
                relay_api::handover::HandoverRequest {
                    device_id: Some(device_id.ok_or_else(|| "missing device id".to_string())?),
                    target_thread_id: agent,
                    provider,
                    model,
                    effort,
                    note,
                },
            )
            .await
            .map(|_| RemoteActionOutcome::default())
            .map_err(|error| error.message()),
        RemoteActionRequest::AckHandover {
            handover_id,
            device_id,
        } => {
            let device_id = device_id.ok_or_else(|| "missing device id".to_string())?;
            state
                .acknowledge_handover(
                    &handover_id,
                    &crate::state::HandoverActor::Device(device_id),
                )
                .await
                .map(|()| RemoteActionOutcome::default())
        }
        // The objective is written whole, never merged: re-sending the same one is how a
        // stopped goal resumes, and how "not done — keep going" answers a completion claim.
        RemoteActionRequest::SetGoal {
            thread_id,
            objective,
            reset_turns,
            device_id,
        } => {
            let device_id = device_id.ok_or_else(|| "missing device id".to_string())?;
            state
                .set_goal(
                    &thread_id,
                    &objective,
                    Some(&device_id),
                    reset_turns,
                    Some(ingress),
                )
                .await
                .map(|()| RemoteActionOutcome::default())
        }
        RemoteActionRequest::StopGoal {
            thread_id,
            device_id,
        } => {
            let device_id = device_id.ok_or_else(|| "missing device id".to_string())?;
            state
                .cancel_goal(&thread_id, Some(&device_id), Some(ingress))
                .await
                .map(|()| RemoteActionOutcome::default())
        }
        RemoteActionRequest::GoalCard {
            thread_id,
            seq,
            action,
            device_id,
        } => {
            let device_id = device_id.ok_or_else(|| "missing device id".to_string())?;
            let action = crate::state::app::GoalCardAction::parse(&action)
                .ok_or_else(|| format!("unknown goal card action: {action}"))?;
            state
                .act_on_goal_card(&thread_id, seq, action, Some(&device_id), Some(ingress))
                .await
                .map(|()| RemoteActionOutcome::default())
        }
        RemoteActionRequest::FetchWorkflows { device_id } => Ok(RemoteActionOutcome {
            workflows: Some(state.workflows(device_id).await),
            ..RemoteActionOutcome::default()
        }),
        RemoteActionRequest::FetchDevices { device_id: _ } => Ok(RemoteActionOutcome {
            devices: Some(state.devices().await),
            ..RemoteActionOutcome::default()
        }),
        RemoteActionRequest::RecheckSignedOutProviders { device_id: _ } => {
            state.spawn_signed_out_recheck();
            Ok(RemoteActionOutcome::default())
        }
        RemoteActionRequest::FetchProjects { device_id: _ } => Ok(RemoteActionOutcome {
            // The dedicated Projects payload (list + membership + revision). Read-only;
            // Projects are global (not device-scoped) and not gated on a session claim.
            projects: Some(state.fetch_projects().await),
            ..RemoteActionOutcome::default()
        }),
        RemoteActionRequest::FetchAskUserQuestionDetail {
            request_id,
            device_id,
        } => state
            .read_ask_user_question_detail(&request_id, device_id)
            .await
            .map(|ask_user_question_detail| RemoteActionOutcome {
                ask_user_question_detail: Some(ask_user_question_detail),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchAsk { ask_id, device_id } => state
            .ask_detail(ask_id, device_id)
            .await
            .map(|ask_detail| RemoteActionOutcome {
                ask_detail: Some(ask_detail),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::DecideModelRequest {
            ask_id,
            decision,
            model,
            device_id,
        } => {
            let device_id = device_id.ok_or_else(|| "missing device id".to_string())?;
            state
                .decide_model_request(
                    &ask_id,
                    crate::protocol::ModelRequestDecisionInput {
                        decision,
                        model,
                        device_id: Some(device_id.clone()),
                    },
                    Some(&device_id),
                )
                .await
                .map(|_| RemoteActionOutcome::default())
        }
        RemoteActionRequest::SubmitAskUserAnswer { request_id, input } => state
            .submit_ask_user_answer(&request_id, input)
            .await
            .map(|receipt| RemoteActionOutcome {
                ask_user_answer_receipt: Some(receipt),
                ..RemoteActionOutcome::default()
            })
            .map_err(ask_user_answer_error_message),
        RemoteActionRequest::RegisterPushSubscription { input } => state
            .register_push_subscription(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::UnregisterPushSubscription {
            endpoint,
            device_id,
        } => {
            let device_id = device_id.ok_or_else(|| "missing device id".to_string())?;
            state
                .unregister_push_subscription(device_id, endpoint)
                .await
                .map(|_| RemoteActionOutcome::default())
        }
    };
    result.map_err(RemoteActionFailure::from)
}

fn approval_error_message(error: ApprovalError) -> String {
    match error {
        ApprovalError::NoPendingRequest => {
            "there is no approval request waiting for a remote decision".to_string()
        }
        ApprovalError::Bridge(message) => message,
    }
}

fn ask_user_answer_error_message(error: AskUserAnswerError) -> String {
    match error {
        AskUserAnswerError::NoPendingRequest => {
            "there is no AskUserQuestion waiting for a remote answer".to_string()
        }
        AskUserAnswerError::NoAnswers => "answers must include at least one entry".to_string(),
        AskUserAnswerError::Bridge(message) => message,
    }
}
