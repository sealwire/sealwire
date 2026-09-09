//! Orchestrator — long-lived secretary thread for the Tasks screen.
//!
//! Ordinary `ThreadRuntime` + transcript. Created via `register_background_thread`
//! (not `start_session`) so opening Tasks does not steal the active conversation.

use super::*;

/// User-visible title for the Orchestrator session.
pub(crate) const ORCHESTRATOR_THREAD_NAME: &str = "Orchestrator";

/// Providers an Orchestrator may be created on. Claude only, for now.
///
/// `claude_code` is the only one that can actually hold the toolset: it takes
/// `mcpServers` per session. Cursor's ACP slot exists but the relay hardcodes
/// `[]` and reads no `mcpCapabilities`, so nobody has confirmed the agent honours
/// it; codex has no per-session MCP at all, and one app-server serves every
/// thread so it could not be scoped even at the process level.
///
/// This list used to rank rather than restrict, falling through to the ACTIVE
/// provider so a relay without Claude still got a chat-only Orchestrator. That
/// pinned a cursor session for at least one user, and cursor sessions do not
/// survive a relay restart — every later turn failed with `Session … not found`
/// and the pin's self-heal could not see it, because the THREAD still resolved
/// fine and only the provider's session was gone. A secretary that cannot hold
/// tools, on a session that cannot be resumed, is worse than a clear refusal.
///
/// `fake` is the test provider. It is reachable only by naming it in config
/// (`provider.rs`), so it is never present on a real relay — same reason
/// `reviewer_thread_settings` names it.
const ORCHESTRATOR_PROVIDERS: &[&str] = &["claude_code", "fake"];

impl AppState {
    /// The provider to open an Orchestrator on, or why we will not open one.
    ///
    /// Never inherits the active session's provider: the pin is persisted, so
    /// whatever conversation happened to be open when Tasks was first pressed
    /// would otherwise decide, permanently, whether tools were possible.
    fn preferred_orchestrator_provider(&self) -> Result<(&str, &Arc<dyn ProviderBridge>), String> {
        for name in ORCHESTRATOR_PROVIDERS {
            if let Some((key, bridge)) = self.providers.get_key_value(*name) {
                return Ok((key.as_str(), bridge));
            }
        }
        Err(
            "the Orchestrator needs Claude — it is the only provider that can be \
handed the Tasks toolset. Start the relay with claude_code available, or use the \
New task button on the Tasks screen."
                .to_string(),
        )
    }

    /// Return the Orchestrator thread id, creating one if needed.
    ///
    /// Idempotent: a second call with a live pin returns the same id. A pin whose
    /// thread is gone (deleted / provider lost) is cleared and replaced.
    pub async fn ensure_orchestrator(&self, device_id: Option<String>) -> Result<String, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let device_id = require_device_id(device_id)?;

        if let Some(existing) = self.live_orchestrator_thread_id().await {
            {
                let mut relay = self.relay.write().await;
                relay.backfill_orchestrator_acting_device(&device_id);
                if let Some((prompt, version)) = self.orchestrator_persona_from_driver() {
                    if !prompt.trim().is_empty() {
                        relay.orchestrator_system_prompt = Some(prompt);
                        relay.orchestrator_system_prompt_version = Some(version);
                    }
                }
                relay.notify();
            }
            return Ok(existing);
        }

        // Everything below is a check-then-act window with a provider round trip
        // inside it, so only one caller may be in it at a time. Taken AFTER the
        // fast path above, so the common case (a live pin) never touches it.
        let _create = self.orchestrator_create_guard.lock().await;

        // Re-check under the guard. The caller that waited here was, by
        // definition, racing one that has since published a pin — handing it a
        // second Orchestrator is the bug this serializes away.
        if let Some(existing) = self.live_orchestrator_thread_id().await {
            let mut relay = self.relay.write().await;
            relay.backfill_orchestrator_acting_device(&device_id);
            relay.notify();
            return Ok(existing);
        }

        // Prefer the user's current workspace; fall back to the relay default.
        let cwd = {
            let relay = self.relay.read().await;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            relay.current_cwd.clone()
        };

