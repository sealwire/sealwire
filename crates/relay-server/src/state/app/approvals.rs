use super::*;

impl AppState {
    pub async fn decide_approval(
        &self,
        request_id: &str,
        input: ApprovalDecisionInput,
    ) -> Result<ApprovalReceipt, ApprovalError> {
        let device_id =
            require_device_id(input.device_id.clone()).map_err(ApprovalError::Bridge)?;
        let pending = {
            let relay = self.relay.read().await;
            relay
                .ensure_device_can_approve(&device_id)
                .map_err(ApprovalError::Bridge)?;
            relay
                .pending_approvals
                .get(request_id)
                .cloned()
                .ok_or(ApprovalError::NoPendingRequest)?
        };

        self.require_active_provider()
            .map_err(ApprovalError::Bridge)?
            .1
            .respond_to_approval(&pending, &input)
            .await
            .map_err(ApprovalError::Bridge)?;

        let mut relay = self.relay.write().await;
        relay.pending_approvals.remove(request_id);
        relay.push_log(
            "info",
            format!(
                "Responded to approval {request_id} with {:?} from {}.",
                input.decision,
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        Ok(ApprovalReceipt {
            request_id: request_id.to_string(),
            decision: input.decision,
            resulting_state: "approval_response_sent".to_string(),
            message: match input.decision {
                ApprovalDecision::Approve => "Remote approval sent to Codex.".to_string(),
                ApprovalDecision::Deny => "Remote denial sent to Codex.".to_string(),
                ApprovalDecision::Cancel => "Remote cancel sent to Codex.".to_string(),
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
        if input.answers.is_empty() {
            return Err(AskUserAnswerError::NoAnswers);
        }
        let exists = {
            let relay = self.relay.read().await;
            relay
                .ensure_device_can_approve(&device_id)
                .map_err(AskUserAnswerError::Bridge)?;
            relay.pending_ask_user_questions.contains_key(request_id)
        };
        if !exists {
            return Err(AskUserAnswerError::NoPendingRequest);
        }

        self.require_active_provider()
            .map_err(AskUserAnswerError::Bridge)?
            .1
            .respond_to_ask_user_question(request_id, &input.answers)
            .await
            .map_err(AskUserAnswerError::Bridge)?;

        let mut relay = self.relay.write().await;
        relay.pending_ask_user_questions.remove(request_id);
        if relay.pending_ask_user_questions.is_empty() {
            let tid = relay.active_thread_id.clone().unwrap_or_default();
            if !tid.is_empty() {
                relay.set_thread_status(&tid, "active".to_string(), Vec::new());
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

    pub async fn workspace_diff(
        &self,
        device_id: Option<String>,
    ) -> Result<WorkspaceDiffResponse, String> {
        let cwd = {
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
            relay.current_cwd.clone()
        };
        collect_workspace_diff(&cwd).await
    }

    pub async fn apply_file_change(
        &self,
        item_id: &str,
        input: ApplyFileChangeInput,
    ) -> Result<ApplyFileChangeReceipt, String> {
        let device_id = require_device_id(input.device_id)?;
        let (cwd, diff) = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            let entry = relay
                .transcript
                .iter()
                .find(|entry| entry.item_id == item_id)
                .ok_or_else(|| format!("file change `{item_id}` was not found"))?;
            let tool = entry
                .tool
                .as_ref()
                .ok_or_else(|| format!("entry `{item_id}` is not a file change"))?;
            let diff = tool
                .diff
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    let parts = tool
                        .file_changes
                        .iter()
                        .filter(|change| !change.diff.trim().is_empty())
                        .map(|change| change.diff.clone())
                        .collect::<Vec<_>>();
                    (!parts.is_empty()).then(|| parts.join("\n"))
                })
                .ok_or_else(|| format!("file change `{item_id}` has no diff to apply"))?;
            (relay.current_cwd.clone(), diff)
        };

        apply_unified_diff(&cwd, &diff, input.direction).await?;

        let mut relay = self.relay.write().await;
        relay.set_file_change_apply_state(
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
