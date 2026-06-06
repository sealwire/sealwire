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
        let thread_id = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active Codex thread to send to".to_string())?
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
        // A review owns the active thread and hands control back itself; don't let
        // a take-over reassign the controller mid-review (it could strand the
        // resolve action or clobber the post-review handoff).
        let _slot = self.acquire_session_slot()?;
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        if relay.active_thread_id.is_none() {
            return Err("there is no active session to take over".to_string());
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
