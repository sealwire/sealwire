use super::*;

impl AppState {
    pub async fn start_session(&self, input: StartSessionInput) -> Result<SessionSnapshot, String> {
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
        }
        let requested_model = non_empty(input.model);
        let approval_policy = non_empty(input.approval_policy).unwrap_or(defaults.approval_policy);
        let sandbox = non_empty(input.sandbox).unwrap_or(defaults.sandbox);
        let (provider_name, bridge) = self.resolve_provider(input.provider.as_deref())?;
        let provider_models = self
            .load_provider_model_catalog(provider_name, bridge)
            .await;
        let model = resolve_provider_model(
            provider_name,
            &provider_models,
            requested_model,
            defaults.model.clone(),
        );
        let effort = non_empty(input.effort)
            .or_else(|| default_effort_for_model(&provider_models, &model))
            .unwrap_or(defaults.reasoning_effort);
        let initial_prompt = non_empty(input.initial_prompt);

        let start_result = bridge
            .start_thread(
                &cwd,
                &model,
                &approval_policy,
                &sandbox,
                initial_prompt.as_deref(),
            )
            .await?;
        let consumed_initial_prompt = start_result.consumed_initial_prompt;
        let initial_user_message = start_result.initial_user_message.clone();
        let started_turn_id = start_result.started_turn_id.clone();

        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(provider_name.to_string());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
            }
            relay.activate_thread(
                start_result.thread,
                &cwd,
                &model,
                &approval_policy,
                &sandbox,
                &effort,
                &device_id,
            );
            // Claude's `start` path consumes the first prompt before this relay
            // activates the new thread, so any earlier worker event can be
            // cleared by `activate_thread`. Reinsert the same SDK-backed entry
            // after activation so live snapshots and later read_thread results
            // share the same item_id.
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
            if let Some(turn_id) = started_turn_id {
                relay.set_active_turn(Some(turn_id));
                if let Some(active_thread_id) = relay.active_thread_id.clone() {
                    relay.set_thread_status(&active_thread_id, "active".to_string(), Vec::new());
                }
                relay.touch_progress(Some("thinking"), None);
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

        if let Some(initial_prompt) = initial_prompt.filter(|_| !consumed_initial_prompt) {
            // Slot-free: `start_session` already holds the session guard.
            return self
                .send_message_inner(SendMessageInput {
                    text: initial_prompt,
                    model: Some(model),
                    effort: Some(effort),
                    device_id: Some(device_id),
                    thread_id: None,
                })
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
        let model = remembered_settings
            .as_ref()
            .map(|settings| settings.model.clone())
            .filter(|model| !model.is_empty())
            .unwrap_or(defaults.model);
        let preview = bridge.read_thread(&input.thread_id).await?;
        {
            let relay = self.relay.read().await;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &preview.thread.cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
        }

        bridge
            .resume_thread(&input.thread_id, &approval_policy, &sandbox)
            .await?;

        let thread_data = bridge.read_thread(&input.thread_id).await?;
        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(provider_name.to_string());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
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
            relay.load_thread_data(
                thread_data,
                &approval_policy,
                &sandbox,
                &effort,
                &model,
                &device_id,
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
        let _slot = self.acquire_session_slot()?;
        self.expire_stale_controller_if_needed().await;
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
            relay.ensure_device_can_send_message(&device_id)?;

            if relay.active_turn_id.is_some() {
                return Err(
                    "cannot change session settings while a turn is in progress".to_string()
                );
            }
            if !relay.pending_approvals.is_empty() {
                return Err(
                    "cannot change session settings while approvals are pending".to_string()
                );
            }
            if relay.current_status != "idle" {
                return Err(format!(
                    "cannot change session settings while agent is `{}`",
                    relay.current_status
                ));
            }

            let thread_id = relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active thread to update".to_string())?;
            if relay.is_thread_review_locked(&thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            let next_approval_policy =
                non_empty(input.approval_policy).unwrap_or_else(|| relay.approval_policy.clone());
            let next_sandbox = non_empty(input.sandbox).unwrap_or_else(|| relay.sandbox.clone());

            (
                thread_id,
                relay.approval_policy.clone(),
                relay.sandbox.clone(),
                relay.reasoning_effort.clone(),
                relay.model.clone(),
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
            relay.set_provider_name(provider_name.to_string());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
            }
            relay.approval_policy = next_approval_policy.clone();
            relay.sandbox = next_sandbox.clone();
            relay.reasoning_effort = next_effort.clone();
            relay.model = next_model.clone();
            relay.remember_active_thread_settings();
            relay.assign_active_controller(&device_id, unix_now());
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
        self.send_message_inner(input).await
    }

    pub(super) async fn send_message_inner(
        &self,
        input: SendMessageInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        self.expire_stale_controller_if_needed().await;
        let defaults = self.defaults().await;
        let text = non_empty(Some(input.text))
            .ok_or_else(|| "message text cannot be empty".to_string())?;
        let requested_model = non_empty(input.model);
        let requested_effort = non_empty(input.effort);
        let requested_thread = non_empty(input.thread_id);

        // Resolve the target thread. An explicit thread_id ("sending IS taking
        // over this thread") wins over the current active thread. The write-control
        // check is intentionally NOT here: requiring control of the CURRENT active
        // thread would reject a legitimate send to a non-active thread that another
        // device happens to control. It is enforced after take-over below, against
        // the target — where resume has reassigned control to this device.
        let target_thread = {
            let relay = self.relay.read().await;
            let target = requested_thread
                .clone()
                .or_else(|| relay.active_thread_id.clone())
                .ok_or_else(|| "there is no thread to send to".to_string())?;
            if relay.is_thread_review_locked(&target) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
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
                .runtime_for_thread(&target)
                .map(|runtime| runtime.active_turn_id.is_some())
                .unwrap_or(false);
            if target_has_live_turn {
                return Err("that thread is busy with a turn; wait for it to finish".to_string());
            }
            target
        };

        // If the target isn't already active, take it over (resume) BEFORE sending.
        // This whole method runs under the session slot acquired by send_message(),
        // so no concurrent resume/send from another client can interleave between
        // the take-over and start_turn — the message can never land on a thread that
        // changed out from under us (closes the wrong-thread send race). resume_inner
        // also validates the device's path scope for the target thread.
        let needs_takeover = {
            let relay = self.relay.read().await;
            relay.active_thread_id.as_deref() != Some(target_thread.as_str())
        };
        if needs_takeover {
            self.resume_session_inner(ResumeSessionInput {
                thread_id: target_thread.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some(device_id.clone()),
                provider: None,
            })
            .await?;
        }

        let thread_id = {
            let relay = self.relay.read().await;
            // Write-control check against the (post-take-over) ACTIVE thread = the
            // target. For a take-over send, resume has just made this device the
            // controller, so it passes; for a same-thread send it still requires the
            // device to already hold control (no implicit takeover of the active
            // thread by a passive device).
            relay.ensure_device_can_send_message(&device_id)?;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            let thread_id = relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active Codex thread to send to".to_string())?;
            // After any take-over, the active thread is the target we resolved.
            debug_assert_eq!(thread_id, target_thread);
            thread_id
        };
        let (provider_name, bridge) = self.find_thread_provider(&thread_id).await?;
        let provider_models = self
            .load_provider_model_catalog(provider_name, bridge)
            .await;
        let model = resolve_provider_model(
            provider_name,
            &provider_models,
            requested_model,
            defaults.model.clone(),
        );
        let effort = requested_effort
            .or_else(|| default_effort_for_model(&provider_models, &model))
            .unwrap_or(defaults.reasoning_effort);

        let turn_id = bridge
            .start_turn(&thread_id, &text, &model, &effort)
            .await?;
        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(provider_name.to_string());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
            }
            relay.assign_active_controller(&device_id, unix_now());
            relay.set_active_turn(turn_id);
            relay.model = model.clone();
            relay.reasoning_effort = effort.clone();
            relay.remember_active_thread_settings();
            relay.push_log(
                "info",
                format!("Sent a prompt to thread {thread_id} with {model} / {effort}."),
            );
            relay.notify();
        }

        Ok(self.snapshot().await)
    }

    pub async fn stop_active_turn(&self, input: StopTurnInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let _slot = self.acquire_session_slot()?;
        self.expire_stale_controller_if_needed().await;
        let (thread_id, turn_id) = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            let thread_id = relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active Codex thread to stop".to_string())?;
            if relay.is_thread_review_locked(&thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            let turn_id = relay
                .active_turn_id
                .clone()
                .ok_or_else(|| "there is no running Codex turn to stop".to_string())?;
            (thread_id, turn_id)
        };

        self.find_thread_provider(&thread_id)
            .await?
            .1
            .request_turn_stop(&thread_id, Some(&turn_id))
            .await?;

        {
            let mut relay = self.relay.write().await;
            relay.assign_active_controller(&device_id, unix_now());
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
    async fn await_stop_or_mark_idle(&self, thread_id: String, turn_id: String) {
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
                if relay.active_thread_id.as_deref() != Some(thread_id.as_str())
                    || relay.active_turn_id.as_deref() != Some(turn_id.as_str())
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
        if relay.active_thread_id.as_deref() == Some(thread_id.as_str())
            && relay.active_turn_id.as_deref() == Some(turn_id.as_str())
        {
            relay.set_active_turn(None);
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
        let _slot = self.acquire_session_slot()?;
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        let Some(active_thread_id) = relay.active_thread_id.clone() else {
            return Err("there is no active session to take over".to_string());
        };
        // A review owns the reviewed thread's turn sequence; don't let a take-over
        // reassign control of THAT thread mid-review. Taking over any other active
        // thread is fine — the review runs in the background and is unaffected.
        if relay.is_thread_review_locked(&active_thread_id) {
            return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
        }

        let changed = relay.set_active_controller(&device_id);
        if changed {
            relay.push_log(
                "info",
                format!("Control moved to {}.", short_device_id(&device_id)),
            );
            relay.notify();
        }

        Ok(relay.snapshot())
    }
}