        let defaults = self.defaults().await;
        let (provider_name, bridge) = self.preferred_orchestrator_provider()?;
        let provider_models = self
            .load_provider_model_catalog(provider_name, bridge)
            .await;
        let model = resolve_provider_model(
            provider_name,
            &provider_models,
            None,
            super::PROVIDER_DEFAULT_MODEL.to_string(),
        );
        let effort = default_effort_for_model(&provider_models, &model)
            .unwrap_or_else(|| DEFAULT_EFFORT.to_string());
        // Never-ask: secretary, not a shell agent prompting on every tool.
        let approval_policy = "never".to_string();
        let sandbox = defaults.sandbox.clone();

        let persona = self.orchestrator_persona_from_driver();
        let persona_text = persona.as_ref().map(|(prompt, _)| prompt.clone());

        let start = bridge
            .start_thread(
                StartThreadRequest::new(&cwd, &model, &approval_policy, &sandbox)
                    // Persona from the private driver when present; public builds stay bare.
                    .with_system_prompt(persona_text.clone())
                    // MCP tools when the provider supports them (Claude preferred above).
                    .with_orchestrator_tools(Some(device_id.clone())),
            )
            .await?;
        let mut thread = start.thread;
        thread.provider = provider_name.to_string();
        thread.source = provider_name.to_string();
        let thread_id = thread.id.clone();

        {
            let mut relay = self.relay.write().await;
            relay.register_background_thread(
                thread,
                &cwd,
                &model,
                &approval_policy,
                &sandbox,
                &effort,
            );
            // Title under the same lock as the pin: a crash in between would
            // leave an untitled thread as the pin.
            let _ = relay
                .set_thread_custom_name(&thread_id, Some(ORCHESTRATOR_THREAD_NAME.to_string()));
            relay.orchestrator_thread_id = Some(thread_id.clone());
            // device_id kept for re-attaching tools on later turns.
            relay.orchestrator_device_id = Some(device_id.clone());
            relay.orchestrator_system_prompt = persona_text;
            relay.orchestrator_system_prompt_version =
                persona.as_ref().map(|(_, version)| *version);
            relay.push_log(
                "info",
                format!("Started the Orchestrator thread ({thread_id}) in {cwd}."),
            );
            relay.notify();
        }

