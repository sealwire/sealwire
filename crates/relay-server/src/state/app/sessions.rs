use super::*;

impl AppState {
    pub async fn start_session(&self, input: StartSessionInput) -> Result<SessionSnapshot, String> {
        self.start_session_with_images(input, Vec::new()).await
    }

    pub async fn start_session_with_images(
        &self,
        input: StartSessionInput,
        images: Vec<ProviderImage>,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        // Hold the session guard for the whole start (incl. the optional initial
        // turn below), so a review can't interleave.
        let _slot = self.acquire_session_slot()?;
        let defaults = self.defaults().await;
        let cwd = normalize_cwd(&non_empty(input.cwd).unwrap_or(defaults.current_cwd));
        {
            let relay = self.relay.read().await;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(&cwd, &device_scope, &relay.allowed_roots)?;
            if relay.is_cwd_workflow_locked(&cwd) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
            // The worst of the unguarded doors: providers that consume an initial
            // prompt during `start_thread` would launch a WRITER into the task's
            // worktree with no thread for any thread-scoped lock to catch.
            if relay.is_cwd_team_locked(&cwd) {
                return Err(TEAM_LOCKED_THREAD_MSG.to_string());
            }
        }
        let requested_model = non_empty(input.model);
        // An id the CALLER named is never healed, even when it happens to equal
        // `DEFAULT_MODEL`.
        let model_was_requested = requested_model.is_some();
        let approval_policy = non_empty(input.approval_policy).unwrap_or(defaults.approval_policy);
        let sandbox = non_empty(input.sandbox).unwrap_or(defaults.sandbox);
        let (provider_name, bridge) = self.resolve_provider(input.provider.as_deref())?;
        let provider_models = self
            .load_provider_model_catalog(provider_name, bridge)
            .await;
        // `mut`: healed below, once the provider has had a chance to publish a
        // catalog it could not publish before the thread existed.
        let mut model = resolve_provider_model(
            provider_name,
            &provider_models,
            requested_model,
            defaults.model.clone(),
        );
        let effort = non_empty(input.effort)
            .or_else(|| default_effort_for_model(&provider_models, &model))
            .unwrap_or(defaults.reasoning_effort);
        let initial_prompt = non_empty(input.initial_prompt);

        // Providers that consume an initial prompt as part of thread creation
        // cannot consume image attachments through `start_thread`. When images
        // are present, create an empty thread and send the complete first turn
        // through the image-aware `start_turn` path below.
        let provider_initial_prompt = if images.is_empty() {
            initial_prompt.as_deref()
        } else {
            None
        };
        let initial_turn_base_sha = if provider_initial_prompt.is_some() {
            self.session_turn_base_sha(&cwd).await
        } else {
            None
        };
        let start_result = bridge
            .start_thread(
                StartThreadRequest::new(&cwd, &model, &approval_policy, &sandbox)
                    .with_initial_prompt(provider_initial_prompt),
            )
            .await?;
        let consumed_initial_prompt = start_result.consumed_initial_prompt;
        let started_thread_id = start_result.thread.id.clone();
        let initial_user_message = start_result.initial_user_message.clone();
        let started_turn_id = start_result.started_turn_id.clone();

        // Same re-ask as `resume_session_inner`: a provider that publishes its
        // catalog on the `session/new` response could not answer before the
        // thread existed, so the model chosen above was picked with no catalog
        // to check it against. Ask again now that the thread is real.
        let provider_models = match provider_models {
            Some(models) => Some(models),
            None => {
                self.load_provider_model_catalog(provider_name, bridge)
                    .await
            }
        };

        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(provider_name.to_string());
            if let Some(models) = provider_models {
                let invented = !model_was_requested && !models.iter().any(|m| m.model == model);
                relay.set_available_models(models);
                // Heal ONLY the value the relay itself invented, and read that
                // off the catalog rather than off the seed constant.
                //
                // "It equals `DEFAULT_MODEL`" is not the same question: that id
                // is "gpt-5.5", which for Codex is a real, choosable model — so
                // the test fired on a choice, and *only* on a brand-new relay,
                // missing the case where the fallback carried another provider's
                // real id. "The provider does not offer it" separates the two
                // exactly. A caller-named id is left alone either way; absent
                // from a catalog is deliberately not treated as invalid for
                // those (see `resolve_provider_model`).
                if invented {
                    // The initial turn below uses the same healed value.
                    model = relay.model.clone();
                }
            }
            // Before the notify() below, so the session does not visibly jump groups.
            if let Some(project_id) = non_empty(input.project_id.clone()) {
                if super::projects::attach_new_thread_to_project(
                    &mut relay,
                    &started_thread_id,
                    &project_id,
                ) {
                    relay.bump_projects_revision();
                }
            }
            let turn_revision = relay.thread_turn_revision(&started_thread_id);
            relay.activate_started_thread(
                start_result.thread,
                &cwd,
                &model,
                &approval_policy,
                &sandbox,
                &effort,
                &device_id,
            );
            if let Some((base_cwd, base_sha)) = initial_turn_base_sha {
                relay.record_thread_last_turn_base(&started_thread_id, base_cwd, base_sha);
            }
            // Claude consumes the first prompt before this relay activates the
            // new thread. Provider events that win that race are preserved by
            // activate_started_thread; upsert the response-backed user entry as
            // well so both event orderings use the same stable item_id.
            if consumed_initial_prompt {
                if let Some(entry) = initial_user_message {
                    if let (Some(item_id), Some(text)) = (entry.item_id, entry.text) {
                        relay.upsert_user_message(
                            item_id,
                            text,
                            entry.turn_id.unwrap_or_else(|| "initial".to_string()),
                        );
                    }
                }
            }
            if turn_revision == 0 {
                if let Some(turn_id) = started_turn_id {
                    relay.set_active_turn(Some(turn_id));
                    if let Some(active_thread_id) = relay.active_thread_id.clone() {
                        relay.set_thread_status(
                            &active_thread_id,
                            "active".to_string(),
                            Vec::new(),
                        );
                    }
                    relay.touch_progress(Some("thinking"), None);
                }
            }
            relay.push_log(
                "info",
                format!(
                    "Started a new {provider_name} thread in {cwd}. Control is now on {}.",
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        if !consumed_initial_prompt && (initial_prompt.is_some() || !images.is_empty()) {
            // Slot-free: `start_session` already holds the session guard.
            return self
                .send_message_inner_with_images(
                    SendMessageInput {
                        text: initial_prompt.unwrap_or_default(),
                        model: Some(model),
                        effort: Some(effort),
                        device_id: Some(device_id),
                        thread_id: started_thread_id,
                    },
                    &images,
                )
                .await;
        }

        let _ = self.list_threads(20, Some(device_id.clone())).await;
        Ok(self.snapshot().await)
    }

    pub async fn resume_session(
        &self,
        input: ResumeSessionInput,
    ) -> Result<SessionSnapshot, String> {
        let _slot = self.acquire_session_slot()?;
        {
            // resume_session is NOT view-only: it calls bridge.resume_thread,
            // overwrites runtime data via load_thread_data, and can change the
            // active thread and its settings. Block it for any thread that a
            // running review owns (its parent OR its reviewer thread):
            //   • Parent: resuming it mid-recap/post-back could rebuild its
            //     runtime, change approval_policy, or interrupt the turn.
            //   • Reviewer: resuming its (hidden) thread_id would make it the
            //     active thread, violating "the active conversation is never
            //     displaced by the reviewer" — the fundamental guarantee of the
            //     background-review model.
            // Users who want to NAVIGATE to the parent during a review should do
            // so via the frontend's URL/view-thread route (setThreadRoute), which
            // does not call resume_session.
            let relay = self.relay.read().await;
            if relay.is_thread_review_locked(&input.thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay.is_thread_workflow_locked(&input.thread_id) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
            // Same for a task team's seats: resuming one rebuilds its runtime and
            // makes it the active thread, out from under the driver holding it.
            if relay.is_thread_team_locked(&input.thread_id) {
                return Err(TEAM_LOCKED_THREAD_MSG.to_string());
            }
        }
        self.resume_session_inner(input).await
    }

    pub(super) async fn resume_session_inner(
        &self,
        input: ResumeSessionInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let defaults = self.defaults().await;
        let remembered_settings = {
            let relay = self.relay.read().await;
            relay.thread_settings(&input.thread_id)
        };
        let approval_policy = non_empty(input.approval_policy)
            .or_else(|| {
                remembered_settings
                    .as_ref()
                    .map(|settings| settings.approval_policy.clone())
            })
            .unwrap_or(defaults.approval_policy);
        let sandbox = non_empty(input.sandbox)
            .or_else(|| {
                remembered_settings
                    .as_ref()
                    .map(|settings| settings.sandbox.clone())
            })
            .unwrap_or(defaults.sandbox);

        let (provider_name, bridge) = self.find_thread_provider(&input.thread_id).await?;
        let provider_models = self
            .load_provider_model_catalog(provider_name, bridge)
            .await;
        let effort = non_empty(input.effort)
            .or_else(|| {
                remembered_settings
                    .as_ref()
                    .map(|settings| settings.reasoning_effort.clone())
            })
            .or_else(|| default_effort_for_model(&provider_models, &defaults.model))
            .unwrap_or(defaults.reasoning_effort);
        // Split out so the heal below can tell "this thread is pinned to that
        // model" from "we fell back to the relay's global because nothing else
        // was known". Merged, the two are indistinguishable.
        let remembered_model = remembered_settings
            .as_ref()
            .map(|settings| settings.model.clone())
            .filter(|model| !model.is_empty());
        let model = remembered_model.clone().unwrap_or(defaults.model);
        let read_started_at_revision = {
            let relay = self.relay.read().await;
            relay.transcript_clock()
        };
        // Armed BEFORE the provider is asked anything, from the cached thread row, so the
        // verdict is already on the runtime no matter how the read below goes.
        let cached_cwd = {
            let relay = self.relay.read().await;
            relay.thread_cwd(&input.thread_id)
        };
        let known_missing = match cached_cwd.as_deref() {
            Some(cwd) => self
                .refresh_workspace_verdict(&input.thread_id, cwd)
                .await
                .is_some(),
            None => false,
        };

        // Opening a thread is how the user REACHES the repair, so opening must not be the
        // thing that fails. `read_thread` is inert for the providers that serve history off
        // disk, but not for all of them — ACP issues `session/load` with the recorded cwd —
        // so a dead workspace can fail the read itself, with a raw provider error and no
        // banner. When that happens and the workspace is the known reason, open the thread
        // anyway: history is unavailable, the repair is not.
        let preview = match bridge.read_thread(&input.thread_id).await {
            Ok(preview) => preview,
            Err(error) if known_missing => {
                self.open_thread_without_its_provider(
                    &input.thread_id,
                    cached_cwd.as_deref().unwrap_or_default(),
                    &device_id,
                    &error,
                )
                .await;
                return Ok(self.snapshot().await);
            }
            Err(error) => return Err(error),
        };
        {
            let relay = self.relay.read().await;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &preview.thread.cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            if relay.is_thread_workflow_locked(&input.thread_id)
                || relay.is_cwd_workflow_locked(&preview.thread.cwd)
            {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
            // The outer guard only knew this thread's id. A session the team does
            // not own but which LIVES in its worktree — restored, or created
            // before the task started — is still a writer in that tree, and the
            // cwd is only knowable here, after the provider was asked.
            if relay.is_cwd_team_locked(&preview.thread.cwd) {
                return Err(TEAM_LOCKED_THREAD_MSG.to_string());
            }
        }

        // Opening the thread is how the user REACHES the repair, so opening must not be
        // the thing that fails. Resuming asks the provider to materialize a session IN the
        // cwd — for Claude that spawns the CLI there, which dies at ENOENT — so a thread
        // whose workspace vanished would refuse to open at all and the banner offering to
        // rebuild it would have nowhere to render. The transcript reads off disk and needs
        // no live session, so skipping the resume costs nothing here: `workspace_missing`
        // on the thread state is what the surface acts on, and the send path refuses again
        // (visibly) if the user types anyway.
        // Second look, for a thread the relay had never heard of above: its cwd is only
        // knowable after the provider read.
        if self
            .refresh_workspace_verdict(&input.thread_id, &preview.thread.cwd)
            .await
            .is_none()
        {
            bridge
                .resume_thread(&input.thread_id, &approval_policy, &sandbox)
                .await?;
        }

        let thread_data = bridge.read_thread(&input.thread_id).await?;

        // Ask for the catalog again if the first attempt came back empty.
        //
        // Not every provider can answer before it has done something: ACP has no
        // catalog method at all — `cursor-agent acp` publishes its models only on
        // the `session/new` / `session/load` responses, which the bridge caches.
        // On the first boot in a workspace there is no cached catalog yet, so the
        // question above is asked before the bridge could possibly answer, and
        // the relay falls back to `DEFAULT_MODEL` — a provider-agnostic seed that
        // happens to be Codex's id. By here the bridge has been through a read
        // and a resume, so it knows. The re-ask is an in-memory read for ACP and
        // is skipped entirely for providers that answered the first time.
        let provider_models = match provider_models {
            Some(models) => Some(models),
            None => {
                self.load_provider_model_catalog(provider_name, bridge)
                    .await
            }
        };

        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(provider_name.to_string());
            // `set_available_models` heals the relay's model when it is still
            // the untouched seed. Recording the seed on the thread here would
            // undo that immediately — and persist another provider's model id,
            // which then survives every later restart. Guarded on a catalog
            // actually landing, so a deliberate no-catalog normalisation stands.
            let mut model = model;
            if let Some(models) = provider_models {
                // Only the value the relay invented — i.e. one it fell back to
                // and this provider does not offer. A thread PINNED to a model
                // keeps it even when the catalog has since dropped it, and a
                // catalog read that merely failed is not evidence of anything.
                let invented =
                    remembered_model.is_none() && !models.iter().any(|m| m.model == model);
                relay.set_available_models(models);
                if invented {
                    model = relay.model.clone();
                }
            }
            // Fold the provider's reported last-activity time into the honest
            // sort key. Only Claude's `read_thread` reports a resume-safe value
            // (the worker derives `updated_at` from the transcript's last
            // message, not the session-file mtime that resume's init-write
            // bumps); for it we max-fold so unwitnessed CLI use can heal on
            // open. Other providers may report a bumpable mtime, so we
            // freeze-first to keep repeated selection from creeping the thread
            // up the list.
            if bridge.read_thread_reports_activity_time() {
                relay.observe_thread_last_activity(&input.thread_id, preview.thread.updated_at);
            } else {
                relay.seed_thread_last_activity(&input.thread_id, preview.thread.updated_at);
            }
            relay.load_thread_data_after_read_start(
                thread_data,
                &approval_policy,
                &sandbox,
                &effort,
                &model,
                &device_id,
                read_started_at_revision,
            );
            relay.push_log(
                "info",
                format!(
                    "Resumed thread {}. Control is now on {}.",
                    input.thread_id,
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        let _ = self.list_threads(20, None).await;
        Ok(self.snapshot().await)
    }

    pub async fn update_session_settings(
        &self,
        input: UpdateSessionSettingsInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let thread_id =
            non_empty(Some(input.thread_id)).ok_or_else(|| "thread_id is required".to_string())?;
        let _slot = self.acquire_session_slot()?;
        self.expire_stale_controller_if_needed().await;
        self.ensure_thread_runtime_loaded(&thread_id, &device_id)
            .await?;
        let requested_model = non_empty(input.model);
        let requested_effort = non_empty(input.effort);

        let (
            thread_id,
            current_approval_policy,
            current_sandbox,
            current_effort,
            current_model,
            next_approval_policy,
            next_sandbox,
        ) = {
            let relay = self.relay.read().await;
            let runtime = relay
                .runtime_for_thread(&thread_id)
                .ok_or_else(|| format!("thread `{thread_id}` is not loaded"))?;
            // A seat's sandbox and approval policy are chosen by its ROLE — a
            // reviewer is read-only precisely so it cannot write. Letting these be
            // edited mid-run would rewrite that decision under the driver.
            if relay.is_thread_or_cwd_team_locked(&thread_id) {
                return Err(TEAM_LOCKED_THREAD_MSG.to_string());
            }
            if runtime.has_live_turn() {
                return Err(
                    "cannot change session settings while a turn is in progress".to_string()
                );
            }
            if !runtime.pending_approvals.is_empty() {
                return Err(
                    "cannot change session settings while approvals are pending".to_string()
                );
            }
            // Semantic per-runtime liveness, NOT a literal `== "idle"`: a saved Codex
            // thread reports `unknown`/`completed`, which must not lock its settings.
            // `is_working()` folds in `active_turn_id` (already checked just above, so this
            // is effectively the status check) — the authoritative in-flight signal.
            if runtime.is_working() {
                return Err(format!(
                    "cannot change session settings while agent is `{}`",
                    runtime.current_status
                ));
            }

            if relay.is_thread_review_locked(&thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay.is_thread_or_cwd_workflow_locked(&thread_id) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
            let next_approval_policy =
                non_empty(input.approval_policy).unwrap_or_else(|| runtime.approval_policy.clone());
            let next_sandbox = non_empty(input.sandbox).unwrap_or_else(|| runtime.sandbox.clone());

            (
                thread_id.clone(),
                runtime.approval_policy.clone(),
                runtime.sandbox.clone(),
                runtime.reasoning_effort.clone(),
                runtime.model.clone(),
                next_approval_policy,
                next_sandbox,
            )
        };

        let (provider_name, bridge) = self.find_thread_provider(&thread_id).await?;
        let provider_models = self
            .load_provider_model_catalog(provider_name, bridge)
            .await;
        let next_model = resolve_provider_model(
            provider_name,
            &provider_models,
            requested_model,
            current_model.clone(),
        );
        let next_effort = requested_effort
            .or_else(|| {
                if next_model != current_model {
                    default_effort_for_model(&provider_models, &next_model)
                } else {
                    None
                }
            })
            .unwrap_or_else(|| current_effort.clone());

        let needs_bridge_resume =
            next_approval_policy != current_approval_policy || next_sandbox != current_sandbox;
        let effort_changed = next_effort != current_effort;
        let model_changed = next_model != current_model;

        if !needs_bridge_resume && !effort_changed && !model_changed {
            return Ok(self.snapshot().await);
        }

        if needs_bridge_resume {
            bridge
                .resume_thread(&thread_id, &next_approval_policy, &next_sandbox)
                .await?;
        }

        {
            let mut relay = self.relay.write().await;
            let is_focused = relay.active_thread_id.as_deref() == Some(thread_id.as_str());
            if is_focused {
                relay.set_provider_name(provider_name.to_string());
                if let Some(models) = provider_models {
                    relay.set_available_models(models);
                }
            }
            relay.remember_thread_settings(
                &thread_id,
                &next_approval_policy,
                &next_sandbox,
                &next_effort,
                &next_model,
            );
            if is_focused {
                relay.sync_selected_runtime_to_fields();
            }
            relay.push_log(
                "info",
                format!(
                    "Updated session settings on thread {thread_id}: approval={next_approval_policy}, sandbox={next_sandbox}, effort={next_effort}, model={next_model} (from {}).",
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        Ok(self.snapshot().await)
    }

    pub async fn send_message(&self, input: SendMessageInput) -> Result<SessionSnapshot, String> {
        let _slot = self.acquire_session_slot()?;
        self.send_message_inner_with_images(input, &[]).await
    }

    pub async fn send_message_with_images(
        &self,
        input: SendMessageInput,
        images: Vec<ProviderImage>,
    ) -> Result<SessionSnapshot, String> {
        let _slot = self.acquire_session_slot()?;
        self.send_message_inner_with_images(input, &images).await
    }

    pub(super) async fn send_message_inner(
        &self,
        input: SendMessageInput,
    ) -> Result<SessionSnapshot, String> {
        self.send_message_inner_with_images(input, &[]).await
    }

    pub(super) async fn send_message_inner_with_images(
        &self,
        input: SendMessageInput,
        images: &[ProviderImage],
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        self.expire_stale_controller_if_needed().await;
        let defaults = self.defaults().await;
        let text = input.text.trim().to_string();
        if text.is_empty() && images.is_empty() {
            return Err("message text or an image attachment is required".to_string());
        }
        let requested_model = non_empty(input.model);
        let requested_effort = non_empty(input.effort);
        let target_thread =
            non_empty(Some(input.thread_id)).ok_or_else(|| "thread_id is required".to_string())?;

        {
            let relay = self.relay.read().await;
            if relay.is_thread_review_locked(&target_thread) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay.is_thread_or_cwd_workflow_locked(&target_thread) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
            // A task team drives its own threads, so a message typed into one would
            // interleave with the driver's turn. The single exception is the team
            // lead of a PAUSED run: nothing is driving it, and redirecting the task
            // before resuming is the whole point of being able to pause.
            //
            // Checked again under the drive gate below, immediately before
            // `start_turn`. This early copy only saves the slow provider work in
            // the obvious case; it is NOT the guard, because a resume can land in
            // between and this answer would be stale by the time the turn starts.
            if matches!(
                relay.team_thread_gate(&target_thread),
                crate::state::TeamThreadGate::Locked
            ) {
                return Err(TEAM_LOCKED_THREAD_MSG.to_string());
            }
            // Unlike the team gate above, this one never lifts: the seat is readable
            // for as long as it exists, and conversable at no point in its life. It
            // is THE guard (there is no later copy) because reviewer identity is
            // durable — nothing can land in between and make this answer stale.
            if relay.is_task_reviewer_thread(&target_thread) {
                return Err(TASK_REVIEWER_READ_ONLY_MSG.to_string());
            }
            // A thread with a turn ALREADY IN FLIGHT must not receive a second
            // prompt: taking it over and calling start_turn again would double-start
            // (the provider rejects/queues it, and the relay loses track of the
            // original turn). Reject up front — BEFORE any take-over side effect — so
            // "send = take over" never silently interleaves two turns on one thread.
            // The session slot held by send_message() keeps this stable for the rest
            // of the method. (Queue/interrupt semantics are a separate, explicit
            // contract; the conservative default is to reject.)
            //
            // The signal is a live `active_turn_id`, NOT is_working(): a blank/pending
            // thread reports a working *status* ("active") before its first turn has
            // started, and sending that first message must be allowed.
            let target_has_live_turn = relay
                .runtime_for_thread(&target_thread)
                .map(|runtime| runtime.has_live_turn())
                .unwrap_or(false)
                || (relay.active_thread_id.as_deref() == Some(target_thread.as_str())
                    && relay.active_thread_has_live_turn());
            if target_has_live_turn {
                return Err("that thread is busy with a turn; wait for it to finish".to_string());
            }
        }
        // BEFORE the provider is touched at all. `ensure_thread_runtime_loaded` reads the
        // thread from its provider to hydrate a cold runtime, and that read is not inert:
        // ACP issues `session/load` with the recorded cwd, so a thread whose workspace
        // vanished would fail there — with a raw provider error, no banner, and nothing in
        // the transcript — before ever reaching the refusal below. That is the state after
        // every relay restart, which is exactly when a user comes back to a dead worktree.
        //
        // The cached thread row carries the cwd, so this costs no provider round trip. A
        // thread the relay has never heard of has no cwd here and falls through to the
        // check after hydration.
        if let Some(recorded) = {
            let relay = self.relay.read().await;
            relay.thread_cwd(&target_thread)
        } {
            if let Some(reason) = self
                .refuse_send_into_missing_workspace(&target_thread, &recorded)
                .await
            {
                return Err(reason);
            }
        }
        self.ensure_thread_runtime_loaded(&target_thread, &device_id)
            .await?;
        let (target_thread, remembered_settings, runtime_cwd) = {
            let relay = self.relay.read().await;
            (
                target_thread.clone(),
                relay.remembered_thread_settings(&target_thread),
                relay
                    .runtime_for_thread(&target_thread)
                    .map(|runtime| runtime.current_cwd.clone())
                    .filter(|cwd| !cwd.is_empty()),
            )
        };

        let (provider_name, bridge) = self.find_thread_provider(&target_thread).await?;
        let provider_models = self
            .load_provider_model_catalog(provider_name, bridge)
            .await;
        // The thread's own model, else the provider-neutral sentinel — NOT
        // `defaults.model`. A person can send into a thread that is not the active
        // one, and a thread with nothing remembered is precisely the one whose
        // model would otherwise come from whatever they last chatted with.
        let fallback_model = remembered_settings
            .as_ref()
            .map(|settings| settings.model.clone())
            .filter(|model| !model.is_empty())
            .unwrap_or_else(|| super::PROVIDER_DEFAULT_MODEL.to_string());
        let model = resolve_provider_model(
            provider_name,
            &provider_models,
            requested_model,
            fallback_model.clone(),
        );
        let effort = requested_effort
            .or_else(|| {
                (model != fallback_model)
                    .then(|| default_effort_for_model(&provider_models, &model))
                    .flatten()
            })
            .or_else(|| {
                remembered_settings
                    .as_ref()
                    .map(|settings| settings.reasoning_effort.clone())
                    .filter(|effort| !effort.is_empty())
            })
            .or_else(|| default_effort_for_model(&provider_models, &model))
            .unwrap_or_else(|| DEFAULT_EFFORT.to_string());
        // Last line of defense: never forward an effort the target model rejects
        // (e.g. a stale Claude "max" on a codex thread -> codex 400 -> "can't
        // send at all"). Heals poisoned threads and any client that skipped the
        // frontend clamp.
        let effort = clamp_effort_to_model(effort, &model, &provider_models);
        let approval_policy = remembered_settings
            .as_ref()
            .map(|settings| settings.approval_policy.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or(defaults.approval_policy);
        let sandbox = remembered_settings
            .as_ref()
            .map(|settings| settings.sandbox.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or(defaults.sandbox);
        // A target that has not been materialized in this relay process still
        // needs a runtime for event routing and path-scope validation. Reading
        // history is non-authoritative for turn liveness and does not resume the
        // provider session.
        let target_cwd = if let Some(cwd) = runtime_cwd {
            cwd
        } else {
            let data = bridge.read_thread(&target_thread).await?;
            let cwd = data.thread.cwd.clone();
            let mut relay = self.relay.write().await;
            if remembered_settings.is_some() {
                relay.hydrate_background_runtime(data, &approval_policy, &sandbox, &effort, &model);
            } else {
                relay.hydrate_background_runtime_without_remembering_settings(
                    data,
                    &approval_policy,
                    &sandbox,
                    &effort,
                    &model,
                );
            }
            cwd
        };
        {
            let relay = self.relay.read().await;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(&target_cwd, &device_scope, &relay.allowed_roots)?;
            if relay.is_thread_workflow_locked(&target_thread)
                || relay.is_cwd_workflow_locked(&target_cwd)
            {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
        }

        // Hold the team drive gate across the rest of the send when the target
        // belongs to a task. Only under it is "the team lead of a paused run" a
        // stable answer: a resume or a cancel takes this same gate, so one of the
        // two happens entirely first. Without it, a message to a paused team lead
        // can start its turn after a cancel has already drained the thread, marked
        // the run terminal, and released the workspace.
        let _team_gate = {
            let team_owned = {
                let relay = self.relay.read().await;
                !matches!(
                    relay.team_thread_gate(&target_thread),
                    crate::state::TeamThreadGate::Free
                )
            };
            if team_owned {
                let gate = self.try_hold_team_drive_gate().ok_or_else(|| {
                    "this task is settling right now; try again in a moment".to_string()
                })?;
                let relay = self.relay.read().await;
                if !matches!(
                    relay.team_thread_gate(&target_thread),
                    crate::state::TeamThreadGate::TlWhilePaused
                ) {
                    return Err(TEAM_LOCKED_THREAD_MSG.to_string());
                }
                Some(gate)
            } else {
                None
            }
        };

        let turn_revision = {
            let relay = self.relay.read().await;
            let target_has_live_turn = relay
                .runtime_for_thread(&target_thread)
                .is_some_and(|runtime| runtime.has_live_turn())
                || (relay.active_thread_id.as_deref() == Some(target_thread.as_str())
                    && relay.active_thread_has_live_turn());
            if target_has_live_turn {
                return Err("that thread is busy with a turn; wait for it to finish".to_string());
            }
            relay.thread_turn_revision(&target_thread)
        };
        // The workspace is checked HERE, on the way to the provider, because past this
        // point the failure stops being legible. A thread keeps the cwd it was born in
        // forever and that directory can stop existing — an agent worktree is removed once
        // its work lands — and every provider then dies at spawn with ENOENT. The Claude
        // SDK renders that as "native binary exists but failed to launch … musl/glibc
        // mismatch", which is not remotely what happened, and none of it reaches the
        // transcript: the user sees their own message and then nothing, forever, however
        // many times they press it again.
        //
        // The refusal is written INTO the transcript (a toast the user scrolls past is how
        // this looked like nothing at all), and then returned as an error so the composer
        // keeps the draft. Recording the message here instead would be worse than the bug:
        // the client clears its input and attachments on success, so the transcript would
        // show text — and silently drop images — that no provider ever received, and a
        // later "continue" would be continuing from something the agent never saw.
        if let Some(reason) = self
            .refuse_send_into_missing_workspace(&target_thread, &target_cwd)
            .await
        {
            return Err(reason);
        }

        // The budget gate sits with the other authoritative checks — right
        // before `start_turn`, not with the early ones — for the reason stated
        // above: spend recorded while this send was being prepared still counts,
        // and an early check would let a turn through on a number that was true
        // a moment ago.
        //
        // `Person` because this is the typed path. The default policy lets a
        // person keep working past the cap; only `stop_everything` refuses here.
        if let crate::usage::budget::BudgetVerdict::Refuse(reason) = self
            .usage_budget_verdict(crate::usage::budget::TurnOrigin::Person)
            .await
        {
            return Err(reason);
        }

        let turn_base_sha = self.session_turn_base_sha(&target_cwd).await;
        let turn_id = bridge
            .start_turn(&target_thread, &text, &model, &effort, images)
            .await?;
        let effective_thread_id = bridge.resolve_started_thread_id(&target_thread).await;
        {
            let mut relay = self.relay.write().await;
            relay.focus_thread_runtime(&effective_thread_id, &device_id);
            relay.set_provider_name(provider_name.to_string());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
            }
            // A provider may publish turn start + completion before start_turn
            // returns. Preserve those turn events instead of resurrecting the
            // completed turn; seed active state only when no turn event landed.
            if relay.thread_turn_revision(&effective_thread_id) == turn_revision {
                relay.set_active_turn(turn_id);
                relay.set_thread_status(&effective_thread_id, "active".to_string(), Vec::new());
            }
            relay.model = model.clone();
            relay.reasoning_effort = effort.clone();
            relay.remember_active_thread_settings();
            if let Some((base_cwd, base_sha)) = turn_base_sha {
                relay.record_thread_last_turn_base(&effective_thread_id, base_cwd, base_sha);
            }
            relay.push_log(
                "info",
                format!(
                    "Sent a prompt to thread {effective_thread_id} with {model} / {effort}; control moved to {}.",
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        Ok(self.snapshot().await)
    }

    async fn session_turn_base_sha(&self, cwd: &str) -> Option<(String, String)> {
        let grants = { self.relay.read().await.trust_grants() };
        let workspace = grants.admit(cwd).await.trusted().cloned()?;
        match is_git_work_tree(&workspace).await {
            Ok(true) => current_head_sha(&workspace)
                .await
                .ok()
                .map(|sha| (workspace.as_str().to_string(), sha)),
            _ => None,
        }
    }

    /// Make a thread current when its provider cannot describe it, because its workspace
    /// is gone. The transcript is whatever the relay already had (usually nothing) and the
    /// banner comes from the verdict already parked on the runtime — enough to reach the
    /// repair, which is the only thing that can move this thread forward.
    async fn open_thread_without_its_provider(
        &self,
        thread_id: &str,
        cwd: &str,
        device_id: &str,
        provider_error: &str,
    ) {
        let mut relay = self.relay.write().await;
        let runtime = relay.ensure_runtime_for_thread(thread_id);
        if runtime.current_cwd.is_empty() {
            runtime.current_cwd = cwd.to_string();
        }
        relay.focus_thread_runtime(thread_id, device_id);
        relay.push_log(
            "warn",
            format!(
                "Opened thread {thread_id} without its provider: its workspace {cwd} is \
                 gone ({provider_error})."
            ),
        );
        relay.notify();
    }

    /// Refuse a send whose workspace is gone, writing the refusal where the user is
    /// already looking. `None` means the workspace is fine and the send may proceed.
    ///
    /// The message itself is NOT recorded. The clients clear their composer — text and
    /// image attachments — on a successful send, so recording it would show a transcript
    /// the provider never received and drop the images outright, and a later "continue"
    /// would be continuing from something the agent never saw. Returning the error keeps
    /// the draft where the user can send it again once the workspace is back.
    async fn refuse_send_into_missing_workspace(
        &self,
        thread_id: &str,
        cwd: &str,
    ) -> Option<String> {
        let plan = self.refresh_workspace_verdict(thread_id, cwd).await?;
        let reason = format!(
            "This thread's workspace {} no longer exists, so nothing can run in it. \
             Re-create it, then send again.",
            plan.recorded_cwd
        );
        let mut relay = self.relay.write().await;
        relay.upsert_relay_owned_row_for_thread(
            thread_id,
            // Unique per attempt, so pressing send twice leaves two records rather than
            // one that silently overwrites the first.
            // Relay-authored: no provider ever saw this row.
            format!(
                "workspace-missing:{}-{}",
                unix_now(),
                super::review::random_suffix()
            ),
            crate::protocol::TranscriptEntryKind::Error,
            Some(reason.clone()),
            "failed".to_string(),
            None,
            None,
        );
        relay.enqueue_error_push(thread_id, reason.clone());
        relay.push_log(
            "warn",
            format!("Refused a send to thread {thread_id}: its workspace {cwd} is gone."),
        );
        relay.notify();
        Some(reason)
    }

    pub async fn stop_active_turn(&self, input: StopTurnInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let requested_thread =
            non_empty(Some(input.thread_id)).ok_or_else(|| "thread_id is required".to_string())?;
        let _slot = self.acquire_session_slot()?;
        self.expire_stale_controller_if_needed().await;
        self.ensure_thread_runtime_loaded(&requested_thread, &device_id)
            .await?;
        let (thread_id, turn_id) = {
            let relay = self.relay.read().await;
            let thread_id = requested_thread;
            let runtime = relay
                .runtime_for_thread(&thread_id)
                .ok_or_else(|| format!("thread `{thread_id}` is not loaded"))?;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &runtime.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            if relay.is_thread_review_locked(&thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay.is_thread_or_cwd_workflow_locked(&thread_id) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
            // A task team has no per-agent stop, by design: the only stop is the
            // run's, which drains every owned thread and settles the record.
            // Stopping one seat here would leave the driver waiting on a turn
            // nobody told it about, and its own next write would contradict it.
            if relay.is_thread_or_cwd_team_locked(&thread_id) {
                return Err(TEAM_LOCKED_THREAD_MSG.to_string());
            }
            (thread_id, runtime.active_turn_id.clone())
        };

        let Some(turn_id) = turn_id else {
            let mut relay = self.relay.write().await;
            let runtime = relay
                .runtime_for_thread(&thread_id)
                .ok_or_else(|| format!("thread `{thread_id}` is not loaded"))?;
            if runtime.active_turn_id.is_some() {
                return Err(format!(
                    "a turn started on thread `{thread_id}` while the stop was being prepared; retry"
                ));
            }
            if !runtime.is_working() {
                return Err(format!("there is no running turn on thread `{thread_id}`"));
            }
            relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
            relay.push_log(
                "warn",
                format!(
                    "Cleared stale working status on thread {thread_id} after an explicit stop \
from {}; no provider turn was active.",
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
            return Ok(relay.snapshot());
        };

        match self
            .find_thread_provider(&thread_id)
            .await?
            .1
            .request_turn_stop(&thread_id, Some(&turn_id))
            .await
        {
            Ok(()) => {}
            // Provider already dropped the turn (Codex: "no active turn to interrupt").
            // That is the terminal signal — clear the local ghost instead of leaving
            // Stop/archive/send wedged until restart.
            Err(error) if provider_reports_turn_already_gone(&error) => {
                let mut relay = self.relay.write().await;
                if relay
                    .runtime_for_thread(&thread_id)
                    .and_then(|runtime| runtime.active_turn_id.as_deref())
                    == Some(turn_id.as_str())
                {
                    relay.bg_set_active_turn(&thread_id, None, unix_now());
                    relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
                }
                relay.push_log(
                    "warn",
                    format!(
                        "Provider reports turn {turn_id} on thread {thread_id} is already gone \
({error}); cleared local working state after stop from {}.",
                        short_device_id(&device_id)
                    ),
                );
                relay.notify();
                return Ok(relay.snapshot());
            }
            Err(error) => return Err(error),
        }

        {
            let mut relay = self.relay.write().await;
            relay.push_log(
                "info",
                format!(
                    "Stop requested for turn {turn_id} in thread {thread_id} from {}; waiting for \
provider completion.",
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        // Bounded fallback: trust the provider's completion event, but if it never
        // arrives, mark the turn idle locally so a provider that accepts the stop
        // yet never confirms can't wedge the session. The review path deliberately
        // has no such fallback (it drains to a user-resolvable Blocked state).
        let app = self.clone();
        tokio::spawn(async move {
            app.await_stop_or_mark_idle(thread_id, turn_id).await;
        });

        Ok(self.snapshot().await)
    }

    #[cfg(test)]
    pub(crate) fn set_stop_fallback_ms(&self, ms: u64) {
        self.stop_fallback_ms
            .store(ms, std::sync::atomic::Ordering::Relaxed);
    }

    /// Wait for the provider to clear `turn_id` on `thread_id`. If it doesn't
    /// within the fallback window, mark the turn idle locally and warn.
    pub(super) async fn await_stop_or_mark_idle(&self, thread_id: String, turn_id: String) {
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(
                self.stop_fallback_ms
                    .load(std::sync::atomic::Ordering::Relaxed),
            );
        let mut rx = self.subscribe();
        loop {
            {
                let relay = self.relay.read().await;
                // The provider confirmed (or the active turn changed) — done.
                if relay
                    .runtime_for_thread(&thread_id)
                    .and_then(|runtime| runtime.active_turn_id.as_deref())
                    != Some(turn_id.as_str())
                {
                    return;
                }
            }
            tokio::select! {
                _ = rx.changed() => {}
                _ = tokio::time::sleep_until(deadline) => break,
            }
        }

        let mut relay = self.relay.write().await;
        // Still the same in-flight turn after the window: the provider never
        // confirmed the stop. Reflect idle locally rather than wedging the session.
        if relay
            .runtime_for_thread(&thread_id)
            .and_then(|runtime| runtime.active_turn_id.as_deref())
            == Some(turn_id.as_str())
        {
            relay.bg_set_active_turn(&thread_id, None, unix_now());
            relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
            relay.push_log(
                "warn",
                format!(
                    "Provider did not confirm the stop of turn {turn_id} in thread {thread_id}; \
marking idle locally."
                ),
            );
            relay.notify();
        }
    }

    /// Record which threads a surface currently has on screen. Transcript deltas are
    /// then published only to the devices that can render them, which is what makes it
    /// affordable for every background thread to stream live instead of only the one
    /// globally-active thread.
    ///
    /// Deliberately does NOT `notify()`: a watch declaration changes nothing any client
    /// renders, and clients re-declare on every navigation — waking the snapshot
    /// publisher here would turn routine scrolling into a broadcast storm.
    pub async fn set_watched_threads(&self, input: WatchThreadsInput) -> Result<(), String> {
        let device_id = require_device_id(input.device_id)?;
        let mut relay = self.relay.write().await;
        // A broker surface is identified by the peer id the relay already bound at
        // join, never by a value the client sent — otherwise one phone could take over
        // another connection's watch slot. Local surfaces send their own per-tab id;
        // that is only a routing key inside an already-authenticated device.
        let broker_peer_id = relay.paired_device_peer_id(&device_id);
        let surface_id = match broker_peer_id {
            Some(peer_id) => {
                relay.register_broker_surface(&peer_id);
                peer_id
            }
            None => non_empty(input.surface_id).unwrap_or_else(|| device_id.clone()),
        };
        relay.set_watched_threads_for_generation(
            &surface_id,
            &device_id,
            input.thread_ids,
            input.surface_generation,
        );
        Ok(())
    }

    /// Open a connection generation for an SSE surface. The returned value is what the
    /// stream's teardown must present to be allowed to unsubscribe.
    pub async fn open_surface_generation(&self, surface_id: &str, claimed: Option<u64>) -> u64 {
        let mut relay = self.relay.write().await;
        relay.open_surface_generation(surface_id, claimed)
    }

    /// Drop a surface's watch set when its connection ends — but only if this is still
    /// the current connection for that surface id. A page refresh reuses the id, so the
    /// old stream's teardown can land AFTER its replacement has already declared.
    pub async fn drop_watched_surface_generation(&self, surface_id: &str, generation: u64) {
        let mut relay = self.relay.write().await;
        relay.drop_watched_surface_generation(surface_id, generation);
    }

    /// Whether one surface should receive deltas for a thread (local SSE filter).
    pub async fn surface_watches_thread(&self, surface_id: &str, thread_id: &str) -> bool {
        let relay = self.relay.read().await;
        relay.surface_watches_thread(surface_id, thread_id)
    }

    pub async fn heartbeat_session(
        &self,
        input: HeartbeatInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        relay.refresh_controller_lease(&device_id, unix_now());
        Ok(relay.snapshot())
    }

    pub async fn take_over_control(&self, input: TakeOverInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let thread_id =
            non_empty(Some(input.thread_id)).ok_or_else(|| "thread_id is required".to_string())?;
        let _slot = self.acquire_session_slot()?;
        self.expire_stale_controller_if_needed().await;
        self.ensure_thread_runtime_loaded(&thread_id, &device_id)
            .await?;

        // Taking over a thread makes it active, so the snapshot's provider and
        // model catalog must follow the OPENED thread's provider — otherwise
        // opening a Codex thread while Claude was active leaves the session
        // showing Claude's provider and model picker. Resolve both BEFORE the
        // write lock (find_thread_provider / load_provider_model_catalog read the
        // relay), mirroring resume_session.
        let provider_models = match self.find_thread_provider(&thread_id).await {
            Ok((provider_name, bridge)) => {
                let models = self
                    .load_provider_model_catalog(provider_name, bridge)
                    .await;
                Some((provider_name.to_string(), models))
            }
            Err(_) => None,
        };

        let mut relay = self.relay.write().await;
        // A review owns the reviewed thread's turn sequence; don't let a take-over
        // reassign control of THAT thread mid-review. Taking over any other active
        // thread is fine — the review runs in the background and is unaffected.
        if relay.is_thread_review_locked(&thread_id) {
            return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
        }
        if relay.is_thread_or_cwd_workflow_locked(&thread_id) {
            return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
        }

        relay.focus_thread_runtime(&thread_id, &device_id);
        if let Some((provider_name, models)) = provider_models {
            relay.set_provider_name(provider_name);
            if let Some(models) = models {
                relay.set_available_models(models);
            }
        }
        relay.push_log(
            "info",
            format!(
                "Control of thread {thread_id} moved to {}.",
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        Ok(relay.snapshot())
    }
}

/// True when a provider interrupt/stop failure means the turn/session is already
/// gone. Codex: "no active turn to interrupt". Claude worker cancel:
/// "Claude session <id> was not found". That is a terminal signal — the relay
/// must clear its local `active_turn_id` or Stop/archive/send stay wedged until
/// restart. Transient failures (timeouts, IPC errors) must NOT match.
pub(super) fn provider_reports_turn_already_gone(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("no active turn")
        || lower.contains("no running turn")
        || lower.contains("nothing to interrupt")
        || lower.contains("turn not found")
        // Claude cancel when the worker has no live session for that id
        // (`worker.mjs`: "Claude session … was not found").
        || (lower.contains("session") && lower.contains("was not found"))
}

#[cfg(test)]
mod already_gone_tests {
    use super::provider_reports_turn_already_gone;

    #[test]
    fn matches_codex_and_claude_terminal_gone_errors() {
        assert!(provider_reports_turn_already_gone(
            "no active turn to interrupt"
        ));
        assert!(provider_reports_turn_already_gone("turn not found: abc"));
        assert!(provider_reports_turn_already_gone(
            "Claude session sess-1 was not found"
        ));
        assert!(provider_reports_turn_already_gone(
            "Claude session (all) was not found"
        ));
    }

    #[test]
    fn rejects_transient_and_unrelated_failures() {
        assert!(!provider_reports_turn_already_gone(
            "timed out waiting for interrupt"
        ));
        assert!(!provider_reports_turn_already_gone("IPC pipe broken"));
        assert!(!provider_reports_turn_already_gone("permission denied"));
        assert!(!provider_reports_turn_already_gone(
            "file was not found on disk"
        ));
    }
}
