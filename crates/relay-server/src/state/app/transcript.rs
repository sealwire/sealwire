use super::*;

impl AppState {
    /// Stamps the generation on every page, whichever branch below produced it.
    ///
    /// A wrapper rather than four call sites: the point of the field is that a client
    /// can always tell which run of the relay a page came from, and a branch that
    /// forgot to set it would silently look like "same run as whatever you have".
    pub async fn read_thread_transcript(
        &self,
        input: ReadThreadTranscriptInput,
    ) -> Result<ThreadTranscriptResponse, String> {
        let generation = self.relay.read().await.transcript_generation.clone();
        self.read_thread_transcript_page_unstamped(input)
            .await
            .map(|page| page.stamp_generation(generation))
    }

    async fn read_thread_transcript_page_unstamped(
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
                // The MERGED records, never the raw page: a page holding only a tool's
                // request would let the client overwrite the settled entry it already
                // has, and an id-less raw row would bypass id and order-key assignment.
                let entries =
                    runtime.prepend_provider_history(entries, input.before, page.prev_cursor);
                return Ok(ThreadTranscriptResponse::from_provider_page(
                    input.thread_id,
                    entries,
                    page.prev_cursor,
                    runtime.transcript_revision,
                ));
            }
        }

        // Sampled together, BEFORE the provider await below: the floor is what
        // lets the merge afterwards tell a row a live event created during the
        // read from history the read itself covered.
        let (runtime_missing, read_started_at_revision) = {
            let relay = self.relay.read().await;
            (
                relay.runtime_for_thread(&input.thread_id).is_none(),
                relay.transcript_revision_floor(),
            )
        };
        if runtime_missing && input.before.is_none() {
            let (provider_name, bridge) = self.find_thread_provider(&input.thread_id).await?;
            let (provider_name, bridge) = (provider_name.to_string(), bridge.clone());
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
                let remembered_model = settings
                    .as_ref()
                    .map(|value| value.model.clone())
                    .filter(|value| !value.is_empty());
                let model = self
                    .resolve_model_for_provider(
                        &provider_name,
                        &bridge,
                        remembered_model,
                        super::PROVIDER_DEFAULT_MODEL.to_string(),
                    )
                    .await;
                let paged = page.paged;
                let prev_cursor = page.prev_cursor;
                // A page has to carry the revision of the runtime it was built from,
                // or the client cannot chain the deltas that follow it.
                let hydrated_revision;
                // Materialized under the SAME lock that captured the revision, from the
                // runtime hydration just built — so ids and order keys are the numbered
                // ones, never the raw provider parse (which carries neither).
                let materialized;
                {
                    let mut relay = self.relay.write().await;
                    // `runtime_missing` was decided before the provider await, so a
                    // stream event may have built the runtime in the meantime. That
                    // does not make the fetched page worthless — it is still this
                    // thread's history — so it is MERGED under the read-start
                    // boundary rather than dropped. Dropping it while still
                    // recording its cursor below is what made fetched history
                    // disappear: the cursor claimed coverage nothing absorbed.
                    relay.hydrate_background_runtime_after_read_start(
                        page.sync,
                        &approval_policy,
                        &sandbox,
                        &effort,
                        &model,
                        settings.is_some(),
                        read_started_at_revision,
                    );
                    let runtime = relay.ensure_runtime_for_thread(&input.thread_id);
                    runtime.provider_history_paged = paged;
                    runtime.provider_history_cursor = prev_cursor;
                    hydrated_revision = runtime.transcript_revision;
                    // Always from the runtime now: after the merge it holds the
                    // fetched history AND anything born during the read, so there is
                    // no longer a state the page could describe that it does not.
                    materialized = paged.then(|| {
                        runtime
                            .transcript
                            .iter()
                            .map(super::super::relay::TranscriptRecord::to_view)
                            .collect::<Vec<_>>()
                    });
                }
                let mut response = if let Some(entries) = materialized {
                    ThreadTranscriptResponse::from_provider_page(
                        input.thread_id.clone(),
                        entries,
                        prev_cursor,
                        hydrated_revision,
                    )
                } else {
                    // Either the provider returned a whole history, or we lost the
                    // race and these entries no longer describe `hydrated_revision`.
                    // Serve the runtime instead, so the entries and the revision that
                    // stamps them come from one state.
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
        let workflow_locked = relay.is_thread_or_cwd_workflow_locked(thread_id);
        let settings_writable = !runtime.has_live_turn()
            && runtime.pending_approvals.is_empty()
            && !runtime.is_working()
            && !review_locked
            && !workflow_locked;

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
            thread_workspace_cwd: {
                let remembered = relay.thread_workspace(thread_id);
                remembered.pinned.or(remembered.proven)
            },
            // The cached verdict, not a fresh `stat`: this runs under the relay read lock,
            // and a blocking filesystem call here stalls every session update behind it.
            // `refresh_workspace_verdict` keeps it current from the async paths.
            workspace_missing: runtime.workspace_missing.clone(),
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
            workflow_locked,
            settings_writable,
            task_reviewer: relay.is_task_reviewer_thread(thread_id),
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

    /// Stamps the generation on every detail response, whichever branch produced it —
    /// same rule as `read_thread_transcript`: a branch that forgot would silently look
    /// like "same run as whatever you have".
    pub async fn read_thread_entry_detail(
        &self,
        input: ReadThreadEntryDetailInput,
    ) -> Result<ThreadEntryDetailResponse, String> {
        let generation = self.relay.read().await.transcript_generation.clone();
        self.read_thread_entry_detail_unstamped(input)
            .await
            .map(|detail| detail.stamp_generation(generation))
    }

    async fn read_thread_entry_detail_unstamped(
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
                    .find(|entry| entry.row_id == input.item_id)
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

            // The client can only name a row the way the relay published it. The
            // provider matches on its OWN id, so translate before crossing that
            // boundary — a relay-minted key reaches the provider as a string it
            // never issued and the detail comes back empty.
            let provider_item_id = {
                let relay = self.relay.read().await;
                match relay.runtime_for_thread(&input.thread_id) {
                    Some(runtime) => runtime
                        .transcript
                        .provider_item_id(&input.item_id)
                        .map(str::to_string),
                    // No runtime: the id can only have come from a provider read.
                    None => Some(input.item_id.clone()),
                }
            };
            let provider_item_id = provider_item_id.ok_or_else(|| {
                format!(
                    "thread entry `{}` has no provider id, so its detail cannot be fetched from the provider",
                    input.item_id
                )
            })?;

            self.find_thread_provider(&input.thread_id)
                .await?
                .1
                .read_thread_entry_detail(&input.thread_id, &provider_item_id)
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