        Ok(thread_id)
    }

    /// Drop the current Orchestrator and open a fresh one.
    ///
    /// The escape hatch for a pin the relay cannot tell is dead. `ensure` only
    /// re-pins when the THREAD is gone; a thread whose provider-side session
    /// vanished still resolves, so it is retried forever — cursor sessions do not
    /// survive a relay restart, and one user's Orchestrator failed every turn
    /// with `Session … not found` and no way out of the screen.
    ///
    /// The old thread is left where it is rather than deleted: it is a background
    /// thread, so it is already out of the way, and whatever was said in it is the
    /// user's. Only the pin moves.
    pub async fn reset_orchestrator(&self, device_id: Option<String>) -> Result<String, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        // Checked before clearing anything: a refusal must not cost the user the
        // Orchestrator they already had.
        let device_id = require_device_id(device_id)?;
        self.preferred_orchestrator_provider()?;
        {
            let mut relay = self.relay.write().await;
            if let Some(previous) = relay.orchestrator_thread_id.take() {
                relay.push_log(
                    "info",
                    format!("Retired the Orchestrator thread ({previous}) at the user's request."),
                );
            }
            relay.orchestrator_device_id = None;
            relay.orchestrator_system_prompt = None;
            relay.orchestrator_system_prompt_version = None;
            relay.notify();
        }
        self.ensure_orchestrator(Some(device_id)).await
    }

    fn orchestrator_persona_from_driver(&self) -> Option<(String, u32)> {
        let driver = self.team_driver()?;
        let prompt = driver.orchestrator_system_prompt();
        if prompt.trim().is_empty() {
            return None;
        }
        Some((prompt, driver.orchestrator_system_prompt_version()))
    }

    /// The pinned id when it is still one we would build today; else `None`
    /// (and clear, so the next `ensure` makes a new one).
    ///
    /// Two ways a pin stops being usable, and only the first is obvious. The
    /// thread can be gone — deleted, provider dropped — which `find_thread_provider`
    /// reports. Or the thread can be perfectly resolvable on a provider we no
    /// longer build Orchestrators on, which nothing reports at all: it was
    /// pinned when the rule was different, and the rule changing underneath it
    /// left a secretary that cannot hold the toolset and, on cursor, cannot even
    /// survive a restart. Requiring the user to know a reset button exists is
    /// not a fix for that; the pin has to move on its own.
    async fn live_orchestrator_thread_id(&self) -> Option<String> {
        let pinned = {
            let relay = self.relay.read().await;
            relay.orchestrator_thread_id.clone()
        }?;
        if let Ok((provider, _)) = self.find_thread_provider(&pinned).await {
            if ORCHESTRATOR_PROVIDERS.contains(&provider) {
                return Some(pinned);
            }
            // Say it once, where someone reading the log can connect the new
            // thread to the old one disappearing.
            self.relay.write().await.push_log(
                "info",
                format!(
                    "Retiring the Orchestrator thread ({pinned}): it is on {provider}, which can no longer hold the Tasks toolset."
                ),
            );
        }
        let mut relay = self.relay.write().await;
        if relay.orchestrator_thread_id.as_deref() == Some(pinned.as_str()) {
            relay.orchestrator_thread_id = None;
            relay.notify();
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::StartSessionInput;
    use crate::state::app::tests::path_scope_tests::{
        build_app, build_app_with_bridge, pair_device,
    };
    use std::sync::Arc;
    use tempfile::TempDir;

    /// Two tabs opening Tasks at the same moment must not each get an Orchestrator.
    ///
    /// `ensure_orchestrator` read the pin, RELEASED the lock, awaited
    /// `start_thread`, and then wrote the pin unconditionally. Two callers could
    /// both observe no pin, both start a provider thread, and the last writer
    /// won. The loser's tab kept an id that is not the pin, so its deferred
    /// first turn ran with the initial options but every later
    /// `attach_orchestrator_session` found it was not the pinned thread and
    /// rebuilt the worker without persona or MCP tools — the endpoint's
    /// idempotence guarantee failing silently, and failing worst on the second
    /// turn rather than the first.
    ///
    /// A multi-thread runtime is required, not decoration: on the default
    /// single-threaded one the two tasks cannot overlap, because nothing between
    /// the pin read and the pin write yields when the fake bridge answers
    /// immediately. Repeated because the window is real time rather than a fixed
    /// interleaving, and one attempt that happens to serialize proves nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_first_opens_create_exactly_one_orchestrator() {
        for attempt in 0..25 {
            run_concurrent_ensure_attempt(attempt).await;
        }
    }

    async fn run_concurrent_ensure_attempt(attempt: usize) {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, bridge, _p, _o) = build_app_with_bridge(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;
        // Hold the check-then-act window open. Without this both callers finish
        // `start_thread` without ever yielding, so they take turns and the race
        // this test exists for never occurs.
        bridge.set_start_thread_delay_ms(40);

        // Released together, so both calls are inside the check-then-act window.
        let gate = Arc::new(tokio::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let app = app.clone();
            let gate = Arc::clone(&gate);
            handles.push(tokio::spawn(async move {
                gate.wait().await;
                app.ensure_orchestrator(Some("device-1".to_string())).await
            }));
        }
        let mut ids = Vec::new();
        for handle in handles {
            ids.push(handle.await.expect("join").expect("ensure"));
        }

        assert_eq!(
            ids[0], ids[1],
            "attempt {attempt}: both tabs must be handed the same Orchestrator; the \
loser of a race keeps an id that is not the pin and silently loses its toolset"
        );

        // And exactly one thread was actually started: returning the same id
        // while having spawned two provider sessions would still leak one.
        let threads = app
            .list_threads(200, Some("device-1".to_string()))
            .await
            .expect("list threads");
        let orchestrators = threads
            .threads
            .iter()
            .filter(|thread| thread.name.as_deref() == Some(ORCHESTRATOR_THREAD_NAME))
            .count();
        assert_eq!(
            orchestrators, 1,
            "attempt {attempt}: a second provider thread was started and orphaned"
        );

        let pinned = app.relay.read().await.orchestrator_thread_id.clone();
        assert_eq!(pinned.as_deref(), Some(ids[0].as_str()));
    }

    #[tokio::test]
    async fn ensure_orchestrator_is_idempotent_and_does_not_steal_active() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let first = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.clone()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                initial_prompt: None,
                provider: None,
                project_id: None,
            })
            .await
            .expect("start conversation");
        let conversation_id = first.active_thread_id.clone().expect("active thread");

        let orch_a = app
            .ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("ensure");
        let orch_b = app
            .ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("ensure again");
        assert_eq!(orch_a, orch_b, "ensure must reuse the same pin");
        assert_ne!(
            orch_a, conversation_id,
            "orchestrator must be a distinct thread"
        );

        let snap = app.snapshot().await;
        assert_eq!(
            snap.active_thread_id.as_deref(),
            Some(conversation_id.as_str()),
            "opening the Orchestrator must not steal the active conversation"
        );
        assert_eq!(
            snap.orchestrator_thread_id.as_deref(),
            Some(orch_a.as_str()),
            "snapshot must advertise the pin"
        );

        let name = {
            let relay = app.relay.read().await;
            relay.thread_custom_name(&orch_a)
        };
        assert_eq!(
            name.as_deref(),
            Some(ORCHESTRATOR_THREAD_NAME),
            "the Orchestrator must be titled"
        );
    }

    /// An app with several providers registered, all backed by the fake bridge.
    /// Only the KEYS matter here: the Orchestrator ranks providers by name, so a
    /// fake standing in for `claude_code` exercises the real choice.
    async fn build_multi_provider_app(cwd: &str, keys: &[&str]) -> AppState {
        use crate::fake_provider::FakeProviderBridge;
        use crate::state::security::SecurityProfile;
        use crate::state::RelayState;
        use std::collections::HashMap;
        use tokio::sync::{watch, RwLock};

        let (change_tx, keep) = watch::channel(0_u64);
        std::mem::forget(keep);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        for key in keys {
            let bridge = Arc::new(
                FakeProviderBridge::spawn(relay.clone())
                    .await
                    .expect("fake provider should spawn"),
            );
            providers.insert((*key).to_string(), bridge as Arc<dyn ProviderBridge>);
        }
        AppState::from_parts(relay, providers, change_tx)
    }

    /// Same, but hands back the one fake bridge so a test can read what the relay
    /// handed it at `start_thread`.
    #[cfg(feature = "private")]
    async fn build_recording_app(
        cwd: &str,
    ) -> (AppState, Arc<crate::fake_provider::FakeProviderBridge>) {
        use crate::fake_provider::FakeProviderBridge;
        use crate::state::security::SecurityProfile;
        use crate::state::RelayState;
        use std::collections::HashMap;
        use tokio::sync::{watch, RwLock};

        let (change_tx, keep) = watch::channel(0_u64);
        std::mem::forget(keep);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let bridge = Arc::new(
            FakeProviderBridge::spawn(relay.clone())
                .await
                .expect("fake provider should spawn"),
        );
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        providers.insert(
            "fake".to_string(),
            bridge.clone() as Arc<dyn ProviderBridge>,
        );
        let app = AppState::from_parts(relay, providers, change_tx)
            .with_team_driver(Arc::new(sealwire_private::TeamEngine::default()));
        (app, bridge)
    }

    /// The Orchestrator was a thread with a TITLE and nothing else — no persona,
    /// no instructions. It did not know it was a secretary, which is why "hello"
    /// looked as much like a work order as anything else did.
    ///
    /// Gated: the persona is a PROMPT, and prompts are the decision layer. A build
    /// with no private crate linked has nothing to say and correctly says nothing
    /// — which is what `..._without_a_decision_layer_sends_no_persona` pins.
    #[cfg(feature = "private")]
    #[tokio::test]
    async fn ensure_orchestrator_gives_the_thread_a_persona() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, bridge) = build_recording_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        app.ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("ensure");

        let recorded = bridge.recorded_system_prompts().await;
        assert_eq!(
            recorded.len(),
            1,
            "the Orchestrator must be opened with a persona"
        );
        let prompt = &recorded[0].1;
        assert!(
            prompt.contains("Orchestrator"),
            "the persona must say what the thread is: {prompt}"
        );
        let lower = prompt.to_lowercase();
        assert!(
            lower.contains("conversation"),
            "the persona must say that most messages are chat, not work: {prompt}"
        );
        for tool in ["propose_task", "task_status", "control_run"] {
            assert!(
                prompt.contains(tool),
                "the persona must name {tool} and when to reach for it: {prompt}"
            );
        }
        assert!(
            !lower.contains("you have no tools"),
            "the persona must not claim it is toolless — it has six: {prompt}"
        );
        assert!(
            lower.contains("investigate"),
            "the persona must treat investigation as routed work: {prompt}"
        );
        assert!(
            lower.contains("do not do the work in this chat"),
            "the persona must forbid substituting for a task: {prompt}"
        );
        assert_eq!(
            app.relay.read().await.orchestrator_system_prompt_version,
            Some(2),
            "ensure must store the decision layer's persona version beside the pin"
        );
    }

    /// Must not inherit the active provider — pin is persisted.
    #[tokio::test]
    async fn ensure_orchestrator_does_not_inherit_the_active_provider() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = build_multi_provider_app(&cwd, &["codex", "claude_code"]).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        // Active is Codex; Orchestrator should still prefer Claude.
        app.relay
            .write()
            .await
            .set_provider_name("codex".to_string());

        let orch = app
            .ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("ensure");

        let provider = {
            let relay = app.relay.read().await;
            relay
                .runtime_for_thread(&orch)
                .and_then(|runtime| runtime.summary.as_ref())
                .map(|summary| summary.provider.clone())
        };
        assert_eq!(
            provider.as_deref(),
            Some("claude_code"),
            "the Orchestrator must pick its provider deliberately, not inherit the active one"
        );
    }

    /// A relay without Claude gets NO Orchestrator, and is told why.
    ///
    /// This used to fall through to whatever was installed, so a codex- or
    /// cursor-only relay got a chat-only secretary. It reads as generosity and is
    /// not: the thread it pins is permanent, holds no tools on those providers,
    /// and on cursor cannot even be resumed after a restart — every later turn
    /// answers `Session ... not found` from a screen with no way out. Refusing
    /// with a sentence beats a secretary that cannot do the job or be replaced.
    #[tokio::test]
    async fn a_relay_without_claude_is_told_why_it_gets_no_orchestrator() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = build_multi_provider_app(&cwd, &["codex"]).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;
        app.relay
            .write()
            .await
            .set_provider_name("codex".to_string());

        let refused = app
            .ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect_err("codex cannot hold the toolset");

        assert!(
            refused.contains("Claude"),
            "the refusal has to name what is missing: {refused}"
        );
        assert!(
            app.relay.read().await.orchestrator_thread_id.is_none(),
            "nothing may be pinned when we refused to build one"
        );
    }

    /// No decision layer linked, no persona invented. The relay must not paper
    /// over a missing driver with a prompt of its own: the prompts ARE the product,
    /// and a public build quietly shipping its own would be the seam leaking.
    #[tokio::test]
    async fn ensure_orchestrator_without_a_decision_layer_sends_no_persona() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        app.ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("ensure");

        assert!(
            !app.has_team_driver(),
            "this fixture is the public build; it has no private driver to ask"
        );
    }

    #[tokio::test]
    async fn ensure_orchestrator_replaces_a_dead_pin() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        {
            let mut relay = app.relay.write().await;
            relay.orchestrator_thread_id = Some("missing-thread".to_string());
        }

        let orch = app
            .ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("ensure after dead pin");
        assert_ne!(orch, "missing-thread");
        let snap = app.snapshot().await;
        assert_eq!(snap.orchestrator_thread_id.as_deref(), Some(orch.as_str()));
    }

    /// The pin can point at a thread the relay still resolves but the PROVIDER
    /// has forgotten — cursor drops its sessions when the relay restarts. `ensure`
    /// cannot see that (the thread is fine; only the session is gone), so it hands
    /// the same dead id back forever and every turn fails. Reset is the way out.
    #[tokio::test]
    async fn reset_replaces_the_pinned_orchestrator() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let first = app
            .ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("first orchestrator");
        assert_eq!(
            app.relay.read().await.orchestrator_thread_id.as_deref(),
            Some(first.as_str())
        );

        let second = app
            .reset_orchestrator(Some("device-1".to_string()))
            .await
            .expect("reset");

        assert_ne!(
            second, first,
            "reset must not hand back the same dead thread"
        );
        assert_eq!(
            app.relay.read().await.orchestrator_thread_id.as_deref(),
            Some(second.as_str()),
            "the pin has to move with it, or the next ensure returns the old one"
        );
    }

    /// A refusal must not cost the user the Orchestrator they already had: the
    /// provider check runs before the pin is cleared.
    #[tokio::test]
    async fn a_refused_reset_leaves_the_current_orchestrator_alone() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let first = app
            .ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("first orchestrator");

        let refused = app.reset_orchestrator(None).await;

        assert!(refused.is_err(), "no device id is a refusal");
        assert_eq!(
            app.relay.read().await.orchestrator_thread_id.as_deref(),
            Some(first.as_str()),
            "a refused reset must not strand the screen with no Orchestrator"
        );
    }

    /// A pin made before Claude was required must not survive the requirement.
    ///
    /// This is the shape that actually reached a user: their Orchestrator was
    /// pinned to cursor back when the list ranked rather than restricted, so
    /// after the restriction landed nothing changed for them — the thread still
    /// resolved, so `ensure` handed it straight back, and it still had no tools
    /// (cursor takes no `mcpServers`) so it did the work itself instead of
    /// proposing it. A manual reset fixed it, which is no fix at all: nobody
    /// should have to know a button exists to escape a provider we stopped
    /// supporting.
    #[tokio::test]
    async fn ensure_moves_a_pin_off_a_provider_we_no_longer_build_on() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = build_multi_provider_app(&cwd, &["cursor", "claude_code"]).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        // A legacy Orchestrator: a real thread on cursor, pinned.
        let legacy = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.clone()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                initial_prompt: None,
                provider: Some("cursor".to_string()),
                project_id: None,
            })
            .await
            .expect("start a cursor thread");
        let legacy_id = legacy.active_thread_id.clone().expect("active thread");
        app.relay.write().await.orchestrator_thread_id = Some(legacy_id.clone());
        let orch = app
            .ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("ensure");

        // NOT an id comparison: the fixture gives each provider key its own fake
        // bridge and each mints ids from its own counter, so two different
        // threads can share a name here. The provider is what the rule is about.
        let provider = app
            .find_thread_provider(&orch)
            .await
            .map(|(name, _)| name.to_string())
            .expect("the replacement resolves");
        assert_eq!(
            provider, "claude_code",
            "the replacement has to be on a provider that can hold the toolset"
        );
        let pinned = app.relay.read().await.orchestrator_thread_id.clone();
        assert_eq!(
            pinned.as_deref(),
            Some(orch.as_str()),
            "and the pin has to point at it"
        );
    }

    /// Persona updates refresh relay state but keep the pinned thread so the Tasks
    /// conversation survives prompt changes; the next send re-bakes the SDK session.
    #[tokio::test]
    async fn ensure_keeps_pin_when_persona_text_updates() {
        use relay_api::{TeamDriver, TeamPort};

        #[derive(Clone, Copy)]
        struct StubDriver {
            prompt: &'static str,
            version: u32,
        }

        #[async_trait::async_trait]
        impl TeamDriver for StubDriver {
            fn orchestrator_system_prompt_version(&self) -> u32 {
                self.version
            }

            fn orchestrator_system_prompt(&self) -> String {
                self.prompt.to_string()
            }

            async fn drive(&self, _port: Arc<dyn TeamPort>, _run_id: String) {}
        }

        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (mut app, _bridge, _observer) = build_app(&cwd).await;
        app = app.with_team_driver(Arc::new(StubDriver {
            prompt: "You are the Orchestrator (v1).",
            version: 1,
        }));
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let first = app
            .ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("first ensure");

        app = app.with_team_driver(Arc::new(StubDriver {
            prompt: "You are the Orchestrator (v2).",
            version: 2,
        }));

        let second = app
            .ensure_orchestrator(Some("device-1".to_string()))
            .await
            .expect("ensure after persona update");
        assert_eq!(
            second, first,
            "a persona update must refresh relay state without retiring the pinned thread"
        );
        let relay = app.relay.read().await;
        assert_eq!(
            relay.orchestrator_system_prompt.as_deref(),
            Some("You are the Orchestrator (v2).")
        );
        assert_eq!(relay.orchestrator_system_prompt_version, Some(2));
    }

    /// Pre-migration pins persisted only `orchestrator_thread_id`. After upgrade,
    /// the first ensure from the local browser must backfill acting identity without
    /// retiring the conversation.
    #[tokio::test]
    async fn ensure_backfills_acting_device_on_legacy_pin() {
        use crate::protocol::ThreadSummaryView;

        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        app.set_beta_features_enabled(true).await;

        let thread_id = "legacy-orch";
        {
            let mut relay = app.relay.write().await;
            let thread = ThreadSummaryView {
                workspace_trusted: false,
                id: thread_id.to_string(),
                name: Some(ORCHESTRATOR_THREAD_NAME.to_string()),
                preview: String::new(),
                cwd: cwd.clone(),
                updated_at: 1,
                source: "fake".to_string(),
                status: "idle".to_string(),
                model_provider: "fake".to_string(),
                provider: "fake".to_string(),
                forked_from: None,
                renamed: false,
                flagged: false,
            };
            relay.register_background_thread(
                thread,
                &cwd,
                "fake-echo",
                "never",
                "read-only",
                "low",
            );
            relay.orchestrator_thread_id = Some(thread_id.to_string());
            relay.orchestrator_device_id = None;
            relay.orchestrator_system_prompt = Some("You are the Orchestrator.".to_string());
            relay.orchestrator_system_prompt_version = Some(2);
        }

        let returned = app
            .ensure_orchestrator(Some("local-browser-uuid".to_string()))
            .await
            .expect("ensure on legacy pin");
        assert_eq!(
            returned, thread_id,
            "legacy pin must survive migration backfill"
        );

        let relay = app.relay.read().await;
        assert_eq!(
            relay.orchestrator_device_id.as_deref(),
            Some("local-browser-uuid"),
            "acting device must be restored from the current ensure caller"
        );
        assert_eq!(
            relay.orchestrator_session_options(thread_id),
            Some((
                "local-browser-uuid".to_string(),
                Some("You are the Orchestrator.".to_string())
            )),
            "session options must be available again after backfill"
        );
    }

    #[tokio::test]
    async fn ensure_replaces_revoked_acting_device_without_retiring_thread() {
        use crate::protocol::{DeviceLifecycleState, ThreadSummaryView};
        use crate::state::DeviceRecord;

        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        app.set_beta_features_enabled(true).await;

        let thread_id = "legacy-orch";
        {
            let mut relay = app.relay.write().await;
            let thread = ThreadSummaryView {
                workspace_trusted: false,
                id: thread_id.to_string(),
                name: Some(ORCHESTRATOR_THREAD_NAME.to_string()),
                preview: String::new(),
                cwd: cwd.clone(),
                updated_at: 1,
                source: "fake".to_string(),
                status: "idle".to_string(),
                model_provider: "fake".to_string(),
                provider: "fake".to_string(),
                forked_from: None,
                renamed: false,
                flagged: false,
            };
            relay.register_background_thread(
                thread,
                &cwd,
                "fake-echo",
                "never",
                "read-only",
                "low",
            );
            relay.orchestrator_thread_id = Some(thread_id.to_string());
            relay.orchestrator_device_id = Some("revoked-phone".to_string());
            relay.orchestrator_system_prompt = Some("You are the Orchestrator.".to_string());
            relay.device_records.insert(
                "revoked-phone".to_string(),
                DeviceRecord {
                    device_id: "revoked-phone".to_string(),
                    label: "Phone".to_string(),
                    lifecycle_state: DeviceLifecycleState::Revoked,
                    created_at: 1,
                    state_changed_at: 100,
                    last_seen_at: None,
                    last_peer_id: None,
                    device_verify_key: String::new(),
                    broker_join_ticket_expires_at: None,
                    path_scope: Vec::new(),
                },
            );
        }

        let returned = app
            .ensure_orchestrator(Some("local-browser-uuid".to_string()))
            .await
            .expect("ensure after revoked acting device");
        assert_eq!(returned, thread_id);
        assert_eq!(
            app.relay.read().await.orchestrator_device_id.as_deref(),
            Some("local-browser-uuid")
        );
        assert!(app
            .relay
            .read()
            .await
            .orchestrator_session_options(thread_id)
            .is_some());
    }
}
