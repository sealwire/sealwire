use super::*;

impl AppState {
    pub async fn read_thread_transcript(
        &self,
        input: ReadThreadTranscriptInput,
    ) -> Result<ThreadTranscriptResponse, String> {
        let device_id = input.device_id.as_deref().unwrap_or_default();

        let provider_history_paged = {
            let relay = self.relay.read().await;
            relay
                .runtime_for_thread(&input.thread_id)
                .is_some_and(|runtime| runtime.provider_history_paged)
        };
        if input.before.is_some() && provider_history_paged {
            let (_, bridge) = self.find_thread_provider(&input.thread_id).await?;
            if let Some(page) = bridge
                .read_thread_transcript_page(&input.thread_id, input.before)
                .await?
            {
                {
                    let relay = self.relay.read().await;
                    let device_scope = relay.device_path_scope(device_id);
                    ensure_path_within_device_scope(
                        &page.sync.thread.cwd,
                        &device_scope,
                        &relay.allowed_roots,
                    )?;
                }
                let entries = page.sync.transcript;
                let mut relay = self.relay.write().await;
                let runtime = relay.ensure_runtime_for_thread(&input.thread_id);
                runtime.prepend_provider_history(entries.clone(), input.before, page.prev_cursor);
                return Ok(ThreadTranscriptResponse::from_provider_page(
                    input.thread_id,
                    entries,
                    page.prev_cursor,
                    runtime.transcript_revision,
                ));
            }
        }

        let runtime_missing = {
            let relay = self.relay.read().await;
            relay.runtime_for_thread(&input.thread_id).is_none()
        };
        if runtime_missing && input.before.is_none() {
            let (_, bridge) = self.find_thread_provider(&input.thread_id).await?;
            if let Some(page) = bridge
                .read_thread_transcript_page(&input.thread_id, None)
                .await?
            {
                {
                    let relay = self.relay.read().await;
                    let device_scope = relay.device_path_scope(device_id);
                    ensure_path_within_device_scope(
                        &page.sync.thread.cwd,
                        &device_scope,
                        &relay.allowed_roots,
                    )?;
                }
                let defaults = self.defaults().await;
                let settings = {
                    let relay = self.relay.read().await;
                    relay.remembered_thread_settings(&input.thread_id)
                };
                let approval_policy = settings
                    .as_ref()
                    .map(|value| value.approval_policy.clone())
                    .unwrap_or(defaults.approval_policy);
                let sandbox = settings
                    .as_ref()
                    .map(|value| value.sandbox.clone())
                    .unwrap_or(defaults.sandbox);
                let effort = settings
                    .as_ref()
                    .map(|value| value.reasoning_effort.clone())
                    .unwrap_or(defaults.reasoning_effort);
                let model = settings
                    .as_ref()
                    .map(|value| value.model.clone())
                    .filter(|value| !value.is_empty())
                    .unwrap_or(defaults.model);
                let entries = page.sync.transcript.clone();
                let paged = page.paged;
                let prev_cursor = page.prev_cursor;
                {
                    let mut relay = self.relay.write().await;
                    if settings.is_some() {
                        relay.hydrate_background_runtime(
                            page.sync,
                            &approval_policy,
                            &sandbox,
                            &effort,
                            &model,
                        );
                    } else {
                        relay.hydrate_background_runtime_without_remembering_settings(
                            page.sync,
                            &approval_policy,
                            &sandbox,
                            &effort,
                            &model,
                        );
                    }
                    let runtime = relay.ensure_runtime_for_thread(&input.thread_id);
                    runtime.provider_history_paged = paged;
                    runtime.provider_history_cursor = prev_cursor;
                }
                let mut response = if paged {
                    ThreadTranscriptResponse::from_provider_page(
                        input.thread_id.clone(),
                        entries,
                        prev_cursor,
                        0,
                    )
                } else {
                    let relay = self.relay.read().await;
                    relay
                        .runtime_for_thread(&input.thread_id)
                        .ok_or_else(|| format!("thread `{}` is not loaded", input.thread_id))?
                        .transcript_page(&input.thread_id, None)
                };
                response.thread_state =
                    Some(self.read_loaded_thread_state(&input.thread_id).await?);
                return Ok(response);
            }
        }

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
        let mut response = runtime.transcript_page(&input.thread_id, input.before);
        response.thread_state = thread_state;
        Ok(response)
    }

    async fn read_loaded_thread_state(&self, thread_id: &str) -> Result<ThreadStateView, String> {
        let (provider, bridge) = self.find_thread_provider(thread_id).await?;
        // A transcript tail may describe a non-active provider. The relay's
        // global available_models belongs only to the active provider, so use the
        // provider-keyed cache here. This endpoint is polled for working viewed
        // threads; a cold catalog may load once, but subsequent polls must not
        // repeat Codex's uncached model/list RPC.
        let available_models = match self.cached_provider_model_catalog(provider).await {
            Some(models) => models,
            None => self
                .load_provider_model_catalog(provider, bridge)
                .await
                .unwrap_or_default(),
        };
        let relay = self.relay.read().await;
        let runtime = relay
            .runtime_for_thread(thread_id)
            .ok_or_else(|| format!("thread `{thread_id}` is not loaded"))?;
        let review_locked = relay.is_thread_review_locked(thread_id);
        let settings_writable = !runtime.has_live_turn()
            && runtime.pending_approvals.is_empty()
            && !runtime.is_working()
            && !review_locked;

        // This thread's OWN reviewers. The global snapshot scopes reviewer_threads
        // to the active parent for broker-bound (remote/iOS) surfaces, so a remote
        // client viewing this (non-active) thread would otherwise see none — supply
        // them per-thread here, mirroring `available_models`.
        let reviewers = relay
            .reviewer_thread_views()
            .into_iter()
            .filter(|view| view.parent_thread_id == thread_id)
            .collect();

        Ok(ThreadStateView {
            thread_id: thread_id.to_string(),
            provider: provider.to_string(),
            current_cwd: runtime.current_cwd.clone(),
            current_status: if runtime.liveness_timed_out {
                "idle".to_string()
            } else {
                runtime.current_status.clone()
            },
            active_turn_id: runtime
                .has_live_turn()
                .then(|| runtime.active_turn_id.clone())
                .flatten(),
            current_phase: runtime.current_phase.clone(),
            current_tool: runtime.current_tool.clone(),
            last_progress_at: runtime.last_progress_at,
            model: runtime.model.clone(),
            reasoning_effort: runtime.reasoning_effort.clone(),
            approval_policy: runtime.approval_policy.clone(),
            sandbox: runtime.sandbox.clone(),
            available_models,
            reviewers,
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
