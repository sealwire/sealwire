use super::*;

impl AppState {
    pub async fn read_thread_transcript(
        &self,
        input: ReadThreadTranscriptInput,
    ) -> Result<ThreadTranscriptResponse, String> {
        let device_id = input.device_id.as_deref().unwrap_or_default();
        self.ensure_thread_runtime_loaded(&input.thread_id, device_id)
            .await?;

        let thread_state = if input.before.is_none() {
            Some(self.read_loaded_thread_state(&input.thread_id).await?)
        } else {
            None
        };
        let relay = self.relay.read().await;
        let runtime = relay
            .runtime_for_thread(&input.thread_id)
            .ok_or_else(|| format!("thread `{}` is not loaded", input.thread_id))?;
        let device_scope = input
            .device_id
            .as_deref()
            .map(|id| relay.device_path_scope(id))
            .unwrap_or_default();
        ensure_path_within_device_scope(&runtime.current_cwd, &device_scope, &relay.allowed_roots)?;
        let transcript = runtime.transcript_views();
        let revision = runtime.transcript_revision;
        let mut response = if input.before.is_some() {
            ThreadTranscriptResponse::from_transcript_before(
                input.thread_id,
                transcript,
                input.before,
                revision,
            )
        } else {
            ThreadTranscriptResponse::from_transcript_tail(input.thread_id, transcript, revision)
        };
        response.thread_state = thread_state;
        Ok(response)
    }

    async fn read_loaded_thread_state(&self, thread_id: &str) -> Result<ThreadStateView, String> {
        let (provider, bridge) = self.find_thread_provider(thread_id).await?;
        // The model catalog comes from the relay's independently-refreshed cache
        // (boot prewarm + provider-connect / session-op refreshes), NOT a live
        // bridge round-trip: this runs on the transcript tail, which a working
        // viewed thread polls ~3x/s. Codex's `model/list` is an uncached
        // app-server RPC, so calling it here amplified app-server traffic and let
        // a slow (up to 30s timeout) `model/list` stall the transcript read. Fall
        // back to a one-off bridge load only while the cache is still cold (boot
        // prewarm not yet landed).
        let mut available_models = {
            let relay = self.relay.read().await;
            relay.available_models.clone()
        };
        if available_models.is_empty() {
            available_models = bridge.list_models().await.unwrap_or_default();
        }
        let relay = self.relay.read().await;
        let runtime = relay
            .runtime_for_thread(thread_id)
            .ok_or_else(|| format!("thread `{thread_id}` is not loaded"))?;
        let review_locked = relay.is_thread_review_locked(thread_id);
        let settings_writable = runtime.active_turn_id.is_none()
            && runtime.pending_approvals.is_empty()
            && !runtime.is_working()
            && !review_locked;

        Ok(ThreadStateView {
            thread_id: thread_id.to_string(),
            provider: provider.to_string(),
            current_cwd: runtime.current_cwd.clone(),
            current_status: runtime.current_status.clone(),
            active_turn_id: runtime.active_turn_id.clone(),
            current_phase: runtime.current_phase.clone(),
            current_tool: runtime.current_tool.clone(),
            last_progress_at: runtime.last_progress_at,
            model: runtime.model.clone(),
            reasoning_effort: runtime.reasoning_effort.clone(),
            approval_policy: runtime.approval_policy.clone(),
            sandbox: runtime.sandbox.clone(),
            available_models,
            review_locked,
            settings_writable,
        })
    }

    pub async fn read_thread_entries(
        &self,
        input: ReadThreadEntriesInput,
    ) -> Result<ThreadEntriesResponse, String> {
        {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            if let Some(runtime) = relay.runtime_for_thread(&input.thread_id) {
                ensure_path_within_device_scope(
                    &runtime.current_cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
                let transcript = runtime.transcript_views();

                return Ok(ThreadEntriesResponse::from_item_ids(
                    input.thread_id,
                    transcript,
                    input.item_ids,
                ));
            }
        }

        let thread_data = self
            .find_thread_provider(&input.thread_id)
            .await?
            .1
            .read_thread(&input.thread_id)
            .await?;
        {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            ensure_path_within_device_scope(
                &thread_data.thread.cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
        }

        Ok(ThreadEntriesResponse::from_item_ids(
            input.thread_id,
            thread_data.transcript,
            input.item_ids,
        ))
    }

    pub async fn read_thread_entry_detail(
        &self,
        input: ReadThreadEntryDetailInput,
    ) -> Result<ThreadEntryDetailResponse, String> {
        let relay_entry = {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            if let Some(runtime) = relay.runtime_for_thread(&input.thread_id) {
                ensure_path_within_device_scope(
                    &runtime.current_cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
                runtime
                    .transcript
                    .iter()
                    .find(|entry| entry.item_id == input.item_id)
                    .filter(|entry| {
                        if entry.kind != crate::protocol::TranscriptEntryKind::ToolCall {
                            return true;
                        }
                        entry.tool.as_ref().is_some_and(|tool| {
                            tool.diff.is_some()
                                || tool
                                    .file_changes
                                    .iter()
                                    .any(|change| !change.diff.is_empty())
                        })
                    })
                    .map(|entry| entry.to_view())
            } else {
                None
            }
        };

        let entry = if let Some(entry) = relay_entry {
            entry
        } else {
            let thread_data = self
                .find_thread_provider(&input.thread_id)
                .await?
                .1
                .read_thread(&input.thread_id)
                .await?;
            {
                let relay = self.relay.read().await;
                let device_scope = input
                    .device_id
                    .as_deref()
                    .map(|id| relay.device_path_scope(id))
                    .unwrap_or_default();
                ensure_path_within_device_scope(
                    &thread_data.thread.cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
            }

            self.find_thread_provider(&input.thread_id)
                .await?
                .1
                .read_thread_entry_detail(&input.thread_id, &input.item_id)
                .await?
                .ok_or_else(|| {
                    format!(
                        "thread entry `{}` was not found in thread `{}`",
                        input.item_id, input.thread_id
                    )
                })?
        };

        if let Some(field) = input.field.as_deref() {
            return ThreadEntryDetailResponse::from_entry_chunk(
                input.thread_id,
                &entry,
                field,
                input.cursor.unwrap_or_default(),
            );
        }

        ThreadEntryDetailResponse::from_entry(input.thread_id, entry)
    }
}
