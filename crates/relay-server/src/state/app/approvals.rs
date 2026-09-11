use super::*;

impl AppState {
    pub async fn read_ask_user_question_detail(
        &self,
        request_id: &str,
        device_id: Option<String>,
    ) -> Result<AskUserQuestionDetailResponse, String> {
        let device_id = require_device_id(device_id)?;
        let request = {
            let relay = self.relay.read().await;
            let pending = relay
                .pending_ask_user_questions
                .get(request_id)
                .cloned()
                .ok_or_else(|| {
                    "there is no AskUserQuestion waiting for remote detail".to_string()
                })?;
            // Same authority as answering it, for the same reason. A remote
            // snapshot externalizes any question body over 4 KB, so without this an
            // unattended task's question renders as "Loading question detail"
            // forever: visible, nominally answerable, and impossible to read.
            match relay.team_run_cwd_for_thread(&pending.thread_id) {
                Some(cwd) => ensure_path_within_device_scope(
                    &cwd,
                    &relay.device_path_scope(&device_id),
                    &relay.allowed_roots,
                )?,
                None => relay.ensure_device_can_approve(&device_id)?,
            }
            pending.to_view()
        };

        Ok(AskUserQuestionDetailResponse { request })
    }

    pub async fn decide_approval(
        &self,
        request_id: &str,
        input: ApprovalDecisionInput,
    ) -> Result<ApprovalReceipt, ApprovalError> {
        let device_id =
            require_device_id(input.device_id.clone()).map_err(ApprovalError::Bridge)?;
        let _slot = self.acquire_session_slot().map_err(ApprovalError::Bridge)?;
        let pending = {
            let relay = self.relay.read().await;
            relay
                .ensure_device_can_approve(&device_id)
                .map_err(ApprovalError::Bridge)?;
            let pending = relay
                .pending_approvals
                .get(request_id)
                .cloned()
                .ok_or(ApprovalError::NoPendingRequest)?;
            // A reviewer thread's approvals belong to the review (the orchestrator
            // auto-denies them) — block user decisions so a write can't be approved
            // out from under it. Approvals on any OTHER thread stay decidable.
            if relay.is_thread_review_locked(&pending.thread_id) {
                return Err(ApprovalError::Bridge(REVIEW_LOCKED_THREAD_MSG.to_string()));
            }
            if relay.is_thread_or_cwd_workflow_locked(&pending.thread_id) {
                return Err(ApprovalError::Bridge(
                    WORKFLOW_LOCKED_THREAD_MSG.to_string(),
                ));
            }
            // Same for a task team: its wait loop denies its own approvals and
            // carries the turn on, so a user decision here would race that and
            // could approve a write the run had already refused.
            if relay.is_thread_or_cwd_team_locked(&pending.thread_id) {
                return Err(ApprovalError::Bridge(TEAM_LOCKED_THREAD_MSG.to_string()));
            }
            pending
        };

        let bridge = if pending.thread_id.is_empty() {
            self.require_active_provider()
                .map_err(ApprovalError::Bridge)?
                .1
        } else {
            self.find_thread_provider(&pending.thread_id)
                .await
                .map_err(ApprovalError::Bridge)?
                .1
        };

        bridge
            .respond_to_approval(&pending, &input)
            .await
            .map_err(ApprovalError::Bridge)?;

        let mut relay = self.relay.write().await;
        relay.remove_pending_approval(request_id);
        relay.push_log(
            "info",
            format!(
                "Responded to approval {request_id} with {:?} from {}.",
                input.decision,
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        // Name the provider that actually received it. This used to say "Codex"
        // for everyone, which made the receipt wrong for every non-Codex user on
        // the one surface whose job is to confirm where a permission decision went.
        let provider = crate::provider::provider_display_name(bridge.provider_name());
        Ok(ApprovalReceipt {
            request_id: request_id.to_string(),
            decision: input.decision,
            resulting_state: "approval_response_sent".to_string(),
            message: match input.decision {
                ApprovalDecision::Approve => format!("Remote approval sent to {provider}."),
                ApprovalDecision::Deny => format!("Remote denial sent to {provider}."),
                ApprovalDecision::Cancel => format!("Remote cancel sent to {provider}."),
            },
        })
    }

    pub async fn submit_ask_user_answer(
        &self,
        request_id: &str,
        input: SubmitAskUserAnswerInput,
    ) -> Result<AskUserAnswerReceipt, AskUserAnswerError> {
        let device_id =
            require_device_id(input.device_id.clone()).map_err(AskUserAnswerError::Bridge)?;
        // A review is single-round and non-interactive; block answering questions
        // (the orchestrator dismisses the reviewer's own).
        let _slot = self
            .acquire_session_slot()
            .map_err(AskUserAnswerError::Bridge)?;
        if input.answers.is_empty() {
            return Err(AskUserAnswerError::NoAnswers);
        }
        let pending = {
            let relay = self.relay.read().await;
            let pending = relay.pending_ask_user_questions.get(request_id).cloned();
            // A task team's question comes from a BACKGROUND thread, so there is no
            // active session to "approve for" — and requiring one would close the
            // run's only channel to a person exactly when a relay has no foreground
            // session open, which is the normal state while a task runs unattended.
            //
            // It is authorized against the RUN's worktree instead, exactly as
            // pause / stop / resume are. Merely SKIPPING the check would leave only
            // "is this a paired device" — and an answer steers an agent that writes
            // files, so any device holding a request id could direct work in a
            // worktree outside its own path scope.
            match pending
                .as_ref()
                .and_then(|pending| relay.team_run_cwd_for_thread(&pending.thread_id))
            {
                Some(cwd) => ensure_path_within_device_scope(
                    &cwd,
                    &relay.device_path_scope(&device_id),
                    &relay.allowed_roots,
                )
                .map_err(AskUserAnswerError::Bridge)?,
                None => relay
                    .ensure_device_can_approve(&device_id)
                    .map_err(AskUserAnswerError::Bridge)?,
            }
            pending
        };
        let pending = pending.ok_or(AskUserAnswerError::NoPendingRequest)?;
        // A reviewer thread's questions belong to the review — block answering them.
        // Questions on any other thread stay answerable.
        if !pending.thread_id.is_empty() {
            let relay = self.relay.read().await;
            if relay.is_thread_review_locked(&pending.thread_id) {
                return Err(AskUserAnswerError::Bridge(
                    REVIEW_LOCKED_THREAD_MSG.to_string(),
                ));
            }
            if relay.is_thread_or_cwd_workflow_locked(&pending.thread_id) {
                return Err(AskUserAnswerError::Bridge(
                    WORKFLOW_LOCKED_THREAD_MSG.to_string(),
                ));
            }
        }

        let bridge = if pending.thread_id.is_empty() {
            self.require_active_provider()
                .map_err(AskUserAnswerError::Bridge)?
                .1
        } else {
            self.find_thread_provider(&pending.thread_id)
                .await
                .map_err(AskUserAnswerError::Bridge)?
                .1
        };

        bridge
            .respond_to_ask_user_question(request_id, &input.answers)
            .await
            .map_err(AskUserAnswerError::Bridge)?;

        let mut relay = self.relay.write().await;
        relay.remove_pending_ask_user_question(request_id);
        if relay.pending_ask_user_questions.is_empty() {
            let tid = pending.thread_id;
            if !tid.is_empty() {
                relay.set_thread_status(&tid, "active".to_string(), Vec::new());
                if relay.active_thread_id.as_deref() != Some(tid.as_str()) {
                    relay.bg_set_thread_status(
                        &tid,
                        "active".to_string(),
                        Vec::new(),
                        crate::state::unix_now(),
                    );
                }
            }
        }
        relay.push_log(
            "info",
            format!(
                "AskUserQuestion {request_id} answered by {}.",
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        Ok(AskUserAnswerReceipt {
            request_id: request_id.to_string(),
            message: "Answer sent to Claude.".to_string(),
        })
    }

    /// Session tree from `resolve_thread_workspace`; `view_root` is a preview of another enumerated root, not a pin.
    pub async fn workspace_diff(
        &self,
        device_id: Option<String>,
        thread_id: Option<String>,
        view_root: Option<String>,
    ) -> Result<WorkspaceDiffResponse, String> {
        // No thread: global cwd. view_root is unauthorized without a roots list.
        let Some(thread_id) = non_empty(thread_id) else {
            if non_empty(view_root).is_some() {
                return Err(
                    "view_root needs a thread_id so the relay can check it against that session's trees"
                        .to_string(),
                );
            }
            let (cwd, device_scope, allowed_roots, grants) = {
                let relay = self.relay.read().await;
                let device_scope = device_id
                    .as_deref()
                    .map(|id| relay.device_path_scope(id))
                    .unwrap_or_default();
                ensure_path_within_device_scope(
                    &relay.current_cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
                (
                    relay.current_cwd.clone(),
                    device_scope,
                    relay.allowed_roots.clone(),
                    relay.trust_grants(),
                )
            };
            let (mut response, retry_fallback) = super::collect_workspace_diff_resilient(
                &cwd,
                &cwd,
                &device_scope,
                &allowed_roots,
                &grants,
            )
            .await?;
            if response.unavailable {
                return Ok(response);
            }
            response.roots = super::list_worktrees(&response.cwd, &grants)
                .await
                .into_iter()
                .filter(|candidate| {
                    path_within_device_scope(&candidate.path, &device_scope, &allowed_roots)
                })
                .collect();
            response.fallback_from = retry_fallback;
            return Ok(response);
        };

        // Unresolvable → empty panel. Do not fall back to active cwd (would leak another workspace).
        let resolved = match self
            .resolve_thread_workspace(&thread_id, device_id.as_deref())
            .await
        {
            Ok(resolved) => resolved,
            Err(ThreadWorkspaceError::Unresolvable(_)) => {
                return Ok(WorkspaceDiffResponse::unavailable())
            }
            Err(ThreadWorkspaceError::OutOfScope(error)) => return Err(error),
        };

        let diff_cwd = match non_empty(view_root) {
            Some(requested) => {
                let matched = resolved
                    .roots
                    .iter()
                    .find(|root| paths_equivalent(&root.path, &requested))
                    .ok_or_else(|| {
                        format!(
                            "{requested} is not one of this session's working trees; pick one of \
the trees the relay listed for it"
                        )
                    })?;
                matched.path.clone()
            }
            None => resolved.cwd.clone(),
        };

        let (relay_cwd, device_scope, allowed_roots, grants) = {
            let relay = self.relay.read().await;
            (
                relay.current_cwd.clone(),
                device_id
                    .as_deref()
                    .map(|id| relay.device_path_scope(id))
                    .unwrap_or_default(),
                relay.allowed_roots.clone(),
                relay.trust_grants(),
            )
        };

        // Tree can vanish between resolve and collect.
        let (mut response, retry_fallback) = super::collect_workspace_diff_resilient(
            &diff_cwd,
            &relay_cwd,
            &device_scope,
            &allowed_roots,
            &grants,
        )
        .await?;
        if response.unavailable {
            return Ok(response);
        }
        response.roots = resolved.roots;
        response.fallback_from = match resolved.origin {
            WorkspaceOrigin::Substituted { gone } => Some(gone),
            _ => None,
        }
        .or(retry_fallback);
        Ok(response)
    }

    pub async fn apply_file_change(
        &self,
        item_id: &str,
        input: ApplyFileChangeInput,
    ) -> Result<ApplyFileChangeReceipt, String> {
        let device_id = require_device_id(input.device_id)?;
        let requested_thread =
            non_empty(Some(input.thread_id)).ok_or_else(|| "thread_id is required".to_string())?;
        // Rollback/reapply mutates the working tree; block it while a review reads
        // that same tree.
        let _slot = self.acquire_session_slot()?;
        self.ensure_thread_runtime_loaded(&requested_thread, &device_id)
            .await?;
        let (thread_id, cwd, diff, grants) = {
            let relay = self.relay.read().await;
            let thread_id = requested_thread;
            if relay.is_thread_review_locked(&thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay.is_thread_or_cwd_workflow_locked(&thread_id) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
            // Rolling a file change back rewrites the working tree, and a task
            // team's worktree has three agents in it.
            if relay.is_thread_or_cwd_team_locked(&thread_id) {
                return Err(TEAM_LOCKED_THREAD_MSG.to_string());
            }
            let runtime = relay
                .runtime_for_thread(&thread_id)
                .ok_or_else(|| format!("thread `{thread_id}` is not loaded"))?;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &runtime.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            let entry = runtime
                .transcript
                .iter()
                .find(|entry| entry.row_id == item_id)
                .ok_or_else(|| format!("file change `{item_id}` was not found"))?;
            let tool = entry
                .tool
                .as_ref()
                .ok_or_else(|| format!("entry `{item_id}` is not a file change"))?;
            // Same selector the snapshot's `can_apply` verdict is computed from, so the
            // two cannot disagree about what "this patch" means.
            let diff = crate::protocol::patch_for_apply(tool)
                .ok_or_else(|| format!("file change `{item_id}` has no diff to apply"))?;
            (
                thread_id,
                runtime.current_cwd.clone(),
                diff,
                relay.trust_grants(),
            )
        };

        apply_unified_diff(&cwd, &diff, input.direction, &grants).await?;

        let mut relay = self.relay.write().await;
        relay.set_file_change_apply_state_for_thread(
            &thread_id,
            item_id,
            match input.direction {
                FileChangeApplyDirection::Rollback => {
                    crate::protocol::FileChangeApplyState::RolledBack
                }
                FileChangeApplyDirection::Reapply => crate::protocol::FileChangeApplyState::Applied,
            },
        );
        relay.push_log(
            "info",
            format!(
                "{} file change {item_id} from {}.",
                match input.direction {
                    FileChangeApplyDirection::Rollback => "Rolled back",
                    FileChangeApplyDirection::Reapply => "Reapplied",
                },
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        Ok(ApplyFileChangeReceipt {
            item_id: item_id.to_string(),
            direction: input.direction,
            resulting_state: "diff_applied".to_string(),
            message: match input.direction {
                FileChangeApplyDirection::Rollback => "File change rolled back.".to_string(),
                FileChangeApplyDirection::Reapply => "File change reapplied.".to_string(),
            },
        })
    }
}
