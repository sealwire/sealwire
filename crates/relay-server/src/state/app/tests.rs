// Lint-style guard against the recurring bug class: an action gate that blocks on a
// literal `current_status != "idle"` instead of the semantic predicate
// (`active_agent_is_working()` / `runtime.is_working()`). That literal misclassifies
// Codex's non-idle settled statuses (`unknown`/`completed`) and has shipped THREE times
// (request_review, start_workflow, update_session_settings).
//
// Scope: the whole action-gate LAYER (`src/state/app/`), scanned by directory rather than
// a hardcoded file list — so a refactor that renames a gate file or moves a gate into a new
// file in this layer stays covered automatically, and if the layer dir is moved wholesale
// the test fails loudly (forcing this guard to be updated) instead of silently passing.
// Test files are skipped (they hold this guard's own pattern strings and idle assertions).
// This layer has zero legitimate literal idle comparisons, so no allowlist is needed; a
// broad whole-crate scan would instead false-positive on benign idle waits (the
// `#[cfg(test)]` `wait_for_threads_idle` helper in claude.rs) and poll-cadence code.
#[cfg(test)]
mod idle_gate_lint {
    use std::path::{Path, PathBuf};

    fn gate_layer_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let entries = std::fs::read_dir(dir).unwrap_or_else(|e| {
            panic!(
                "read_dir {} ({e}) — did the action layer move?",
                dir.display()
            )
        });
        for entry in entries {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                gate_layer_files(&path, out);
                continue;
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            // Skip test sources: tests.rs carries this guard's own literal pattern strings
            // and many `current_status == "idle"` assertions.
            if path.extension().and_then(|e| e.to_str()) == Some("rs")
                && name != "tests.rs"
                && !name.contains("test")
            {
                out.push(path);
            }
        }
    }

    #[test]
    fn action_gates_use_the_semantic_idle_predicate_not_a_literal() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let layer = Path::new(manifest).join("src/state/app");
        let mut files = Vec::new();
        gate_layer_files(&layer, &mut files);
        assert!(
            !files.is_empty(),
            "no non-test .rs files under {} — update this guard to the action layer's new home",
            layer.display()
        );

        for path in files {
            let rel = path
                .strip_prefix(manifest)
                .unwrap_or(&path)
                .display()
                .to_string();
            let src = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {rel}: {e}"));
            for (i, line) in src.lines().enumerate() {
                // Skip comments — the fixes left explanatory `// ... == "idle"` notes.
                if line.trim_start().starts_with("//") {
                    continue;
                }
                let normalized = line.replace(' ', "");
                assert!(
                    !(normalized.contains("current_status!=\"idle\"")
                        || normalized.contains("current_status==\"idle\"")),
                    "{rel}:{} gates on a literal current_status idle comparison; use the semantic \
predicate (active_agent_is_working / runtime.is_working) so Codex's `unknown`/`completed` \
statuses aren't misread as busy:\n  {line}",
                    i + 1
                );
            }
        }
    }
}

#[cfg(test)]
mod workspace_diff_tests {
    use super::super::{
        collect_workspace_diff, synthesize_untracked_diff, truncate_to_char_boundary,
    };
    use tempfile::TempDir;
    use tokio::process::Command;

    async fn run(cmd: &mut Command) {
        let output = cmd.output().await.expect("git command should run");
        assert!(
            output.status.success(),
            "git failed: stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    async fn init_repo() -> TempDir {
        let dir = TempDir::new().expect("tmpdir");
        let path = dir.path().to_path_buf();
        run(Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(&path))
        .await;
        run(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&path))
        .await;
        run(Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&path))
        .await;
        std::fs::write(path.join("seed.txt"), "line1\nline2\n").unwrap();
        run(Command::new("git")
            .args(["add", "seed.txt"])
            .current_dir(&path))
        .await;
        run(Command::new("git")
            .args(["commit", "-q", "-m", "seed"])
            .current_dir(&path))
        .await;
        dir
    }

    #[test]
    fn truncate_caps_and_marks_truncated() {
        let bytes = vec![b'a'; 10];
        let (text, truncated) = truncate_to_char_boundary(bytes, 4);
        assert_eq!(text, "aaaa");
        assert!(truncated);
    }

    #[test]
    fn truncate_under_limit_is_not_truncated() {
        let (text, truncated) = truncate_to_char_boundary(b"hello".to_vec(), 100);
        assert_eq!(text, "hello");
        assert!(!truncated);
    }

    #[test]
    fn truncate_respects_utf8_boundary() {
        // "héllo" — 'é' is 2 bytes (0xC3 0xA9). Limit 2 should drop into mid-char,
        // then back off to "h".
        let bytes = "héllo".as_bytes().to_vec();
        let (text, truncated) = truncate_to_char_boundary(bytes, 2);
        assert_eq!(text, "h");
        assert!(truncated);
    }

    #[tokio::test]
    async fn synthesize_untracked_emits_added_lines() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("new.txt"), "alpha\nbeta\n").unwrap();
        let (diff, truncated) = synthesize_untracked_diff(&dir.path().to_string_lossy(), "new.txt")
            .await
            .unwrap();
        assert!(!truncated);
        assert!(diff.contains("new file mode 100644"));
        assert!(diff.contains("+++ b/new.txt"));
        assert!(diff.contains("@@ -0,0 +1,2 @@"));
        assert!(diff.contains("+alpha"));
        assert!(diff.contains("+beta"));
    }

    #[tokio::test]
    async fn synthesize_untracked_skips_binary() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("blob.bin"), [0u8, 1, 2, 3, 0]).unwrap();
        let (diff, _truncated) =
            synthesize_untracked_diff(&dir.path().to_string_lossy(), "blob.bin")
                .await
                .unwrap();
        assert_eq!(diff, "");
    }

    #[tokio::test]
    async fn collect_returns_not_a_git_repo_outside_git() {
        let dir = TempDir::new().unwrap();
        let response = collect_workspace_diff(&dir.path().to_string_lossy())
            .await
            .unwrap();
        assert!(response.not_a_git_repo);
        assert!(response.file_changes.is_empty());
    }

    #[tokio::test]
    async fn collect_shows_tracked_modification() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("seed.txt"), "line1\nLINE2\n").unwrap();
        let response = collect_workspace_diff(&dir.path().to_string_lossy())
            .await
            .unwrap();
        assert!(!response.not_a_git_repo);
        assert_eq!(response.file_changes.len(), 1);
        let change = &response.file_changes[0];
        assert_eq!(change.path, "seed.txt");
        assert_eq!(change.change_type, "update");
        assert!(change.diff.contains("-line2"));
        assert!(change.diff.contains("+LINE2"));
    }

    #[tokio::test]
    async fn collect_includes_untracked_files_as_adds() {
        let dir = init_repo().await;
        std::fs::write(dir.path().join("fresh.txt"), "hello\nworld\n").unwrap();
        let response = collect_workspace_diff(&dir.path().to_string_lossy())
            .await
            .unwrap();
        let fresh = response
            .file_changes
            .iter()
            .find(|change| change.path == "fresh.txt")
            .expect("fresh.txt should appear");
        assert_eq!(fresh.change_type, "add");
        assert!(fresh.diff.contains("+hello"));
        assert!(fresh.diff.contains("+world"));
    }

    #[tokio::test]
    async fn collect_clean_tree_returns_no_changes() {
        let dir = init_repo().await;
        let response = collect_workspace_diff(&dir.path().to_string_lossy())
            .await
            .unwrap();
        assert!(!response.not_a_git_repo);
        assert!(response.file_changes.is_empty());
    }
}

#[cfg(test)]
mod path_scope_tests {
    use super::super::*;
    use crate::codex::CodexBridge;
    use crate::fake_provider::FakeProviderBridge;
    use crate::protocol::{
        ApprovalDecision, ApprovalDecisionInput, ApprovalScope, AskUserOptionView,
        AskUserQuestionView, ForkSessionInput, ReadThreadTranscriptInput, ResumeSessionInput,
        SendMessageInput, StartSessionInput, SubmitAskUserAnswerInput, ThreadSummaryView,
        UpdateSessionSettingsInput,
    };
    use crate::state::security::SecurityProfile;
    use crate::state::{
        ApprovalKind, PendingApproval, PendingAskUserQuestion, DEFAULT_APPROVAL_POLICY,
        DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_SANDBOX,
    };
    use std::collections::HashSet;
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    };
    use tempfile::TempDir;
    use tokio::sync::{watch, Mutex, RwLock};

    async fn build_app(cwd: &str) -> (AppState, TempDir, TempDir) {
        let project = TempDir::new().expect("project tempdir");
        let outside = TempDir::new().expect("outside tempdir");
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let bridge = FakeProviderBridge::spawn(relay.clone())
            .await
            .expect("fake provider should spawn");
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        providers.insert("fake".to_string(), Arc::new(bridge));
        (
            AppState::from_parts(relay, providers, change_tx),
            project,
            outside,
        )
    }

    async fn build_status_app(cwd: &str, read_status: &str) -> (AppState, TempDir, TempDir) {
        let project = TempDir::new().expect("project tempdir");
        let outside = TempDir::new().expect("outside tempdir");
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        providers.insert(
            "statusy".to_string(),
            Arc::new(StatusProviderBridge::new("statusy", read_status)),
        );
        (
            AppState::from_parts(relay, providers, change_tx),
            project,
            outside,
        )
    }

    /// Two independent providers in one relay, for cross-provider isolation.
    async fn build_two_provider_app(cwd: &str) -> (AppState, TempDir, TempDir) {
        let project = TempDir::new().expect("project tempdir");
        let outside = TempDir::new().expect("outside tempdir");
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        providers.insert(
            "alpha".to_string(),
            Arc::new(StatusProviderBridge::new("alpha", "idle")),
        );
        providers.insert(
            "beta".to_string(),
            // Beta reports Codex's saved-thread status, so the symmetry tests
            // also cover the notLoaded classification.
            Arc::new(StatusProviderBridge::new("beta", "notLoaded")),
        );
        (
            AppState::from_parts(relay, providers, change_tx),
            project,
            outside,
        )
    }

    async fn build_consumed_initial_prompt_app(cwd: &str) -> (AppState, TempDir, TempDir) {
        let project = TempDir::new().expect("project tempdir");
        let outside = TempDir::new().expect("outside tempdir");
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        providers.insert(
            "consumed-initial".to_string(),
            Arc::new(ConsumedInitialPromptProvider::default()),
        );
        (
            AppState::from_parts(relay, providers, change_tx),
            project,
            outside,
        )
    }

    async fn build_completed_consumed_initial_prompt_app(
        cwd: &str,
    ) -> (AppState, TempDir, TempDir) {
        let project = TempDir::new().expect("project tempdir");
        let outside = TempDir::new().expect("outside tempdir");
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        providers.insert(
            "consumed-initial".to_string(),
            Arc::new(ConsumedInitialPromptProvider {
                relay: Some(relay.clone()),
                complete_initial_before_return: true,
                ..ConsumedInitialPromptProvider::default()
            }),
        );
        (
            AppState::from_parts(relay, providers, change_tx),
            project,
            outside,
        )
    }

    // End-to-end guard for "a freshly started service shows a running Codex thread
    // with nothing running". The unit test in runtime.rs pins the from_sync_data choke
    // point; this pins the whole restart-restore wiring
    // (restore_persisted_session → provider resume_thread + read_thread →
    // restore_thread_data → from_sync_data AND the closing upsert_thread), because the
    // read status arrives on TWO fields (ThreadSyncData.status AND .thread.status) and
    // the summary path nearly re-clobbered the constructor fix.
    //
    // The fake provider's read_thread passes its stored status through, exactly like
    // Codex's thread/read returns the real `status.type` (Claude hardcodes "idle"). A
    // restored thread has no live turn (turn ids are never persisted), so it must come
    // back idle — not a ghost "working" thread that jams every escape.
    #[tokio::test]
    async fn restoring_a_thread_with_a_working_read_status_is_not_a_ghost() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().into_owned();
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.clone(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));

        // Seed an ACTIVE thread BEFORE spawning the provider: the fake provider seeds
        // its one thread (and the status its read_thread will report) from the relay
        // snapshot at spawn time. This stands in for a Codex thread that codex's store
        // still reports as `active`.
        {
            let mut relay = relay.write().await;
            relay.activate_thread(
                ThreadSummaryView {
                    id: "ghost-thread".to_string(),
                    name: None,
                    preview: String::new(),
                    cwd: cwd.clone(),
                    updated_at: unix_now(),
                    source: "fake".to_string(),
                    status: "active".to_string(),
                    model_provider: "fake".to_string(),
                    provider: "fake".to_string(),
                    forked_from: None,
                },
                &cwd,
                DEFAULT_MODEL,
                DEFAULT_APPROVAL_POLICY,
                DEFAULT_SANDBOX,
                DEFAULT_EFFORT,
                "device-a",
            );
            assert_eq!(
                relay.current_status, "active",
                "precondition: the thread is working before the restart"
            );
        }

        let bridge = FakeProviderBridge::spawn(relay.clone())
            .await
            .expect("fake provider should spawn");
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        providers.insert("fake".to_string(), Arc::new(bridge));
        let app = AppState::from_parts(relay.clone(), providers, change_tx);

        // Capture what shutdown would persist, then model a fresh boot: the in-memory
        // runtime is gone (active_turn_id is never persisted) while the provider's store
        // still has the thread and reports it `active` on read.
        let persisted = {
            let relay = relay.read().await;
            crate::state::persistence::PersistedRelayState::from_relay(&relay)
        };
        relay.write().await.clear_active_session();

        app.restore_persisted_session(persisted).await;

        let snapshot = app.snapshot().await;
        assert_eq!(snapshot.active_thread_id.as_deref(), Some("ghost-thread"));
        assert_eq!(
            snapshot.active_turn_id, None,
            "a restore never resurrects a turn id"
        );
        assert_eq!(
            snapshot.current_status, "idle",
            "a restored thread with no live turn must not come back as a ghost 'working' thread"
        );
    }

    // Repro for: "an existing Codex session shows Claude's models — not a single
    // GPT." The relay persists `active_thread_id` + the active provider, but NOT
    // the thread row. On restart the provider for the restored active thread must
    // be resolved from the PERSISTED provider — not from whatever provider spawned
    // last (claude_code wins by spawn order) — otherwise a restored Codex session
    // is mis-routed to the Claude worker and comes back as Claude (provider AND
    // model catalog).
    #[tokio::test]
    async fn restored_session_resumes_on_its_persisted_provider_not_the_last_spawned() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().into_owned();
        let (app, codex, claude) = build_recording_provider_app(&cwd).await;

        // The Codex session's thread is resumable + readable in codex's store, but
        // codex's `list_threads` does NOT surface it yet — the live trigger. So
        // `find_thread_provider`'s probe can't locate it, and resolution must come
        // from the persisted provider.
        let codex_thread = codex.thread_summary("codex-thread-1", &cwd);
        codex
            .threads
            .lock()
            .await
            .insert(codex_thread.id.clone(), codex_thread.clone());
        codex
            .hidden_from_list
            .lock()
            .await
            .insert("codex-thread-1".to_string());

        // Capture what shutdown would persist while the Codex session was active.
        let persisted = {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some("codex-thread-1".to_string());
            crate::state::persistence::PersistedRelayState::from_relay(&relay)
        };
        assert_eq!(
            persisted.provider_name, "codex",
            "the active provider must be persisted"
        );

        // Model the REAL fresh-boot state: apply_persisted leaves active_thread_id
        // SET, provider startup leaves the global provider on the last-spawned
        // provider (claude_code), the startup refresh stamped Claude's catalog, and
        // the relay thread/runtime caches are empty (not persisted). Critically,
        // active_thread_id stays set — clearing it would hide the
        // find_thread_provider active-provider shortcut from the test.
        {
            let mut relay = app.relay.write().await;
            relay.active_thread_id = Some("codex-thread-1".to_string());
            relay.set_provider_name("claude_code".to_string());
            relay.threads.clear();
            relay.set_available_models(vec![crate::protocol::ModelOptionView {
                model: "default".to_string(),
                display_name: "Default (Opus 4.8)".to_string(),
                provider: "anthropic".to_string(),
                supported_reasoning_efforts: vec!["high".to_string()],
                default_reasoning_effort: "high".to_string(),
                hidden: false,
                is_default: true,
            }]);
        }

        app.restore_persisted_session(persisted).await;

        let snapshot = app.snapshot().await;
        // The session is restored ON CODEX — resumed there, active thread back,
        // and the Codex model catalog loaded (no Claude leakage).
        assert_eq!(
            snapshot.provider, "codex",
            "a restored Codex session must come back as codex, not the last-spawned provider"
        );
        assert_eq!(
            snapshot.active_thread_id.as_deref(),
            Some("codex-thread-1"),
            "the active Codex thread must be restored"
        );
        assert_eq!(
            codex.resume_thread_ids.lock().await.as_slice(),
            ["codex-thread-1".to_string()],
            "restore must resume on the codex provider"
        );
        assert!(
            claude.resume_thread_ids.lock().await.is_empty(),
            "restore must NOT route the codex thread to the claude worker"
        );
        assert!(
            !snapshot.available_models.is_empty()
                && snapshot
                    .available_models
                    .iter()
                    .all(|m| m.provider == "codex"),
            "the restored Codex session must show codex models, got: {:?}",
            snapshot
                .available_models
                .iter()
                .map(|m| (&m.model, &m.provider))
                .collect::<Vec<_>>()
        );
    }

    // A legacy persisted state (saved before `provider_name` existed → empty on
    // load) must still restore via provider probing: the new persisted field is
    // an ADDITIVE preference, not a hard requirement, so old state files keep
    // working.
    #[tokio::test]
    async fn restored_session_without_persisted_provider_falls_back_to_probing() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().into_owned();
        let (app, codex, claude) = build_recording_provider_app(&cwd).await;

        // Here the thread IS surfaced by codex's list_threads, so probing finds it.
        let codex_thread = codex.thread_summary("codex-thread-2", &cwd);
        codex
            .threads
            .lock()
            .await
            .insert(codex_thread.id.clone(), codex_thread.clone());

        // An OLD state file: active_thread_id present, provider_name absent.
        let mut persisted = {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some("codex-thread-2".to_string());
            crate::state::persistence::PersistedRelayState::from_relay(&relay)
        };
        persisted.provider_name = String::new();

        // Real startup state: active_thread_id stays SET (apply_persisted), the
        // global provider is the last-spawned one, thread/runtime caches empty.
        {
            let mut relay = app.relay.write().await;
            relay.active_thread_id = Some("codex-thread-2".to_string());
            relay.set_provider_name("claude_code".to_string());
            relay.threads.clear();
        }

        app.restore_persisted_session(persisted).await;

        let snapshot = app.snapshot().await;
        assert_eq!(
            snapshot.provider, "codex",
            "probing must still resolve the codex thread when no provider was persisted"
        );
        assert_eq!(snapshot.active_thread_id.as_deref(), Some("codex-thread-2"));
        assert_eq!(
            codex.resume_thread_ids.lock().await.as_slice(),
            ["codex-thread-2".to_string()]
        );
        assert!(claude.resume_thread_ids.lock().await.is_empty());
    }

    // A persisted provider that no longer exists (provider removed/renamed) must
    // fall back to probing the currently-registered providers — not give up.
    #[tokio::test]
    async fn restored_session_falls_back_to_probing_when_persisted_provider_is_gone() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().into_owned();
        let (app, codex, claude) = build_recording_provider_app(&cwd).await;

        let codex_thread = codex.thread_summary("codex-thread-gone", &cwd);
        codex
            .threads
            .lock()
            .await
            .insert(codex_thread.id.clone(), codex_thread.clone());

        // Persisted provider key is no longer in the providers map.
        let mut persisted = {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some("codex-thread-gone".to_string());
            crate::state::persistence::PersistedRelayState::from_relay(&relay)
        };
        persisted.provider_name = "retired_provider".to_string();

        // Real startup state: active_thread_id stays SET (apply_persisted), the
        // global provider is the last-spawned one, thread/runtime caches empty.
        {
            let mut relay = app.relay.write().await;
            relay.active_thread_id = Some("codex-thread-gone".to_string());
            relay.set_provider_name("claude_code".to_string());
            relay.threads.clear();
        }

        app.restore_persisted_session(persisted).await;

        let snapshot = app.snapshot().await;
        assert_eq!(
            snapshot.provider, "codex",
            "an unknown persisted provider must fall back to probing, not be trusted blindly"
        );
        assert_eq!(
            snapshot.active_thread_id.as_deref(),
            Some("codex-thread-gone")
        );
        assert_eq!(
            codex.resume_thread_ids.lock().await.as_slice(),
            ["codex-thread-gone".to_string()]
        );
        assert!(claude.resume_thread_ids.lock().await.is_empty());
    }

    // A persisted provider that still EXISTS but is WRONG for the thread (stale /
    // corrupted) must self-heal: resuming on it fails, so restore falls back to
    // probing and resumes on the thread's real provider instead of dropping the
    // session.
    #[tokio::test]
    async fn restored_session_recovers_when_persisted_provider_is_wrong() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().into_owned();
        let (app, codex, claude) = build_recording_provider_app(&cwd).await;

        // The thread genuinely lives on codex (resumable + surfaced by list_threads).
        let codex_thread = codex.thread_summary("codex-thread-wrong", &cwd);
        codex
            .threads
            .lock()
            .await
            .insert(codex_thread.id.clone(), codex_thread.clone());

        // ...but the persisted provider WRONGLY names claude_code (a valid,
        // registered provider that does not own this thread).
        let mut persisted = {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some("codex-thread-wrong".to_string());
            crate::state::persistence::PersistedRelayState::from_relay(&relay)
        };
        persisted.provider_name = "claude_code".to_string();

        // Real startup state: active_thread_id stays SET (apply_persisted), the
        // global provider is the last-spawned one, thread/runtime caches empty.
        {
            let mut relay = app.relay.write().await;
            relay.active_thread_id = Some("codex-thread-wrong".to_string());
            relay.set_provider_name("claude_code".to_string());
            relay.threads.clear();
        }

        app.restore_persisted_session(persisted).await;

        let snapshot = app.snapshot().await;
        assert_eq!(
            snapshot.provider, "codex",
            "a wrong-but-valid persisted provider must self-heal via probing, not lose the session"
        );
        assert_eq!(
            snapshot.active_thread_id.as_deref(),
            Some("codex-thread-wrong")
        );
        assert_eq!(
            codex.resume_thread_ids.lock().await.as_slice(),
            ["codex-thread-wrong".to_string()]
        );
        // Claude was attempted first and failed, so it recorded no successful resume.
        assert!(claude.resume_thread_ids.lock().await.is_empty());
    }

    #[tokio::test]
    async fn file_change_detail_uses_authoritative_runtime_entry() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().into_owned();
        let (app, _, _) = build_app(&cwd).await;
        let thread_id = "runtime-only-thread";
        let item_id = "turn-diff:turn-1";

        {
            let mut relay = app.relay.write().await;
            relay.activate_thread(
                ThreadSummaryView {
                    id: thread_id.to_string(),
                    name: None,
                    preview: String::new(),
                    cwd: cwd.clone(),
                    updated_at: unix_now(),
                    source: "fake".to_string(),
                    status: "idle".to_string(),
                    model_provider: "fake".to_string(),
                    provider: "fake".to_string(),
                    forked_from: None,
                },
                &cwd,
                DEFAULT_MODEL,
                DEFAULT_APPROVAL_POLICY,
                DEFAULT_SANDBOX,
                DEFAULT_EFFORT,
                "device-a",
            );
            relay.upsert_transcript_item(
                item_id.to_string(),
                crate::protocol::TranscriptEntryKind::ToolCall,
                Some("Edited files".to_string()),
                "completed".to_string(),
                Some("turn-1".to_string()),
                Some(crate::protocol::ToolCallView {
                    item_type: "turnDiff".to_string(),
                    name: "turn_diff".to_string(),
                    title: "Changed files".to_string(),
                    detail: None,
                    query: None,
                    path: None,
                    url: None,
                    command: None,
                    input_preview: None,
                    result_preview: None,
                    diff: Some("@@ -1 +1 @@\n-old\n+new".to_string()),
                    file_changes: vec![crate::protocol::FileChangeDiffView {
                        path: "src/main.rs".to_string(),
                        change_type: "modify".to_string(),
                        diff: "-old\n+new".to_string(),
                    }],
                    apply_state: None,
                    file_changes_omitted: false,
                }),
            );
        }

        let detail = app
            .read_thread_entry_detail(crate::protocol::ReadThreadEntryDetailInput {
                thread_id: thread_id.to_string(),
                item_id: item_id.to_string(),
                field: None,
                cursor: None,
                device_id: None,
            })
            .await
            .expect("runtime file-change detail should not require a provider read");

        let tool = detail
            .entry
            .expect("detail entry")
            .tool
            .expect("tool detail");
        assert_eq!(tool.diff.as_deref(), Some("@@ -1 +1 @@\n-old\n+new"));
        assert!(tool.file_changes[0].diff.is_empty());
        assert!(!tool.file_changes_omitted);
    }

    async fn pair_device(app: &AppState, device_id: &str, path_scope: Vec<String>) {
        // Normalize the scope the same way start_pairing does in production, so symlinked
        // tmpdirs on macOS (/var/folders → /private/var/folders) don't produce false misses.
        let path_scope = if path_scope.is_empty() {
            Vec::new()
        } else {
            normalize_allowed_roots(path_scope).expect("test scope should normalize")
        };
        let mut relay = app.relay.write().await;
        relay.paired_devices.insert(
            device_id.to_string(),
            crate::state::relay::PairedDevice {
                device_id: device_id.to_string(),
                label: device_id.to_string(),
                payload_secret: "test-payload-secret".to_string(),
                device_verify_key: "test-verify-key".to_string(),
                created_at: 1,
                last_seen_at: Some(1),
                last_peer_id: Some("peer-test".to_string()),
                broker_join_ticket_expires_at: None,
                path_scope,
            },
        );
    }

    #[derive(Clone)]
    struct RecordingProvider {
        name: &'static str,
        threads: Arc<Mutex<HashMap<String, ThreadSummaryView>>>,
        approval_thread_ids: Arc<Mutex<Vec<String>>>,
        ask_request_ids: Arc<Mutex<Vec<String>>>,
        turn_thread_ids: Arc<Mutex<Vec<String>>>,
        turn_efforts: Arc<Mutex<Vec<String>>>,
        turn_images: Arc<Mutex<Vec<Vec<ProviderImage>>>>,
        interrupt_thread_ids: Arc<Mutex<Vec<String>>>,
        resume_thread_ids: Arc<Mutex<Vec<String>>>,
        // Thread ids that are resumable/readable but deliberately omitted from
        // `list_threads` — models a provider whose store can resume a session
        // that its thread listing hasn't surfaced yet (e.g. Codex at restart).
        hidden_from_list: Arc<Mutex<std::collections::HashSet<String>>>,
        state: Arc<RwLock<RelayState>>,
        mark_active_status_before_return: Arc<AtomicBool>,
        complete_before_return: Arc<AtomicBool>,
        transcript_pages:
            Arc<Mutex<HashMap<(String, Option<usize>), crate::provider::ThreadTranscriptPageData>>>,
        read_thread_calls: Arc<AtomicUsize>,
        list_models_calls: Arc<AtomicUsize>,
        // Model-catalog fault injection: a cold/erroring provider (`should_fail`)
        // or one that answers before it's ready (`returns_empty`).
        list_models_should_fail: Arc<AtomicBool>,
        list_models_returns_empty: Arc<AtomicBool>,
    }

    impl RecordingProvider {
        fn new(name: &'static str, state: Arc<RwLock<RelayState>>) -> Self {
            Self {
                name,
                threads: Arc::new(Mutex::new(HashMap::new())),
                approval_thread_ids: Arc::new(Mutex::new(Vec::new())),
                ask_request_ids: Arc::new(Mutex::new(Vec::new())),
                turn_thread_ids: Arc::new(Mutex::new(Vec::new())),
                turn_efforts: Arc::new(Mutex::new(Vec::new())),
                turn_images: Arc::new(Mutex::new(Vec::new())),
                interrupt_thread_ids: Arc::new(Mutex::new(Vec::new())),
                resume_thread_ids: Arc::new(Mutex::new(Vec::new())),
                hidden_from_list: Arc::new(Mutex::new(std::collections::HashSet::new())),
                state,
                mark_active_status_before_return: Arc::new(AtomicBool::new(false)),
                complete_before_return: Arc::new(AtomicBool::new(false)),
                transcript_pages: Arc::new(Mutex::new(HashMap::new())),
                read_thread_calls: Arc::new(AtomicUsize::new(0)),
                list_models_calls: Arc::new(AtomicUsize::new(0)),
                list_models_should_fail: Arc::new(AtomicBool::new(false)),
                list_models_returns_empty: Arc::new(AtomicBool::new(false)),
            }
        }

        fn thread_summary(&self, id: &str, cwd: &str) -> ThreadSummaryView {
            ThreadSummaryView {
                id: id.to_string(),
                name: Some(format!("{} thread", self.name)),
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: self.name.to_string(),
                status: "idle".to_string(),
                model_provider: self.name.to_string(),
                provider: self.name.to_string(),
                forked_from: None,
            }
        }
    }

    #[async_trait::async_trait]
    impl ProviderBridge for RecordingProvider {
        async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
            let hidden = self.hidden_from_list.lock().await;
            let mut threads = self
                .threads
                .lock()
                .await
                .values()
                .filter(|thread| !hidden.contains(&thread.id))
                .cloned()
                .collect::<Vec<_>>();
            threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
            threads.truncate(limit);
            Ok(threads)
        }

        async fn list_models(&self) -> Result<Vec<crate::protocol::ModelOptionView>, String> {
            self.list_models_calls.fetch_add(1, Ordering::Relaxed);
            if self.list_models_should_fail.load(Ordering::Relaxed) {
                return Err(format!("{} model/list failed (cold)", self.name));
            }
            if self.list_models_returns_empty.load(Ordering::Relaxed) {
                return Ok(Vec::new());
            }
            Ok(vec![crate::protocol::ModelOptionView {
                model: format!("{}-model", self.name),
                display_name: format!("{} Model", self.name),
                provider: self.name.to_string(),
                supported_reasoning_efforts: vec!["medium".to_string()],
                default_reasoning_effort: "medium".to_string(),
                hidden: false,
                is_default: true,
            }])
        }

        async fn start_thread(
            &self,
            cwd: &str,
            _model: &str,
            _approval_policy: &str,
            _sandbox: &str,
            _initial_prompt: Option<&str>,
        ) -> Result<crate::provider::StartThreadResult, String> {
            let mut threads = self.threads.lock().await;
            let id = format!("{}-thread-{}", self.name, threads.len() + 1);
            let thread = self.thread_summary(&id, cwd);
            threads.insert(id, thread.clone());
            Ok(crate::provider::StartThreadResult {
                thread,
                consumed_initial_prompt: false,
                initial_user_message: None,
                started_turn_id: None,
            })
        }

        async fn resume_thread(
            &self,
            thread_id: &str,
            _approval_policy: &str,
            _sandbox: &str,
        ) -> Result<(), String> {
            if self.threads.lock().await.contains_key(thread_id) {
                self.resume_thread_ids
                    .lock()
                    .await
                    .push(thread_id.to_string());
                Ok(())
            } else {
                Err(format!("{} thread '{thread_id}' was not found", self.name))
            }
        }

        async fn read_thread(
            &self,
            thread_id: &str,
        ) -> Result<crate::provider::ThreadSyncData, String> {
            self.read_thread_calls.fetch_add(1, Ordering::Relaxed);
            let thread = self
                .threads
                .lock()
                .await
                .get(thread_id)
                .cloned()
                .ok_or_else(|| format!("{} thread '{thread_id}' was not found", self.name))?;
            Ok(crate::provider::ThreadSyncData {
                thread,
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            })
        }

        async fn read_thread_transcript_page(
            &self,
            thread_id: &str,
            before: Option<usize>,
        ) -> Result<Option<crate::provider::ThreadTranscriptPageData>, String> {
            Ok(self
                .transcript_pages
                .lock()
                .await
                .get(&(thread_id.to_string(), before))
                .cloned())
        }

        async fn read_thread_entry_detail(
            &self,
            _thread_id: &str,
            _item_id: &str,
        ) -> Result<Option<crate::protocol::TranscriptEntryView>, String> {
            Ok(None)
        }

        async fn archive_thread(&self, thread_id: &str) -> Result<(), String> {
            self.threads.lock().await.remove(thread_id);
            Ok(())
        }

        async fn delete_thread_permanently(
            &self,
            thread_id: &str,
        ) -> Result<crate::codex_local::LocalThreadDeleteSummary, String> {
            self.threads.lock().await.remove(thread_id);
            Ok(crate::codex_local::LocalThreadDeleteSummary {
                deleted_paths: Vec::new(),
                deleted_thread_row: true,
            })
        }

        async fn start_turn(
            &self,
            thread_id: &str,
            _text: &str,
            _model: &str,
            effort: &str,
            images: &[ProviderImage],
        ) -> Result<Option<String>, String> {
            self.turn_thread_ids
                .lock()
                .await
                .push(thread_id.to_string());
            self.turn_efforts.lock().await.push(effort.to_string());
            self.turn_images.lock().await.push(images.to_vec());
            let turn_id = format!("turn:{thread_id}");
            if self
                .mark_active_status_before_return
                .load(Ordering::Relaxed)
            {
                let mut relay = self.state.write().await;
                relay.set_thread_status(thread_id, "active".to_string(), Vec::new());
                relay.notify();
            }
            if self.complete_before_return.load(Ordering::Relaxed) {
                let mut relay = self.state.write().await;
                if relay.active_thread_id.as_deref() == Some(thread_id) {
                    relay.set_active_turn(Some(turn_id.clone()));
                    relay.set_thread_status(thread_id, "active".to_string(), Vec::new());
                    relay.set_active_turn(None);
                    relay.set_thread_status(thread_id, "idle".to_string(), Vec::new());
                } else {
                    let now = unix_now();
                    relay.bg_set_active_turn(thread_id, Some(turn_id.clone()), now);
                    relay.bg_set_thread_status(thread_id, "active".to_string(), Vec::new(), now);
                    relay.bg_set_active_turn(thread_id, None, now);
                    relay.bg_set_thread_status(thread_id, "idle".to_string(), Vec::new(), now);
                }
                relay.notify();
            }
            Ok(Some(turn_id))
        }

        async fn request_turn_stop(
            &self,
            thread_id: &str,
            _turn_id: Option<&str>,
        ) -> Result<(), String> {
            self.interrupt_thread_ids
                .lock()
                .await
                .push(thread_id.to_string());
            Ok(())
        }

        async fn respond_to_approval(
            &self,
            pending: &PendingApproval,
            _input: &ApprovalDecisionInput,
        ) -> Result<(), String> {
            self.approval_thread_ids
                .lock()
                .await
                .push(pending.thread_id.clone());
            Ok(())
        }

        async fn respond_to_ask_user_question(
            &self,
            request_id: &str,
            _answers: &serde_json::Map<String, serde_json::Value>,
        ) -> Result<(), String> {
            self.ask_request_ids
                .lock()
                .await
                .push(request_id.to_string());
            Ok(())
        }

        fn provider_name(&self) -> &'static str {
            self.name
        }
    }

    async fn build_recording_provider_app(
        cwd: &str,
    ) -> (AppState, RecordingProvider, RecordingProvider) {
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let codex = RecordingProvider::new("codex", relay.clone());
        let claude = RecordingProvider::new("claude_code", relay.clone());
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        providers.insert("codex".to_string(), Arc::new(codex.clone()));
        providers.insert("claude_code".to_string(), Arc::new(claude.clone()));
        (
            AppState::from_parts(relay, providers, change_tx),
            codex,
            claude,
        )
    }

    fn fake_codex_path() -> &'static str {
        let crate_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace_root = crate_dir
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| ".".to_string());
        let path = format!("{workspace_root}/scripts/fake-codex-app-server.mjs");
        assert!(
            std::path::Path::new(&path).is_file(),
            "missing fake Codex app-server script at {path}; AppState send regression must not be skipped"
        );
        Box::leak(path.into_boxed_str())
    }

    async fn build_fake_codex_app(cwd: &str) -> AppState {
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let bridge = CodexBridge::spawn(relay.clone(), fake_codex_path(), "Fake Codex", "codex")
            .await
            .unwrap_or_else(|error| {
                panic!("spawn fake Codex app-server for AppState regression: {error}")
            });
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        providers.insert("codex".to_string(), Arc::new(bridge));
        AppState::from_parts(relay, providers, change_tx)
    }

    async fn codex_recv_methods(app: &AppState) -> Vec<String> {
        app.relay
            .read()
            .await
            .snapshot()
            .logs
            .iter()
            .rev()
            .filter_map(|log| log.message.strip_prefix("CODEX RECV ").map(str::to_string))
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(&line).ok())
            .filter_map(|payload| {
                payload
                    .get("method")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .collect()
    }

    #[tokio::test]
    async fn approval_response_routes_to_pending_thread_provider() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let codex_thread = codex.thread_summary("codex-thread", cwd);
        let claude_thread = claude.thread_summary("claude-thread", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(codex_thread.id.clone(), codex_thread.clone());
        claude
            .threads
            .lock()
            .await
            .insert(claude_thread.id.clone(), claude_thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(codex_thread.id.clone());
            relay.threads = vec![codex_thread, claude_thread];
            relay.pending_approvals.insert(
                "approval-claude".to_string(),
                PendingApproval {
                    request_id: "approval-claude".to_string(),
                    raw_request_id: serde_json::json!("raw-approval-claude"),
                    kind: ApprovalKind::Command,
                    thread_id: "claude-thread".to_string(),
                    summary: "Run command".to_string(),
                    detail: None,
                    command: Some("true".to_string()),
                    cwd: Some(cwd.to_string()),
                    context_preview: None,
                    requested_permissions: None,
                    available_decisions: vec!["approve".to_string(), "deny".to_string()],
                    supports_session_scope: false,
                },
            );
        }

        app.decide_approval(
            "approval-claude",
            ApprovalDecisionInput {
                decision: ApprovalDecision::Approve,
                scope: Some(ApprovalScope::Once),
                device_id: Some("device-1".to_string()),
            },
        )
        .await
        .expect("approval response should route to claude provider");

        assert!(codex.approval_thread_ids.lock().await.is_empty());
        assert_eq!(
            *claude.approval_thread_ids.lock().await,
            vec!["claude-thread".to_string()]
        );
    }

    // P0b: a send carrying an explicit thread_id must take over that thread and
    // start the turn ON it — even when a different thread is currently active.
    // This is what closes the wrong-thread send race: the send targets the thread
    // the user meant, not "whatever happens to be active when it lands".
    #[tokio::test]
    async fn send_message_with_thread_id_takes_over_and_targets_that_thread() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread_a = codex.thread_summary("codex-thread-a", cwd);
        let thread_b = codex.thread_summary("codex-thread-b", cwd);
        {
            let mut threads = codex.threads.lock().await;
            threads.insert(thread_a.id.clone(), thread_a.clone());
            threads.insert(thread_b.id.clone(), thread_b.clone());
        }
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread_a.id.clone());
            relay.threads = vec![thread_a.clone(), thread_b.clone()];
        }

        // A is active; send to B.
        let snapshot = app
            .send_message(SendMessageInput {
                text: "work on B".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: thread_b.id.clone(),
            })
            .await
            .expect("send with explicit thread_id should succeed");

        assert_eq!(
            snapshot.active_thread_id.as_deref(),
            Some(thread_b.id.as_str()),
            "sending to a non-active thread must take it over"
        );
        assert_eq!(
            *codex.turn_thread_ids.lock().await,
            vec![thread_b.id.clone()],
            "the turn must go to the requested thread, never the previously-active one"
        );
        assert!(
            codex.resume_thread_ids.lock().await.is_empty(),
            "targeted send must not resume the provider session first"
        );
    }

    #[tokio::test]
    async fn image_only_message_is_accepted_and_forwarded_to_the_provider() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread = codex.thread_summary("codex-image-thread", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(thread.id.clone(), thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread.id.clone());
            relay.threads = vec![thread.clone()];
        }
        let image = ProviderImage {
            media_type: "image/png".to_string(),
            data: "iVBORw0KGgo=".to_string(),
        };

        app.send_message_with_images(
            SendMessageInput {
                text: String::new(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: thread.id,
            },
            vec![image.clone()],
        )
        .await
        .expect("an image-only message should start a provider turn");

        assert_eq!(*codex.turn_images.lock().await, vec![vec![image]]);
    }

    #[tokio::test]
    async fn send_message_rejects_empty_text_without_images() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let error = app
            .send_message_with_images(
                SendMessageInput {
                    text: "  ".to_string(),
                    model: None,
                    effort: None,
                    device_id: Some("device-1".to_string()),
                    thread_id: "unused".to_string(),
                },
                Vec::new(),
            )
            .await
            .expect_err("a message with no text or images must be rejected");

        assert_eq!(error, "message text or an image attachment is required");
    }

    #[tokio::test]
    async fn send_to_cold_codex_thread_with_unknown_settings_fails_closed_after_hydration() {
        let app = build_fake_codex_app("/tmp/project").await;
        pair_device(&app, "device-1", Vec::new()).await;
        let thread_id = "thread-imported";
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.approval_policy = "bypass".to_string();
            relay.sandbox = "danger-full-access".to_string();
            relay.threads = vec![ThreadSummaryView {
                id: thread_id.to_string(),
                name: Some("imported codex thread".to_string()),
                preview: String::new(),
                cwd: "/tmp/project".to_string(),
                updated_at: unix_now(),
                source: "codex".to_string(),
                status: "idle".to_string(),
                model_provider: "codex".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            }];
        }

        let error = app
            .send_message(SendMessageInput {
                text: "resume unsafely?".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: thread_id.to_string(),
            })
            .await
            .expect_err("unknown Codex settings must fail closed after cold hydration");

        assert!(
            error.contains("thread not found"),
            "the original Codex not-loaded error must survive, got: {error}"
        );
        {
            let relay = app.relay.read().await;
            assert!(
                relay.runtime_for_thread(thread_id).is_some(),
                "send preflight should have hydrated a runtime for the readable thread"
            );
            assert!(
                relay.remembered_thread_settings(thread_id).is_none(),
                "cold hydration must not turn permissive relay defaults into remembered settings"
            );
            assert!(
                relay.thread_settings(thread_id).is_some(),
                "the runtime can still expose display settings without authorizing Codex resume"
            );
        }

        let methods = codex_recv_methods(&app).await;
        assert_eq!(
            methods
                .iter()
                .filter(|method| *method == "turn/start")
                .count(),
            1,
            "the bridge may probe turn/start once, but must not retry after guessing policy"
        );
        assert!(
            !methods.iter().any(|method| method == "thread/resume"),
            "send must not resume a cold Codex thread when approval/sandbox settings are unknown"
        );
    }

    #[tokio::test]
    async fn targeted_send_takes_over_the_focused_thread_from_another_device() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-a", Vec::new()).await;
        pair_device(&app, "device-b", Vec::new()).await;

        let thread = codex.thread_summary("codex-thread-a", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(thread.id.clone(), thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread.id.clone());
            relay.threads = vec![thread.clone()];
            relay.assign_active_controller("device-a", unix_now());
        }

        let snapshot = app
            .send_message(SendMessageInput {
                text: "device B sends directly".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-b".to_string()),
                thread_id: thread.id.clone(),
            })
            .await
            .expect("an explicit send should take control even when the target is focused");

        assert_eq!(
            snapshot.active_controller_device_id.as_deref(),
            Some("device-b")
        );
        assert_eq!(*codex.turn_thread_ids.lock().await, vec![thread.id]);
        assert!(codex.resume_thread_ids.lock().await.is_empty());
    }

    // Review #2: a device must be able to take over a NON-active thread by sending
    // to it, even while another device controls the current active thread. The
    // write-control check applies to the target (post-take-over), not the old
    // active thread.
    #[tokio::test]
    async fn send_to_non_active_thread_takes_over_even_when_another_device_controls_active() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-a", Vec::new()).await;
        pair_device(&app, "device-b", Vec::new()).await;

        let thread_a = codex.thread_summary("codex-thread-a", cwd);
        let thread_b = codex.thread_summary("codex-thread-b", cwd);
        {
            let mut threads = codex.threads.lock().await;
            threads.insert(thread_a.id.clone(), thread_a.clone());
            threads.insert(thread_b.id.clone(), thread_b.clone());
        }
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread_a.id.clone());
            relay.threads = vec![thread_a.clone(), thread_b.clone()];
            // device-a controls the currently-active thread A.
            relay.assign_active_controller("device-a", unix_now());
        }

        // device-b sends to the non-active thread B → must take it over (not be
        // rejected with "another device has control").
        let snapshot = app
            .send_message(SendMessageInput {
                text: "take over B".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-b".to_string()),
                thread_id: thread_b.id.clone(),
            })
            .await
            .expect("device B should take over a non-active thread by sending to it");

        assert_eq!(
            snapshot.active_thread_id.as_deref(),
            Some(thread_b.id.as_str())
        );
        assert_eq!(
            *codex.turn_thread_ids.lock().await,
            vec![thread_b.id.clone()]
        );
    }

    #[tokio::test]
    async fn explicit_take_over_targets_a_non_active_thread_without_starting_a_turn() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-a", Vec::new()).await;
        pair_device(&app, "device-b", Vec::new()).await;

        let thread_a = codex.thread_summary("codex-thread-a", cwd);
        let thread_b = codex.thread_summary("codex-thread-b", cwd);
        {
            let mut threads = codex.threads.lock().await;
            threads.insert(thread_a.id.clone(), thread_a.clone());
            threads.insert(thread_b.id.clone(), thread_b.clone());
        }
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread_a.id.clone());
            relay.threads = vec![thread_a, thread_b.clone()];
            relay.assign_active_controller("device-a", unix_now());
        }

        let snapshot = app
            .take_over_control(crate::protocol::TakeOverInput {
                device_id: Some("device-b".to_string()),
                thread_id: thread_b.id.clone(),
            })
            .await
            .expect("take-over should target the viewed background thread");

        assert_eq!(
            snapshot.active_thread_id.as_deref(),
            Some(thread_b.id.as_str())
        );
        assert_eq!(
            snapshot.active_controller_device_id.as_deref(),
            Some("device-b")
        );
        assert!(
            codex.turn_thread_ids.lock().await.is_empty(),
            "take-over changes control focus but must not start a turn"
        );
    }

    // Repro for: "opening an existing Codex thread still shows Claude's provider /
    // models." Taking over a thread makes it active, so the snapshot's provider
    // and model catalog must follow the OPENED thread's provider — not stay on
    // whatever provider was active before.
    #[tokio::test]
    async fn take_over_a_codex_thread_switches_provider_and_model_catalog() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-a", Vec::new()).await;

        let claude_thread = claude.thread_summary("claude-thread", cwd);
        let codex_thread = codex.thread_summary("codex-thread", cwd);
        claude
            .threads
            .lock()
            .await
            .insert(claude_thread.id.clone(), claude_thread.clone());
        codex
            .threads
            .lock()
            .await
            .insert(codex_thread.id.clone(), codex_thread.clone());

        // Claude is the active session: its provider + catalog are in the snapshot.
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some(claude_thread.id.clone());
            relay.threads = vec![claude_thread.clone(), codex_thread.clone()];
            relay.assign_active_controller("device-a", unix_now());
            relay.set_available_models(vec![crate::protocol::ModelOptionView {
                model: "default".to_string(),
                display_name: "Default (Opus 4.8)".to_string(),
                provider: "anthropic".to_string(),
                supported_reasoning_efforts: vec!["high".to_string()],
                default_reasoning_effort: "high".to_string(),
                hidden: false,
                is_default: true,
            }]);
        }

        // Open (take over) the existing Codex thread.
        let snapshot = app
            .take_over_control(crate::protocol::TakeOverInput {
                device_id: Some("device-a".to_string()),
                thread_id: codex_thread.id.clone(),
            })
            .await
            .expect("take-over of the codex thread should succeed");

        assert_eq!(
            snapshot.active_thread_id.as_deref(),
            Some(codex_thread.id.as_str())
        );
        // The session must now reflect the CODEX provider + catalog, not Claude's.
        assert_eq!(
            snapshot.provider, "codex",
            "opening a codex thread must switch the session provider to codex"
        );
        assert!(
            !snapshot.available_models.is_empty()
                && snapshot
                    .available_models
                    .iter()
                    .all(|m| m.provider == "codex"),
            "opening a codex thread must show codex models, got: {:?}",
            snapshot
                .available_models
                .iter()
                .map(|m| (&m.model, &m.provider))
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn transcript_tail_carries_the_target_threads_settings_and_liveness() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread = codex.thread_summary("codex-thread-settings", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(thread.id.clone(), thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.threads = vec![thread.clone()];
            relay.remember_thread_settings(&thread.id, "never", "read-only", "low", "saved-model");
        }

        let page = app
            .read_thread_transcript(crate::protocol::ReadThreadTranscriptInput {
                thread_id: thread.id.clone(),
                cursor: None,
                before: None,
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("tail read");
        let thread_state = page.thread_state.expect("tail must include thread state");

        assert_eq!(thread_state.thread_id, thread.id);
        assert_eq!(thread_state.model, "saved-model");
        assert_eq!(thread_state.reasoning_effort, "low");
        assert_eq!(thread_state.approval_policy, "never");
        assert_eq!(thread_state.sandbox, "read-only");
        assert!(thread_state.active_turn_id.is_none());
        assert!(thread_state.settings_writable);
    }

    #[tokio::test]
    async fn cold_transcript_uses_provider_pages_without_full_session_read() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread = claude.thread_summary("claude-paged-thread", cwd);
        let expected_name = thread.name.clone();
        claude
            .threads
            .lock()
            .await
            .insert(thread.id.clone(), thread.clone());
        let entry = |item_id: &str, text: &str| crate::protocol::TranscriptEntryView {
            item_id: Some(item_id.to_string()),
            kind: crate::protocol::TranscriptEntryKind::AgentText,
            text: Some(text.to_string()),
            status: "completed".to_string(),
            turn_id: Some(item_id.to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        };
        {
            let mut pages = claude.transcript_pages.lock().await;
            pages.insert(
                (thread.id.clone(), None),
                crate::provider::ThreadTranscriptPageData {
                    sync: crate::provider::ThreadSyncData {
                        thread: thread.clone(),
                        status: "idle".to_string(),
                        active_flags: Vec::new(),
                        transcript: vec![entry("tail", "tail")],
                    },
                    prev_cursor: Some(123),
                    paged: true,
                },
            );
            pages.insert(
                (thread.id.clone(), Some(123)),
                crate::provider::ThreadTranscriptPageData {
                    sync: crate::provider::ThreadSyncData {
                        thread: thread.clone(),
                        status: "idle".to_string(),
                        active_flags: Vec::new(),
                        transcript: vec![entry("older", "older")],
                    },
                    prev_cursor: None,
                    paged: true,
                },
            );
        }
        app.relay.write().await.threads = vec![thread.clone()];

        let tail = app
            .read_thread_transcript(ReadThreadTranscriptInput {
                thread_id: thread.id.clone(),
                cursor: None,
                before: None,
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("cold tail page");
        assert_eq!(tail.prev_cursor, Some(123));
        assert_eq!(tail.entries[0].item_id.as_deref(), Some("tail"));

        let older = app
            .read_thread_transcript(ReadThreadTranscriptInput {
                thread_id: thread.id.clone(),
                cursor: None,
                before: Some(123),
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("older provider page");
        assert_eq!(older.prev_cursor, None);
        assert_eq!(older.entries[0].item_id.as_deref(), Some("older"));
        assert_eq!(claude.read_thread_calls.load(Ordering::Relaxed), 0);

        let relay = app.relay.read().await;
        let runtime = relay.runtime_for_thread(&thread.id).expect("paged runtime");
        assert_eq!(runtime.transcript.len(), 2);
        assert_eq!(runtime.transcript[0].item_id, "older");
        assert_eq!(runtime.transcript[1].item_id, "tail");
        assert_eq!(
            runtime
                .summary
                .as_ref()
                .and_then(|summary| summary.name.clone()),
            expected_name
        );
    }

    #[tokio::test]
    async fn transcript_tail_serves_models_from_the_relay_cache_not_a_live_bridge_call() {
        // The transcript tail is polled ~3x/s for a working viewed thread. It
        // must serve the model catalog from the relay's independently-refreshed
        // cache rather than re-issuing a (Codex-uncached) `model/list` per read.
        // Seed the cache with a sentinel the bridge would never return, then
        // assert the tail surfaces exactly that.
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread = codex.thread_summary("codex-thread-models", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(thread.id.clone(), thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.threads = vec![thread.clone()];
            relay.set_available_models(vec![crate::protocol::ModelOptionView {
                model: "cached-sentinel".to_string(),
                display_name: "Cached Sentinel".to_string(),
                provider: "codex".to_string(),
                supported_reasoning_efforts: vec!["medium".to_string()],
                default_reasoning_effort: "medium".to_string(),
                hidden: false,
                is_default: true,
            }]);
        }

        let page = app
            .read_thread_transcript(crate::protocol::ReadThreadTranscriptInput {
                thread_id: thread.id.clone(),
                cursor: None,
                before: None,
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("tail read");
        let thread_state = page.thread_state.expect("tail must include thread state");

        // The recording bridge's list_models returns "codex-model"; seeing the
        // sentinel proves the tail read the cache, not the bridge.
        assert_eq!(thread_state.available_models.len(), 1);
        assert_eq!(thread_state.available_models[0].model, "cached-sentinel");
        assert_eq!(codex.list_models_calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn provider_models_falls_back_to_cached_catalog_when_live_query_fails() {
        // The model catalog must survive a cold/erroring provider. Codex's catalog
        // is fetched live (app-server `model/list`); when that round-trip fails, the
        // remote dialog used to render an EMPTY model picker (and the new-session
        // dialog a single hardcoded default). A read must instead serve the
        // last-known (prewarmed) catalog — stale beats empty.
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;

        // Warm the cache with one good pull (mirrors `spawn_model_catalog_prewarm`).
        let warm = app.provider_models("codex").await.expect("warm pull");
        assert_eq!(warm.len(), 1);
        assert_eq!(warm[0].model, "codex-model");

        // Provider now goes cold/errors on every pull.
        codex.list_models_should_fail.store(true, Ordering::Relaxed);
        let served = app
            .provider_models("codex")
            .await
            .expect("a failed live query must fall back to the cached catalog, not error");
        assert_eq!(
            served.len(),
            1,
            "the warm catalog is served despite the failure"
        );
        assert_eq!(served[0].model, "codex-model");
    }

    #[tokio::test]
    async fn provider_models_does_not_clobber_a_warm_cache_with_an_empty_result() {
        // A provider that answers before it's ready returns an EMPTY list. Treat
        // that as "not ready": serve the warm cache AND leave the cache intact, so
        // an empty success never poisons a previously-good catalog.
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;

        app.provider_models("codex").await.expect("warm pull");

        // Cold provider returns empty → must fall back, not surface empty.
        codex
            .list_models_returns_empty
            .store(true, Ordering::Relaxed);
        let served = app
            .provider_models("codex")
            .await
            .expect("empty live result must fall back to the cached catalog");
        assert_eq!(served.len(), 1, "an empty result is never surfaced");
        assert_eq!(served[0].model, "codex-model");

        // Prove the empty result did NOT poison the cache: now fail hard, and the
        // fallback must still yield the warm catalog (which only survives if the
        // earlier empty call left the cache untouched).
        codex
            .list_models_returns_empty
            .store(false, Ordering::Relaxed);
        codex.list_models_should_fail.store(true, Ordering::Relaxed);
        let served_again = app
            .provider_models("codex")
            .await
            .expect("warm cache survives an intervening empty result");
        assert_eq!(served_again.len(), 1);
        assert_eq!(served_again[0].model, "codex-model");
    }

    #[tokio::test]
    async fn refreshing_a_catalog_with_an_empty_result_keeps_the_warm_cache() {
        // `load_provider_model_catalog` is the prewarm/periodic-refresh primitive.
        // A scheduled refresh that races a cold provider (empty list) must NOT
        // poison the warm cache — otherwise the background refresh we add for
        // freshness would itself blank the catalog.
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;

        app.provider_models("codex").await.expect("warm pull");

        codex
            .list_models_returns_empty
            .store(true, Ordering::Relaxed);
        let bridge = app.providers.get("codex").expect("codex bridge").clone();
        let refreshed = app.load_provider_model_catalog("codex", &bridge).await;
        assert!(refreshed.is_none(), "an empty refresh adopts nothing");

        // The previously-warm catalog must still be servable after the empty
        // refresh (prove it by failing the live pull and seeing the fallback work).
        codex
            .list_models_returns_empty
            .store(false, Ordering::Relaxed);
        codex.list_models_should_fail.store(true, Ordering::Relaxed);
        let served = app
            .provider_models("codex")
            .await
            .expect("warm cache survived the empty refresh");
        assert_eq!(served.len(), 1);
        assert_eq!(served[0].model, "codex-model");
    }

    #[tokio::test]
    async fn transcript_tail_uses_the_viewed_threads_provider_model_catalog() {
        // Opening a non-active saved thread is view-only: the frontend reads this
        // transcript tail and builds the model picker from thread_state. The
        // relay's global available_models belongs to the active provider, so it
        // must never leak into a viewed thread owned by another provider.
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let codex_thread = codex.thread_summary("codex-thread-models", cwd);
        let claude_thread = claude.thread_summary("claude-thread-active", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(codex_thread.id.clone(), codex_thread.clone());
        claude
            .threads
            .lock()
            .await
            .insert(claude_thread.id.clone(), claude_thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some(claude_thread.id.clone());
            relay.threads = vec![claude_thread, codex_thread.clone()];
            relay.set_available_models(vec![crate::protocol::ModelOptionView {
                model: "claude-only".to_string(),
                display_name: "Claude Only".to_string(),
                provider: "claude_code".to_string(),
                supported_reasoning_efforts: vec!["high".to_string()],
                default_reasoning_effort: "high".to_string(),
                hidden: false,
                is_default: true,
            }]);
        }

        let page = app
            .read_thread_transcript(crate::protocol::ReadThreadTranscriptInput {
                thread_id: codex_thread.id.clone(),
                cursor: None,
                before: None,
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("view-only transcript tail read");
        let thread_state = page.thread_state.expect("tail must include thread state");

        assert_eq!(thread_state.provider, "codex");
        assert!(
            !thread_state.available_models.is_empty()
                && thread_state
                    .available_models
                    .iter()
                    .all(|model| model.provider == "codex"),
            "viewing a Codex thread must return Codex models, got: {:?}",
            thread_state
                .available_models
                .iter()
                .map(|model| (&model.model, &model.provider))
                .collect::<Vec<_>>()
        );

        app.read_thread_transcript(crate::protocol::ReadThreadTranscriptInput {
            thread_id: codex_thread.id,
            cursor: None,
            before: None,
            device_id: Some("device-1".to_string()),
        })
        .await
        .expect("second view-only transcript tail read");
        assert_eq!(
            codex.list_models_calls.load(Ordering::Relaxed),
            1,
            "the non-active provider catalog must be cached across transcript polling"
        );
    }

    // Repro for: "remote shows fewer reviewers than local." The global snapshot
    // scopes reviewer_threads to the ACTIVE parent for broker-bound surfaces, so a
    // remote client VIEWING a non-active thread loses that thread's reviewers. The
    // per-thread transcript read must supply the viewed thread's OWN reviewers
    // (same shape as the view-only model-catalog fix above).
    #[tokio::test]
    async fn transcript_tail_includes_the_viewed_threads_reviewers() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let codex_thread = codex.thread_summary("codex-thread-reviewed", cwd);
        let claude_thread = claude.thread_summary("claude-thread-active", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(codex_thread.id.clone(), codex_thread.clone());
        claude
            .threads
            .lock()
            .await
            .insert(claude_thread.id.clone(), claude_thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some(claude_thread.id.clone());
            relay.threads = vec![claude_thread, codex_thread.clone()];
            // The viewed (non-active) codex thread owns a reviewer — exactly the
            // entry the broker-bound global snapshot would scope away.
            relay
                .register_reviewer_thread("reviewer-of-codex".to_string(), codex_thread.id.clone());
        }

        let page = app
            .read_thread_transcript(crate::protocol::ReadThreadTranscriptInput {
                thread_id: codex_thread.id.clone(),
                cursor: None,
                before: None,
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("view-only transcript tail read");
        let thread_state = page.thread_state.expect("tail must include thread state");

        assert!(
            thread_state.reviewers.iter().any(|reviewer| {
                reviewer.reviewer_thread_id == "reviewer-of-codex"
                    && reviewer.parent_thread_id == codex_thread.id
            }),
            "viewing a thread must return its own reviewers, got: {:?}",
            thread_state
                .reviewers
                .iter()
                .map(|reviewer| (&reviewer.reviewer_thread_id, &reviewer.parent_thread_id))
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn send_with_thread_id_and_no_active_thread_takes_over() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread_a = codex.thread_summary("codex-thread-a", cwd);
        {
            codex
                .threads
                .lock()
                .await
                .insert(thread_a.id.clone(), thread_a.clone());
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            // No active thread.
            relay.active_thread_id = None;
            relay.threads = vec![thread_a.clone()];
        }

        let snapshot = app
            .send_message(SendMessageInput {
                text: "start here".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: thread_a.id.clone(),
            })
            .await
            .expect("send with thread_id should take over even with no active thread");

        assert_eq!(
            snapshot.active_thread_id.as_deref(),
            Some(thread_a.id.as_str())
        );
        assert_eq!(
            *codex.turn_thread_ids.lock().await,
            vec![thread_a.id.clone()]
        );
    }

    #[tokio::test]
    async fn send_does_not_resurrect_a_turn_completed_before_start_returns() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread_a = codex.thread_summary("codex-thread-a", cwd);
        let thread_b = codex.thread_summary("codex-thread-b", cwd);
        {
            let mut threads = codex.threads.lock().await;
            threads.insert(thread_a.id.clone(), thread_a.clone());
            threads.insert(thread_b.id.clone(), thread_b.clone());
        }
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread_a.id.clone());
            relay.threads = vec![thread_a, thread_b.clone()];
        }
        codex.complete_before_return.store(true, Ordering::Relaxed);

        let snapshot = app
            .send_message(SendMessageInput {
                text: "finish immediately".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: thread_b.id.clone(),
            })
            .await
            .expect("the completed turn should still count as an accepted send");

        assert_eq!(
            snapshot.active_thread_id.as_deref(),
            Some(thread_b.id.as_str()),
            "an accepted send still moves control focus"
        );
        assert_eq!(
            snapshot.active_controller_device_id.as_deref(),
            Some("device-1")
        );
        assert_eq!(
            snapshot.active_turn_id, None,
            "the app fallback must not resurrect a provider-completed turn"
        );
        assert_eq!(snapshot.current_status, "idle");
        assert!(
            snapshot
                .thread_activity
                .iter()
                .all(|activity| activity.thread_id != thread_b.id),
            "the completed thread must not retain a ghost activity badge"
        );
    }

    #[tokio::test]
    async fn status_event_before_start_response_still_seeds_returned_turn_id() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread = codex.thread_summary("codex-thread", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(thread.id.clone(), thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread.id.clone());
            relay.threads = vec![thread.clone()];
        }
        codex
            .mark_active_status_before_return
            .store(true, Ordering::Relaxed);

        let snapshot = app
            .send_message(SendMessageInput {
                text: "status arrives first".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: thread.id.clone(),
            })
            .await
            .expect("the status-before-turn window should remain writable");

        assert_eq!(
            snapshot.active_turn_id.as_deref(),
            Some("turn:codex-thread"),
            "a status notification alone must not suppress the response fallback"
        );
        assert_eq!(snapshot.current_status, "active");
    }

    // C5 repro: resuming a thread that is genuinely mid-turn must NOT drop its
    // "running" state. This exercises the WORST case — the post-turn-start,
    // pre-status-event window: active_turn_id is set but current_status hasn't been
    // bumped to a working value yet (the RecordingProvider, like a real provider
    // before its status event lands, leaves it idle). Combined with Claude's
    // always-idle read_thread, a status-based guard would clear the live turn here.
    // active_turn_id is the authority, so the turn must survive. Automatic resumes
    // (review / workflow runner re-driving a thread) trigger this with no user
    // action — "什么都没做自己就这样".
    #[tokio::test]
    async fn resuming_a_running_thread_keeps_its_live_turn() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread = claude.thread_summary("claude-thread", cwd);
        {
            claude
                .threads
                .lock()
                .await
                .insert(thread.id.clone(), thread.clone());
            let mut relay = app.relay.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some(thread.id.clone());
            relay.threads = vec![thread.clone()];
            relay.assign_active_controller("device-1", unix_now());
        }

        // Drive a turn so the thread is genuinely running (active_turn_id set). We do
        // NOT set a working status — modelling the window before the provider's
        // status event arrives, which is exactly where the old guard misfired.
        let running = app
            .send_message(SendMessageInput {
                text: "do the thing".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: thread.id.clone(),
            })
            .await
            .expect("send should start a turn");
        assert!(
            running.active_turn_id.is_some(),
            "precondition: the thread is running (has a live turn)"
        );

        // An automatic resume of the still-running thread (the turn is still live
        // on the provider; a review/workflow runner re-drives it). Claude's
        // read_thread reports status=idle here even though work is ongoing.
        let after = app
            .resume_session(ResumeSessionInput {
                thread_id: thread.id.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("claude_code".to_string()),
            })
            .await
            .expect("resume should succeed");

        assert!(
            after.active_turn_id.is_some(),
            "resuming a running thread must not drop its in-flight turn — a provider \
             that reports idle (Claude) on read_thread must not settle a live turn to \
             idle, or the thread shows as not-running while still working"
        );
    }

    // Review finding 2: "send = take over" must NOT start a second turn on a thread
    // that is already running one. Sending to a background thread with a live
    // active_turn_id would resume it and call start_turn again — double-starting.
    // The server rejects up front, before any take-over side effect, and leaves the
    // current active thread untouched.
    #[tokio::test]
    async fn send_to_a_busy_background_thread_is_rejected_without_double_starting() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread_a = codex.thread_summary("codex-thread-a", cwd);
        let thread_b = codex.thread_summary("codex-thread-b", cwd);
        {
            let mut threads = codex.threads.lock().await;
            threads.insert(thread_a.id.clone(), thread_a.clone());
            threads.insert(thread_b.id.clone(), thread_b.clone());
        }
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread_a.id.clone());
            relay.threads = vec![thread_a.clone(), thread_b.clone()];
            relay.assign_active_controller("device-1", unix_now());
            // B is running a turn in the background.
            let now = unix_now();
            relay.bg_set_active_turn(&thread_b.id, Some("turn-b".to_string()), now);
            relay.bg_set_thread_status(&thread_b.id, "active".to_string(), Vec::new(), now);
        }

        let result = app
            .send_message(SendMessageInput {
                text: "interrupt B".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: thread_b.id.clone(),
            })
            .await;

        assert!(
            result.is_err(),
            "sending to a thread already running a turn must be rejected"
        );
        assert!(
            codex.turn_thread_ids.lock().await.is_empty(),
            "no turn may be started on a thread that is already running one"
        );
        assert_eq!(
            app.snapshot().await.active_thread_id.as_deref(),
            Some(thread_a.id.as_str()),
            "a rejected take-over must not displace the current active thread"
        );
    }

    #[tokio::test]
    async fn send_message_targets_the_explicit_thread() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread_a = codex.thread_summary("codex-thread-a", cwd);
        {
            codex
                .threads
                .lock()
                .await
                .insert(thread_a.id.clone(), thread_a.clone());
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread_a.id.clone());
            relay.threads = vec![thread_a.clone()];
        }

        app.send_message(SendMessageInput {
            text: "hi".to_string(),
            model: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            thread_id: thread_a.id.clone(),
        })
        .await
        .expect("targeted send should start on the explicit thread");

        assert_eq!(
            *codex.turn_thread_ids.lock().await,
            vec![thread_a.id.clone()],
            "without a thread_id, the turn goes to the active thread (no take-over)"
        );
    }

    #[tokio::test]
    async fn send_message_clamps_a_foreign_effort_the_model_rejects() {
        // REGRESSION: a codex thread can carry a foreign/stale reasoning effort
        // (e.g. Claude's "max", which codex rejects with `unknown variant max,
        // expected one of none/minimal/low/medium/high/xhigh` -> HTTP 400 and the
        // user "can't send at all"). The relay must clamp the outgoing effort to
        // the target model's supported set BEFORE start_turn, so the foreign value
        // never reaches the provider. This is the last line of defense that heals
        // every client (incl. the remote app) and any already-poisoned thread.
        // RecordingProvider's catalog model supports only ["medium"], so "max" is
        // unsupported and must be clamped to the model default ("medium").
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let thread = codex.thread_summary("codex-thread-a", cwd);
        {
            codex
                .threads
                .lock()
                .await
                .insert(thread.id.clone(), thread.clone());
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread.id.clone());
            relay.threads = vec![thread.clone()];
        }

        app.send_message(SendMessageInput {
            text: "hi".to_string(),
            model: Some("codex-model".to_string()),
            effort: Some("max".to_string()),
            device_id: Some("device-1".to_string()),
            thread_id: thread.id.clone(),
        })
        .await
        .expect("send should succeed after clamping the foreign effort");

        assert_eq!(
            *codex.turn_efforts.lock().await,
            vec!["medium".to_string()],
            "codex must receive its supported default, never the foreign `max`",
        );
    }

    #[tokio::test]
    async fn ask_user_answer_routes_to_pending_thread_provider() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let codex_thread = codex.thread_summary("codex-thread", cwd);
        let claude_thread = claude.thread_summary("claude-thread", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(codex_thread.id.clone(), codex_thread.clone());
        claude
            .threads
            .lock()
            .await
            .insert(claude_thread.id.clone(), claude_thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(codex_thread.id.clone());
            relay.threads = vec![codex_thread, claude_thread];
            relay.pending_ask_user_questions.insert(
                "ask-claude".to_string(),
                PendingAskUserQuestion {
                    request_id: "ask-claude".to_string(),
                    tool_use_id: "toolu-ask-claude".to_string(),
                    thread_id: "claude-thread".to_string(),
                    requested_at: 123,
                    questions: vec![AskUserQuestionView {
                        question: "Pick one".to_string(),
                        header: "Choice".to_string(),
                        multi_select: false,
                        options: vec![AskUserOptionView {
                            label: "A".to_string(),
                            description: String::new(),
                        }],
                    }],
                },
            );
        }
        let mut answers = serde_json::Map::new();
        answers.insert(
            "Pick one".to_string(),
            serde_json::Value::String("A".to_string()),
        );

        app.submit_ask_user_answer(
            "ask-claude",
            SubmitAskUserAnswerInput {
                answers,
                device_id: Some("device-1".to_string()),
            },
        )
        .await
        .expect("AskUser answer should route to claude provider");

        assert!(codex.ask_request_ids.lock().await.is_empty());
        assert_eq!(
            *claude.ask_request_ids.lock().await,
            vec!["ask-claude".to_string()]
        );
    }

    #[tokio::test]
    async fn send_message_routes_by_active_thread_provider_not_global_provider_name() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let claude_thread = claude.thread_summary("claude-thread", cwd);
        claude
            .threads
            .lock()
            .await
            .insert(claude_thread.id.clone(), claude_thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(claude_thread.id.clone());
            relay.current_cwd = cwd.to_string();
            relay.threads = vec![claude_thread];
        }

        app.send_message(SendMessageInput {
            text: "hello".to_string(),
            model: Some("claude_code-model".to_string()),
            effort: Some("medium".to_string()),
            device_id: Some("device-1".to_string()),
            thread_id: "claude-thread".to_string(),
        })
        .await
        .expect("message should route to claude provider");

        assert!(codex.turn_thread_ids.lock().await.is_empty());
        assert_eq!(
            *claude.turn_thread_ids.lock().await,
            vec!["claude-thread".to_string()]
        );
    }

    #[tokio::test]
    async fn stop_request_does_not_forge_provider_completion() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let claude_thread = claude.thread_summary("claude-thread", cwd);
        claude
            .threads
            .lock()
            .await
            .insert(claude_thread.id.clone(), claude_thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some(claude_thread.id.clone());
            relay.active_turn_id = Some("turn-1".to_string());
            relay.current_status = "active".to_string();
            relay.threads = vec![claude_thread];
            relay.set_active_controller("device-1");
        }

        let snapshot = app
            .stop_active_turn(StopTurnInput {
                device_id: Some("device-1".to_string()),
                thread_id: "claude-thread".to_string(),
            })
            .await
            .expect("provider should accept the stop request");

        assert!(codex.interrupt_thread_ids.lock().await.is_empty());
        assert_eq!(
            *claude.interrupt_thread_ids.lock().await,
            vec!["claude-thread".to_string()]
        );
        assert_eq!(
            snapshot.active_turn_id.as_deref(),
            Some("turn-1"),
            "the relay must wait for a provider completion event"
        );
        assert_eq!(snapshot.current_status, "active");
    }

    #[tokio::test]
    async fn targeted_stop_does_not_move_live_focus_or_controller() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-a", Vec::new()).await;
        pair_device(&app, "device-b", Vec::new()).await;

        let thread_a = codex.thread_summary("codex-thread-a", cwd);
        let thread_b = codex.thread_summary("codex-thread-b", cwd);
        {
            let mut threads = codex.threads.lock().await;
            threads.insert(thread_a.id.clone(), thread_a.clone());
            threads.insert(thread_b.id.clone(), thread_b.clone());
        }
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread_a.id.clone());
            relay.current_cwd = cwd.to_string();
            relay.threads = vec![thread_a.clone(), thread_b.clone()];
            relay.assign_active_controller("device-a", unix_now());
            relay.bg_set_active_turn(&thread_b.id, Some("turn-b".to_string()), unix_now());
            relay.bg_set_thread_status(&thread_b.id, "active".to_string(), Vec::new(), unix_now());
        }

        let snapshot = app
            .stop_active_turn(StopTurnInput {
                device_id: Some("device-b".to_string()),
                thread_id: thread_b.id.clone(),
            })
            .await
            .expect("targeted stop should reach the background thread");

        assert_eq!(
            snapshot.active_thread_id.as_deref(),
            Some(thread_a.id.as_str())
        );
        assert_eq!(
            snapshot.active_controller_device_id.as_deref(),
            Some("device-a")
        );
        assert_eq!(*codex.interrupt_thread_ids.lock().await, vec![thread_b.id]);
    }

    #[tokio::test]
    async fn stop_clears_stale_working_status_without_a_turn() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, _claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-a", Vec::new()).await;

        let thread = codex.thread_summary("codex-thread", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(thread.id.clone(), thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(thread.id.clone());
            relay.threads = vec![thread.clone()];
            relay.ensure_runtime_for_thread(&thread.id).summary = Some(thread.clone());
            relay.set_thread_status(&thread.id, "active".to_string(), Vec::new());
            relay.set_active_controller("device-a");
        }

        let snapshot = app
            .stop_active_turn(StopTurnInput {
                device_id: Some("device-a".to_string()),
                thread_id: "codex-thread".to_string(),
            })
            .await
            .expect("explicit stop should clear a no-turn working ghost");

        assert_eq!(snapshot.current_status, "idle");
        assert!(snapshot.active_turn_id.is_none());
        assert!(codex.interrupt_thread_ids.lock().await.is_empty());
    }

    #[tokio::test]
    async fn stop_falls_back_to_idle_when_provider_never_confirms() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_stop_fallback_ms(80);

        let claude_thread = claude.thread_summary("claude-thread", cwd);
        claude
            .threads
            .lock()
            .await
            .insert(claude_thread.id.clone(), claude_thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some(claude_thread.id.clone());
            relay.active_turn_id = Some("turn-1".to_string());
            relay.current_status = "active".to_string();
            relay.threads = vec![claude_thread];
            relay.set_active_controller("device-1");
        }

        // The recording provider accepts the stop but never emits a completion.
        let snapshot = app
            .stop_active_turn(StopTurnInput {
                device_id: Some("device-1".to_string()),
                thread_id: "claude-thread".to_string(),
            })
            .await
            .expect("provider should accept the stop request");
        // Immediately, the relay still waits (does not forge completion).
        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-1"));

        // After the bounded fallback window, it marks the turn idle locally.
        let mut idled = false;
        for _ in 0..50 {
            if app.snapshot().await.active_turn_id.is_none() {
                idled = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            idled,
            "the bounded fallback must mark idle when no completion arrives"
        );
        assert_eq!(app.snapshot().await.current_status, "idle");
    }

    #[tokio::test]
    async fn stale_turn_watchdog_stops_provider_without_releasing_the_turn_early() {
        // This also models a persistent Claude SDK stream that emitted `result`
        // but lost its authoritative `idle`: no terminal event arrives, so only
        // provider progress expiry can initiate recovery.
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_stop_fallback_ms(80);

        let thread = claude.thread_summary("claude-thread", cwd);
        claude
            .threads
            .lock()
            .await
            .insert(thread.id.clone(), thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some(thread.id.clone());
            relay.threads = vec![thread.clone()];
            relay.ensure_runtime_for_thread(&thread.id).summary = Some(thread.clone());
            relay.ensure_runtime_for_thread(&thread.id).current_cwd = cwd.to_string();
            relay.bg_set_active_turn(&thread.id, Some("turn-stale".to_string()), 100);
            relay.bg_set_thread_status(&thread.id, "active".to_string(), Vec::new(), 100);
            relay.set_active_controller("device-1");
        }

        app.run_stale_turn_watchdog_once(100 + crate::state::STALE_TURN_PROGRESS_TIMEOUT_SECS)
            .await;

        {
            let relay = app.relay.read().await;
            let runtime = relay
                .runtime_for_thread(&thread.id)
                .expect("stale runtime remains tracked until provider completion");
            assert!(runtime.liveness_timed_out);
            assert!(runtime.liveness_stop_requested);
        }
        assert_eq!(
            *claude.interrupt_thread_ids.lock().await,
            vec![thread.id.clone()]
        );
        assert_eq!(
            app.snapshot().await.active_turn_id.as_deref(),
            Some("turn-stale"),
            "accepted stop must not forge provider completion"
        );
        let send_error = app
            .send_message(SendMessageInput {
                text: "must remain blocked".to_string(),
                model: Some("claude_code-model".to_string()),
                effort: Some("medium".to_string()),
                device_id: Some("device-1".to_string()),
                thread_id: thread.id.clone(),
            })
            .await
            .expect_err("a stale provider turn remains exclusive until it stops");
        assert!(send_error.contains("busy with a turn"));

        let mut idled = false;
        for _ in 0..50 {
            if app.snapshot().await.active_turn_id.is_none() {
                idled = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            idled,
            "the bounded stop fallback must eventually release the turn"
        );
    }

    #[tokio::test]
    async fn send_message_routes_new_active_thread_before_provider_list_syncs() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, codex, claude) = build_recording_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("claude_code".to_string());
            relay.active_thread_id = Some("claude-thread-new".to_string());
            relay.current_cwd = cwd.to_string();
            relay.threads.clear();
        }

        app.send_message(SendMessageInput {
            text: "hello".to_string(),
            model: Some("claude_code-model".to_string()),
            effort: Some("medium".to_string()),
            device_id: Some("device-1".to_string()),
            thread_id: "claude-thread-new".to_string(),
        })
        .await
        .expect("new active thread should route through the current provider before list sync");

        assert!(codex.turn_thread_ids.lock().await.is_empty());
        assert_eq!(
            *claude.turn_thread_ids.lock().await,
            vec!["claude-thread-new".to_string()]
        );
    }

    #[tokio::test]
    async fn read_ask_user_question_detail_returns_full_pending_question() {
        let (app, _project, _outside) = build_app("/tmp/project").await;
        pair_device(&app, "device-a", Vec::new()).await;
        let long_question = "Which brand should the visible title use? ".repeat(400);
        let long_description =
            "Keep the complete option description available remotely. ".repeat(200);
        {
            let mut relay = app.relay.write().await;
            relay.activate_thread(
                ThreadSummaryView {
                    id: "thread-1".to_string(),
                    name: Some("AskUser thread".to_string()),
                    preview: "pending ask-user".to_string(),
                    cwd: "/tmp/project".to_string(),
                    updated_at: 1,
                    source: "fake".to_string(),
                    status: "active".to_string(),
                    model_provider: "fake".to_string(),
                    provider: "fake".to_string(),
                    forked_from: None,
                },
                "/tmp/project",
                DEFAULT_MODEL,
                DEFAULT_APPROVAL_POLICY,
                DEFAULT_SANDBOX,
                DEFAULT_EFFORT,
                "device-a",
            );
            relay.pending_ask_user_questions.insert(
                "ask:large".to_string(),
                PendingAskUserQuestion {
                    request_id: "ask:large".to_string(),
                    tool_use_id: "toolu_large".to_string(),
                    thread_id: "thread-1".to_string(),
                    requested_at: 123,
                    questions: vec![AskUserQuestionView {
                        question: long_question.clone(),
                        header: "Brand".to_string(),
                        multi_select: false,
                        options: vec![AskUserOptionView {
                            label: "Sealwire".to_string(),
                            description: long_description.clone(),
                        }],
                    }],
                },
            );
        }

        let detail = app
            .read_ask_user_question_detail("ask:large", Some("device-a".to_string()))
            .await
            .expect("pending ask-user detail should load");

        assert_eq!(detail.request.request_id, "ask:large");
        assert!(detail.request.questions_inline_complete);
        assert!(detail.request.detail_available);
        assert_eq!(detail.request.question_count, 1);
        assert_eq!(detail.request.questions[0].question, long_question);
        assert_eq!(
            detail.request.questions[0].options[0].description,
            long_description
        );
    }

    #[derive(Clone)]
    struct ConsumedInitialThread {
        summary: ThreadSummaryView,
        transcript: Vec<crate::protocol::TranscriptEntryView>,
    }

    /// Minimal bridge whose provider name AND the `status` it reports from
    /// `read_thread` are both configurable. Needed because `FakeProviderBridge`
    /// hardcodes `provider_name() == "fake"` and always reports an idle-ish
    /// status, so it can model neither a Codex-style `notLoaded` thread nor a
    /// two-provider relay.
    struct StatusProviderBridge {
        name: &'static str,
        read_status: String,
        threads: Arc<std::sync::Mutex<HashMap<String, ThreadSummaryView>>>,
        running: Arc<std::sync::Mutex<HashSet<String>>>,
        next_id: AtomicU64,
    }

    impl StatusProviderBridge {
        fn new(name: &'static str, read_status: &str) -> Self {
            Self {
                name,
                read_status: read_status.to_string(),
                threads: Arc::new(std::sync::Mutex::new(HashMap::new())),
                running: Arc::new(std::sync::Mutex::new(HashSet::new())),
                next_id: AtomicU64::new(1),
            }
        }

        fn summary(&self, id: &str, cwd: &str) -> ThreadSummaryView {
            ThreadSummaryView {
                id: id.to_string(),
                name: Some(format!("{} thread", self.name)),
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: 1,
                source: self.name.to_string(),
                status: self.read_status.clone(),
                model_provider: self.name.to_string(),
                provider: self.name.to_string(),
                forked_from: None,
            }
        }
    }

    #[async_trait::async_trait]
    impl ProviderBridge for StatusProviderBridge {
        async fn list_threads(&self, _limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
            Ok(self.threads.lock().unwrap().values().cloned().collect())
        }

        async fn list_models(&self) -> Result<Vec<crate::protocol::ModelOptionView>, String> {
            // Two models so a thread can use a NON-default one — the case where
            // "inherit" and "provider default" diverge.
            Ok(vec![
                crate::protocol::ModelOptionView {
                    model: format!("{}-default", self.name),
                    display_name: "Default".to_string(),
                    provider: self.name.to_string(),
                    supported_reasoning_efforts: vec!["low".to_string(), "medium".to_string()],
                    default_reasoning_effort: "medium".to_string(),
                    hidden: false,
                    is_default: true,
                },
                crate::protocol::ModelOptionView {
                    model: format!("{}-fancy", self.name),
                    display_name: "Fancy".to_string(),
                    provider: self.name.to_string(),
                    supported_reasoning_efforts: vec!["low".to_string(), "high".to_string()],
                    default_reasoning_effort: "low".to_string(),
                    hidden: false,
                    is_default: false,
                },
            ])
        }

        async fn start_thread(
            &self,
            cwd: &str,
            _model: &str,
            _approval_policy: &str,
            _sandbox: &str,
            initial_prompt: Option<&str>,
        ) -> Result<StartThreadResult, String> {
            let id = format!(
                "{}-thread-{}",
                self.name,
                self.next_id.fetch_add(1, Ordering::Relaxed)
            );
            let thread = self.summary(&id, cwd);
            self.threads
                .lock()
                .unwrap()
                .insert(id.clone(), thread.clone());
            // A prompt means this thread is now mid-turn and stays that way,
            // modelling "another session is running".
            if initial_prompt.is_some() {
                self.running.lock().unwrap().insert(id.clone());
            }
            Ok(StartThreadResult {
                thread,
                consumed_initial_prompt: initial_prompt.is_some(),
                initial_user_message: None,
                started_turn_id: initial_prompt.map(|_| format!("{id}-turn")),
            })
        }

        async fn resume_thread(
            &self,
            _thread_id: &str,
            _approval_policy: &str,
            _sandbox: &str,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String> {
            let thread = self
                .threads
                .lock()
                .unwrap()
                .get(thread_id)
                .cloned()
                .ok_or_else(|| format!("unknown thread {thread_id}"))?;
            let running = self.running.lock().unwrap().contains(thread_id);
            Ok(ThreadSyncData {
                thread,
                status: if running {
                    "active".to_string()
                } else {
                    self.read_status.clone()
                },
                active_flags: Vec::new(),
                transcript: Vec::new(),
            })
        }

        async fn read_thread_entry_detail(
            &self,
            _thread_id: &str,
            _item_id: &str,
        ) -> Result<Option<crate::protocol::TranscriptEntryView>, String> {
            Ok(None)
        }

        async fn archive_thread(&self, _thread_id: &str) -> Result<(), String> {
            Ok(())
        }

        async fn delete_thread_permanently(
            &self,
            _thread_id: &str,
        ) -> Result<crate::codex_local::LocalThreadDeleteSummary, String> {
            Ok(crate::codex_local::LocalThreadDeleteSummary {
                deleted_paths: Vec::new(),
                deleted_thread_row: false,
            })
        }

        async fn start_turn(
            &self,
            thread_id: &str,
            _text: &str,
            _model: &str,
            _effort: &str,
            _images: &[ProviderImage],
        ) -> Result<Option<String>, String> {
            Ok(Some(format!("{thread_id}-turn")))
        }

        async fn request_turn_stop(
            &self,
            _thread_id: &str,
            _turn_id: Option<&str>,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn respond_to_approval(
            &self,
            _pending: &PendingApproval,
            _input: &crate::protocol::ApprovalDecisionInput,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn respond_to_ask_user_question(
            &self,
            _request_id: &str,
            _answers: &serde_json::Map<String, serde_json::Value>,
        ) -> Result<(), String> {
            Ok(())
        }

        fn provider_name(&self) -> &'static str {
            self.name
        }
    }

    #[derive(Default)]
    struct ConsumedInitialPromptProvider {
        threads: Arc<Mutex<HashMap<String, ConsumedInitialThread>>>,
        next_id: AtomicU64,
        relay: Option<Arc<RwLock<RelayState>>>,
        complete_initial_before_return: bool,
    }

    impl ConsumedInitialPromptProvider {
        fn next_thread_id(&self) -> String {
            format!(
                "consumed-initial-thread-{}",
                self.next_id.fetch_add(1, Ordering::Relaxed)
            )
        }

        fn model() -> crate::protocol::ModelOptionView {
            crate::protocol::ModelOptionView {
                model: "consumed-initial-model".to_string(),
                display_name: "Consumed Initial Model".to_string(),
                provider: "consumed-initial".to_string(),
                supported_reasoning_efforts: vec![
                    "low".to_string(),
                    "medium".to_string(),
                    "high".to_string(),
                ],
                default_reasoning_effort: "medium".to_string(),
                hidden: false,
                is_default: true,
            }
        }

        fn thread_summary(thread_id: String, cwd: &str, preview: String) -> ThreadSummaryView {
            ThreadSummaryView {
                id: thread_id,
                name: Some("Consumed Initial Prompt Session".to_string()),
                preview,
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "consumed-initial".to_string(),
                status: "idle".to_string(),
                model_provider: "consumed-initial".to_string(),
                provider: "consumed-initial".to_string(),
                forked_from: None,
            }
        }
    }

    #[async_trait::async_trait]
    impl ProviderBridge for ConsumedInitialPromptProvider {
        async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
            let mut threads = self
                .threads
                .lock()
                .await
                .values()
                .map(|thread| thread.summary.clone())
                .collect::<Vec<_>>();
            threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
            threads.truncate(limit);
            Ok(threads)
        }

        async fn list_models(&self) -> Result<Vec<crate::protocol::ModelOptionView>, String> {
            Ok(vec![Self::model()])
        }

        async fn start_thread(
            &self,
            cwd: &str,
            _model: &str,
            _approval_policy: &str,
            _sandbox: &str,
            initial_prompt: Option<&str>,
        ) -> Result<crate::provider::StartThreadResult, String> {
            let thread_id = self.next_thread_id();
            let preview = initial_prompt.unwrap_or_default().to_string();
            let thread = Self::thread_summary(thread_id, cwd, preview.clone());
            let initial_user_message =
                initial_prompt.map(|prompt| crate::protocol::TranscriptEntryView {
                    item_id: Some("user:provider-initial".to_string()),
                    kind: crate::protocol::TranscriptEntryKind::UserText,
                    text: Some(prompt.to_string()),
                    status: "completed".to_string(),
                    turn_id: Some("turn:provider-initial".to_string()),
                    tool: None,
                    content_state: crate::protocol::TranscriptContentState::Full,
                });
            let mut transcript = Vec::new();
            if let Some(entry) = initial_user_message.clone() {
                transcript.push(entry);
                transcript.push(crate::protocol::TranscriptEntryView {
                    item_id: Some("assistant:provider-reply".to_string()),
                    kind: crate::protocol::TranscriptEntryKind::AgentText,
                    text: Some("provider reply".to_string()),
                    status: "completed".to_string(),
                    turn_id: Some("turn:provider-initial".to_string()),
                    tool: None,
                    content_state: crate::protocol::TranscriptContentState::Full,
                });
            }

            self.threads.lock().await.insert(
                thread.id.clone(),
                ConsumedInitialThread {
                    summary: thread.clone(),
                    transcript,
                },
            );

            if self.complete_initial_before_return {
                let relay = self
                    .relay
                    .as_ref()
                    .expect("completion harness requires relay access");
                let turn_id = initial_user_message
                    .as_ref()
                    .and_then(|entry| entry.turn_id.clone())
                    .expect("completion harness requires an initial turn");
                let now = unix_now();
                let mut relay = relay.write().await;
                relay.bg_set_active_turn(&thread.id, Some(turn_id.clone()), now);
                relay.bg_set_thread_status(&thread.id, "active".to_string(), Vec::new(), now);
                relay.bg_upsert_user_message(
                    &thread.id,
                    "user:provider-initial".to_string(),
                    initial_prompt.unwrap_or_default().to_string(),
                    turn_id.clone(),
                    now,
                );
                relay.bg_complete_agent_message(
                    &thread.id,
                    "assistant:provider-reply".to_string(),
                    "provider reply".to_string(),
                    turn_id,
                    now,
                );
                relay.bg_set_active_turn(&thread.id, None, now);
                relay.bg_set_thread_status(&thread.id, "idle".to_string(), Vec::new(), now);
            }

            Ok(crate::provider::StartThreadResult {
                thread,
                consumed_initial_prompt: initial_prompt.is_some(),
                started_turn_id: initial_user_message
                    .as_ref()
                    .and_then(|entry| entry.turn_id.clone()),
                initial_user_message,
            })
        }

        async fn resume_thread(
            &self,
            thread_id: &str,
            _approval_policy: &str,
            _sandbox: &str,
        ) -> Result<(), String> {
            if self.threads.lock().await.contains_key(thread_id) {
                Ok(())
            } else {
                Err(format!(
                    "consumed-initial thread '{thread_id}' was not found"
                ))
            }
        }

        async fn read_thread(
            &self,
            thread_id: &str,
        ) -> Result<crate::provider::ThreadSyncData, String> {
            let threads = self.threads.lock().await;
            let thread = threads
                .get(thread_id)
                .ok_or_else(|| format!("consumed-initial thread '{thread_id}' was not found"))?;
            Ok(crate::provider::ThreadSyncData {
                thread: thread.summary.clone(),
                status: thread.summary.status.clone(),
                active_flags: Vec::new(),
                transcript: thread.transcript.clone(),
            })
        }

        async fn read_thread_entry_detail(
            &self,
            thread_id: &str,
            item_id: &str,
        ) -> Result<Option<crate::protocol::TranscriptEntryView>, String> {
            Ok(self.threads.lock().await.get(thread_id).and_then(|thread| {
                thread
                    .transcript
                    .iter()
                    .find(|entry| entry.item_id.as_deref() == Some(item_id))
                    .cloned()
            }))
        }

        async fn archive_thread(&self, thread_id: &str) -> Result<(), String> {
            self.threads.lock().await.remove(thread_id);
            Ok(())
        }

        async fn delete_thread_permanently(
            &self,
            thread_id: &str,
        ) -> Result<crate::codex_local::LocalThreadDeleteSummary, String> {
            self.threads.lock().await.remove(thread_id);
            Ok(crate::codex_local::LocalThreadDeleteSummary {
                deleted_paths: Vec::new(),
                deleted_thread_row: true,
            })
        }

        async fn start_turn(
            &self,
            _thread_id: &str,
            _text: &str,
            _model: &str,
            _effort: &str,
            _images: &[ProviderImage],
        ) -> Result<Option<String>, String> {
            Err("consumed-initial provider does not support follow-up turns".to_string())
        }

        async fn request_turn_stop(
            &self,
            _thread_id: &str,
            _turn_id: Option<&str>,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn respond_to_approval(
            &self,
            _pending: &crate::state::PendingApproval,
            _input: &crate::protocol::ApprovalDecisionInput,
        ) -> Result<(), String> {
            Err("consumed-initial provider does not request approvals".to_string())
        }

        async fn respond_to_ask_user_question(
            &self,
            _request_id: &str,
            _answers: &serde_json::Map<String, serde_json::Value>,
        ) -> Result<(), String> {
            Err("consumed-initial provider does not surface AskUserQuestion".to_string())
        }

        fn provider_name(&self) -> &'static str {
            "consumed-initial"
        }
    }

    #[tokio::test]
    async fn start_session_rejects_cwd_outside_device_scope() {
        let project = TempDir::new().expect("project tempdir");
        let scoped = project.path().join("scoped");
        let other = project.path().join("other");
        std::fs::create_dir_all(&scoped).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        let (app, _p, _o) = build_app(scoped.to_str().unwrap()).await;
        pair_device(&app, "scoped-device", vec![scoped.display().to_string()]).await;

        let error = app
            .start_session(StartSessionInput {
                device_id: Some("scoped-device".to_string()),
                cwd: Some(other.display().to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect_err("start_session outside scope should fail");
        assert!(
            error.contains("device's allowed paths"),
            "expected device-scope rejection, got: {error}"
        );

        // Same call with cwd inside scope succeeds.
        app.start_session(StartSessionInput {
            device_id: Some("scoped-device".to_string()),
            cwd: Some(scoped.display().to_string()),
            model: None,
            effort: None,
            approval_policy: None,
            sandbox: None,
            provider: Some("fake".to_string()),
            initial_prompt: None,
        })
        .await
        .expect("start_session inside scope should succeed");
    }

    #[tokio::test]
    async fn start_session_allows_unscoped_device_anywhere_within_relay_roots() {
        let project = TempDir::new().expect("project tempdir");
        let any = project.path().join("any");
        std::fs::create_dir_all(&any).unwrap();

        let (app, _p, _o) = build_app(any.to_str().unwrap()).await;
        // No path_scope = inherit relay roots only.
        pair_device(&app, "wide-device", Vec::new()).await;

        app.start_session(StartSessionInput {
            device_id: Some("wide-device".to_string()),
            cwd: Some(any.display().to_string()),
            model: None,
            effort: None,
            approval_policy: None,
            sandbox: None,
            provider: Some("fake".to_string()),
            initial_prompt: None,
        })
        .await
        .expect("unscoped device should succeed within relay roots");
    }

    async fn wait_for_completed_agent_text(app: &AppState) {
        for _ in 0..200 {
            let snap = app.snapshot().await;
            if snap.transcript.iter().any(|entry| {
                entry.kind == crate::protocol::TranscriptEntryKind::AgentText
                    && entry.status == "completed"
            }) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("fake agent reply never landed in the active transcript");
    }

    // Waiting for "idle" alone is not enough right after `send_message`: the
    // turn may not have flipped the thread to working yet, so the idle check
    // passes on the PREVIOUS turn's settled state and the fork then races the
    // turn that is just starting. Wait for the new turn's reply to land first.
    async fn wait_for_completed_agent_texts(app: &AppState, count: usize) {
        for _ in 0..400 {
            let snap = app.snapshot().await;
            let completed = snap
                .transcript
                .iter()
                .filter(|entry| {
                    entry.kind == crate::protocol::TranscriptEntryKind::AgentText
                        && entry.status == "completed"
                })
                .count();
            if completed >= count {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("expected {count} completed agent replies");
    }

    // `wait_for_completed_agent_text` returns as soon as ANY completed agent
    // entry exists, so after a second turn it can return while that turn is
    // still running. Forking needs the thread actually settled.
    async fn wait_for_idle_active_thread(app: &AppState) {
        for _ in 0..200 {
            let snap = app.snapshot().await;
            if snap.active_turn_id.is_none()
                && !crate::state::relay::thread_status_is_working(&snap.current_status)
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("active thread never settled");
    }

    // The per-message fork button sends the item it is rendered on. Without
    // truncation the branch silently inherits everything that happened AFTER
    // the point the user picked.
    #[tokio::test]
    async fn fork_session_branches_at_the_requested_message() {
        use crate::protocol::TranscriptEntryKind;

        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let source = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: Some("fake-echo".to_string()),
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: Some("EARLY-MARKER first goal".to_string()),
            })
            .await
            .expect("start source");
        let source_thread_id = source.active_thread_id.clone().expect("source thread id");
        wait_for_completed_agent_text(&app).await;

        // The branch point: the last entry that exists before the second turn.
        let fork_point = app
            .snapshot()
            .await
            .transcript
            .iter()
            .filter(|entry| entry.kind == TranscriptEntryKind::AgentText)
            .last()
            .and_then(|entry| entry.item_id.clone())
            .expect("an agent entry to fork from");

        app.send_message(SendMessageInput {
            text: "LATE-MARKER second goal".to_string(),
            model: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            thread_id: source_thread_id.clone(),
        })
        .await
        .expect("second turn");
        wait_for_completed_agent_texts(&app, 2).await;
        wait_for_idle_active_thread(&app).await;

        let forked = app
            .fork_session(ForkSessionInput {
                source_thread_id: source_thread_id.clone(),
                up_to_item_id: Some(fork_point),
                cwd: Some(cwd.to_string()),
                initial_prompt: Some("continue on the fork".to_string()),
                model: Some("fake-echo".to_string()),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("fake".to_string()),
            })
            .await
            .expect("fork at message");
        assert_ne!(
            forked.active_thread_id.clone().expect("fork thread id"),
            source_thread_id
        );

        let mut user_text = String::new();
        for _ in 0..100 {
            let snap = app.snapshot().await;
            user_text = snap
                .transcript
                .iter()
                .find(|entry| entry.kind == TranscriptEntryKind::UserText)
                .and_then(|entry| entry.text.clone())
                .unwrap_or_default();
            if user_text.contains("EARLY-MARKER") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            user_text.contains("EARLY-MARKER"),
            "replay must carry context up to the fork point: {user_text}"
        );
        assert!(
            !user_text.contains("LATE-MARKER"),
            "replay must NOT carry anything after the fork point: {user_text}"
        );
    }

    // The relay resolves omitted approval/sandbox from the SOURCE thread. This
    // is what keeps a fork of a restricted thread from silently inheriting the
    // permissions of whatever session happens to be active.
    #[tokio::test]
    async fn fork_session_inherits_source_thread_settings_when_unspecified() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let source = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: Some("fake-echo".to_string()),
                effort: None,
                approval_policy: Some("untrusted".to_string()),
                sandbox: Some("read-only".to_string()),
                provider: Some("fake".to_string()),
                initial_prompt: Some("restricted work".to_string()),
            })
            .await
            .expect("start source");
        let source_thread_id = source.active_thread_id.clone().expect("source thread id");
        wait_for_completed_agent_text(&app).await;

        // Move the live projection to a permissive session, the way an open
        // full-access session would sit next to the restricted thread.
        app.start_session(StartSessionInput {
            device_id: Some("device-1".to_string()),
            cwd: Some(cwd.to_string()),
            model: Some("fake-echo".to_string()),
            effort: None,
            approval_policy: Some("on-request".to_string()),
            sandbox: Some("danger-full-access".to_string()),
            provider: Some("fake".to_string()),
            initial_prompt: None,
        })
        .await
        .expect("start permissive session");

        let forked = app
            .fork_session(ForkSessionInput {
                source_thread_id: source_thread_id.clone(),
                up_to_item_id: None,
                cwd: Some(cwd.to_string()),
                initial_prompt: Some("continue".to_string()),
                model: None,
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("fake".to_string()),
            })
            .await
            .expect("fork inherits");

        assert_eq!(
            forked.sandbox, "read-only",
            "fork must inherit the SOURCE thread's sandbox, not the live session's"
        );
        assert_eq!(
            forked.approval_policy, "untrusted",
            "fork must inherit the SOURCE thread's approval policy"
        );
    }

    // Lineage must be recorded on BOTH fork paths. Recording it only for
    // native forks means every cross-provider (replay) fork — the majority —
    // silently loses the link back to its source.
    #[tokio::test]
    async fn fork_session_records_lineage_on_the_replay_path() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let source = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: Some("fake-echo".to_string()),
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: Some("source work".to_string()),
            })
            .await
            .expect("start source");
        let source_thread_id = source.active_thread_id.clone().expect("source thread id");
        wait_for_completed_agent_text(&app).await;
        wait_for_idle_active_thread(&app).await;

        // The fake bridge has no native fork, so this exercises the replay path.
        let forked = app
            .fork_session(ForkSessionInput {
                source_thread_id: source_thread_id.clone(),
                up_to_item_id: None,
                cwd: Some(cwd.to_string()),
                initial_prompt: Some("continue".to_string()),
                model: Some("fake-echo".to_string()),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("fake".to_string()),
            })
            .await
            .expect("replay fork");
        let forked_thread_id = forked.active_thread_id.clone().expect("fork thread id");

        let threads = app
            .list_threads(20, Some("device-1".to_string()))
            .await
            .expect("list threads");
        let forked_row = threads
            .threads
            .iter()
            .find(|thread| thread.id == forked_thread_id)
            .expect("forked thread is listed");
        assert_eq!(
            forked_row.forked_from.as_deref(),
            Some(source_thread_id.as_str()),
            "a replay fork must record its source thread too"
        );
    }

    #[tokio::test]
    async fn fork_session_rejects_an_unknown_fork_point() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let source = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: Some("fake-echo".to_string()),
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: Some("some work".to_string()),
            })
            .await
            .expect("start source");
        let source_thread_id = source.active_thread_id.clone().expect("source thread id");
        wait_for_completed_agent_text(&app).await;

        let error = app
            .fork_session(ForkSessionInput {
                source_thread_id,
                up_to_item_id: Some("does-not-exist".to_string()),
                cwd: Some(cwd.to_string()),
                initial_prompt: None,
                model: None,
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("fake".to_string()),
            })
            .await
            .expect_err("unknown fork point must not silently fork the whole thread");
        assert!(error.contains("fork point"), "unexpected error: {error}");
    }

    #[tokio::test]
    async fn fork_session_replays_source_context_into_new_thread() {
        use crate::protocol::TranscriptEntryKind;

        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let source = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: Some("fake-echo".to_string()),
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: Some("source goal: build fork support".to_string()),
            })
            .await
            .expect("start source");
        let source_thread_id = source.active_thread_id.clone().expect("source thread id");
        wait_for_completed_agent_text(&app).await;

        let forked = app
            .fork_session(ForkSessionInput {
                source_thread_id: source_thread_id.clone(),
                cwd: Some(cwd.to_string()),
                initial_prompt: Some("continue on the fork".to_string()),
                model: Some("fake-echo".to_string()),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("fake".to_string()),
                up_to_item_id: None,
            })
            .await
            .expect("fork source");
        let forked_thread_id = forked.active_thread_id.clone().expect("fork thread id");
        assert_ne!(forked_thread_id, source_thread_id);
        let mut user_text = String::new();
        for _ in 0..100 {
            let snap = app.snapshot().await;
            user_text = snap
                .transcript
                .iter()
                .find(|entry| entry.kind == TranscriptEntryKind::UserText)
                .and_then(|entry| entry.text.clone())
                .unwrap_or_default();
            if user_text.contains("source goal: build fork support") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            user_text.contains("source goal: build fork support"),
            "fork replay prompt should include source context: {user_text}"
        );
        assert!(
            user_text.contains("continue on the fork"),
            "fork replay prompt should include the requested fork prompt: {user_text}"
        );
    }

    // Codex reports `notLoaded` for a saved thread that the app-server has not
    // opened — the MOST idle state there is. `thread_status_is_working` only
    // whitelisted idle/viewing/completed/unknown, so every saved Codex thread
    // read as busy and fork was refused with "a turn is in progress". Claude
    // reports `idle` and was unaffected, which is why this looked like a
    // Codex-only failure.
    #[test]
    fn a_not_loaded_thread_is_not_working() {
        use crate::state::relay::thread_status_is_working;
        assert!(!thread_status_is_working("notLoaded"));
        // Case is provider-formatting, not semantics.
        assert!(!thread_status_is_working("notloaded"));
        assert!(!thread_status_is_working("NotLoaded"));
        // The genuinely-working statuses must stay working.
        assert!(thread_status_is_working("active"));
        assert!(thread_status_is_working("running"));
    }

    // Capability seeding was once done only in the test constructor, so
    // production snapshots published an empty list and every client labelled
    // every fork as lossy replay. Both constructors now call one helper; this
    // pins the helper's output AND that it reaches the snapshot.
    #[tokio::test]
    async fn fork_capabilities_are_derived_from_the_bridges_and_reach_the_snapshot() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_two_provider_app(cwd).await;

        let snapshot = app.snapshot().await;
        let names = snapshot
            .provider_fork_capabilities
            .iter()
            .map(|entry| entry.provider.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec!["alpha", "beta"],
            "every configured provider must be described"
        );
        // StatusProviderBridge does not override fork_capability, so it takes
        // the trait default — which must agree with its replaying fork_thread.
        for entry in &snapshot.provider_fork_capabilities {
            assert!(
                !entry.native_fork,
                "a replaying bridge must not claim native"
            );
            assert!(!entry.native_fork_at_message);
        }
    }

    // "Inherit from source session" must mean the SOURCE thread's model and
    // effort. The shared resolve_provider_model prefers the catalog default
    // when the request omits a model, so the source fallback it is handed was
    // only ever reached with an empty catalog — a thread on a non-default model
    // silently forked onto the provider default instead.
    #[tokio::test]
    async fn fork_session_inherits_a_non_default_source_model_and_effort() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_status_app(cwd, "idle").await;
        pair_device(&app, "device-1", Vec::new()).await;

        let source = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                // NOT the catalog default.
                model: Some("statusy-fancy".to_string()),
                effort: Some("high".to_string()),
                approval_policy: None,
                sandbox: None,
                provider: Some("statusy".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start source");
        let source_thread_id = source.active_thread_id.clone().expect("source thread id");
        assert_eq!(source.model, "statusy-fancy", "source runs the fancy model");

        let forked = app
            .fork_session(ForkSessionInput {
                source_thread_id,
                up_to_item_id: None,
                cwd: Some(cwd.to_string()),
                initial_prompt: Some("continue".to_string()),
                // Omitted: the user chose "inherit from source".
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                device_id: Some("device-1".to_string()),
                provider: Some("statusy".to_string()),
            })
            .await
            .expect("fork");

        assert_eq!(
            forked.model, "statusy-fancy",
            "inherit must keep the source model, not fall back to the catalog default"
        );
        assert_eq!(
            forked.reasoning_effort, "high",
            "and the source effort, not the new model's default"
        );
    }

    // Inherited effort is conditional on the model surviving: choosing a
    // different model explicitly must take THAT model's default effort, not
    // carry over a level the source ran at (which the new model need not
    // support). Implemented, but nothing asserted it directly.
    #[tokio::test]
    async fn an_explicit_model_switch_does_not_inherit_the_source_effort() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_status_app(cwd, "idle").await;
        pair_device(&app, "device-1", Vec::new()).await;

        // Source runs the fancy model at "low". Crucially "low" IS supported by
        // the model we switch to — so clamping cannot mask a wrong answer, and
        // the assertion tests the inheritance CONDITION rather than the clamp.
        // (An unsupported level would be clamped either way, which is how the
        // first version of this test passed for the wrong reason.)
        let source = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: Some("statusy-fancy".to_string()),
                effort: Some("low".to_string()),
                approval_policy: None,
                sandbox: None,
                provider: Some("statusy".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start source");
        let source_thread_id = source.active_thread_id.clone().expect("source thread id");
        assert_eq!(source.reasoning_effort, "low");

        let forked = app
            .fork_session(ForkSessionInput {
                source_thread_id,
                up_to_item_id: None,
                cwd: Some(cwd.to_string()),
                initial_prompt: Some("continue".to_string()),
                // Explicitly switching models within the same provider.
                model: Some("statusy-default".to_string()),
                effort: None,
                approval_policy: None,
                sandbox: None,
                device_id: Some("device-1".to_string()),
                provider: Some("statusy".to_string()),
            })
            .await
            .expect("fork with an explicit model");

        assert_eq!(forked.model, "statusy-default");
        assert_eq!(
            forked.reasoning_effort, "medium",
            "the chosen model's default, not the source's still-valid 'low'"
        );
    }

    // The other half of the rule: inheritance must NOT cross providers. A
    // source model id is meaningless to a different bridge, and
    // resolve_provider_model passes an explicit model through unchecked — so
    // leaking it here would send e.g. a codex model id to Claude.
    #[tokio::test]
    async fn a_cross_provider_fork_does_not_inherit_the_source_model() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_two_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let source = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: Some("alpha-fancy".to_string()),
                effort: Some("high".to_string()),
                approval_policy: None,
                sandbox: None,
                provider: Some("alpha".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start source");
        let source_thread_id = source.active_thread_id.clone().expect("source thread id");

        let forked = app
            .fork_session(ForkSessionInput {
                source_thread_id,
                up_to_item_id: None,
                cwd: Some(cwd.to_string()),
                initial_prompt: Some("continue".to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                device_id: Some("device-1".to_string()),
                provider: Some("beta".to_string()),
            })
            .await
            .expect("cross-provider fork");

        assert!(
            !forked.model.starts_with("alpha-"),
            "an alpha model id must not reach beta: {}",
            forked.model
        );
        assert!(
            forked.model.starts_with("beta-"),
            "the target provider's own catalog answers: {}",
            forked.model
        );
    }

    #[tokio::test]
    async fn fork_session_accepts_a_saved_thread_reported_as_not_loaded() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_status_app(cwd, "notLoaded").await;
        pair_device(&app, "device-1", Vec::new()).await;

        let source = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("statusy".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start source");
        let source_thread_id = source.active_thread_id.clone().expect("source thread id");

        app.fork_session(ForkSessionInput {
            source_thread_id,
            up_to_item_id: None,
            cwd: Some(cwd.to_string()),
            initial_prompt: Some("continue".to_string()),
            model: None,
            approval_policy: None,
            sandbox: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            provider: Some("statusy".to_string()),
        })
        .await
        .expect("a saved (notLoaded) thread must be forkable");
    }

    // Symmetry: a turn running on one provider must not block forking a thread
    // that belongs to a DIFFERENT provider. Asserted in both directions so a
    // future guard that reaches across providers fails here.
    async fn assert_cross_provider_fork_is_unblocked(busy: &str, forked: &str) {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_two_provider_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        // The thread we will fork: created first, then left idle.
        let quiet = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some(forked.to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start quiet thread");
        let quiet_thread_id = quiet.active_thread_id.clone().expect("quiet thread id");

        // Now start a thread on the other provider and leave its turn running.
        app.start_session(StartSessionInput {
            device_id: Some("device-1".to_string()),
            cwd: Some(cwd.to_string()),
            model: None,
            effort: None,
            approval_policy: None,
            sandbox: None,
            provider: Some(busy.to_string()),
            initial_prompt: Some("keep this turn running briefly".to_string()),
        })
        .await
        .expect("start busy thread");

        app.fork_session(ForkSessionInput {
            source_thread_id: quiet_thread_id,
            up_to_item_id: None,
            cwd: Some(cwd.to_string()),
            initial_prompt: Some("continue".to_string()),
            model: None,
            approval_policy: None,
            sandbox: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            provider: Some(forked.to_string()),
        })
        .await
        .unwrap_or_else(|error| {
            panic!("a running {busy} turn must not block forking a {forked} thread: {error}")
        });
    }

    #[tokio::test]
    async fn a_running_alpha_turn_does_not_block_forking_a_beta_thread() {
        assert_cross_provider_fork_is_unblocked("alpha", "beta").await;
    }

    #[tokio::test]
    async fn a_running_beta_turn_does_not_block_forking_an_alpha_thread() {
        assert_cross_provider_fork_is_unblocked("beta", "alpha").await;
    }

    #[tokio::test]
    async fn fork_session_rejects_running_source_thread() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let source = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: Some("fake-echo".to_string()),
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: Some("keep this turn running briefly".to_string()),
            })
            .await
            .expect("start source");
        let source_thread_id = source.active_thread_id.clone().expect("source thread id");

        let error = app
            .fork_session(ForkSessionInput {
                source_thread_id,
                cwd: Some(cwd.to_string()),
                initial_prompt: None,
                model: Some("fake-echo".to_string()),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("fake".to_string()),
                up_to_item_id: None,
            })
            .await
            .expect_err("running source must not fork");
        assert!(
            error.contains("turn is in progress"),
            "unexpected fork rejection: {error}"
        );
    }

    #[tokio::test]
    async fn streaming_turn_does_not_bleed_into_thread_switched_to_mid_stream() {
        use crate::protocol::TranscriptEntryKind;

        let project = TempDir::new().expect("project tempdir");
        let a_dir = project.path().join("a");
        let b_dir = project.path().join("b");
        std::fs::create_dir_all(&a_dir).unwrap();
        std::fs::create_dir_all(&b_dir).unwrap();

        let (app, _p, _o) = build_app(project.path().to_str().unwrap()).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let snap_a = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(a_dir.display().to_string()),
                model: Some("fake-echo".to_string()),
                effort: None,
                approval_policy: Some("never".to_string()),
                sandbox: Some("workspace-write".to_string()),
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start A");
        let thread_a = snap_a.active_thread_id.clone().expect("thread A id");

        let snap_b = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(b_dir.display().to_string()),
                model: Some("fake-echo".to_string()),
                effort: None,
                approval_policy: Some("never".to_string()),
                sandbox: Some("workspace-write".to_string()),
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start B");
        let thread_b = snap_b.active_thread_id.clone().expect("thread B id");

        app.resume_session(ResumeSessionInput {
            thread_id: thread_a.clone(),
            approval_policy: None,
            sandbox: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            provider: Some("fake".to_string()),
        })
        .await
        .expect("resume A");

        let expected = (1..=20)
            .map(|index| format!("STREAM-A-LINE-{index:02}"))
            .collect::<Vec<_>>()
            .join("\n");
        app.send_message(SendMessageInput {
            text: format!(
                "Reply with exactly these 20 lines, one per line, and no extra text:\n{expected}"
            ),
            model: Some("fake-echo".to_string()),
            effort: None,
            device_id: Some("device-1".to_string()),
            thread_id: thread_a.clone(),
        })
        .await
        .expect("send streaming message to A");

        tokio::time::sleep(std::time::Duration::from_millis(40)).await;

        let snap_b_active = app
            .resume_session(ResumeSessionInput {
                thread_id: thread_b.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("fake".to_string()),
            })
            .await
            .expect("resume B mid-stream");
        assert_eq!(
            snap_b_active.active_thread_id.as_deref(),
            Some(thread_b.as_str())
        );

        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        let snap_b_after_stream = app.snapshot().await;
        assert_eq!(
            snap_b_after_stream.active_thread_id.as_deref(),
            Some(thread_b.as_str())
        );
        assert!(
            !snap_b_after_stream.transcript.iter().any(|entry| entry
                .text
                .as_deref()
                .unwrap_or("")
                .contains("STREAM-A-LINE")),
            "thread B should not contain thread A streaming output: {:?}",
            snap_b_after_stream.transcript
        );

        let snap_a_back = app
            .resume_session(ResumeSessionInput {
                thread_id: thread_a.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("fake".to_string()),
            })
            .await
            .expect("resume A after non-selected stream");
        assert!(
            snap_a_back.transcript.iter().any(|entry| {
                entry.kind == TranscriptEntryKind::AgentText
                    && entry
                        .text
                        .as_deref()
                        .unwrap_or("")
                        .contains("STREAM-A-LINE-20")
            }),
            "thread A should retain its completed non-selected stream: {:?}",
            snap_a_back.transcript
        );
    }

    // Reproduces the user-reported "agent message disappears after switching
    // threads and coming back" bug: start a session, switch to another, switch
    // back, and the agent reply must still be in the transcript.
    #[tokio::test]
    async fn switching_threads_and_back_keeps_the_agent_message() {
        use crate::protocol::{ResumeSessionInput, TranscriptEntryKind};

        let project = TempDir::new().expect("project tempdir");
        let a_dir = project.path().join("a");
        let b_dir = project.path().join("b");
        std::fs::create_dir_all(&a_dir).unwrap();
        std::fs::create_dir_all(&b_dir).unwrap();

        let (app, _p, _o) = build_app(project.path().to_str().unwrap()).await;
        pair_device(&app, "device-1", Vec::new()).await;

        // Start session A with an initial prompt; the fake provider echoes it
        // as a completed user + assistant turn.
        let snap_a = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(a_dir.display().to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: Some("Hellooo".to_string()),
            })
            .await
            .expect("start A");
        let thread_a = snap_a.active_thread_id.clone().expect("thread A id");
        wait_for_completed_agent_text(&app).await;

        // Two switch cycles — the user reported it vanishes "the second time".
        for round in 1..=2 {
            // Switch to a brand-new session B while A remains in its runtime.
            app.start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(b_dir.display().to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start B");

            // Switch back to A.
            let snap = app
                .resume_session(ResumeSessionInput {
                    thread_id: thread_a.clone(),
                    approval_policy: None,
                    sandbox: None,
                    effort: None,
                    device_id: Some("device-1".to_string()),
                    provider: Some("fake".to_string()),
                })
                .await
                .expect("resume A");

            assert_eq!(snap.active_thread_id.as_deref(), Some(thread_a.as_str()));
            let has_user = snap
                .transcript
                .iter()
                .any(|entry| entry.kind == TranscriptEntryKind::UserText);
            let has_agent = snap
                .transcript
                .iter()
                .any(|entry| entry.kind == TranscriptEntryKind::AgentText);
            assert!(
                has_user,
                "round {round}: user message should survive switch-back, got {:?}",
                snap.transcript
            );
            assert!(
                has_agent,
                "round {round}: agent message should survive switch-back, got {:?}",
                snap.transcript
            );
        }
    }

    #[tokio::test]
    async fn resume_session_remembers_settings_per_thread() {
        let project = TempDir::new().expect("project tempdir");
        let a_dir = project.path().join("a");
        let b_dir = project.path().join("b");
        std::fs::create_dir_all(&a_dir).unwrap();
        std::fs::create_dir_all(&b_dir).unwrap();

        let (app, _p, _o) = build_app(project.path().to_str().unwrap()).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let snap_a = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(a_dir.display().to_string()),
                model: None,
                effort: Some("high".to_string()),
                approval_policy: Some("untrusted".to_string()),
                sandbox: Some("workspace-write".to_string()),
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start A");
        let thread_a = snap_a.active_thread_id.clone().expect("thread A id");

        let snap_a_bypass = app
            .update_session_settings(UpdateSessionSettingsInput {
                approval_policy: Some("bypass".to_string()),
                sandbox: Some("danger-full-access".to_string()),
                effort: Some("medium".to_string()),
                model: Some("fake-pinned-a".to_string()),
                device_id: Some("device-1".to_string()),
                thread_id: thread_a.clone(),
            })
            .await
            .expect("update A settings");
        assert_eq!(snap_a_bypass.approval_policy, "bypass");
        assert_eq!(snap_a_bypass.sandbox, "danger-full-access");
        assert_eq!(snap_a_bypass.reasoning_effort, "medium");
        assert_eq!(snap_a_bypass.model, "fake-pinned-a");

        let snap_b = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(b_dir.display().to_string()),
                model: None,
                effort: Some("low".to_string()),
                approval_policy: Some("untrusted".to_string()),
                sandbox: Some("workspace-write".to_string()),
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start B");
        let thread_b = snap_b.active_thread_id.clone().expect("thread B id");
        assert_eq!(snap_b.approval_policy, "untrusted");
        assert_eq!(snap_b.sandbox, "workspace-write");
        assert_eq!(snap_b.reasoning_effort, "low");

        let snap_a_back = app
            .resume_session(ResumeSessionInput {
                thread_id: thread_a.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("fake".to_string()),
            })
            .await
            .expect("resume A");
        assert_eq!(
            snap_a_back.active_thread_id.as_deref(),
            Some(thread_a.as_str())
        );
        assert_eq!(snap_a_back.approval_policy, "bypass");
        assert_eq!(snap_a_back.sandbox, "danger-full-access");
        assert_eq!(snap_a_back.reasoning_effort, "medium");
        assert_eq!(snap_a_back.model, "fake-pinned-a");

        let snap_b_back = app
            .resume_session(ResumeSessionInput {
                thread_id: thread_b.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("fake".to_string()),
            })
            .await
            .expect("resume B");
        assert_eq!(
            snap_b_back.active_thread_id.as_deref(),
            Some(thread_b.as_str())
        );
        assert_eq!(snap_b_back.approval_policy, "untrusted");
        assert_eq!(snap_b_back.sandbox, "workspace-write");
        assert_eq!(snap_b_back.reasoning_effort, "low");
    }

    #[tokio::test]
    async fn start_session_preserves_chosen_effort() {
        // Regression for the "I start at high but the session runs medium" report.
        // The neighboring test passes effort=high at start but only asserts it
        // after an update — so a backend that dropped the start effort would slip
        // through. Pin the post-start value directly.
        let project = TempDir::new().expect("project tempdir");
        let (app, _p, _o) = build_app(project.path().to_str().unwrap()).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let snap = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(project.path().display().to_string()),
                model: None,
                effort: Some("high".to_string()),
                approval_policy: Some("untrusted".to_string()),
                sandbox: Some("workspace-write".to_string()),
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start");

        assert_eq!(
            snap.reasoning_effort, "high",
            "start_session must keep the effort the caller chose",
        );
    }

    // Settings harness: drive a realistic session lifecycle and assert the
    // shared settings invariants (matchable model, no blank controls) after
    // every step, plus that each setting is preserved/isolated as expected.
    // Any future setting added to the snapshot is covered by the invariant
    // checker for free; this scenario covers the interactions that have
    // historically broken settings (catalog reload, thread switch, restart).
    #[tokio::test]
    async fn settings_harness_invariants_hold_across_lifecycle() {
        use crate::state::assert_settings_invariants;

        let project = TempDir::new().expect("project tempdir");
        let a_dir = project.path().join("a");
        let b_dir = project.path().join("b");
        std::fs::create_dir_all(&a_dir).unwrap();
        std::fs::create_dir_all(&b_dir).unwrap();

        let (app, _p, _o) = build_app(project.path().to_str().unwrap()).await;
        pair_device(&app, "device-1", Vec::new()).await;
        let dev = || Some("device-1".to_string());

        // Start A with explicit, non-default settings.
        let snap = app
            .start_session(StartSessionInput {
                device_id: dev(),
                cwd: Some(a_dir.display().to_string()),
                model: None,
                effort: Some("high".to_string()),
                approval_policy: Some("untrusted".to_string()),
                sandbox: Some("workspace-write".to_string()),
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start A");
        assert_settings_invariants(&snap, "start A");
        let thread_a = snap.active_thread_id.clone().expect("thread A");
        assert_eq!(snap.reasoning_effort, "high");

        // Update every mutable setting on A.
        let snap = app
            .update_session_settings(UpdateSessionSettingsInput {
                approval_policy: Some("bypass".to_string()),
                sandbox: Some("danger-full-access".to_string()),
                effort: Some("low".to_string()),
                model: Some("fake-echo".to_string()),
                device_id: dev(),
                thread_id: thread_a.clone(),
            })
            .await
            .expect("update A");
        assert_settings_invariants(&snap, "update A");
        assert_eq!(snap.approval_policy, "bypass");
        assert_eq!(snap.sandbox, "danger-full-access");
        assert_eq!(snap.reasoning_effort, "low");

        // Start B with different settings; A's settings must not leak in.
        let snap = app
            .start_session(StartSessionInput {
                device_id: dev(),
                cwd: Some(b_dir.display().to_string()),
                model: None,
                effort: Some("high".to_string()),
                approval_policy: Some("untrusted".to_string()),
                sandbox: Some("workspace-write".to_string()),
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start B");
        assert_settings_invariants(&snap, "start B");
        let thread_b = snap.active_thread_id.clone().expect("thread B");
        assert_eq!(snap.reasoning_effort, "high");

        // Reloading the model catalog while B is active must not rewrite B's
        // settings (the set_available_models clobber class).
        {
            let mut relay = app.relay.write().await;
            let catalog = relay.available_models.clone();
            relay.set_available_models(catalog);
        }
        let snap = app.snapshot().await;
        assert_settings_invariants(&snap, "catalog reload on B");
        assert_eq!(snap.reasoning_effort, "high");
        assert_eq!(snap.approval_policy, "untrusted");

        // Switch back to A: A's settings are restored and isolated from B.
        let snap = app
            .resume_session(ResumeSessionInput {
                thread_id: thread_a.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: dev(),
                provider: Some("fake".to_string()),
            })
            .await
            .expect("resume A");
        assert_settings_invariants(&snap, "resume A");
        assert_eq!(snap.approval_policy, "bypass");
        assert_eq!(snap.sandbox, "danger-full-access");
        assert_eq!(snap.reasoning_effort, "low");

        // Restart: persist the live state and reload it into a fresh relay.
        // available_models is not persisted, so the reloaded snapshot has an
        // empty catalog — the invariants must still hold (no blank controls)
        // and A's settings must survive.
        let persisted = {
            let relay = app.relay.read().await;
            crate::state::persistence::PersistedRelayState::from_relay(&relay)
        };
        let (tx, _) = watch::channel(0_u64);
        let mut reloaded = RelayState::new(
            project.path().display().to_string(),
            tx,
            SecurityProfile::private(),
        );
        reloaded.apply_persisted(&persisted);
        let snap = reloaded.snapshot();
        assert_settings_invariants(&snap, "after restart");
        assert_eq!(snap.active_thread_id.as_deref(), Some(thread_a.as_str()));
        assert_eq!(snap.reasoning_effort, "low");
        assert_eq!(snap.approval_policy, "bypass");
        assert_eq!(snap.sandbox, "danger-full-access");

        // Sanity: B retained its own distinct settings throughout.
        let snap = app
            .resume_session(ResumeSessionInput {
                thread_id: thread_b.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: dev(),
                provider: Some("fake".to_string()),
            })
            .await
            .expect("resume B");
        assert_settings_invariants(&snap, "resume B");
        assert_eq!(snap.reasoning_effort, "high");
        assert_eq!(snap.approval_policy, "untrusted");
    }

    #[tokio::test]
    async fn consumed_initial_prompt_completion_before_start_returns_stays_idle() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();
        let (app, _p, _o) = build_completed_consumed_initial_prompt_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let snapshot = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("consumed-initial".to_string()),
                initial_prompt: Some("finish before start returns".to_string()),
            })
            .await
            .expect("start consumed initial prompt");

        assert_eq!(
            snapshot.active_turn_id, None,
            "start_session must not resurrect a provider-completed initial turn"
        );
        assert_eq!(snapshot.current_status, "idle");
        assert!(
            snapshot.thread_activity.is_empty(),
            "a completed initial turn must not leave a ghost activity badge"
        );
        assert!(
            snapshot.transcript.iter().any(|entry| {
                entry.item_id.as_deref() == Some("assistant:provider-reply")
                    && entry.text.as_deref() == Some("provider reply")
            }),
            "provider transcript events that beat activation must be preserved"
        );
    }

    #[tokio::test]
    async fn consumed_initial_prompt_keeps_provider_user_item_id_after_switchback() {
        use crate::protocol::TranscriptEntryKind;

        let project = TempDir::new().expect("project tempdir");
        let a_dir = project.path().join("a");
        let b_dir = project.path().join("b");
        std::fs::create_dir_all(&a_dir).unwrap();
        std::fs::create_dir_all(&b_dir).unwrap();

        let (app, _p, _o) =
            build_consumed_initial_prompt_app(project.path().to_str().unwrap()).await;
        pair_device(&app, "device-1", Vec::new()).await;

        let snap_a = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(a_dir.display().to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("consumed-initial".to_string()),
                initial_prompt: Some("Hellooo".to_string()),
            })
            .await
            .expect("start A");
        let thread_a = snap_a.active_thread_id.clone().expect("thread A id");
        assert_eq!(
            snap_a.active_turn_id.as_deref(),
            Some("turn:provider-initial"),
            "provider-consumed initial prompt should mark the started turn as active"
        );
        assert!(
            snap_a
                .thread_activity
                .iter()
                .any(|activity| activity.thread_id == thread_a),
            "provider-consumed initial prompt should surface as live activity"
        );
        let live_user_entries = snap_a
            .transcript
            .iter()
            .filter(|entry| entry.kind == TranscriptEntryKind::UserText)
            .collect::<Vec<_>>();
        assert_eq!(live_user_entries.len(), 1, "{:?}", snap_a.transcript);
        assert_eq!(
            live_user_entries[0].item_id.as_deref(),
            Some("user:provider-initial")
        );
        assert_eq!(live_user_entries[0].text.as_deref(), Some("Hellooo"));

        let snap_b = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(b_dir.display().to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("consumed-initial".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("start B");
        assert!(
            snap_b
                .thread_activity
                .iter()
                .any(|activity| activity.thread_id == thread_a),
            "switching away must keep provider-consumed initial turn in background activity"
        );

        let snap_back = app
            .resume_session(ResumeSessionInput {
                thread_id: thread_a.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("consumed-initial".to_string()),
            })
            .await
            .expect("resume A");

        assert_eq!(
            snap_back.active_thread_id.as_deref(),
            Some(thread_a.as_str())
        );
        let user_entries = snap_back
            .transcript
            .iter()
            .filter(|entry| entry.kind == TranscriptEntryKind::UserText)
            .collect::<Vec<_>>();
        assert_eq!(
            user_entries.len(),
            1,
            "switch-back should merge the live initial prompt with provider history: {:?}",
            snap_back.transcript
        );
        assert_eq!(
            user_entries[0].item_id.as_deref(),
            Some("user:provider-initial")
        );
        assert_eq!(user_entries[0].text.as_deref(), Some("Hellooo"));
        assert!(
            snap_back.transcript.iter().any(|entry| {
                entry.kind == TranscriptEntryKind::AgentText
                    && entry.item_id.as_deref() == Some("assistant:provider-reply")
                    && entry.text.as_deref() == Some("provider reply")
            }),
            "provider history should still load on switch-back: {:?}",
            snap_back.transcript
        );
    }

    #[tokio::test]
    async fn send_message_rejects_when_active_thread_cwd_outside_device_scope() {
        let project = TempDir::new().expect("project tempdir");
        let scoped = project.path().join("scoped");
        let other = project.path().join("other");
        std::fs::create_dir_all(&scoped).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        // Relay starts at `other` — outside the scoped device's path.
        let (app, _p, _o) = build_app(other.to_str().unwrap()).await;
        pair_device(&app, "scoped-device", vec![scoped.display().to_string()]).await;

        // Manually plant an active thread at `other` so send_message has something to target.
        // Use an unscoped device to start the session first (so we don't trip the scope at start).
        pair_device(&app, "wide-device", Vec::new()).await;
        let started = app
            .start_session(StartSessionInput {
                device_id: Some("wide-device".to_string()),
                cwd: Some(other.display().to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("wide device should start session");
        let target_thread = started.active_thread_id.expect("started thread id");

        let error = app
            .send_message(SendMessageInput {
                device_id: Some("scoped-device".to_string()),
                thread_id: target_thread,
                text: "hello".to_string(),
                model: None,
                effort: None,
            })
            .await
            .expect_err("scoped device should be rejected when active cwd is outside its scope");
        assert!(
            error.contains("device's allowed paths"),
            "expected device-scope rejection, got: {error}"
        );
    }

    #[tokio::test]
    async fn read_thread_transcript_rejects_when_device_id_scopes_out_thread_cwd() {
        let project = TempDir::new().expect("project tempdir");
        let scoped = project.path().join("scoped");
        let other = project.path().join("other");
        std::fs::create_dir_all(&scoped).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        let (app, _p, _o) = build_app(other.to_str().unwrap()).await;
        pair_device(&app, "wide-device", Vec::new()).await;
        pair_device(&app, "scoped-device", vec![scoped.display().to_string()]).await;

        let snapshot = app
            .start_session(StartSessionInput {
                device_id: Some("wide-device".to_string()),
                cwd: Some(other.display().to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("wide device should start session");
        let thread_id = snapshot.active_thread_id.expect("active thread");

        // Wide device reads transcript: succeeds.
        app.read_thread_transcript(ReadThreadTranscriptInput {
            thread_id: thread_id.clone(),
            cursor: None,
            before: None,
            device_id: Some("wide-device".to_string()),
        })
        .await
        .expect("wide device should read transcript");

        // Scoped device reads same transcript whose cwd is outside its scope: rejected.
        let error = app
            .read_thread_transcript(ReadThreadTranscriptInput {
                thread_id,
                cursor: None,
                before: None,
                device_id: Some("scoped-device".to_string()),
            })
            .await
            .expect_err("scoped device should be rejected reading out-of-scope transcript");
        assert!(
            error.contains("device's allowed paths"),
            "expected device-scope rejection, got: {error}"
        );
    }

    #[tokio::test]
    async fn resume_session_rejects_when_thread_cwd_outside_device_scope() {
        let project = TempDir::new().expect("project tempdir");
        let scoped = project.path().join("scoped");
        let other = project.path().join("other");
        std::fs::create_dir_all(&scoped).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        let (app, _p, _o) = build_app(other.to_str().unwrap()).await;
        pair_device(&app, "wide-device", Vec::new()).await;
        pair_device(&app, "scoped-device", vec![scoped.display().to_string()]).await;

        let snapshot = app
            .start_session(StartSessionInput {
                device_id: Some("wide-device".to_string()),
                cwd: Some(other.display().to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("fake".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("wide device should start session");
        let thread_id = snapshot.active_thread_id.expect("active thread");

        let error = app
            .resume_session(ResumeSessionInput {
                device_id: Some("scoped-device".to_string()),
                thread_id,
                approval_policy: None,
                sandbox: None,
                effort: None,
                provider: Some("fake".to_string()),
            })
            .await
            .expect_err("scoped device should not resume out-of-scope thread");
        assert!(
            error.contains("device's allowed paths"),
            "expected device-scope rejection, got: {error}"
        );
    }

    // ---- Regression: codex normalizes the "default" model alias ------------
    //
    // Mirrors the real codex `app-server`, which only accepts concrete model
    // ids (e.g. "gpt-5.5") and rejects the non-concrete string "default" with a
    // "model not supported, pick a specific model" error. Claude's worker, by
    // contrast, resolves "default" to a concrete model, so the same value works
    // there. `accepts_default` captures exactly that provider difference.
    #[derive(Clone)]
    struct ModelStrictProvider {
        name: &'static str,
        accepts_default: bool,
        threads: Arc<Mutex<HashMap<String, ThreadSummaryView>>>,
        seen_models: Arc<Mutex<Vec<String>>>,
    }

    impl ModelStrictProvider {
        fn new(name: &'static str, accepts_default: bool) -> Self {
            Self {
                name,
                accepts_default,
                threads: Arc::new(Mutex::new(HashMap::new())),
                seen_models: Arc::new(Mutex::new(Vec::new())),
            }
        }

        async fn models_seen(&self) -> Vec<String> {
            self.seen_models.lock().await.clone()
        }

        fn reject(&self, model: &str) -> Option<String> {
            if !self.accepts_default && model == "default" {
                Some(
                    "model `default` is not supported, please select a specific model (e.g. 5.5)"
                        .to_string(),
                )
            } else {
                None
            }
        }
    }

    #[async_trait::async_trait]
    impl ProviderBridge for ModelStrictProvider {
        async fn list_threads(&self, _limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
            Ok(Vec::new())
        }

        // Simulate a transient catalog miss so the relay falls back to the
        // session default model (the inherited "default" alias) instead of a
        // concrete catalog id.
        async fn list_models(&self) -> Result<Vec<crate::protocol::ModelOptionView>, String> {
            Err("model catalog temporarily unavailable".to_string())
        }

        async fn start_thread(
            &self,
            cwd: &str,
            model: &str,
            _approval_policy: &str,
            _sandbox: &str,
            _initial_prompt: Option<&str>,
        ) -> Result<crate::provider::StartThreadResult, String> {
            self.seen_models.lock().await.push(model.to_string());
            if let Some(err) = self.reject(model) {
                return Err(err);
            }
            let id = format!("{}-thread-1", self.name);
            let thread = ThreadSummaryView {
                id: id.clone(),
                name: Some(format!("{} thread", self.name)),
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: self.name.to_string(),
                status: "idle".to_string(),
                model_provider: self.name.to_string(),
                provider: self.name.to_string(),
                forked_from: None,
            };
            self.threads.lock().await.insert(id, thread.clone());
            Ok(crate::provider::StartThreadResult {
                thread,
                consumed_initial_prompt: false,
                initial_user_message: None,
                started_turn_id: None,
            })
        }

        async fn resume_thread(&self, _t: &str, _a: &str, _s: &str) -> Result<(), String> {
            Ok(())
        }

        async fn read_thread(
            &self,
            thread_id: &str,
        ) -> Result<crate::provider::ThreadSyncData, String> {
            let thread = self
                .threads
                .lock()
                .await
                .get(thread_id)
                .cloned()
                .ok_or_else(|| format!("thread '{thread_id}' not found"))?;
            Ok(crate::provider::ThreadSyncData {
                thread,
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            })
        }

        async fn read_thread_entry_detail(
            &self,
            _t: &str,
            _i: &str,
        ) -> Result<Option<crate::protocol::TranscriptEntryView>, String> {
            Ok(None)
        }

        async fn archive_thread(&self, _thread_id: &str) -> Result<(), String> {
            Ok(())
        }

        async fn delete_thread_permanently(
            &self,
            _thread_id: &str,
        ) -> Result<crate::codex_local::LocalThreadDeleteSummary, String> {
            Ok(crate::codex_local::LocalThreadDeleteSummary {
                deleted_paths: Vec::new(),
                deleted_thread_row: true,
            })
        }

        async fn start_turn(
            &self,
            _t: &str,
            _text: &str,
            model: &str,
            _e: &str,
            _images: &[ProviderImage],
        ) -> Result<Option<String>, String> {
            self.seen_models.lock().await.push(model.to_string());
            if let Some(err) = self.reject(model) {
                return Err(err);
            }
            Ok(Some("turn:1".to_string()))
        }

        async fn request_turn_stop(&self, _t: &str, _turn: Option<&str>) -> Result<(), String> {
            Ok(())
        }

        async fn respond_to_approval(
            &self,
            _p: &PendingApproval,
            _i: &ApprovalDecisionInput,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn respond_to_ask_user_question(
            &self,
            _r: &str,
            _a: &serde_json::Map<String, serde_json::Value>,
        ) -> Result<(), String> {
            Ok(())
        }

        fn provider_name(&self) -> &'static str {
            self.name
        }
    }

    // Regression for: "codex default model is rejected (model not supported,
    // pick 5.5), but default works fine on claude." When the session's current
    // model is the stable "default" alias (set/persisted while on Claude) and
    // the codex catalog isn't available to reconcile it, the relay must not
    // forward "default" verbatim to codex.
    #[tokio::test]
    async fn codex_normalizes_default_model_inherited_from_claude() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_str().unwrap();

        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        let codex_provider = Arc::new(ModelStrictProvider::new("codex", false));
        let claude_provider = Arc::new(ModelStrictProvider::new("claude_code", true));
        providers.insert("codex".to_string(), codex_provider.clone());
        providers.insert("claude_code".to_string(), claude_provider.clone());
        let app = AppState::from_parts(relay.clone(), providers, change_tx);
        pair_device(&app, "device-1", Vec::new()).await;

        // A prior Claude session left the stable "default" alias as the current
        // (and persisted) model.
        relay.write().await.model = "default".to_string();

        // User starts a codex session WITHOUT picking a model. The codex
        // catalog momentarily fails to load, so the inherited "default" is
        // normalized before reaching codex.
        let snap = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("codex".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("codex inherited default alias should normalize to a concrete model");
        let codex_thread_id = snap.active_thread_id.clone().expect("codex thread id");
        assert_eq!(snap.model, DEFAULT_MODEL);
        assert_eq!(codex_provider.models_seen().await, vec![DEFAULT_MODEL]);

        // Settings updates should also never persist the cross-provider alias
        // onto a codex thread when codex cannot load its catalog.
        relay.write().await.model = "default".to_string();
        let snap = app
            .update_session_settings(UpdateSessionSettingsInput {
                approval_policy: None,
                sandbox: None,
                effort: None,
                model: None,
                device_id: Some("device-1".to_string()),
                thread_id: codex_thread_id.clone(),
            })
            .await
            .expect("codex settings update should normalize the inherited default alias");
        assert_eq!(snap.model, DEFAULT_MODEL);

        // The same guard is needed for subsequent turns, because send_message
        // also resolves its model from the relay's current default when the
        // caller does not pick one explicitly.
        relay.write().await.model = "default".to_string();
        app.send_message(SendMessageInput {
            text: "hello".to_string(),
            model: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            thread_id: codex_thread_id,
        })
        .await
        .expect("codex send_message should normalize the inherited default alias");
        assert_eq!(
            codex_provider.models_seen().await,
            vec![DEFAULT_MODEL, DEFAULT_MODEL]
        );

        // Identical conditions, but claude resolves "default" → it starts fine.
        relay.write().await.model = "default".to_string();
        app.start_session(StartSessionInput {
            device_id: Some("device-1".to_string()),
            cwd: Some(cwd.to_string()),
            model: None,
            effort: None,
            approval_policy: None,
            sandbox: None,
            provider: Some("claude_code".to_string()),
            initial_prompt: None,
        })
        .await
        .expect("claude resolves \"default\" and should start successfully");
        assert_eq!(claude_provider.models_seen().await, vec!["default"]);
    }
}

#[cfg(test)]
mod review_tests {
    use super::super::*;
    use crate::protocol::{
        ModelOptionView, RequestReviewInput, SendMessageInput, StartSessionInput,
        StartWorkflowInput, StopTurnInput, TakeOverInput, ThreadSummaryView, TranscriptEntryKind,
        TranscriptEntryView, UpdateSessionSettingsInput, WorkflowActionInput,
    };
    use crate::state::security::SecurityProfile;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::{watch, Mutex, RwLock};
    use tokio::time::{sleep, Duration};

    const REVIEW_REPLY: &str = "AGENT_REVIEW_REPLY";

    /// A provider that records the prompts/cwds it is asked to run and (unless
    /// `complete_turns` is cleared) completes each turn by writing a fixed
    /// assistant reply back into relay state — enough to drive the orchestrator
    /// end to end and assert what it sent to whom.
    #[derive(Clone)]
    struct ReviewTestProvider {
        name: &'static str,
        state: Arc<RwLock<RelayState>>,
        threads: Arc<Mutex<HashMap<String, ThreadSummaryView>>>,
        transcripts: Arc<Mutex<HashMap<String, Vec<TranscriptEntryView>>>>,
        start_thread_cwds: Arc<Mutex<Vec<(String, String)>>>,
        // (thread_id, approval_policy, sandbox) recorded at start_thread.
        start_thread_settings: Arc<Mutex<Vec<(String, String, String)>>>,
        turns: Arc<Mutex<Vec<(String, String)>>>,
        complete_turns: Arc<AtomicBool>,
        // When false, turns still complete (clearing the active turn) but emit no
        // assistant message — exercising the "no recap text" path.
        emit_assistant: Arc<AtomicBool>,
        // When true, a turn parks on a pending approval instead of replying —
        // exercising the reviewer-approval auto-deny path.
        raise_approval: Arc<AtomicBool>,
        // When true, `respond_to_approval` errors (provider rejects the denial).
        deny_fails: Arc<AtomicBool>,
        // When true, `request_turn_stop` errors.
        interrupt_fails: Arc<AtomicBool>,
        interrupts: Arc<Mutex<Vec<String>>>,
        // When set, the first completing turn also injects a pending approval for
        // an unrelated background thread — it must NOT fail the review.
        inject_unrelated_approval: Arc<AtomicBool>,
        // When true, a turn parks on an AskUserQuestion instead of replying.
        raise_ask_user: Arc<AtomicBool>,
        // When true, only a reviewer turn parks on an AskUserQuestion.
        ask_user_on_reviewer_turn: Arc<AtomicBool>,
        // When true, only the *reviewer* turn parks on an approval (recap completes
        // normally) — exercises the reviewer-handoff cleanup path.
        approval_on_reviewer_turn: Arc<AtomicBool>,
        // Simulate losing/rejecting the reviewer turn-start response after the
        // reviewer thread became active.
        fail_reviewer_start: Arc<AtomicBool>,
        // Simulate the workflow task panicking after an author turn has started.
        panic_after_author_start: Arc<AtomicBool>,
        // When true, `archive_thread` errors — exercises the delete path where
        // the reviewer thread can't be archived but the job is still dropped.
        fail_archive: Arc<AtomicBool>,
        // When true, `delete_thread_permanently` also errors — forces the tombstone
        // path when both archive and delete fail.
        fail_delete: Arc<AtomicBool>,
        // Thread ids whose `delete_thread_permanently` should error, while every
        // other thread deletes fine. Lets a test fail ONLY a reviewer delete while
        // the parent delete still succeeds (the F1 un-hide-on-failure path).
        fail_delete_thread_ids: Arc<Mutex<std::collections::HashSet<String>>>,
        // (thread_id, model, effort) recorded at each start_turn, so a test can
        // assert the model/effort a reviewer turn actually ran with (reuse must keep
        // the reviewer's own model, not the parent's).
        turn_models: Arc<Mutex<Vec<(String, String, String)>>>,
        // When true, a REVIEWER turn (its prompt carries the relay's workspace diff)
        // completes WITHOUT emitting an assistant reply — exercising the read-back
        // guard that must refuse to reuse a thread's PRIOR review as this turn's
        // result. Recap/other turns still reply normally.
        suppress_reviewer_reply: Arc<AtomicBool>,
        // Verdicts the reviewer should emit, one popped per reviewer turn (FIFO).
        // Empty → default NEEDS_CHANGES. Drives the iterative loop in tests.
        reviewer_verdicts: Arc<Mutex<std::collections::VecDeque<String>>>,
        // When true, a parent FIX turn (driven between rounds) parks on an approval —
        // exercising the "author's fix needs the user → escalate" path.
        raise_approval_on_fix_turn: Arc<AtomicBool>,
        // When true, a parent FIX turn COMPLETES normally but emits NO assistant
        // message — modeling a Claude author that addresses findings via tool edits
        // without a trailing text block (its worker only emits `assistant_message`
        // when a turn has a text block). The review loop must still advance to the
        // next round instead of mistaking the text-less fix for a no-op author.
        suppress_fix_reply: Arc<AtomicBool>,
        // When set (marker line), a parent FIX turn appends that marker to the
        // tracked `seed.txt` in the thread's cwd — modeling an author that edits
        // code. Lets a test assert the NEXT round re-reviews the REFRESHED workspace
        // diff (the marker surfaces in the reviewer's re-review prompt).
        mutate_cwd_on_fix_turn: Arc<Mutex<Option<String>>>,
        // Threads "evicted" by a simulated provider/app-server restart: a turn can't
        // start on one until it is re-loaded via `resume_thread`. Models Codex, where
        // approvalPolicy/sandbox attach on thread/resume, not turn/start.
        unloaded_threads: Arc<Mutex<std::collections::HashSet<String>>>,
        // (thread_id, approval_policy, sandbox) recorded at each resume_thread, so a
        // test can assert a reused reviewer is resumed with its read-only sandbox.
        resumes: Arc<Mutex<Vec<(String, String, String)>>>,
        // Delay before a turn completes (ms). Lets tests complete a turn *after* a
        // short step timeout, exercising the drain path.
        complete_delay_ms: Arc<AtomicU64>,
        // When true, models a provider (like Claude) whose read_thread reports a
        // resume-safe last-activity time → resume max-folds it. Default false
        // models a provider whose updated_at is a bumpable mtime (like Codex) →
        // resume freezes (or-insert) to avoid click-to-top creep.
        report_activity_time: Arc<AtomicBool>,
        next_id: Arc<AtomicU64>,
    }

    impl ReviewTestProvider {
        fn new(name: &'static str, state: Arc<RwLock<RelayState>>) -> Self {
            Self {
                name,
                state,
                threads: Arc::new(Mutex::new(HashMap::new())),
                transcripts: Arc::new(Mutex::new(HashMap::new())),
                start_thread_cwds: Arc::new(Mutex::new(Vec::new())),
                start_thread_settings: Arc::new(Mutex::new(Vec::new())),
                turns: Arc::new(Mutex::new(Vec::new())),
                complete_turns: Arc::new(AtomicBool::new(true)),
                emit_assistant: Arc::new(AtomicBool::new(true)),
                raise_approval: Arc::new(AtomicBool::new(false)),
                deny_fails: Arc::new(AtomicBool::new(false)),
                interrupt_fails: Arc::new(AtomicBool::new(false)),
                interrupts: Arc::new(Mutex::new(Vec::new())),
                inject_unrelated_approval: Arc::new(AtomicBool::new(false)),
                raise_ask_user: Arc::new(AtomicBool::new(false)),
                ask_user_on_reviewer_turn: Arc::new(AtomicBool::new(false)),
                approval_on_reviewer_turn: Arc::new(AtomicBool::new(false)),
                fail_reviewer_start: Arc::new(AtomicBool::new(false)),
                panic_after_author_start: Arc::new(AtomicBool::new(false)),
                fail_archive: Arc::new(AtomicBool::new(false)),
                fail_delete: Arc::new(AtomicBool::new(false)),
                fail_delete_thread_ids: Arc::new(Mutex::new(std::collections::HashSet::new())),
                turn_models: Arc::new(Mutex::new(Vec::new())),
                suppress_reviewer_reply: Arc::new(AtomicBool::new(false)),
                reviewer_verdicts: Arc::new(Mutex::new(std::collections::VecDeque::new())),
                raise_approval_on_fix_turn: Arc::new(AtomicBool::new(false)),
                suppress_fix_reply: Arc::new(AtomicBool::new(false)),
                mutate_cwd_on_fix_turn: Arc::new(Mutex::new(None)),
                unloaded_threads: Arc::new(Mutex::new(std::collections::HashSet::new())),
                resumes: Arc::new(Mutex::new(Vec::new())),
                complete_delay_ms: Arc::new(AtomicU64::new(15)),
                report_activity_time: Arc::new(AtomicBool::new(false)),
                next_id: Arc::new(AtomicU64::new(1)),
            }
        }

        fn next_token(&self, prefix: &str) -> String {
            format!(
                "{}-{prefix}-{}",
                self.name,
                self.next_id.fetch_add(1, Ordering::Relaxed)
            )
        }

        fn summary(&self, id: &str, cwd: &str) -> ThreadSummaryView {
            ThreadSummaryView {
                id: id.to_string(),
                name: Some(format!("{} thread", self.name)),
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: self.name.to_string(),
                status: "idle".to_string(),
                model_provider: self.name.to_string(),
                provider: self.name.to_string(),
                forked_from: None,
            }
        }
    }

    #[async_trait::async_trait]
    impl ProviderBridge for ReviewTestProvider {
        async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
            let mut threads = self
                .threads
                .lock()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
            threads.truncate(limit);
            Ok(threads)
        }

        async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
            Ok(vec![ModelOptionView {
                model: format!("{}-model", self.name),
                display_name: format!("{} Model", self.name),
                provider: self.name.to_string(),
                supported_reasoning_efforts: vec!["medium".to_string()],
                default_reasoning_effort: "medium".to_string(),
                hidden: false,
                is_default: true,
            }])
        }

        async fn start_thread(
            &self,
            cwd: &str,
            _model: &str,
            approval_policy: &str,
            sandbox: &str,
            _initial_prompt: Option<&str>,
        ) -> Result<crate::provider::StartThreadResult, String> {
            let id = self.next_token("thread");
            let thread = self.summary(&id, cwd);
            self.threads.lock().await.insert(id.clone(), thread.clone());
            self.start_thread_cwds
                .lock()
                .await
                .push((id.clone(), cwd.to_string()));
            self.start_thread_settings.lock().await.push((
                id,
                approval_policy.to_string(),
                sandbox.to_string(),
            ));
            Ok(crate::provider::StartThreadResult {
                thread,
                consumed_initial_prompt: false,
                initial_user_message: None,
                started_turn_id: None,
            })
        }

        async fn resume_thread(
            &self,
            thread_id: &str,
            approval_policy: &str,
            sandbox: &str,
        ) -> Result<(), String> {
            if !self.threads.lock().await.contains_key(thread_id) {
                return Err(format!("{} thread '{thread_id}' was not found", self.name));
            }
            // Record the resume settings and re-load the thread into the (simulated)
            // app-server so a turn can start on it.
            self.resumes.lock().await.push((
                thread_id.to_string(),
                approval_policy.to_string(),
                sandbox.to_string(),
            ));
            self.unloaded_threads.lock().await.remove(thread_id);
            Ok(())
        }

        async fn read_thread(
            &self,
            thread_id: &str,
        ) -> Result<crate::provider::ThreadSyncData, String> {
            let thread = self
                .threads
                .lock()
                .await
                .get(thread_id)
                .cloned()
                .ok_or_else(|| format!("{} thread '{thread_id}' was not found", self.name))?;
            let transcript = self
                .transcripts
                .lock()
                .await
                .get(thread_id)
                .cloned()
                .unwrap_or_default();
            Ok(crate::provider::ThreadSyncData {
                thread,
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript,
            })
        }

        async fn read_thread_entry_detail(
            &self,
            _thread_id: &str,
            _item_id: &str,
        ) -> Result<Option<TranscriptEntryView>, String> {
            Ok(None)
        }

        async fn archive_thread(&self, thread_id: &str) -> Result<(), String> {
            if self.fail_archive.load(Ordering::Relaxed) {
                return Err("archive failed (simulated)".to_string());
            }
            self.threads.lock().await.remove(thread_id);
            Ok(())
        }

        async fn delete_thread_permanently(
            &self,
            thread_id: &str,
        ) -> Result<crate::codex_local::LocalThreadDeleteSummary, String> {
            if self.fail_delete.load(Ordering::Relaxed)
                || self.fail_delete_thread_ids.lock().await.contains(thread_id)
            {
                return Err("delete failed (simulated)".to_string());
            }
            self.threads.lock().await.remove(thread_id);
            Ok(crate::codex_local::LocalThreadDeleteSummary {
                deleted_paths: Vec::new(),
                deleted_thread_row: true,
            })
        }

        async fn start_turn(
            &self,
            thread_id: &str,
            text: &str,
            model: &str,
            effort: &str,
            _images: &[ProviderImage],
        ) -> Result<Option<String>, String> {
            // A thread evicted by a simulated restart can't run a turn until it has
            // been re-loaded via resume_thread (mirrors Codex needing thread/resume).
            if self.unloaded_threads.lock().await.contains(thread_id) {
                return Err(format!(
                    "{} thread '{thread_id}' is not loaded; resume it first",
                    self.name
                ));
            }
            self.turns
                .lock()
                .await
                .push((thread_id.to_string(), text.to_string()));
            self.turn_models.lock().await.push((
                thread_id.to_string(),
                model.to_string(),
                effort.to_string(),
            ));
            // A reviewer/re-review turn always carries the relay-collected workspace
            // diff; recap/other turns do not.
            let is_reviewer_diff_turn = text.contains("Workspace diff collected by the relay");
            let is_reviewer_turn = text.contains("You are reviewing another agent's work");
            // The parent fix turn (driven between rounds) carries this marker.
            let is_fix_turn = text.contains("Address the findings below");
            if is_reviewer_turn && self.fail_reviewer_start.load(Ordering::Relaxed) {
                // Model a response-loss race: the provider has started work and
                // published liveness, but the start request itself returns an
                // error to the orchestrator.
                let mut relay = self.state.write().await;
                relay.set_thread_status(thread_id, "active".to_string(), Vec::new());
                relay.notify();
                return Err("reviewer turn start response was lost".to_string());
            }
            let turn_id = self.next_token("turn");
            if !is_reviewer_turn && self.panic_after_author_start.swap(false, Ordering::Relaxed) {
                let mut relay = self.state.write().await;
                if relay.active_thread_id.as_deref() == Some(thread_id) {
                    relay.set_active_turn(Some(turn_id.clone()));
                    relay.set_thread_status(thread_id, "active".to_string(), Vec::new());
                } else {
                    let now = unix_now();
                    relay.bg_set_active_turn(thread_id, Some(turn_id.clone()), now);
                    relay.bg_set_thread_status(thread_id, "active".to_string(), Vec::new(), now);
                }
                relay.notify();
                panic!("simulated workflow author panic after turn start");
            }
            if !self.complete_turns.load(Ordering::Relaxed) {
                return Ok(Some(turn_id));
            }

            let state = self.state.clone();
            let transcripts = self.transcripts.clone();
            let thread_id = thread_id.to_string();
            let user_text = text.to_string();
            let turn = turn_id.clone();
            let user_item = self.next_token("user");
            let assistant_item = self.next_token("assistant");
            // Model an author that EDITS code on its fix turn: append the configured
            // marker to the tracked `seed.txt` in this thread's cwd, so the NEXT
            // round's freshly-collected workspace diff reflects the change.
            if is_fix_turn {
                if let Some(marker) = self.mutate_cwd_on_fix_turn.lock().await.clone() {
                    let cwd = self
                        .start_thread_cwds
                        .lock()
                        .await
                        .iter()
                        .find(|(id, _)| id == &thread_id)
                        .map(|(_, cwd)| cwd.clone());
                    if let Some(cwd) = cwd {
                        let path = std::path::Path::new(&cwd).join("seed.txt");
                        let mut contents = std::fs::read_to_string(&path).unwrap_or_default();
                        contents.push_str(&marker);
                        contents.push('\n');
                        std::fs::write(&path, contents).expect("author fix should edit seed.txt");
                    }
                }
            }
            let emit_assistant = self.emit_assistant.load(Ordering::Relaxed)
                && !(is_reviewer_diff_turn && self.suppress_reviewer_reply.load(Ordering::Relaxed))
                && !(is_fix_turn && self.suppress_fix_reply.load(Ordering::Relaxed));
            // A reviewer turn ends with the verdict the test queued (default needs-changes).
            let reply_text = if is_reviewer_diff_turn {
                let verdict = self
                    .reviewer_verdicts
                    .lock()
                    .await
                    .pop_front()
                    .unwrap_or_else(|| "NEEDS_CHANGES".to_string());
                format!("{REVIEW_REPLY}\n\nVERDICT: {verdict}")
            } else {
                REVIEW_REPLY.to_string()
            };
            let raise_approval = self.raise_approval.load(Ordering::Relaxed)
                || (is_reviewer_turn && self.approval_on_reviewer_turn.load(Ordering::Relaxed))
                || (is_fix_turn && self.raise_approval_on_fix_turn.load(Ordering::Relaxed));
            let inject_unrelated = self
                .inject_unrelated_approval
                .swap(false, Ordering::Relaxed);
            let raise_ask_user = self.raise_ask_user.load(Ordering::Relaxed)
                || (is_reviewer_turn && self.ask_user_on_reviewer_turn.load(Ordering::Relaxed));
            let complete_delay_ms = self.complete_delay_ms.load(Ordering::Relaxed);
            let approval_id = self.next_token("approval");
            let ask_id = self.next_token("ask");
            let unrelated_approval_id = self.next_token("unrelated-approval");
            tokio::spawn(async move {
                // Let the orchestrator seed the active-turn marker first so the
                // wait loop observes "working" before we clear it.
                sleep(Duration::from_millis(complete_delay_ms)).await;
                if raise_ask_user {
                    // Park on an AskUserQuestion instead of replying.
                    let mut relay = state.write().await;
                    relay.pending_ask_user_questions.insert(
                        ask_id.clone(),
                        crate::state::PendingAskUserQuestion {
                            request_id: ask_id.clone(),
                            tool_use_id: format!("toolu-{ask_id}"),
                            thread_id: thread_id.clone(),
                            requested_at: 1,
                            questions: vec![crate::protocol::AskUserQuestionView {
                                question: "Which approach?".to_string(),
                                header: "Choice".to_string(),
                                multi_select: false,
                                options: vec![crate::protocol::AskUserOptionView {
                                    label: "A".to_string(),
                                    description: String::new(),
                                }],
                            }],
                        },
                    );
                    relay.notify();
                    return;
                }
                if inject_unrelated {
                    // An unrelated background thread parks on its own approval. The
                    // review must ignore it (not fail, not auto-deny).
                    let mut relay = state.write().await;
                    relay.add_pending_approval(crate::state::PendingApproval {
                        request_id: unrelated_approval_id.clone(),
                        raw_request_id: serde_json::json!(unrelated_approval_id),
                        kind: crate::state::ApprovalKind::Command,
                        thread_id: "unrelated-bg-thread".to_string(),
                        summary: "unrelated background command".to_string(),
                        detail: None,
                        command: Some("true".to_string()),
                        cwd: None,
                        context_preview: None,
                        requested_permissions: None,
                        available_decisions: vec!["approve".to_string(), "deny".to_string()],
                        supports_session_scope: false,
                    });
                    relay.notify();
                }
                if raise_approval {
                    // Park on an approval request instead of replying. The wait
                    // loop checks pending approvals before liveness.
                    let mut relay = state.write().await;
                    relay.add_pending_approval(crate::state::PendingApproval {
                        request_id: approval_id.clone(),
                        raw_request_id: serde_json::json!(approval_id),
                        kind: crate::state::ApprovalKind::Command,
                        thread_id: thread_id.clone(),
                        summary: "edit a file".to_string(),
                        detail: None,
                        command: None,
                        cwd: None,
                        context_preview: None,
                        requested_permissions: None,
                        available_decisions: vec!["approve".to_string(), "deny".to_string()],
                        supports_session_scope: false,
                    });
                    relay.notify();
                    return;
                }
                {
                    let mut relay = state.write().await;
                    let is_active = relay.active_thread_id.as_deref() == Some(thread_id.as_str());
                    if is_active {
                        relay.set_active_turn(Some(turn.clone()));
                        relay.upsert_user_message(
                            user_item.clone(),
                            user_text.clone(),
                            turn.clone(),
                        );
                        if emit_assistant {
                            relay.start_agent_message(assistant_item.clone(), turn.clone());
                            relay.complete_agent_message(
                                assistant_item.clone(),
                                reply_text.clone(),
                                turn.clone(),
                            );
                        }
                        relay.set_active_turn(None);
                        relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
                    } else {
                        let now = unix_now();
                        relay.bg_set_active_turn(&thread_id, Some(turn.clone()), now);
                        relay.bg_upsert_user_message(
                            &thread_id,
                            user_item.clone(),
                            user_text.clone(),
                            turn.clone(),
                            now,
                        );
                        if emit_assistant {
                            relay.bg_start_agent_message(
                                &thread_id,
                                assistant_item.clone(),
                                turn.clone(),
                                now,
                            );
                            relay.bg_complete_agent_message(
                                &thread_id,
                                assistant_item.clone(),
                                reply_text.clone(),
                                turn.clone(),
                                now,
                            );
                        }
                        relay.bg_set_active_turn(&thread_id, None, now);
                        relay.bg_set_thread_status(&thread_id, "idle".to_string(), Vec::new(), now);
                    }
                    relay.notify();
                }
                let mut transcripts = transcripts.lock().await;
                let entries = transcripts.entry(thread_id).or_default();
                entries.push(TranscriptEntryView {
                    item_id: Some(user_item),
                    kind: TranscriptEntryKind::UserText,
                    text: Some(user_text),
                    status: "completed".to_string(),
                    turn_id: Some(turn.clone()),
                    tool: None,
                    content_state: crate::protocol::TranscriptContentState::Full,
                });
                if emit_assistant {
                    entries.push(TranscriptEntryView {
                        item_id: Some(assistant_item),
                        kind: TranscriptEntryKind::AgentText,
                        text: Some(reply_text.clone()),
                        status: "completed".to_string(),
                        turn_id: Some(turn),
                        tool: None,
                        content_state: crate::protocol::TranscriptContentState::Full,
                    });
                }
            });
            Ok(Some(turn_id))
        }

        async fn request_turn_stop(
            &self,
            thread_id: &str,
            _turn_id: Option<&str>,
        ) -> Result<(), String> {
            self.interrupts.lock().await.push(thread_id.to_string());
            if self.interrupt_fails.load(Ordering::Relaxed) {
                return Err("interrupt rejected".to_string());
            }
            // Simulate the provider acknowledging the cancel by ending the turn — a
            // real provider clears `active_turn` via a turn/completed event, which
            // is the only signal the orchestrator trusts as "stopped".
            let mut relay = self.state.write().await;
            if relay.active_thread_id.as_deref() == Some(thread_id) {
                relay.set_active_turn(None);
                relay.set_thread_status(thread_id, "idle".to_string(), Vec::new());
            } else {
                let now = unix_now();
                relay.bg_set_active_turn(thread_id, None, now);
                relay.bg_set_thread_status(thread_id, "idle".to_string(), Vec::new(), now);
            }
            relay.notify();
            Ok(())
        }

        async fn respond_to_approval(
            &self,
            _pending: &crate::state::PendingApproval,
            _input: &crate::protocol::ApprovalDecisionInput,
        ) -> Result<(), String> {
            if self.deny_fails.load(Ordering::Relaxed) {
                Err("provider rejected the approval response".to_string())
            } else {
                Ok(())
            }
        }

        async fn respond_to_ask_user_question(
            &self,
            _request_id: &str,
            _answers: &serde_json::Map<String, serde_json::Value>,
        ) -> Result<(), String> {
            Ok(())
        }

        fn provider_name(&self) -> &'static str {
            self.name
        }

        fn read_thread_reports_activity_time(&self) -> bool {
            self.report_activity_time.load(Ordering::Relaxed)
        }
    }

    async fn build_review_app(
        cwd: &str,
        provider_names: &[&'static str],
    ) -> (AppState, HashMap<&'static str, ReviewTestProvider>) {
        let (change_tx, _rx) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let mut bridges: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        let mut map = HashMap::new();
        for name in provider_names {
            let provider = ReviewTestProvider::new(name, relay.clone());
            bridges.insert(name.to_string(), Arc::new(provider.clone()));
            map.insert(*name, provider);
        }
        (AppState::from_parts(relay, bridges, change_tx), map)
    }

    async fn start_parent(app: &AppState, cwd: &str, provider: &str) -> ThreadSummaryView {
        let snap = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some(provider.to_string()),
                initial_prompt: None,
            })
            .await
            .expect("parent session should start");
        let thread_id = snap.active_thread_id.clone().expect("parent thread id");
        ThreadSummaryView {
            id: thread_id,
            name: None,
            preview: String::new(),
            cwd: snap.current_cwd.clone(),
            updated_at: 0,
            source: provider.to_string(),
            status: snap.current_status.clone(),
            model_provider: provider.to_string(),
            provider: provider.to_string(),
            forked_from: None,
        }
    }

    async fn wait_for_review(app: &AppState, job_id: &str) -> crate::protocol::ReviewJobView {
        wait_for_review_status(app, job_id, &["complete", "failed", "blocked", "escalated"]).await
    }

    /// Wait until no turn is in flight on the active thread (e.g. the review's
    /// post-back turn on the parent has finished settling), so the parent can be
    /// deleted (`can_delete_thread` rejects a thread with a running turn).
    async fn wait_for_active_turn_idle(app: &AppState) {
        for _ in 0..400 {
            if app.relay.read().await.active_turn_id.is_none() {
                return;
            }
            sleep(Duration::from_millis(10)).await;
        }
        panic!("active turn never settled");
    }

    /// Wait until the review job has a reviewer_thread_id set (atomically with
    /// thread registration in production, so this is reachable even when the recap
    /// completes and the review transitions to StartingReviewer).
    async fn wait_for_reviewer_thread_id(app: &AppState, job_id: &str) -> String {
        for _ in 0..400 {
            if let Some(id) = app
                .relay
                .read()
                .await
                .review_job(job_id)
                .and_then(|j| j.reviewer_thread_id.clone())
            {
                return id;
            }
            sleep(Duration::from_millis(10)).await;
        }
        panic!("review job {job_id} never got a reviewer_thread_id");
    }

    async fn wait_for_review_status(
        app: &AppState,
        job_id: &str,
        statuses: &[&str],
    ) -> crate::protocol::ReviewJobView {
        // Read the job by id directly, not via the snapshot view: the view shows one
        // card per reviewer thread (older reuse runs collapse into the latest), so a
        // specific job we're waiting on may be deduped out of the display list.
        for _ in 0..400 {
            if let Some(job) = app
                .relay
                .read()
                .await
                .review_job(job_id)
                .map(|job| job.view())
            {
                if statuses.contains(&job.status.as_str()) {
                    return job;
                }
            }
            sleep(Duration::from_millis(10)).await;
        }
        panic!("review job {job_id} never reached {statuses:?}");
    }

    fn review_input(reviewer_provider: &str) -> RequestReviewInput {
        RequestReviewInput {
            parent_thread_id: None,
            reviewer_provider: reviewer_provider.to_string(),
            reviewer_model: None,
            reviewer_effort: None,
            reviewer_thread_id: None,
            instructions: Some("focus on the tests".to_string()),
            // These tests exercise the recap-turn flow explicitly (the user-facing
            // default is now "last_message"; that path has its own dedicated tests).
            recap_source: Some("recap".to_string()),
            max_rounds: None,
            device_id: Some("device-1".to_string()),
        }
    }

    #[tokio::test]
    async fn review_can_target_a_non_active_parent_thread() {
        // A review must be allowed to target a thread the request NAMES (parent_thread_id),
        // not only the relay's active thread. Start B, then start A so A is active and B is a
        // background (non-active) thread; then review B explicitly. Before lifting the v1
        // "can only review the active thread" guard this errors; after, it runs against B.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent_b = start_parent(&app, cwd, "codex").await;
        let parent_a = start_parent(&app, cwd, "codex").await;
        assert_eq!(
            app.snapshot().await.active_thread_id.as_deref(),
            Some(parent_a.id.as_str()),
            "A should be the active thread; B is now a background thread"
        );

        let mut input = review_input("codex");
        input.parent_thread_id = Some(parent_b.id.clone());

        let receipt = app
            .request_review(input)
            .await
            .expect("reviewing a named non-active parent should be allowed");
        assert_eq!(receipt.parent_thread_id, parent_b.id);

        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
        assert_eq!(
            job.parent_thread_id, parent_b.id,
            "the review must be recorded against the named parent B"
        );

        // The active thread A must stay active throughout — the review runs in the
        // background on B and never displaces the user's active thread.
        assert_eq!(
            app.snapshot().await.active_thread_id.as_deref(),
            Some(parent_a.id.as_str())
        );

        // The recap turn ran on B (the named parent), never on the active thread A.
        let provider = providers.get("codex").unwrap();
        let turns = provider.turns.lock().await.clone();
        assert!(
            turns.iter().any(|(tid, _)| tid == &parent_b.id),
            "expected a recap turn on the named parent B: {turns:?}"
        );
        assert!(
            !turns.iter().any(|(tid, _)| tid == &parent_a.id),
            "no turn should run on the active thread A: {turns:?}"
        );
    }

    #[tokio::test]
    async fn review_allowed_when_another_device_controls_the_session() {
        // A review is a BACKGROUND action authorized by workspace path-scope, NOT by who
        // holds the active-thread control lease. Even when another device controls the
        // active session, this device may start a review of an idle thread. (Before the
        // control gate was dropped this failed with "another device currently has control".)
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        {
            let mut relay = app.relay.write().await;
            relay.active_controller_device_id = Some("some-other-device".to_string());
            relay.active_controller_last_seen_at = Some(unix_now());
        }

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("a review must not require controlling the active session");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
        assert_eq!(job.parent_thread_id, parent.id);
    }

    #[tokio::test]
    async fn stopping_a_review_is_not_gated_on_active_session_control() {
        // Symmetry with request_review: a review is authorized by workspace path-scope, NOT
        // by who controls the active session — so STOPPING must follow the same rule.
        // Otherwise a path-authorized device that started a background review could be unable
        // to stop a hung one, stranding the reviewed thread locked until the controller
        // intervenes. With another device controlling and no active review, the failure must
        // be "no active review" — never a control-ownership rejection.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        {
            let mut relay = app.relay.write().await;
            relay.active_controller_device_id = Some("some-other-device".to_string());
            relay.active_controller_last_seen_at = Some(unix_now());
        }

        let err = app
            .cancel_active_review(Some("device-1".to_string()))
            .await
            .expect_err("there is no active review to stop");
        assert!(
            !err.to_lowercase().contains("has control"),
            "stopping a review must not be gated on active-session control: {err}"
        );
        assert!(err.contains("no active review"), "got: {err}");
    }

    #[tokio::test]
    async fn review_rejected_when_parent_workspace_is_outside_the_device_scope() {
        // Authorization now lives in path-scope (not control): a paired device may only
        // review threads whose workspace is inside its scope. A device scoped to a
        // different directory is refused before any review work happens.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let other = TempDir::new().expect("other tmpdir");
        let other_scope = other.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        {
            // Pair a device scoped to a DIFFERENT directory than the reviewed thread's cwd.
            let mut relay = app.relay.write().await;
            relay.paired_devices.insert(
                "device-scoped".to_string(),
                crate::state::relay::PairedDevice {
                    device_id: "device-scoped".to_string(),
                    label: "device-scoped".to_string(),
                    payload_secret: "test-payload-secret".to_string(),
                    device_verify_key: "test-verify-key".to_string(),
                    created_at: 1,
                    last_seen_at: Some(1),
                    last_peer_id: Some("peer-test".to_string()),
                    broker_join_ticket_expires_at: None,
                    path_scope: vec![other_scope.to_string()],
                },
            );
        }

        let mut input = review_input("codex");
        input.device_id = Some("device-scoped".to_string());
        let err = app
            .request_review(input)
            .await
            .expect_err("a review of a workspace outside the device's scope must be rejected");
        assert!(
            err.to_lowercase().contains("outside") && err.to_lowercase().contains("allowed paths"),
            "expected a path-scope rejection, got: {err}"
        );
    }

    #[tokio::test]
    async fn reviewer_thread_provider_never_reports_the_session_source_as_provider() {
        // Codex running inside an editor reports a session `source` of "vscode" with an
        // EMPTY provider on its summary. The reviewer thread's provider must NOT become
        // "vscode": that is the session ORIGIN, not a provider, and surfacing it filtered
        // the reviewer out of the re-review reuse picker (its provider "vscode" did not
        // match the job's "codex") and made the backend reuse-validation reject it.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let reviewer_id = "reviewer-vscode-sourced";
        {
            let mut relay = app.relay.write().await;
            let thread = ThreadSummaryView {
                id: reviewer_id.to_string(),
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "vscode".to_string(),
                status: "idle".to_string(),
                model_provider: "vscode".to_string(),
                provider: String::new(),
                forked_from: None,
            };
            relay.register_background_thread(thread, cwd, "model", "never", "read-only", "low");
            relay.register_reviewer_thread(reviewer_id.to_string(), "parent-1".to_string());

            assert_ne!(
                relay.reviewer_thread_provider(reviewer_id).as_deref(),
                Some("vscode"),
                "the editor session source must never be surfaced as the reviewer provider"
            );
            // The snapshot field the reuse picker reads must not carry the source either.
            let view = relay
                .reviewer_thread_views()
                .into_iter()
                .find(|v| v.reviewer_thread_id == reviewer_id)
                .expect("reviewer thread view");
            assert_ne!(view.reviewer_provider.as_deref(), Some("vscode"));
        }
    }

    #[tokio::test]
    async fn reviewer_thread_provider_resolves_from_the_review_job_when_summary_lacks_it() {
        // When the summary can't tell us the provider (codex's editor-sourced summary has an
        // empty provider), the REVIEW JOB recorded it definitively at creation. Use it, so a
        // reviewer groups under its REAL provider in the reuse picker — instead of being left
        // unknown (null), which leaks it under every provider (e.g. a codex reviewer showing
        // when Claude is selected).
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let reviewer_id = "reviewer-grouped-by-job";
        {
            let mut relay = app.relay.write().await;
            let thread = ThreadSummaryView {
                id: reviewer_id.to_string(),
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "vscode".to_string(),
                status: "idle".to_string(),
                model_provider: "vscode".to_string(),
                provider: String::new(),
                forked_from: None,
            };
            relay.register_background_thread(thread, cwd, "model", "never", "read-only", "low");
            relay.register_reviewer_thread(reviewer_id.to_string(), "parent-1".to_string());

            let mut job = crate::state::ReviewJob::new(
                "review-grouping".to_string(),
                "parent-1".to_string(),
                "codex".to_string(),
                "codex".to_string(),
                None,
                crate::state::ReviewMode::CleanThread,
                cwd.to_string(),
                "device-1".to_string(),
                None,
                1,
            );
            job.reviewer_thread_id = Some(reviewer_id.to_string());
            relay.insert_review_job(job);

            assert_eq!(
                relay.reviewer_thread_provider(reviewer_id).as_deref(),
                Some("codex"),
                "the reviewer's provider must resolve from its review job, not stay unknown"
            );
            let view = relay
                .reviewer_thread_views()
                .into_iter()
                .find(|v| v.reviewer_thread_id == reviewer_id)
                .expect("reviewer thread view");
            assert_eq!(view.reviewer_provider.as_deref(), Some("codex"));
        }
    }

    #[tokio::test]
    async fn reviews_channel_returns_full_cards_with_a_revision_matching_the_snapshot() {
        // The reviewer panel's dedicated channel (`app.reviews()`) returns the FULL review
        // cards + reviewer threads + a content revision — the panel's source of truth,
        // decoupled from the snapshot's drainable `active_review_jobs`. The revision it
        // carries must match the snapshot's `reviews_revision` (the client's cache key, used
        // to decide when to re-fetch).
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        let reviews = app.reviews(None).await;
        assert!(
            reviews
                .review_jobs
                .iter()
                .any(|j| j.reviewer_thread_id == job.reviewer_thread_id),
            "the reviews channel must include the completed review card for the parent"
        );
        assert_ne!(
            reviews.reviews_revision, 0,
            "a real review must yield a non-zero reviews_revision"
        );
        assert_eq!(
            reviews.reviews_revision,
            app.snapshot().await.reviews_revision,
            "the snapshot's reviews_revision must match the channel (the client's cache key)"
        );
        let _ = parent;
    }

    #[tokio::test]
    async fn reviews_revision_changes_when_a_review_is_added() {
        // The revision is the client's refetch signal: it must change when the reviewer data
        // changes (a new review), and otherwise stay put so the client doesn't refetch on
        // every snapshot frame.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        let before = app.reviews(None).await.reviews_revision;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        wait_for_review(&app, &receipt.review_job_id).await;
        let after = app.reviews(None).await.reviews_revision;

        assert_ne!(
            before, after,
            "adding a review must change reviews_revision"
        );
        // Stable across an unrelated re-read (no new review).
        assert_eq!(after, app.reviews(None).await.reviews_revision);
    }

    #[tokio::test]
    async fn reviews_channel_is_scoped_to_the_requesting_device_workspace() {
        // The reviews read channel must not leak review metadata for parents outside the
        // requesting device's path scope — consistent with workspace_diff / transcripts. A
        // device scoped to one workspace sees only that workspace's reviews; the local
        // operator (None) sees all.
        let in_dir = TempDir::new().expect("in tmpdir");
        let out_dir = TempDir::new().expect("out tmpdir");
        let in_cwd = in_dir.path().to_str().unwrap();
        let out_cwd = out_dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(in_cwd, &["codex"]).await;
        {
            let mut relay = app.relay.write().await;
            let mk_thread = |id: &str, cwd: &str| ThreadSummaryView {
                id: id.to_string(),
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "codex".to_string(),
                status: "idle".to_string(),
                model_provider: "codex".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            };
            for (parent, reviewer, cwd, job_id) in [
                ("parent-in", "rev-in", in_cwd, "job-in"),
                ("parent-out", "rev-out", out_cwd, "job-out"),
            ] {
                relay.register_background_thread(
                    mk_thread(parent, cwd),
                    cwd,
                    "model",
                    "never",
                    "read-only",
                    "low",
                );
                relay.register_background_thread(
                    mk_thread(reviewer, cwd),
                    cwd,
                    "model",
                    "never",
                    "read-only",
                    "low",
                );
                relay.register_reviewer_thread(reviewer.to_string(), parent.to_string());
                let mut job = crate::state::ReviewJob::new(
                    job_id.to_string(),
                    parent.to_string(),
                    "codex".to_string(),
                    "codex".to_string(),
                    None,
                    crate::state::ReviewMode::CleanThread,
                    cwd.to_string(),
                    "device-1".to_string(),
                    None,
                    1,
                );
                job.reviewer_thread_id = Some(reviewer.to_string());
                relay.insert_review_job(job);
            }
            // A device scoped to ONLY the in-workspace.
            relay.paired_devices.insert(
                "device-scoped".to_string(),
                crate::state::relay::PairedDevice {
                    device_id: "device-scoped".to_string(),
                    label: "device-scoped".to_string(),
                    payload_secret: "test-payload-secret".to_string(),
                    device_verify_key: "test-verify-key".to_string(),
                    created_at: 1,
                    last_seen_at: Some(1),
                    last_peer_id: Some("peer-test".to_string()),
                    broker_join_ticket_expires_at: None,
                    // Normalize like start_pairing does, so symlinked tmpdirs on macOS
                    // (/var/folders → /private/var/folders) don't produce false misses.
                    path_scope: crate::state::normalize_allowed_roots(vec![in_cwd.to_string()])
                        .expect("scope should normalize"),
                },
            );
        }

        // The local operator (None) sees reviews from both workspaces.
        assert_eq!(
            app.reviews(None).await.review_jobs.len(),
            2,
            "the operator sees all reviews"
        );

        // The scoped device sees ONLY its own workspace's review + reviewer thread.
        let scoped = app.reviews(Some("device-scoped".to_string())).await;
        assert_eq!(
            scoped
                .review_jobs
                .iter()
                .map(|job| job.parent_thread_id.clone())
                .collect::<Vec<_>>(),
            vec!["parent-in".to_string()],
            "a scoped device must not see reviews outside its workspace"
        );
        assert_eq!(
            scoped
                .reviewer_threads
                .iter()
                .map(|view| view.reviewer_thread_id.clone())
                .collect::<Vec<_>>(),
            vec!["rev-in".to_string()]
        );
    }

    #[tokio::test]
    async fn reviews_channel_enforces_relay_allowed_roots_even_with_empty_device_scope() {
        // Even with an EMPTY device scope — the local operator via reviews(None), or a paired
        // device with no per-device scope — reviews for parents outside the relay's
        // allowed_roots must NOT leak. This mirrors workspace_diff, whose
        // ensure_path_within_device_scope enforces relay roots FIRST regardless of device
        // scope (guards against stale review jobs left over from older allowed_roots).
        let in_dir = TempDir::new().expect("in tmpdir");
        let out_dir = TempDir::new().expect("out tmpdir");
        let in_cwd = in_dir.path().to_str().unwrap();
        let out_cwd = out_dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(in_cwd, &["codex"]).await;
        {
            let mut relay = app.relay.write().await;
            let mk_thread = |id: &str, cwd: &str| ThreadSummaryView {
                id: id.to_string(),
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "codex".to_string(),
                status: "idle".to_string(),
                model_provider: "codex".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            };
            for (parent, reviewer, cwd, job_id) in [
                ("parent-in", "rev-in", in_cwd, "job-in"),
                ("parent-out", "rev-out", out_cwd, "job-out"),
            ] {
                relay.register_background_thread(
                    mk_thread(parent, cwd),
                    cwd,
                    "model",
                    "never",
                    "read-only",
                    "low",
                );
                relay.register_reviewer_thread(reviewer.to_string(), parent.to_string());
                let mut job = crate::state::ReviewJob::new(
                    job_id.to_string(),
                    parent.to_string(),
                    "codex".to_string(),
                    "codex".to_string(),
                    None,
                    crate::state::ReviewMode::CleanThread,
                    cwd.to_string(),
                    "device-1".to_string(),
                    None,
                    1,
                );
                job.reviewer_thread_id = Some(reviewer.to_string());
                relay.insert_review_job(job);
            }
            // Relay roots restrict to the in-workspace; the device itself has NO scope.
            relay.allowed_roots = crate::state::normalize_allowed_roots(vec![in_cwd.to_string()])
                .expect("allowed roots should normalize");
            relay.paired_devices.insert(
                "device-unscoped".to_string(),
                crate::state::relay::PairedDevice {
                    device_id: "device-unscoped".to_string(),
                    label: "device-unscoped".to_string(),
                    payload_secret: "test-payload-secret".to_string(),
                    device_verify_key: "test-verify-key".to_string(),
                    created_at: 1,
                    last_seen_at: Some(1),
                    last_peer_id: Some("peer-test".to_string()),
                    broker_join_ticket_expires_at: None,
                    path_scope: Vec::new(),
                },
            );
        }

        let parents_of = |resp: &crate::protocol::ReviewsResponse| {
            resp.review_jobs
                .iter()
                .map(|job| job.parent_thread_id.clone())
                .collect::<Vec<_>>()
        };

        // The local operator (None) must respect relay allowed_roots (mirrors workspace_diff).
        assert_eq!(
            parents_of(&app.reviews(None).await),
            vec!["parent-in".to_string()],
            "operator reads must enforce relay allowed_roots"
        );
        // A paired device with no scope of its own still inherits the relay roots boundary.
        assert_eq!(
            parents_of(&app.reviews(Some("device-unscoped".to_string())).await),
            vec!["parent-in".to_string()],
            "an unscoped device must still be bounded by relay allowed_roots"
        );
    }

    #[tokio::test]
    async fn find_thread_provider_resolves_a_background_thread_missing_from_the_cache() {
        // Regression: a freshly-created background reviewer thread lives in `runtimes`,
        // but a thread-list refresh can transiently drop its row from `relay.threads`
        // (it's hidden from navigation), and a provider's own `list_threads` doesn't
        // yet include a brand-new thread with no persisted turn (Codex persists a
        // session on its first turn). find_thread_provider must still route it via the
        // authoritative live runtime — otherwise sending the reviewer prompt fails with
        // "thread '…' was not found on any provider" and the review dies before it runs.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;

        let reviewer_id = "reviewer-codex-orphan";
        {
            let mut relay = app.relay.write().await;
            let thread = ThreadSummaryView {
                id: reviewer_id.to_string(),
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "codex".to_string(),
                status: "idle".to_string(),
                model_provider: "codex".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            };
            relay.register_background_thread(thread, cwd, "model", "never", "read-only", "low");
            // Drop the routing-cache row while the live runtime survives (and the
            // provider never persisted it), reproducing the production race.
            relay.threads.retain(|thread| thread.id != reviewer_id);
            assert!(relay.runtime_for_thread(reviewer_id).is_some());
        }

        let (name, _bridge) = app
            .find_thread_provider(reviewer_id)
            .await
            .expect("runtime fallback must resolve the provider");
        assert_eq!(name, "codex");
    }

    #[tokio::test]
    async fn upsert_thread_preserves_a_stamped_reviewer_provider_against_codex_refresh() {
        // Root cause of "thread '…' was not found on any provider": Codex thread
        // summaries carry an empty `provider`, so when the codex event loop upserts a
        // freshly-created reviewer thread mid-review it would clobber the "codex"
        // provider stamped at registration — leaving the background reviewer
        // unroutable. upsert_thread must preserve the known provider.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;

        let reviewer_id = "reviewer-codex-clobber";
        {
            let mut relay = app.relay.write().await;
            let mut thread = ThreadSummaryView {
                id: reviewer_id.to_string(),
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "codex".to_string(),
                status: "idle".to_string(),
                model_provider: "codex".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            };
            relay.register_background_thread(
                thread.clone(),
                cwd,
                "model",
                "never",
                "read-only",
                "low",
            );

            // Simulate a codex event-loop refresh: the same thread, but with the empty
            // provider/`unknown` source codex actually returns (see parse_thread_summary).
            thread.provider = String::new();
            thread.source = "unknown".to_string();
            thread.model_provider = "unknown".to_string();
            relay.upsert_thread(thread);

            // The stamped provider must survive on BOTH the routing row and runtime.
            assert_eq!(
                relay
                    .threads
                    .iter()
                    .find(|t| t.id == reviewer_id)
                    .map(|t| t.provider.as_str()),
                Some("codex"),
                "routing-cache row must keep the stamped provider"
            );
            assert_eq!(
                relay
                    .runtime_for_thread(reviewer_id)
                    .and_then(|r| r.summary.as_ref())
                    .map(|s| s.provider.as_str()),
                Some("codex"),
                "runtime summary must keep the stamped provider"
            );
        }

        let (name, _bridge) = app
            .find_thread_provider(reviewer_id)
            .await
            .expect("a clobbering refresh must not make the reviewer unroutable");
        assert_eq!(name, "codex");
    }

    #[tokio::test]
    async fn review_runs_recap_then_reviewer_then_posts_back() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        let parent_cwd = app.snapshot().await.current_cwd;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        assert_eq!(receipt.parent_thread_id, parent.id);
        assert_eq!(receipt.status.status, "pending_parent_recap");

        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);

        // The review was requested WITHOUT an explicit model (review_input sets
        // reviewer_model: None), but the card must still show the model it actually ran
        // on: the orchestrator records the resolved EFFECTIVE model on the job once the
        // reviewer thread starts. Without that, a default-model clean reviewer would
        // store None and the UI would show no model at all.
        assert!(
            job.reviewer_model
                .as_ref()
                .map(|m| !m.is_empty())
                .unwrap_or(false),
            "the effective reviewer model must be recorded on the job (got {:?})",
            job.reviewer_model
        );

        // Same for reasoning effort: the review was requested WITHOUT an explicit
        // effort (review_input sets reviewer_effort: None), but ReviewJobView must
        // still carry the EFFECTIVE effort the clean reviewer ran on — the orchestrator
        // resolves and records it when the reviewer thread starts. Without that the card
        // would show a model but no effort (the reported gap).
        assert!(
            job.reviewer_effort
                .as_ref()
                .map(|e| !e.is_empty())
                .unwrap_or(false),
            "the effective reviewer effort must be recorded on the job (got {:?})",
            job.reviewer_effort
        );

        // The reviewer ran entirely in the BACKGROUND: the active thread stayed the
        // parent the whole time — there was no handoff to displace the user.
        assert_eq!(
            app.snapshot().await.active_thread_id.as_deref(),
            Some(parent.id.as_str()),
            "the active thread must remain the parent throughout a background review"
        );

        let provider = providers.get("codex").unwrap();
        let turns = provider.turns.lock().await.clone();
        assert_eq!(
            turns.len(),
            3,
            "expected recap, review, post-back: {turns:?}"
        );

        // Recap goes to the parent first.
        assert_eq!(turns[0].0, parent.id);
        assert!(
            turns[0].1.contains("recap the changes"),
            "recap prompt: {}",
            turns[0].1
        );

        // Reviewer prompt is a separate thread and carries recap + diff metadata.
        let reviewer_thread = job.reviewer_thread_id.clone().expect("reviewer thread id");
        assert_ne!(reviewer_thread, parent.id);
        assert_eq!(turns[1].0, reviewer_thread);
        assert!(
            turns[1]
                .1
                .contains("Workspace diff collected by the relay at"),
            "reviewer prompt missing diff metadata: {}",
            turns[1].1
        );
        assert!(
            turns[1].1.contains(REVIEW_REPLY),
            "reviewer prompt should embed the parent recap: {}",
            turns[1].1
        );
        assert!(
            turns[1].1.contains("focus on the tests"),
            "reviewer prompt should carry user instructions: {}",
            turns[1].1
        );

        // The review is posted back into the parent thread.
        assert_eq!(turns[2].0, parent.id);
        assert!(
            turns[2].1.contains("review result from reviewer thread"),
            "post-back message: {}",
            turns[2].1
        );

        // The clean reviewer thread was created against the parent cwd.
        let cwds = provider.start_thread_cwds.lock().await.clone();
        assert!(
            cwds.iter()
                .any(|(tid, c)| tid == &reviewer_thread && c == &parent_cwd),
            "reviewer thread cwd mismatch: {cwds:?} (parent cwd {parent_cwd})"
        );
    }

    #[tokio::test]
    async fn review_last_message_mode_skips_the_recap_turn() {
        // The default briefing mode hands the parent's LAST assistant message to the
        // reviewer instead of driving a fresh recap turn — saving a whole parent turn.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        // Seed a last assistant message on the parent (the fake replies REVIEW_REPLY).
        app.send_message(crate::protocol::SendMessageInput {
            text: "implement the storage refactor".to_string(),
            model: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            thread_id: parent.id.clone(),
        })
        .await
        .expect("seed turn should start");
        wait_for_active_turn_idle(&app).await;

        // Default briefing = last_message (no explicit recap_source).
        let mut input = review_input("codex");
        input.recap_source = None;
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);

        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        // No recap turn was driven on the parent — the whole point of last_message mode.
        assert!(
            turns
                .iter()
                .all(|(_, prompt)| !prompt.contains("recap the changes")),
            "last_message mode must NOT drive a recap turn: {turns:?}"
        );
        // The reviewer was briefed with the parent's last message (REVIEW_REPLY).
        let reviewer_thread = job.reviewer_thread_id.clone().expect("reviewer thread id");
        let reviewer_turn = turns
            .iter()
            .find(|(tid, _)| tid == &reviewer_thread)
            .expect("a reviewer turn");
        assert!(
            reviewer_turn.1.contains(REVIEW_REPLY),
            "reviewer prompt should carry the parent's last message as the recap: {}",
            reviewer_turn.1
        );
    }

    #[tokio::test]
    async fn review_last_message_mode_falls_back_to_recap_when_no_message() {
        // last_message mode with nothing to brief from (the parent never replied) must
        // fall back to driving a real recap turn rather than briefing the reviewer empty.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        // No turn has run on the parent → no assistant message to brief from.

        let mut input = review_input("codex");
        input.recap_source = Some("last_message".to_string());
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);

        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert!(
            turns
                .iter()
                .any(|(tid, prompt)| tid == &parent.id && prompt.contains("recap the changes")),
            "last_message with no parent message must fall back to a recap turn: {turns:?}"
        );
    }

    #[tokio::test]
    async fn review_reuses_existing_reviewer_thread() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        // First review spawns a clean reviewer thread.
        let first = app
            .request_review(review_input("codex"))
            .await
            .expect("first review should start");
        let first_job = wait_for_review(&app, &first.review_job_id).await;
        assert_eq!(
            first_job.status, "complete",
            "job failed: {:?}",
            first_job.error
        );
        let reviewer = first_job
            .reviewer_thread_id
            .clone()
            .expect("reviewer thread id");
        assert!(app
            .relay
            .read()
            .await
            .reviewer_threads_of_parent(&parent.id)
            .contains(&reviewer));
        wait_for_active_turn_idle(&app).await;

        let provider = providers.get("codex").unwrap();
        let threads_before = provider.start_thread_cwds.lock().await.len();

        // Second review REUSES the existing reviewer thread.
        let mut reuse = review_input("codex");
        reuse.reviewer_thread_id = Some(reviewer.clone());
        let second = app
            .request_review(reuse)
            .await
            .expect("reuse review should start");
        // The receipt immediately names the reused thread.
        assert_eq!(
            second.reviewer_thread_id.as_deref(),
            Some(reviewer.as_str())
        );
        let second_job = wait_for_review(&app, &second.review_job_id).await;
        assert_eq!(
            second_job.status, "complete",
            "reuse job failed: {:?}",
            second_job.error
        );
        assert_eq!(
            second_job.reviewer_thread_id.as_deref(),
            Some(reviewer.as_str()),
            "the reuse job runs on the same reviewer thread"
        );

        // No NEW reviewer thread was created (an idle reused reviewer in the same
        // cwd also does not trip the has_working_thread_in_cwd guard).
        assert_eq!(
            provider.start_thread_cwds.lock().await.len(),
            threads_before,
            "reuse must not create a new reviewer thread"
        );

        // The second review's reviewer turn went to the reused thread with the
        // re-review framing; recap → reviewer(reuse) → post-back are the last 3 turns.
        let turns = provider.turns.lock().await.clone();
        assert_eq!(turns.len(), 6, "expected 3 turns per review: {turns:?}");
        assert_eq!(turns[3].0, parent.id, "second recap goes to the parent");
        assert_eq!(
            turns[4].0, reviewer,
            "second review runs on the reused thread"
        );
        assert!(
            turns[4]
                .1
                .contains("You previously reviewed this repository"),
            "reuse should send the re-review prompt: {}",
            turns[4].1
        );
        assert_eq!(
            turns[5].0, parent.id,
            "second review posts back to the parent"
        );
    }

    #[tokio::test]
    async fn review_reuse_rejects_foreign_reviewer() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;

        // A reviewer thread that belongs to a DIFFERENT parent is not reusable here.
        app.relay
            .write()
            .await
            .register_reviewer_thread("foreign-reviewer".to_string(), "other-parent".to_string());

        let mut input = review_input("codex");
        input.reviewer_thread_id = Some("foreign-reviewer".to_string());
        let error = app
            .request_review(input)
            .await
            .expect_err("a reviewer owned by another parent should be rejected");
        assert!(error.contains("does not belong"), "got: {error}");
    }

    #[tokio::test]
    async fn review_reuse_rejects_provider_mismatch() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex", "claude_code"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        // Create a codex reviewer via a first review.
        let first = app
            .request_review(review_input("codex"))
            .await
            .expect("first review should start");
        let first_job = wait_for_review(&app, &first.review_job_id).await;
        let reviewer = first_job
            .reviewer_thread_id
            .clone()
            .expect("reviewer thread id");
        assert!(app
            .relay
            .read()
            .await
            .reviewer_threads_of_parent(&parent.id)
            .contains(&reviewer));
        wait_for_active_turn_idle(&app).await;

        // Reusing it but claiming a different provider is rejected.
        let mut input = review_input("claude_code");
        input.reviewer_thread_id = Some(reviewer.clone());
        let error = app
            .request_review(input)
            .await
            .expect_err("a provider mismatch should be rejected");
        assert!(error.contains("does not match"), "got: {error}");
    }

    // R1: a reused reviewer that produces no fresh reply this turn must FAIL — never
    // replay its prior review as the current result.
    #[tokio::test]
    async fn review_reuse_fails_when_no_fresh_review() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let first = app
            .request_review(review_input("codex"))
            .await
            .expect("first review should start");
        let first_job = wait_for_review(&app, &first.review_job_id).await;
        let reviewer = first_job
            .reviewer_thread_id
            .clone()
            .expect("reviewer thread id");
        wait_for_active_turn_idle(&app).await;
        let turns_before = providers.get("codex").unwrap().turns.lock().await.len();

        // The reviewer turn completes but emits NO new assistant reply.
        providers
            .get("codex")
            .unwrap()
            .suppress_reviewer_reply
            .store(true, Ordering::Relaxed);

        let mut reuse = review_input("codex");
        reuse.reviewer_thread_id = Some(reviewer.clone());
        let second = app
            .request_review(reuse)
            .await
            .expect("reuse review should start");
        let second_job = wait_for_review(&app, &second.review_job_id).await;

        assert_eq!(
            second_job.status, "failed",
            "reuse with no fresh reply must fail, not post the prior review"
        );
        assert!(
            second_job
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("no review for this turn"),
            "unexpected error: {:?}",
            second_job.error
        );
        // Recap + reviewer turns ran, but NO post-back to the parent (it would have
        // carried the stale review).
        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert_eq!(
            turns.len(),
            turns_before + 2,
            "expected only recap + reviewer: {turns:?}"
        );
        assert!(
            !turns[turns_before..]
                .iter()
                .any(|(tid, text)| tid == &parent.id
                    && text.contains("review result from reviewer thread")),
            "a stale review must not be posted back: {turns:?}"
        );
    }

    // R2: after a restart the reused reviewer has no runtime; the orchestrator must
    // re-attach it and actually wait for the turn (not read the prior review early).
    #[tokio::test]
    async fn review_reuse_after_restart_waits_for_fresh_review() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let first = app
            .request_review(review_input("codex"))
            .await
            .expect("first review should start");
        let first_job = wait_for_review(&app, &first.review_job_id).await;
        let reviewer = first_job
            .reviewer_thread_id
            .clone()
            .expect("reviewer thread id");
        wait_for_active_turn_idle(&app).await;

        // Simulate a FULL restart: the relay runtime is gone AND the provider's
        // app-server evicted the thread (a turn can't start on it until it's resumed),
        // but the durable map + persisted settings + the on-disk thread survive. Delay
        // completion so a non-waiting orchestrator would read the prior review early.
        {
            let mut relay = app.relay.write().await;
            relay.runtimes.remove(&reviewer);
        }
        let codex = providers.get("codex").unwrap();
        codex.unloaded_threads.lock().await.insert(reviewer.clone());
        codex.complete_delay_ms.store(60, Ordering::Relaxed);

        let mut reuse = review_input("codex");
        reuse.reviewer_thread_id = Some(reviewer.clone());
        let second = app
            .request_review(reuse)
            .await
            .expect("reuse review should start");
        let second_job = wait_for_review(&app, &second.review_job_id).await;

        assert_eq!(
            second_job.status, "complete",
            "post-restart reuse must resume + re-attach + wait, then complete: {:?}",
            second_job.error
        );
        // The reviewer thread was re-attached (has a runtime again).
        assert!(
            app.relay
                .read()
                .await
                .runtime_for_thread(&reviewer)
                .is_some(),
            "the reused reviewer thread should be re-attached with a runtime"
        );
        // It was resumed with the reviewer's READ-ONLY sandbox before the turn — not
        // the parent's writable settings. (Codex applies the sandbox on thread/resume.)
        let resumes = codex.resumes.lock().await.clone();
        let resumed = resumes
            .iter()
            .find(|(tid, _, _)| tid == &reviewer)
            .expect("the reviewer thread must be resumed after a restart");
        assert_eq!(
            resumed.1, "never",
            "reviewer must resume with `never` approval"
        );
        assert_eq!(
            resumed.2, "read-only",
            "reviewer must resume with the read-only sandbox"
        );
        // The review was posted back to the parent.
        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert!(
            turns.iter().any(|(tid, text)| tid == &parent.id
                && text.contains("review result from reviewer thread")),
            "the fresh review should be posted back: {turns:?}"
        );
    }

    // R2b: a reviewer thread whose persisted settings were flipped to a WRITABLE
    // sandbox (after its review went terminal and unlocked) must be re-forced to the
    // read-only reviewer policy on reuse — both at the provider (resume) and in the
    // relay's settings. The read-only policy is never trusted from persisted settings.
    #[tokio::test]
    async fn review_reuse_re_enforces_read_only_over_writable_settings() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;

        let first = app
            .request_review(review_input("codex"))
            .await
            .expect("first review should start");
        let first_job = wait_for_review(&app, &first.review_job_id).await;
        let reviewer = first_job
            .reviewer_thread_id
            .clone()
            .expect("reviewer thread id");
        wait_for_active_turn_idle(&app).await;

        // The (now terminal, unlocked) reviewer is resumed by a user and flipped to a
        // writable sandbox, which persists in thread_settings.
        {
            let mut relay = app.relay.write().await;
            relay.remember_thread_settings(
                &reviewer,
                "bypass",
                "danger-full-access",
                "medium",
                "codex-model",
            );
        }

        let mut reuse = review_input("codex");
        reuse.reviewer_thread_id = Some(reviewer.clone());
        let second = app
            .request_review(reuse)
            .await
            .expect("reuse review should start");
        let second_job = wait_for_review(&app, &second.review_job_id).await;
        assert_eq!(
            second_job.status, "complete",
            "reuse job failed: {:?}",
            second_job.error
        );

        // The reviewer was re-resumed with the read-only policy, NOT the writable
        // settings a user had left on it.
        let resumes = providers.get("codex").unwrap().resumes.lock().await.clone();
        let resumed = resumes
            .iter()
            .rev()
            .find(|(tid, _, _)| tid == &reviewer)
            .expect("the reused reviewer must be resumed");
        assert_eq!(
            resumed.1, "never",
            "reviewer must be forced to `never` approval"
        );
        assert_eq!(
            resumed.2, "read-only",
            "reviewer must be forced to the read-only sandbox"
        );
        // The relay's persisted settings were corrected away from the writable values.
        let settings = app
            .relay
            .read()
            .await
            .thread_settings(&reviewer)
            .expect("reviewer settings");
        assert_eq!(settings.approval_policy, "never");
        assert_eq!(settings.sandbox, "read-only");
    }

    // R3: a reused reviewer keeps its OWN model/effort, not the parent's session model.
    #[tokio::test]
    async fn review_reuse_keeps_reviewer_model() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;

        // The reviewer thread is created with a distinct, explicit model.
        let mut first_input = review_input("codex");
        first_input.reviewer_model = Some("codex-special".to_string());
        let first = app
            .request_review(first_input)
            .await
            .expect("first review should start");
        let first_job = wait_for_review(&app, &first.review_job_id).await;
        let reviewer = first_job
            .reviewer_thread_id
            .clone()
            .expect("reviewer thread id");
        wait_for_active_turn_idle(&app).await;

        // Reuse with NO model in the request.
        let mut reuse = review_input("codex");
        reuse.reviewer_thread_id = Some(reviewer.clone());
        let second = app
            .request_review(reuse)
            .await
            .expect("reuse review should start");
        let second_job = wait_for_review(&app, &second.review_job_id).await;
        assert_eq!(
            second_job.status, "complete",
            "reuse job failed: {:?}",
            second_job.error
        );

        // The reuse turn on the reviewer thread ran with the reviewer's OWN model,
        // not the parent's session model.
        let turn_models = providers
            .get("codex")
            .unwrap()
            .turn_models
            .lock()
            .await
            .clone();
        let reviewer_turn_model = turn_models
            .iter()
            .filter(|(tid, _, _)| tid == &reviewer)
            .last()
            .map(|(_, model, _)| model.clone())
            .expect("a reviewer turn should have run");
        assert_eq!(
            reviewer_turn_model, "codex-special",
            "the reuse turn must keep the reviewer's own model: {turn_models:?}"
        );
    }

    // A reused reviewer now honors an EXPLICIT model + effort override from the
    // request (the user can re-review with a different model/effort), instead of
    // silently keeping the thread's own.
    #[tokio::test]
    async fn review_reuse_honors_model_and_effort_override() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;

        let mut first_input = review_input("codex");
        first_input.reviewer_model = Some("codex-special".to_string());
        let first = app
            .request_review(first_input)
            .await
            .expect("first review should start");
        let first_job = wait_for_review(&app, &first.review_job_id).await;
        let reviewer = first_job
            .reviewer_thread_id
            .clone()
            .expect("reviewer thread id");
        wait_for_active_turn_idle(&app).await;

        // Reuse WITH an explicit model + effort override.
        let mut reuse = review_input("codex");
        reuse.reviewer_thread_id = Some(reviewer.clone());
        reuse.reviewer_model = Some("codex-override".to_string());
        reuse.reviewer_effort = Some("high".to_string());
        let second = app
            .request_review(reuse)
            .await
            .expect("reuse review should start");
        let second_job = wait_for_review(&app, &second.review_job_id).await;
        assert_eq!(
            second_job.status, "complete",
            "reuse job failed: {:?}",
            second_job.error
        );

        let turn_models = providers
            .get("codex")
            .unwrap()
            .turn_models
            .lock()
            .await
            .clone();
        let (model, effort) = turn_models
            .iter()
            .filter(|(tid, _, _)| tid == &reviewer)
            .last()
            .map(|(_, model, effort)| (model.clone(), effort.clone()))
            .expect("a reviewer turn should have run");
        assert_eq!(
            model, "codex-override",
            "the reuse turn must use the override model: {turn_models:?}"
        );
        assert_eq!(
            effort, "high",
            "the reuse turn must use the override effort: {turn_models:?}"
        );
    }

    // R4: after a restart, a wrong provider hint must still be rejected even though
    // the provider is re-derived by probing.
    #[tokio::test]
    async fn review_reuse_after_restart_rejects_provider_mismatch() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex", "claude_code"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let first = app
            .request_review(review_input("codex"))
            .await
            .expect("first review should start");
        let first_job = wait_for_review(&app, &first.review_job_id).await;
        let reviewer = first_job
            .reviewer_thread_id
            .clone()
            .expect("reviewer thread id");
        wait_for_active_turn_idle(&app).await;

        // Simulate a restart where ALL in-process state is gone — runtime, cache row, AND
        // review jobs (none are persisted; only the reviewer→parent map is durable) — so the
        // provider must be re-derived by probing.
        {
            let mut relay = app.relay.write().await;
            relay.runtimes.remove(&reviewer);
            relay.threads.retain(|thread| thread.id != reviewer);
            relay.review_jobs.clear();
            assert!(relay.reviewer_thread_provider(&reviewer).is_none());
            // Still owned by the parent in the durable map.
            assert!(relay
                .reviewer_threads_of_parent(&parent.id)
                .contains(&reviewer));
        }

        // The reviewer actually runs on codex; a claude_code hint must be rejected.
        let mut input = review_input("claude_code");
        input.reviewer_thread_id = Some(reviewer.clone());
        let error = app
            .request_review(input)
            .await
            .expect_err("a post-restart provider mismatch should be rejected");
        assert!(error.contains("does not match"), "got: {error}");
    }

    // F-E: a parent keeps at most MAX_REVIEWERS_PER_PARENT reviewer threads; the
    // oldest is evicted (FIFO) and permanently deleted once the cap is exceeded.
    #[tokio::test]
    async fn review_caps_reviewers_per_parent_and_evicts_oldest() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let cap = crate::state::MAX_REVIEWERS_PER_PARENT;
        // Run one more clean review than the cap; each spawns a new reviewer thread.
        let mut created = Vec::new();
        for _ in 0..(cap + 1) {
            let receipt = app
                .request_review(review_input("codex"))
                .await
                .expect("review should start");
            let job = wait_for_review(&app, &receipt.review_job_id).await;
            assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
            created.push(job.reviewer_thread_id.clone().expect("reviewer thread id"));
            wait_for_active_turn_idle(&app).await;
        }
        assert_eq!(created.len(), cap + 1);

        // The parent keeps exactly the cap; the extra (oldest) reviewer was evicted.
        let kept = app
            .relay
            .read()
            .await
            .reviewer_threads_of_parent(&parent.id);
        assert_eq!(
            kept.len(),
            cap,
            "parent should keep exactly the cap of reviewers"
        );

        // The evicted reviewer is exactly the OLDEST (first created) one — true FIFO,
        // deterministic via the registration seq — and it's gone from the durable map
        // AND permanently deleted from the provider.
        let evicted: Vec<&String> = created.iter().filter(|id| !kept.contains(id)).collect();
        assert_eq!(
            evicted,
            vec![&created[0]],
            "the single oldest reviewer is evicted (FIFO): created={created:?} kept={kept:?}"
        );
        let provider_threads = providers.get("codex").unwrap().threads.lock().await;
        assert!(
            !provider_threads.contains_key(&created[0]),
            "the evicted (oldest) reviewer thread must be deleted from the provider"
        );
        for id in &kept {
            assert!(
                provider_threads.contains_key(id),
                "kept reviewer {id} should still exist on the provider"
            );
        }
    }

    // --- Phase 5: iterative review loop ----------------------------------------

    async fn queue_verdicts(provider: &ReviewTestProvider, verdicts: &[&str]) {
        let mut queue = provider.reviewer_verdicts.lock().await;
        for verdict in verdicts {
            queue.push_back(verdict.to_string());
        }
    }

    fn count_turns_with(turns: &[(String, String)], marker: &str) -> usize {
        turns
            .iter()
            .filter(|(_, text)| text.contains(marker))
            .count()
    }

    async fn wait_for_provider_turn(provider: &ReviewTestProvider, marker: &str) {
        for _ in 0..400 {
            if provider
                .turns
                .lock()
                .await
                .iter()
                .any(|(_, text)| text.contains(marker))
            {
                return;
            }
            sleep(Duration::from_millis(10)).await;
        }
        panic!("provider never received a turn containing `{marker}`");
    }

    // --- Workflow runner (chunk 6) ---------------------------------------------
    // Reuses the review harness: ReviewTestProvider already replies to the runner's
    // reviewer_prompt (the "Workspace diff collected by the relay" marker) with the
    // queued verdict, and to author turns (execute/revise) with a generic reply.

    /// A canonical Code-Flow workflow with all steps on `provider`.
    fn workflow_code_flow(provider: &str, max_rounds: u32) -> crate::state::Workflow {
        use crate::state::{ArtifactKind, LoopSpec, StepRole, Workflow, WorkflowStep};
        let mk = |id: &str, role: StepRole| WorkflowStep {
            id: id.to_string(),
            agent: provider.to_string(),
            role,
            model: None,
            prompt: String::new(),
        };
        Workflow {
            id: "code".to_string(),
            name: "Code Flow".to_string(),
            artifact: ArtifactKind::Diff,
            steps: vec![
                mk("execute", StepRole::Execute),
                mk("review", StepRole::Review),
                mk("revise", StepRole::Revise),
            ],
            loop_: Some(LoopSpec {
                from_step: "review".to_string(),
                to_step: "revise".to_string(),
                max_rounds,
                stop_when: crate::state::StopCondition::ReviewerApproved,
            }),
        }
    }

    async fn wait_for_workflow_status(app: &AppState, run_id: &str, statuses: &[&str]) -> String {
        for _ in 0..400 {
            if let Some(status) = app
                .relay
                .read()
                .await
                .workflow_run(run_id)
                .map(|run| run.status.as_str().to_string())
            {
                if statuses.contains(&status.as_str()) {
                    return status;
                }
            }
            sleep(Duration::from_millis(10)).await;
        }
        panic!("workflow run {run_id} never reached {statuses:?}");
    }

    const WORKFLOW_TERMINAL: &[&str] = &["done", "escalated", "failed", "interrupted", "cancelled"];

    async fn wait_for_task_list_status(app: &AppState, run_id: &str, statuses: &[&str]) -> String {
        for _ in 0..800 {
            if let Some(status) = app
                .relay
                .read()
                .await
                .task_list_run(run_id)
                .map(|run| run.status.as_str().to_string())
            {
                if statuses.contains(&status.as_str()) {
                    return status;
                }
            }
            sleep(Duration::from_millis(10)).await;
        }
        panic!("task list {run_id} never reached {statuses:?}");
    }

    #[tokio::test]
    async fn task_list_runs_two_tasks_serially_to_done() {
        use crate::state::{CheckpointMode, EscalatePolicy, TaskItem};
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        // Each task's Code Flow is execute -> review APPROVE -> Done, so two tasks
        // consume two reviewer verdicts. If the driver ran them concurrently (or
        // skipped one) the counts below would be wrong.
        queue_verdicts(providers.get("codex").unwrap(), &["APPROVE", "APPROVE"]).await;

        let tasks = vec![
            TaskItem::new("t0", "do task 0", "codex", None, None, 1),
            TaskItem::new("t1", "do task 1", "codex", None, None, 1),
        ];
        let run_id = app
            .start_task_list(
                Some("device-1".to_string()),
                "Nightly".to_string(),
                tasks,
                None,
                EscalatePolicy::Halt,
                CheckpointMode::None,
                String::new(),
            )
            .await
            .expect("task list should start");

        let status =
            wait_for_task_list_status(&app, &run_id, &["done", "escalated", "failed"]).await;
        assert_eq!(status, "done", "both tasks approved -> list Done");

        let relay = app.relay.read().await;
        let run = relay.task_list_run(&run_id).expect("run exists");
        assert_eq!(run.done_count(), 2, "both tasks reached Done");
        assert_eq!(run.current_index, 2, "cursor advanced past both tasks");
        assert!(
            run.tasks.iter().all(|task| task.child_run_id.is_some()),
            "each task recorded the child workflow that ran it"
        );
    }

    #[tokio::test]
    async fn task_list_halts_and_skips_remaining_on_escalation() {
        use crate::state::{CheckpointMode, EscalatePolicy, TaskItem, TaskStatus};
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        // Task 0's single review round is NEEDS_CHANGES -> escalates (max_rounds=1).
        // Only ONE verdict is queued: task 1 must never run, so it never consumes one.
        queue_verdicts(providers.get("codex").unwrap(), &["NEEDS_CHANGES"]).await;

        let tasks = vec![
            TaskItem::new("t0", "do task 0", "codex", None, None, 1),
            TaskItem::new("t1", "do task 1", "codex", None, None, 1),
        ];
        let run_id = app
            .start_task_list(
                Some("device-1".to_string()),
                "Halt list".to_string(),
                tasks,
                None,
                EscalatePolicy::Halt,
                CheckpointMode::None,
                String::new(),
            )
            .await
            .expect("task list should start");

        let status =
            wait_for_task_list_status(&app, &run_id, &["done", "escalated", "failed"]).await;
        assert_eq!(
            status, "escalated",
            "escalation under Halt -> list Escalated"
        );

        let relay = app.relay.read().await;
        let run = relay.task_list_run(&run_id).expect("run exists");
        assert_eq!(run.tasks[0].status, TaskStatus::Escalated);
        assert_eq!(
            run.tasks[1].status,
            TaskStatus::Skipped,
            "the later task is skipped by the halt"
        );
        assert!(
            run.tasks[1].child_run_id.is_none(),
            "a skipped task never started a workflow"
        );
        assert_eq!(run.done_count(), 0);
    }

    #[tokio::test]
    async fn workflow_completes_after_revise_then_approve() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        // Round 1 reviewer rejects -> revise; round 2 approves -> Done.
        queue_verdicts(
            providers.get("codex").unwrap(),
            &["NEEDS_CHANGES", "APPROVE"],
        )
        .await;

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");

        let status = wait_for_workflow_status(&app, &run_id, WORKFLOW_TERMINAL).await;
        assert_eq!(status, "done", "approved on round 2 -> Done");

        let (round, approved) = {
            let relay = app.relay.read().await;
            let run = relay.workflow_run(&run_id).expect("run exists");
            (run.round, run.last_verdict.as_ref().map(|v| v.approved))
        };
        assert_eq!(round, 2, "one rejected round, then approved");
        assert_eq!(approved, Some(true));

        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert_eq!(
            count_turns_with(&turns, "Workspace diff collected by the relay"),
            2,
            "two reviews (round 1 + round 2)"
        );
        assert_eq!(
            count_turns_with(&turns, "Address the findings below"),
            1,
            "one revise, after the round-1 rejection"
        );
    }

    #[tokio::test]
    async fn start_code_workflow_builds_builtin_and_surfaces_snapshot_card() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        queue_verdicts(providers.get("codex").unwrap(), &["APPROVE"]).await;

        let receipt = app
            .start_code_workflow(StartWorkflowInput {
                workflow_id: Some("code_flow".to_string()),
                task_prompt: "implement the retry fix".to_string(),
                reviewer_provider: "codex".to_string(),
                reviewer_model: None,
                reviewer_instructions: Some("focus on regression coverage".to_string()),
                max_rounds: Some(2),
                anchor_item_id: Some("anchor-item".to_string()),
                parent_thread_id: None,
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("code flow should start");

        assert_eq!(receipt.parent_thread_id, parent.id);
        assert_eq!(receipt.status.status, "queued");

        let status =
            wait_for_workflow_status(&app, &receipt.workflow_run_id, WORKFLOW_TERMINAL).await;
        assert_eq!(status, "done");

        let snapshot = app.snapshot().await;
        let view = snapshot
            .active_workflow_runs
            .iter()
            .find(|run| run.id == receipt.workflow_run_id)
            .expect("workflow run should be in snapshot");
        assert_eq!(view.workflow_id, "code_flow");
        assert_eq!(view.parent_thread_id, parent.id);
        assert_eq!(view.round, 1);
        assert_eq!(view.last_verdict.as_ref().map(|v| v.approved), Some(true));

        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert!(
            turns
                .iter()
                .any(|(_, text)| text.contains("implement the retry fix")),
            "author execute prompt should carry the submitted task"
        );
        assert!(
            turns
                .iter()
                .any(|(_, text)| text.contains("focus on regression coverage")),
            "reviewer prompt should carry the submitted review instructions"
        );
    }

    #[tokio::test]
    async fn start_code_workflow_honors_parent_thread_id() {
        // Code Flow must run on the NAMED author thread (mirroring how Request review
        // targets the viewed thread), not silently on the active thread. A bogus id is
        // the discriminator: the pre-parity runner ignored the field entirely, so it
        // could not reject; the parity runner resolves it and refuses.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let bogus = app
            .start_code_workflow(StartWorkflowInput {
                workflow_id: Some("code_flow".to_string()),
                task_prompt: "do it".to_string(),
                reviewer_provider: "codex".to_string(),
                reviewer_model: None,
                reviewer_instructions: None,
                max_rounds: Some(1),
                anchor_item_id: None,
                parent_thread_id: Some("no-such-thread".to_string()),
                device_id: Some("device-1".to_string()),
            })
            .await;
        // Rejected at the `thread_cwd` gate — BEFORE `find_thread_provider` could
        // enumerate providers (the security fix: no cheap-DoS / existence oracle for a
        // bogus id). The specific message pins that ordering, not just "some error".
        let bogus_err = bogus.expect_err("a nonexistent parent thread must be rejected");
        assert!(
            bogus_err.contains("cannot resolve the thread"),
            "bogus parent must be rejected by the local thread lookup (pre-probe), got: {bogus_err}"
        );

        // Explicitly naming the real (here active) author thread is honored and runs.
        queue_verdicts(providers.get("codex").unwrap(), &["APPROVE"]).await;
        let receipt = app
            .start_code_workflow(StartWorkflowInput {
                workflow_id: Some("code_flow".to_string()),
                task_prompt: "do it".to_string(),
                reviewer_provider: "codex".to_string(),
                reviewer_model: None,
                reviewer_instructions: None,
                max_rounds: Some(1),
                anchor_item_id: None,
                parent_thread_id: Some(parent.id.clone()),
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("named-parent code flow should start");
        assert_eq!(receipt.parent_thread_id, parent.id);
        let status =
            wait_for_workflow_status(&app, &receipt.workflow_run_id, WORKFLOW_TERMINAL).await;
        assert_eq!(status, "done");
    }

    #[tokio::test]
    async fn start_code_workflow_refused_when_another_thread_writes_the_same_workspace() {
        // Code Flow's author WRITES the tree, so it must refuse while ANOTHER thread is
        // working the same workspace — even though the frontend now enables the button on
        // an idle viewed thread. This is the intentional "enable then error" the review
        // flagged: two writers on one tree corrupt the diff, so we reject at start.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        // A different background thread is mid-turn in the SAME workspace. Use the
        // PARENT's resolved cwd (start_session may canonicalize the path, e.g. macOS
        // /tmp -> /private/...) so it matches the cwd the guard checks.
        let workspace = parent.cwd.clone();
        {
            let mut relay = app.relay.write().await;
            relay.register_background_thread(
                ThreadSummaryView {
                    id: "codex-busy".to_string(),
                    name: None,
                    preview: String::new(),
                    cwd: workspace.clone(),
                    updated_at: unix_now(),
                    source: "codex".to_string(),
                    status: "active".to_string(),
                    model_provider: "codex".to_string(),
                    provider: "codex".to_string(),
                    forked_from: None,
                },
                &workspace,
                "gpt-5.5",
                "never",
                "workspace-write",
                "medium",
            );
            relay.bg_set_active_turn("codex-busy", Some("turn-x".to_string()), unix_now());
            relay.bg_set_thread_status("codex-busy", "active".to_string(), Vec::new(), unix_now());
        }

        let err = app
            .start_code_workflow(StartWorkflowInput {
                workflow_id: Some("code_flow".to_string()),
                task_prompt: "do it".to_string(),
                reviewer_provider: "codex".to_string(),
                reviewer_model: None,
                reviewer_instructions: None,
                max_rounds: Some(1),
                anchor_item_id: None,
                parent_thread_id: Some(parent.id.clone()),
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect_err("must refuse while another thread writes the same workspace");
        assert!(
            err.contains("another thread is running in this workspace"),
            "got: {err}"
        );
    }

    // Sibling of the review-gate bug, SAME root cause: start_workflow's status gate is
    // the literal `current_status != "idle"` (workflow.rs), while its cwd-quiet check went
    // semantic — so a saved Codex thread ("unknown"/"completed", no live turn) hits the
    // exact mixed literal/semantic gate-pair the original report complained about and
    // can't launch a workflow. Now green: workflow.rs uses the semantic
    // `active_agent_is_working`. Loops the full Codex terminal vocabulary.
    #[tokio::test]
    async fn workflow_starts_when_codex_reports_a_non_idle_saved_status() {
        for saved_status in ["unknown", "completed"] {
            let dir = TempDir::new().expect("tmpdir");
            let cwd = dir.path().to_str().unwrap();
            let (app, providers) = build_review_app(cwd, &["codex"]).await;
            let parent = start_parent(&app, cwd, "codex").await;
            queue_verdicts(providers.get("codex").unwrap(), &["APPROVE"]).await;

            // Saved Codex thread, not running: no live turn, non-idle status string.
            {
                let mut relay = app.relay.write().await;
                relay.set_active_turn(None);
                relay.set_thread_status(&parent.id, saved_status.to_string(), Vec::new());
            }

            let run_id = app
                .start_workflow(
                    Some("device-1".to_string()),
                    workflow_code_flow("codex", 2),
                    "anchor-item".to_string(),
                    None,
                )
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "status `{saved_status}`: a not-running Codex thread must allow a \
workflow: {error}"
                    )
                });
            let status = wait_for_workflow_status(&app, &run_id, WORKFLOW_TERMINAL).await;
            assert_eq!(
                status, "done",
                "status `{saved_status}` workflow should complete"
            );
        }
    }

    // Sibling of the review-gate bug, SAME root cause: update_session_settings' status gate
    // is the literal `runtime.current_status != "idle"` (sessions.rs), so a saved Codex
    // thread ("unknown"/"completed") has its model/effort/approval/sandbox permanently
    // locked. Now green: sessions.rs uses the semantic per-runtime `is_working()` check.
    #[tokio::test]
    async fn session_settings_update_when_codex_reports_a_non_idle_saved_status() {
        for saved_status in ["unknown", "completed"] {
            let dir = TempDir::new().expect("tmpdir");
            let cwd = dir.path().to_str().unwrap();
            let (app, _providers) = build_review_app(cwd, &["codex"]).await;
            let parent = start_parent(&app, cwd, "codex").await;

            {
                let mut relay = app.relay.write().await;
                relay.set_active_turn(None);
                relay.set_thread_status(&parent.id, saved_status.to_string(), Vec::new());
            }

            let snap = app
                .update_session_settings(UpdateSessionSettingsInput {
                    approval_policy: Some("bypass".to_string()),
                    sandbox: Some("danger-full-access".to_string()),
                    effort: Some("low".to_string()),
                    model: None,
                    device_id: Some("device-1".to_string()),
                    thread_id: parent.id.clone(),
                })
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "status `{saved_status}`: a not-running Codex thread must allow a \
settings update: {error}"
                    )
                });

            // Read back: the update must actually TAKE EFFECT, not merely return Ok.
            assert_eq!(
                snap.approval_policy, "bypass",
                "status `{saved_status}`: approval_policy must persist"
            );
            assert_eq!(
                snap.sandbox, "danger-full-access",
                "status `{saved_status}`: sandbox must persist"
            );
            assert_eq!(
                snap.reasoning_effort, "low",
                "status `{saved_status}`: effort must persist"
            );
        }
    }

    // Negative gate-wiring guard: closing the loop on the two semantic migrations above,
    // a genuinely-WORKING status (no live turn id yet — the pre-turn-id window) must STILL
    // block both gates. Without this, deleting the gate line entirely would slip past the
    // positive repros (which only exercise not-working statuses). Mirrors the C5-reverse
    // semantics: `active` + no turn = working.
    #[tokio::test]
    async fn workflow_and_settings_blocked_when_agent_status_is_working() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        // A working status with NO live turn id (provider reported "active" before the
        // turn id surfaced) — the gates must read this as busy.
        {
            let mut relay = app.relay.write().await;
            relay.set_active_turn(None);
            relay.set_thread_status(&parent.id, "active".to_string(), Vec::new());
        }

        let workflow_err = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 2),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect_err("a working status must still block start_workflow");
        assert!(
            workflow_err.contains("while the agent is `active`"),
            "got: {workflow_err}"
        );

        let settings_err = app
            .update_session_settings(UpdateSessionSettingsInput {
                approval_policy: Some("bypass".to_string()),
                sandbox: Some("danger-full-access".to_string()),
                effort: Some("low".to_string()),
                model: None,
                device_id: Some("device-1".to_string()),
                thread_id: parent.id.clone(),
            })
            .await
            .expect_err("a working status must still block update_session_settings");
        assert!(
            settings_err.contains("while agent is `active`"),
            "got: {settings_err}"
        );
    }

    #[tokio::test]
    async fn workflow_escalates_when_budget_runs_out() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        // Never approves within the 2-round budget.
        queue_verdicts(
            providers.get("codex").unwrap(),
            &["NEEDS_CHANGES", "NEEDS_CHANGES"],
        )
        .await;

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 2),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");

        let status = wait_for_workflow_status(&app, &run_id, WORKFLOW_TERMINAL).await;
        assert_eq!(status, "escalated", "budget exhausted without approval");

        let (round, findings) = {
            let relay = app.relay.read().await;
            let run = relay.workflow_run(&run_id).unwrap();
            (
                run.round,
                run.last_verdict
                    .as_ref()
                    .map(|verdict| verdict.findings.clone())
                    .unwrap_or_default(),
            )
        };
        assert_eq!(round, 2, "ran both rounds");
        assert!(
            findings
                .first()
                .is_some_and(|text| text.contains("VERDICT: NEEDS_CHANGES")),
            "final negative review should be retained for the workflow card: {findings:?}"
        );
    }

    #[tokio::test]
    async fn workflow_max_rounds_one_surfaces_final_negative_review() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        queue_verdicts(providers.get("codex").unwrap(), &["NEEDS_CHANGES"]).await;

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 1),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");

        let status = wait_for_workflow_status(&app, &run_id, WORKFLOW_TERMINAL).await;
        assert_eq!(status, "escalated");

        let snapshot = app.snapshot().await;
        let view = snapshot
            .active_workflow_runs
            .iter()
            .find(|run| run.id == run_id)
            .expect("workflow card should remain visible");
        let verdict = view
            .last_verdict
            .as_ref()
            .expect("verdict should be visible");
        assert_eq!(verdict.approved, false);
        assert!(
            verdict
                .findings
                .first()
                .is_some_and(|text| text.contains("VERDICT: NEEDS_CHANGES")),
            "final reviewer findings should be exposed in the workflow card: {:?}",
            verdict.findings
        );
    }

    #[tokio::test]
    async fn workflow_drains_and_fails_on_lost_reviewer_start() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // The double won't settle the thread on stop, so cap the drain wait.
        app.set_workflow_drain_max_ms(50);
        let _parent = start_parent(&app, cwd, "codex").await;
        let provider = providers.get("codex").unwrap();
        // The reviewer turn starts work, then its start response is lost (Err).
        provider.fail_reviewer_start.store(true, Ordering::Relaxed);

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");

        let status = wait_for_workflow_status(&app, &run_id, WORKFLOW_TERMINAL).await;
        assert_eq!(status, "failed", "a lost reviewer start fails the run");

        // The runner requested a stop on the reviewer thread before going terminal,
        // so a started-but-lost turn can't keep running afterward.
        let reviewer = app
            .relay
            .read()
            .await
            .workflow_run(&run_id)
            .unwrap()
            .step_threads
            .get("review")
            .cloned()
            .expect("reviewer thread recorded");
        let interrupted = provider.interrupts.lock().await.clone();
        assert!(
            interrupted.contains(&reviewer),
            "the lost reviewer turn must be stopped before the run goes terminal"
        );
    }

    #[tokio::test]
    async fn workflow_blocks_when_uncertain_turn_cannot_confirm_stopped() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_workflow_drain_max_ms(50);
        let _parent = start_parent(&app, cwd, "codex").await;
        let provider = providers.get("codex").unwrap();
        provider.fail_reviewer_start.store(true, Ordering::Relaxed);
        provider.interrupt_fails.store(true, Ordering::Relaxed);

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");

        let status = wait_for_workflow_status(&app, &run_id, &["blocked"]).await;
        assert_eq!(status, "blocked");
        let relay = app.relay.read().await;
        let run = relay.workflow_run(&run_id).expect("run exists");
        assert!(
            relay.is_thread_workflow_locked(&run.parent_thread_id),
            "blocked workflow should keep parent thread locked"
        );
        assert!(
            relay.is_cwd_workflow_locked(&run.cwd),
            "blocked workflow should keep the workspace locked"
        );
        assert!(run
            .error
            .as_deref()
            .is_some_and(|error| { error.contains("did not confirm stopping") }));
    }

    #[tokio::test]
    async fn workflow_lifeguard_blocks_when_author_panic_cannot_confirm_stopped() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_workflow_drain_max_ms(50);
        let _parent = start_parent(&app, cwd, "codex").await;
        let provider = providers.get("codex").unwrap();
        provider
            .panic_after_author_start
            .store(true, Ordering::Relaxed);
        provider.interrupt_fails.store(true, Ordering::Relaxed);

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");

        let status = wait_for_workflow_status(&app, &run_id, &["blocked"]).await;
        assert_eq!(status, "blocked");
        let relay = app.relay.read().await;
        let run = relay.workflow_run(&run_id).expect("run exists");
        assert!(
            relay.is_thread_workflow_locked(&run.parent_thread_id),
            "lifeguard-blocked workflow should keep parent thread locked"
        );
        assert!(
            relay.is_cwd_workflow_locked(&run.cwd),
            "lifeguard-blocked workflow should keep workspace locked"
        );
        assert!(run.error.as_deref().is_some_and(|error| {
            error.contains("ended unexpectedly") && error.contains("did not confirm stopping")
        }));
    }

    #[tokio::test]
    async fn resolve_blocked_workflow_unlocks_after_owned_turns_stop() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_workflow_drain_max_ms(50);
        let _parent = start_parent(&app, cwd, "codex").await;
        let provider = providers.get("codex").unwrap();
        provider.fail_reviewer_start.store(true, Ordering::Relaxed);
        provider.interrupt_fails.store(true, Ordering::Relaxed);

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");
        wait_for_workflow_status(&app, &run_id, &["blocked"]).await;

        provider.interrupt_fails.store(false, Ordering::Relaxed);
        let receipt = app
            .resolve_blocked_workflow(WorkflowActionInput {
                workflow_run_id: Some(run_id.clone()),
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("blocked workflow should resolve once owned turns can stop");
        assert_eq!(receipt.status.status, "failed");

        let relay = app.relay.read().await;
        let run = relay.workflow_run(&run_id).expect("run exists");
        assert_eq!(run.status.as_str(), "failed");
        assert!(
            !relay.is_cwd_workflow_locked(&run.cwd),
            "resolved workflow should release workspace lock"
        );
        assert!(
            !relay.is_thread_workflow_locked(&run.parent_thread_id),
            "resolved workflow should release parent thread lock"
        );
    }

    #[tokio::test]
    async fn concurrent_workflow_recovery_rejects_duplicate_before_draining() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_workflow_drain_max_ms(200);
        let parent = start_parent(&app, cwd, "codex").await;
        let provider = providers.get("codex").unwrap();
        provider.fail_reviewer_start.store(true, Ordering::Relaxed);
        provider.interrupt_fails.store(true, Ordering::Relaxed);

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");
        wait_for_workflow_status(&app, &run_id, &["blocked"]).await;

        let first_app = app.clone();
        let first_run_id = run_id.clone();
        let first = tokio::spawn(async move {
            first_app
                .resolve_blocked_workflow(WorkflowActionInput {
                    workflow_run_id: Some(first_run_id),
                    device_id: Some("device-1".to_string()),
                })
                .await
        });
        wait_for_workflow_status(&app, &run_id, &["resolving"]).await;

        let duplicate = app
            .resolve_blocked_workflow(WorkflowActionInput {
                workflow_run_id: Some(run_id.clone()),
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect_err("duplicate recovery must be rejected before it can drain threads");
        assert!(
            duplicate.contains("already resolving"),
            "unexpected duplicate recovery error: {duplicate}"
        );

        provider.interrupt_fails.store(false, Ordering::Relaxed);
        let receipt = first
            .await
            .expect("recovery task joins")
            .expect("first recovery should resolve once the provider later confirms stopping");
        assert_eq!(receipt.status.status, "failed");

        provider.interrupts.lock().await.clear();
        provider.complete_turns.store(false, Ordering::Relaxed);
        app.send_message(SendMessageInput {
            text: "new work after recovery".to_string(),
            model: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            thread_id: parent.id.clone(),
        })
        .await
        .expect("the resolved workflow should unlock the parent for new work");

        sleep(Duration::from_millis(50)).await;
        assert!(
            provider.interrupts.lock().await.is_empty(),
            "the rejected duplicate recovery must not retain a drain future that can stop new work"
        );
    }

    #[tokio::test]
    async fn aborted_workflow_recovery_restores_blocked_and_can_retry() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_workflow_drain_max_ms(250);
        let _parent = start_parent(&app, cwd, "codex").await;
        let provider = providers.get("codex").unwrap();
        provider.fail_reviewer_start.store(true, Ordering::Relaxed);
        provider.interrupt_fails.store(true, Ordering::Relaxed);

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");
        wait_for_workflow_status(&app, &run_id, &["blocked"]).await;

        let recovery_app = app.clone();
        let recovery_run_id = run_id.clone();
        let recovery = tokio::spawn(async move {
            recovery_app
                .resolve_blocked_workflow(WorkflowActionInput {
                    workflow_run_id: Some(recovery_run_id),
                    device_id: Some("device-1".to_string()),
                })
                .await
        });
        wait_for_workflow_status(&app, &run_id, &["resolving"]).await;
        recovery.abort();
        let _ = recovery.await;

        wait_for_workflow_status(&app, &run_id, &["blocked"]).await;
        {
            let relay = app.relay.read().await;
            let run = relay.workflow_run(&run_id).expect("run exists");
            assert!(
                relay.is_cwd_workflow_locked(&run.cwd),
                "aborted recovery must restore a non-terminal lock"
            );
        }

        provider.interrupt_fails.store(false, Ordering::Relaxed);
        let receipt = app
            .resolve_blocked_workflow(WorkflowActionInput {
                workflow_run_id: Some(run_id.clone()),
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("restored blocked workflow should be recoverable");
        assert_eq!(receipt.status.status, "failed");
    }

    #[tokio::test]
    async fn workflow_author_approval_cleanup_clears_interactions() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        let provider = providers.get("codex").unwrap();
        provider.raise_approval.store(true, Ordering::Relaxed);

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");

        let status = wait_for_workflow_status(&app, &run_id, WORKFLOW_TERMINAL).await;
        assert_eq!(status, "failed");
        assert!(
            app.relay.read().await.pending_approvals.is_empty(),
            "workflow cleanup should clear author approvals"
        );
        assert!(
            provider.interrupts.lock().await.contains(&parent.id),
            "workflow cleanup should stop the parked author turn"
        );
    }

    #[tokio::test]
    async fn workflow_reviewer_ask_user_cleanup_clears_interactions() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        let provider = providers.get("codex").unwrap();
        provider
            .ask_user_on_reviewer_turn
            .store(true, Ordering::Relaxed);

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");

        let status = wait_for_workflow_status(&app, &run_id, WORKFLOW_TERMINAL).await;
        assert_eq!(status, "failed");
        assert!(
            app.relay.read().await.pending_ask_user_questions.is_empty(),
            "workflow cleanup should clear reviewer AskUser questions"
        );
    }

    #[tokio::test]
    async fn workflow_locks_parent_and_same_cwd_threads_during_reviewer_step() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        let sibling = start_parent(&app, cwd, "codex").await;
        app.take_over_control(TakeOverInput {
            device_id: Some("device-1".to_string()),
            thread_id: parent.id.clone(),
        })
        .await
        .expect("return control to parent before workflow");

        let provider = providers.get("codex").unwrap();
        provider.complete_delay_ms.store(250, Ordering::Relaxed);
        queue_verdicts(provider, &["APPROVE"]).await;
        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 1),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");

        wait_for_provider_turn(provider, "Workspace diff collected by the relay").await;

        let send_err = app
            .send_message(SendMessageInput {
                text: "please write during review".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: parent.id.clone(),
            })
            .await
            .expect_err("parent send must be locked while workflow reviewer runs");
        assert!(send_err.contains("workflow"), "{send_err}");

        let sibling_send_err = app
            .send_message(SendMessageInput {
                text: "same cwd sibling write".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: sibling.id.clone(),
            })
            .await
            .expect_err("same-cwd sibling send must be locked while workflow runs");
        assert!(sibling_send_err.contains("workflow"), "{sibling_send_err}");

        let settings_err = app
            .update_session_settings(UpdateSessionSettingsInput {
                approval_policy: Some("bypass".to_string()),
                sandbox: None,
                effort: None,
                model: None,
                device_id: Some("device-1".to_string()),
                thread_id: parent.id.clone(),
            })
            .await
            .expect_err("settings mutation must be locked while workflow runs");
        assert!(settings_err.contains("workflow"), "{settings_err}");

        let stop_err = app
            .stop_active_turn(StopTurnInput {
                device_id: Some("device-1".to_string()),
                thread_id: parent.id.clone(),
            })
            .await
            .expect_err("user stop must be locked while workflow owns the thread");
        assert!(stop_err.contains("workflow"), "{stop_err}");

        let takeover_err = app
            .take_over_control(TakeOverInput {
                device_id: Some("device-1".to_string()),
                thread_id: sibling.id.clone(),
            })
            .await
            .expect_err("same-cwd takeover must be locked while workflow runs");
        assert!(takeover_err.contains("workflow"), "{takeover_err}");

        let delete_err = app
            .delete_thread_permanently(&parent.id, None)
            .await
            .expect_err("delete must be locked while workflow runs");
        assert!(delete_err.contains("workflow"), "{delete_err}");

        let start_err = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("codex".to_string()),
                initial_prompt: None,
            })
            .await
            .expect_err("new same-cwd session must be locked while workflow runs");
        assert!(start_err.contains("workflow"), "{start_err}");

        let status = wait_for_workflow_status(&app, &run_id, WORKFLOW_TERMINAL).await;
        assert_eq!(status, "done");
    }

    #[tokio::test]
    async fn workflow_reviewer_thread_is_hidden_from_navigation() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        queue_verdicts(providers.get("codex").unwrap(), &["APPROVE"]).await;

        let run_id = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 1),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("workflow should start");
        wait_for_workflow_status(&app, &run_id, WORKFLOW_TERMINAL).await;

        let relay = app.relay.read().await;
        let reviewer = relay
            .workflow_run(&run_id)
            .unwrap()
            .step_threads
            .get("review")
            .cloned()
            .expect("reviewer thread recorded");
        // Hidden from navigation...
        assert!(
            relay.reviewer_thread_ids().contains(&reviewer),
            "workflow reviewer thread should be hidden from nav"
        );
        assert!(
            relay
                .reviewer_threads_of_parent(&parent.id)
                .contains(&reviewer),
            "workflow reviewer should be durably hidden through the reviewer_threads map"
        );
    }

    #[tokio::test]
    async fn workflow_and_review_are_mutually_exclusive() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        // Turns never complete, so the first workflow stays non-terminal.
        providers
            .get("codex")
            .unwrap()
            .complete_turns
            .store(false, Ordering::Relaxed);

        let _run = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect("first workflow should start");

        // A second workflow is refused...
        let err = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
                None,
            )
            .await
            .expect_err("a second workflow must be refused");
        assert!(err.contains("already running"), "{err}");

        // ...and so is a review while the workflow is active.
        let err2 = app
            .request_review(review_input("codex"))
            .await
            .expect_err("a review must be refused while a workflow runs");
        assert!(err2.contains("workflow is running"), "{err2}");
    }

    #[tokio::test]
    async fn review_loop_completes_when_reviewer_approves_first_round() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        queue_verdicts(providers.get("codex").unwrap(), &["APPROVE"]).await;

        let mut input = review_input("codex");
        input.max_rounds = Some(3);
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(job.status, "complete");
        assert_eq!(job.round, 1, "approved on the first round");
        assert_eq!(job.verdict.as_deref(), Some("approve"));
        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert_eq!(
            count_turns_with(&turns, "Workspace diff collected by the relay"),
            1,
            "one review, no re-review"
        );
        assert_eq!(
            count_turns_with(&turns, "Address the findings below"),
            0,
            "no author fix turn when approved immediately"
        );
        assert!(turns
            .iter()
            .any(|(tid, text)| tid == &parent.id && text.contains("APPROVED")));
    }

    #[tokio::test]
    async fn review_clamps_max_rounds_to_cap() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;
        queue_verdicts(providers.get("codex").unwrap(), &["APPROVE"]).await;

        let mut input = review_input("codex");
        input.max_rounds = Some(99); // absurd → clamp to the cap (10).
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(job.status, "complete");
        assert_eq!(job.max_rounds, 10, "max_rounds is clamped to the hard cap");
    }

    #[tokio::test]
    async fn review_loop_escalates_after_budget_without_approval() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        queue_verdicts(
            providers.get("codex").unwrap(),
            &["NEEDS_CHANGES", "NEEDS_CHANGES"],
        )
        .await;

        let mut input = review_input("codex");
        input.max_rounds = Some(2);
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(job.status, "escalated");
        assert_eq!(job.round, 2, "ran the full 2-round budget");
        assert_eq!(job.verdict.as_deref(), Some("needs_changes"));
        let reviewer = job.reviewer_thread_id.clone().expect("reviewer thread id");
        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert_eq!(
            turns.iter().filter(|(tid, _)| tid == &reviewer).count(),
            2,
            "both rounds re-used the SAME reviewer thread"
        );
        assert_eq!(
            count_turns_with(&turns, "Address the findings below"),
            1,
            "one author fix turn between the two rounds"
        );
        assert!(turns
            .iter()
            .any(|(tid, text)| tid == &parent.id && text.contains("still has concerns")));
        // Escalated is terminal → both threads unlock so the user can continue.
        let relay = app.relay.read().await;
        assert!(!relay.is_thread_review_locked(&parent.id));
        assert!(!relay.is_thread_review_locked(&reviewer));
    }

    #[tokio::test]
    async fn review_loop_completes_when_reviewer_approves_second_round() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;
        queue_verdicts(
            providers.get("codex").unwrap(),
            &["NEEDS_CHANGES", "APPROVE"],
        )
        .await;

        let mut input = review_input("codex");
        input.max_rounds = Some(3);
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(job.status, "complete");
        assert_eq!(job.round, 2, "approved on the second round");
        assert_eq!(job.verdict.as_deref(), Some("approve"));
        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert_eq!(
            count_turns_with(&turns, "Workspace diff collected by the relay"),
            2
        );
        assert_eq!(count_turns_with(&turns, "Address the findings below"), 1);
    }

    #[tokio::test]
    async fn review_loop_continues_when_claude_author_fix_emits_no_text() {
        // Regression: a Codex reviewer reviewing a Claude author. Round 1 is
        // NEEDS_CHANGES; the Claude author addresses the findings by EDITING files
        // but ends the turn with no trailing text block — so its worker emits no
        // `assistant_message` and the parent thread gains no fresh AgentText entry.
        // The loop used to gate the next round on a fresh author *reply* and so
        // escalated after round 1 ("codex review claude, then only 1 round"). The
        // fix turn completed normally, so the review must ADVANCE to round 2.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["claude_code", "codex"]).await;
        // Author (parent) = Claude; reviewer = Codex.
        start_parent(&app, cwd, "claude_code").await;
        let claude = providers.get("claude_code").unwrap();
        // The Claude author's between-round fix turn edits code but emits no text.
        claude.suppress_fix_reply.store(true, Ordering::Relaxed);
        // The Codex reviewer: NEEDS_CHANGES first, then APPROVE on the re-review.
        queue_verdicts(
            providers.get("codex").unwrap(),
            &["NEEDS_CHANGES", "APPROVE"],
        )
        .await;

        let mut input = review_input("codex");
        input.max_rounds = Some(3);
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(
            job.status, "complete",
            "a text-less author fix must not be mistaken for a no-op (job err: {:?})",
            job.error
        );
        assert_eq!(
            job.round, 2,
            "the review must advance to round 2 after the author's text-less fix"
        );
        assert_eq!(job.verdict.as_deref(), Some("approve"));
        // Exactly one fix turn ran between the two rounds, and the reviewer
        // re-reviewed (two diff-carrying reviewer turns).
        let codex_turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert_eq!(
            count_turns_with(&codex_turns, "Workspace diff collected by the relay"),
            2,
            "the reviewer ran both the initial review and the re-review"
        );
        let claude_turns = claude.turns.lock().await.clone();
        assert_eq!(
            count_turns_with(&claude_turns, "Address the findings below"),
            1,
            "one author fix turn between the two rounds"
        );
    }

    // Initialize `cwd` as a git work tree with a committed `seed.txt`, so
    // `collect_workspace_diff` yields a real diff once the file is modified.
    fn init_git_seed(cwd: &str) {
        use std::process::Command;
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(std::path::Path::new(cwd).join("seed.txt"), "line1\nline2\n").unwrap();
        git(&["add", "seed.txt"]);
        git(&["commit", "-q", "-m", "seed"]);
    }

    #[tokio::test]
    async fn review_loop_re_reviews_the_refreshed_diff_after_a_text_less_author_fix() {
        // Stronger end-to-end guard for the Codex-reviews-Claude fix: it's not enough
        // that the loop ADVANCES past a text-less author fix — the next round must
        // re-review the REFRESHED workspace diff (the author's actual edits), not a
        // stale one. Here the Claude author edits `seed.txt` on its fix turn while
        // emitting no assistant text, and the Codex reviewer must see that edit on the
        // re-review before approving.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        init_git_seed(cwd);

        let (app, providers) = build_review_app(cwd, &["claude_code", "codex"]).await;
        start_parent(&app, cwd, "claude_code").await;
        let claude = providers.get("claude_code").unwrap();
        // Claude author: fix turn edits code (adds a marker) but emits no text block.
        claude.suppress_fix_reply.store(true, Ordering::Relaxed);
        *claude.mutate_cwd_on_fix_turn.lock().await = Some("AUTHOR_FIX_MARKER".to_string());
        // Codex reviewer: NEEDS_CHANGES on the clean tree, APPROVE once it sees the fix.
        queue_verdicts(
            providers.get("codex").unwrap(),
            &["NEEDS_CHANGES", "APPROVE"],
        )
        .await;

        let mut input = review_input("codex");
        input.max_rounds = Some(3);
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(job.status, "complete", "job err: {:?}", job.error);
        assert_eq!(
            job.round, 2,
            "approved on the re-review of the refreshed diff"
        );

        // The two diff-carrying reviewer turns: the first saw the clean tree, the
        // second (re-review) must carry the author's edit — proving the loop
        // re-reviewed the REFRESHED diff rather than a stale one.
        let codex_turns = providers.get("codex").unwrap().turns.lock().await.clone();
        let review_turns: Vec<&(String, String)> = codex_turns
            .iter()
            .filter(|(_, text)| text.contains("Workspace diff collected by the relay"))
            .collect();
        assert_eq!(review_turns.len(), 2, "an initial review and one re-review");
        assert!(
            !review_turns[0].1.contains("AUTHOR_FIX_MARKER"),
            "the initial review saw the clean tree (no marker yet)"
        );
        assert!(
            review_turns[1].1.contains("AUTHOR_FIX_MARKER"),
            "the re-review must see the author's refreshed workspace diff"
        );
    }

    #[tokio::test]
    async fn review_loop_author_fix_uses_parent_thread_model() {
        // The automated author fix turn must run under the PARENT thread's own
        // model/effort, not the relay default.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        {
            let mut relay = app.relay.write().await;
            relay.remember_thread_settings(
                &parent.id,
                "bypass",
                "workspace-write",
                "high",
                "parent-special-model",
            );
        }
        queue_verdicts(
            providers.get("codex").unwrap(),
            &["NEEDS_CHANGES", "APPROVE"],
        )
        .await;

        let mut input = review_input("codex");
        input.max_rounds = Some(3);
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);

        let codex = providers.get("codex").unwrap();
        let turns = codex.turns.lock().await.clone();
        let turn_models = codex.turn_models.lock().await.clone();
        // `turns` and `turn_models` are pushed together per start_turn, so indices align.
        let fix_index = turns
            .iter()
            .position(|(tid, text)| {
                tid == &parent.id && text.contains("Address the findings below")
            })
            .expect("a fix turn ran on the parent");
        assert_eq!(
            turn_models[fix_index].1, "parent-special-model",
            "the author fix turn must use the parent thread's model"
        );
        assert_eq!(
            turn_models[fix_index].2, "high",
            "the author fix turn must use the parent thread's effort"
        );
    }

    #[tokio::test]
    async fn review_single_round_completes_even_when_not_approved() {
        // max_rounds = 1 keeps today's behavior: post the review and complete,
        // regardless of verdict — no escalation, no author fix turn.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        queue_verdicts(providers.get("codex").unwrap(), &["NEEDS_CHANGES"]).await;

        let mut input = review_input("codex");
        input.max_rounds = Some(1);
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(
            job.status, "complete",
            "single-shot completes, never escalates"
        );
        assert_eq!(job.round, 1);
        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert_eq!(count_turns_with(&turns, "Address the findings below"), 0);
        assert!(turns
            .iter()
            .any(|(tid, text)| tid == &parent.id
                && text.contains("review result from reviewer thread")));
    }

    #[tokio::test]
    async fn review_loop_escalates_when_author_fix_needs_approval() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        let codex = providers.get("codex").unwrap();
        queue_verdicts(codex, &["NEEDS_CHANGES"]).await;
        // The author's fix turn parks on an approval the review flow can't grant.
        codex
            .raise_approval_on_fix_turn
            .store(true, Ordering::Relaxed);

        let mut input = review_input("codex");
        input.max_rounds = Some(3);
        let receipt = app
            .request_review(input)
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(
            job.status, "escalated",
            "the author's fix needing approval escalates to the user"
        );
        let reviewer = job.reviewer_thread_id.clone().expect("reviewer thread id");
        let turns = providers.get("codex").unwrap().turns.lock().await.clone();
        assert_eq!(
            turns.iter().filter(|(tid, _)| tid == &reviewer).count(),
            1,
            "only the first review ran before escalation"
        );
        assert!(count_turns_with(&turns, "Address the findings below") >= 1);
        let relay = app.relay.read().await;
        assert!(!relay.is_thread_review_locked(&parent.id));
    }

    #[tokio::test]
    async fn review_rejects_when_no_thread_to_review() {
        // With neither a named `parent_thread_id` NOR an active thread, there is nothing to
        // review. (A named parent no longer requires an active thread — see
        // `review_can_target_a_non_active_parent_thread` — so the error is now about having
        // no thread at all, not specifically "no active thread".)
        let dir = TempDir::new().expect("tmpdir");
        let (app, _providers) = build_review_app(dir.path().to_str().unwrap(), &["codex"]).await;
        let error = app
            .request_review(review_input("codex"))
            .await
            .expect_err("review with no named parent and no active thread should fail");
        assert!(error.contains("no thread to review"), "got: {error}");
    }

    #[tokio::test]
    async fn review_rejects_when_parent_running() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;
        app.relay
            .write()
            .await
            .set_active_turn(Some("turn-in-flight".to_string()));

        let error = app
            .request_review(review_input("codex"))
            .await
            .expect_err("review with a running parent should fail");
        assert!(error.contains("turn is in progress"), "got: {error}");
    }

    #[tokio::test]
    async fn review_rejects_with_pending_approval() {
        use crate::state::{ApprovalKind, PendingApproval};

        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        app.relay.write().await.pending_approvals.insert(
            "approval-1".to_string(),
            PendingApproval {
                request_id: "approval-1".to_string(),
                raw_request_id: serde_json::json!("approval-1"),
                kind: ApprovalKind::Command,
                thread_id: parent.id.clone(),
                summary: "run".to_string(),
                detail: None,
                command: Some("true".to_string()),
                cwd: Some(cwd.to_string()),
                context_preview: None,
                requested_permissions: None,
                available_decisions: vec!["approve".to_string()],
                supports_session_scope: false,
            },
        );

        let error = app
            .request_review(review_input("codex"))
            .await
            .expect_err("review with a pending approval should fail");
        assert!(error.contains("approvals are pending"), "got: {error}");
    }

    #[tokio::test]
    async fn review_rejects_unavailable_reviewer_provider() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        let error = app
            .request_review(review_input("claude_code"))
            .await
            .expect_err("unavailable reviewer provider should fail");
        assert!(error.contains("claude_code"), "got: {error}");
    }

    #[tokio::test]
    async fn review_reuse_rejects_unknown_reviewer() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        // An id that is not a reviewer thread of the active parent is rejected.
        let mut input = review_input("codex");
        input.reviewer_thread_id = Some("some-unknown-thread".to_string());
        let error = app
            .request_review(input)
            .await
            .expect_err("an unknown reviewer thread should be rejected");
        assert!(error.contains("does not belong"), "got: {error}");
    }

    #[tokio::test]
    async fn review_rejects_concurrent_requests() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // The reviewer/recap turns never complete, so the first job holds the
        // serialization guard while we issue a second request.
        providers
            .get("codex")
            .unwrap()
            .complete_turns
            .store(false, Ordering::Relaxed);
        start_parent(&app, cwd, "codex").await;

        app.request_review(review_input("codex"))
            .await
            .expect("first review should start");
        let error = app
            .request_review(review_input("codex"))
            .await
            .expect_err("second concurrent review should be rejected");
        assert!(error.contains("already running"), "got: {error}");
    }

    #[tokio::test]
    async fn concurrent_reviews_of_different_threads_are_allowed() {
        // Repro (cross-conversation interference): a review in flight on thread A must
        // NOT block reviewing a DIFFERENT thread B. Each review already locks only its
        // OWN parent+reviewer (is_thread_review_locked), so two unrelated threads should
        // be reviewable at once. Today the GLOBAL `has_active_review()` guard serializes
        // every review, so B is wrongly refused with "a review is already running".
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // Hold A's review open: its turns never complete, so its job stays non-terminal.
        providers
            .get("codex")
            .unwrap()
            .complete_turns
            .store(false, Ordering::Relaxed);
        let parent_a = start_parent(&app, cwd, "codex").await;
        let parent_b = start_parent(&app, cwd, "codex").await;

        let mut review_a = review_input("codex");
        review_a.parent_thread_id = Some(parent_a.id.clone());
        let receipt_a = app
            .request_review(review_a)
            .await
            .expect("review on A should start");

        // A review on a DIFFERENT thread B must be allowed concurrently.
        let mut review_b = review_input("codex");
        review_b.parent_thread_id = Some(parent_b.id.clone());
        let receipt_b = app
            .request_review(review_b)
            .await
            .expect("reviewing a different thread B must not be blocked by A's review");
        assert_eq!(receipt_b.parent_thread_id, parent_b.id);

        let ambiguous = app
            .cancel_active_review(Some("device-1".to_string()))
            .await
            .expect_err("an untargeted stop is ambiguous with two active reviews");
        assert!(
            ambiguous.contains("review_job_id is required"),
            "got: {ambiguous}"
        );

        app.cancel_review(
            Some(receipt_b.review_job_id.clone()),
            Some("device-1".to_string()),
        )
        .await
        .expect("targeted stop should cancel only review B");
        let relay = app.relay.read().await;
        assert!(
            relay
                .review_job(&receipt_b.review_job_id)
                .expect("review B")
                .status
                .is_terminal(),
            "review B should be terminal after targeted cancellation"
        );
        let review_a = relay
            .review_job(&receipt_a.review_job_id)
            .expect("review A");
        assert!(
            !review_a.status.is_terminal(),
            "targeting review B must leave review A running"
        );
    }

    #[tokio::test]
    async fn send_message_to_thread_routes_by_target_provider() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex", "claude_code"]).await;
        let codex = providers.get("codex").unwrap();
        let claude = providers.get("claude_code").unwrap();

        let codex_thread = codex.summary("codex-active", cwd);
        let claude_thread = claude.summary("claude-bg", cwd);
        codex
            .threads
            .lock()
            .await
            .insert(codex_thread.id.clone(), codex_thread.clone());
        claude
            .threads
            .lock()
            .await
            .insert(claude_thread.id.clone(), claude_thread.clone());
        {
            let mut relay = app.relay.write().await;
            relay.set_provider_name("codex".to_string());
            relay.active_thread_id = Some(codex_thread.id.clone());
            relay.current_cwd = cwd.to_string();
            relay.threads = vec![codex_thread, claude_thread.clone()];
        }

        app.send_message_to_thread(&claude_thread.id, "route me", None, None)
            .await
            .expect("send should route to the target thread's provider");

        assert!(
            codex.turns.lock().await.is_empty(),
            "codex provider should not receive a turn for a claude target"
        );
        assert_eq!(
            claude.turns.lock().await.clone(),
            vec![(claude_thread.id.clone(), "route me".to_string())]
        );
    }

    #[tokio::test]
    async fn reviewer_thread_is_created_read_only_for_codex() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);

        let reviewer_thread = job.reviewer_thread_id.clone().expect("reviewer thread id");
        let settings = providers
            .get("codex")
            .unwrap()
            .start_thread_settings
            .lock()
            .await
            .clone();
        let reviewer = settings
            .iter()
            .find(|(id, _, _)| id == &reviewer_thread)
            .expect("reviewer thread settings recorded");
        assert_eq!(reviewer.1, "never", "reviewer approval policy");
        assert_eq!(
            reviewer.2, "read-only",
            "reviewer sandbox must be read-only"
        );
    }

    #[tokio::test]
    async fn review_freezes_only_the_reviewed_thread() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // The recap turn never completes, so the review stays in progress with the
        // parent (reviewed) thread locked for the whole test.
        providers
            .get("codex")
            .unwrap()
            .complete_turns
            .store(false, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;

        app.request_review(review_input("codex"))
            .await
            .expect("review should start");

        // Sending to the reviewed (active) thread is blocked.
        let send_err = app
            .send_message(crate::protocol::SendMessageInput {
                text: "hi".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: parent.id.clone(),
            })
            .await
            .expect_err("send to the reviewed thread should be blocked");
        assert!(send_err.contains("being reviewed"), "got: {send_err}");

        // Starting another session is NOT blocked — other threads stay usable —
        // and it becomes the active thread.
        let started = app
            .start_session(StartSessionInput {
                device_id: Some("device-1".to_string()),
                cwd: Some(cwd.to_string()),
                model: None,
                effort: None,
                approval_policy: None,
                sandbox: None,
                provider: Some("codex".to_string()),
                initial_prompt: None,
            })
            .await
            .expect("starting another session must be allowed during a review");
        let other_thread = started.active_thread_id.expect("new active thread");
        assert_ne!(other_thread, parent.id, "a new thread became active");

        // The new (non-reviewed) thread can receive messages while the review runs.
        app.send_message(crate::protocol::SendMessageInput {
            text: "work on the other thread".to_string(),
            model: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            thread_id: other_thread.clone(),
        })
        .await
        .expect("sending on a non-reviewed thread must be allowed during a review");

        // resume_session is NOT view-only — it calls bridge.resume_thread,
        // overwrites the runtime, and can change settings. Both the reviewed parent
        // and the reviewer thread are blocked for resume while a review runs. The
        // frontend navigates to other threads via setThreadRoute (view-only URL
        // change), not by calling resume_session.
        let resume_err = app
            .resume_session(crate::protocol::ResumeSessionInput {
                thread_id: parent.id.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: Some("codex".to_string()),
            })
            .await
            .expect_err("resuming the reviewed parent must be blocked (resume is mutating)");
        assert!(resume_err.contains("being reviewed"), "got: {resume_err}");
    }

    #[tokio::test]
    async fn resume_session_is_blocked_for_reviewed_parent_and_reviewer_thread() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // Recap completes so the orchestrator advances to StartingReviewer and the
        // reviewer_thread_id is set. Then the reviewer turn never completes, keeping
        // the review in-progress for the rest of the test.
        let codex = providers.get("codex").unwrap();
        codex.complete_turns.store(true, Ordering::Relaxed); // recap completes
        let parent = start_parent(&app, cwd, "codex").await;
        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");

        // Wait until the reviewer thread is registered (recap done, Step 3 complete).
        let reviewer_id = wait_for_reviewer_thread_id(&app, &receipt.review_job_id).await;

        // Pause further turns so the review stays in-progress.
        codex.complete_turns.store(false, Ordering::Relaxed);

        // Resuming the reviewed parent must be blocked (resume is mutating, not view-only).
        let resume_parent_err = app
            .resume_session(crate::protocol::ResumeSessionInput {
                thread_id: parent.id.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: None,
            })
            .await
            .expect_err("resuming the reviewed parent must be blocked");
        assert!(
            resume_parent_err.contains("being reviewed"),
            "got: {resume_parent_err}"
        );

        // Resuming the reviewer thread must ALWAYS be blocked — it would make the
        // hidden reviewer the active thread, violating the background-review invariant.
        let resume_reviewer_err = app
            .resume_session(crate::protocol::ResumeSessionInput {
                thread_id: reviewer_id.clone(),
                approval_policy: None,
                sandbox: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                provider: None,
            })
            .await
            .expect_err("resuming the reviewer thread must always be blocked");
        assert!(
            resume_reviewer_err.contains("being reviewed"),
            "got: {resume_reviewer_err}"
        );
    }

    #[tokio::test]
    async fn list_threads_retains_reviewer_rows_in_routing_cache() {
        // A background Claude reviewer is registered under a synthetic pending id
        // and must remain routable even if list_threads is called before its first
        // turn (when the provider cannot return it yet).
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let pending = "claude-pending-review-test";
        {
            // Mirror production ordering: insert the job WITHOUT reviewer_thread_id,
            // then register the background thread and assign reviewer_thread_id
            // atomically in the same write lock. This is the race the test covers:
            // list_threads called between insert_review_job and the atomic
            // (register + assign) step must not lose the row.
            let mut relay = app.relay.write().await;
            let job = crate::state::ReviewJob::new(
                "review-cache".to_string(),
                parent.id.clone(),
                "codex".to_string(),
                "claude_code".to_string(),
                None,
                crate::state::ReviewMode::CleanThread,
                cwd.to_string(),
                "device-1".to_string(),
                None,
                1,
            );
            relay.insert_review_job(job);
            // Atomic: register the row AND assign reviewer_thread_id together.
            relay.register_background_thread(
                ThreadSummaryView {
                    id: pending.to_string(),
                    name: None,
                    preview: String::new(),
                    cwd: cwd.to_string(),
                    updated_at: 1,
                    source: "claude_code".to_string(),
                    status: "active".to_string(),
                    model_provider: "anthropic".to_string(),
                    provider: "claude_code".to_string(),
                    forked_from: None,
                },
                cwd,
                "claude-model",
                "on-request",
                "workspace-write",
                "medium",
            );
            relay.update_review_job("review-cache", |job| {
                job.reviewer_thread_id = Some(pending.to_string());
            });
        }

        // Trigger a list_threads refresh (simulates the periodic poll or a
        // browser-triggered refresh) and verify the reviewer row is preserved.
        let listed = app.list_threads(50, None).await.expect("list_threads");
        assert!(
            listed.threads.iter().all(|t| t.id != pending),
            "reviewer thread must not appear in the nav-visible response"
        );
        // But it must still be in the relay.threads routing cache.
        let in_cache = app
            .relay
            .read()
            .await
            .threads
            .iter()
            .any(|t| t.id == pending);
        assert!(
            in_cache,
            "reviewer thread must be retained in relay.threads for routing after list_threads"
        );
    }

    #[tokio::test]
    async fn list_threads_orders_by_honest_activity_not_resume_polluted_mtime() {
        // End-to-end guard for the click-reorder fix: the provider reports both
        // threads with a ~now mtime (the mock's summary() uses unix_now(), which
        // is exactly what a resume/selection pollutes the real session file to),
        // but list_threads must order and surface by our tracked last-activity
        // timestamp instead.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;

        let stale = start_parent(&app, cwd, "codex").await;
        let active = start_parent(&app, cwd, "codex").await;

        {
            // `stale` was genuinely last used long ago (the user merely selected
            // it just now); `active` had real recent activity. Overwrite whatever
            // start_session recorded with these explicit honest values.
            let mut relay = app.relay.write().await;
            relay
                .thread_last_activity_at
                .insert(stale.id.clone(), 1_000);
            relay
                .thread_last_activity_at
                .insert(active.id.clone(), 2_000_000_000);
        }

        let listed = app.list_threads(50, None).await.expect("list_threads");

        // The surfaced timestamp is the tracked value, not the provider mtime.
        let stale_view = listed
            .threads
            .iter()
            .find(|t| t.id == stale.id)
            .expect("stale thread present");
        assert_eq!(
            stale_view.updated_at, 1_000,
            "provider session-file mtime must be replaced by the tracked activity time"
        );

        // ...and ordering follows it: the merely-selected (stale) thread sorts
        // BELOW the one with recent real activity, despite both having a ~now
        // provider mtime.
        let pos_stale = listed
            .threads
            .iter()
            .position(|t| t.id == stale.id)
            .expect("stale position");
        let pos_active = listed
            .threads
            .iter()
            .position(|t| t.id == active.id)
            .expect("active position");
        assert!(
            pos_active < pos_stale,
            "recent-activity thread must outrank the merely-selected one (active={pos_active}, stale={pos_stale})"
        );
    }

    #[tokio::test]
    async fn list_threads_fills_empty_provider_cwd_from_known_runtime() {
        // Claude SDK listSessions can omit cwd for sessions created by
        // forkSession unless the list is scoped by dir. The relay already knows
        // the cwd from the fork/start runtime; the nav-visible list must not let
        // the provider's partial summary erase it, because the local sidebar
        // groups by cwd and drops empty-workspace rows.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["claude_code"]).await;
        let thread = start_parent(&app, cwd, "claude_code").await;

        {
            let provider = providers.get("claude_code").expect("provider");
            let mut threads = provider.threads.lock().await;
            threads
                .get_mut(&thread.id)
                .expect("provider thread")
                .cwd
                .clear();
        }

        let listed = app.list_threads(50, None).await.expect("list_threads");
        let row = listed
            .threads
            .iter()
            .find(|item| item.id == thread.id)
            .expect("thread should remain nav-visible");
        assert_eq!(
            std::fs::canonicalize(&row.cwd).expect("row cwd canonicalizes"),
            std::fs::canonicalize(cwd).expect("expected cwd canonicalizes")
        );
    }

    // The runtime fallback only covers threads this process has loaded. After a
    // restart the relay has no runtime for a saved thread, so the cached thread
    // row is the remaining source — without it the row goes out with an empty
    // cwd and the local sidebar drops it.
    #[tokio::test]
    async fn list_threads_fills_empty_provider_cwd_from_the_thread_cache() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["claude_code"]).await;
        let thread = start_parent(&app, cwd, "claude_code").await;

        {
            // Drop the runtime so only the cached row can answer, then blank the
            // provider's cwd the way Claude's listSessions does.
            let mut relay = app.relay.write().await;
            relay.runtimes.remove(&thread.id);
        }
        {
            let provider = providers.get("claude_code").expect("provider");
            let mut threads = provider.threads.lock().await;
            threads
                .get_mut(&thread.id)
                .expect("provider thread")
                .cwd
                .clear();
        }

        let listed = app.list_threads(50, None).await.expect("list_threads");
        let row = listed
            .threads
            .iter()
            .find(|item| item.id == thread.id)
            .expect("thread must stay nav-visible after a restart-like state");
        assert!(
            !row.cwd.is_empty(),
            "the cached thread row must supply the cwd"
        );
    }

    // Regression guard for the Codex creep the reviewer flagged: a provider whose
    // read_thread.updated_at may be a resume-bumped mtime must NOT advance the
    // tracked activity key on a no-prompt selection — repeated selection would
    // otherwise creep it up the list (the original click-to-top bug).
    #[tokio::test]
    async fn resume_does_not_creep_last_activity_for_non_honest_provider() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        // Default ReviewTestProvider reports report_activity_time=false (Codex-like)
        // and its read_thread returns updated_at = unix_now() (a "bumped" mtime).
        let thread = start_parent(&app, cwd, "codex").await;

        // Stand in for an honest older baseline, then select the thread.
        app.relay
            .write()
            .await
            .thread_last_activity_at
            .insert(thread.id.clone(), 1_000);
        app.resume_session(crate::protocol::ResumeSessionInput {
            thread_id: thread.id.clone(),
            approval_policy: None,
            sandbox: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            provider: None,
        })
        .await
        .expect("resume");

        let tracked = app
            .relay
            .read()
            .await
            .thread_last_activity_at
            .get(&thread.id)
            .copied();
        assert_eq!(
            tracked,
            Some(1_000),
            "a non-honest provider's selection must freeze (or-insert), not adopt its bumpable mtime"
        );
    }

    // The honest-source path the reviewer noted was untested end-to-end: a
    // provider that reports a resume-safe last-activity time (like Claude) must
    // max-fold on resume, healing a stale tracked value from unwitnessed use.
    #[tokio::test]
    async fn resume_heals_last_activity_for_honest_provider() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        providers
            .get("codex")
            .unwrap()
            .report_activity_time
            .store(true, Ordering::Relaxed);
        let thread = start_parent(&app, cwd, "codex").await;

        // Stale tracked value (e.g. the session was used via the CLI since we
        // last saw it); the provider's honest read reports a much newer time.
        app.relay
            .write()
            .await
            .thread_last_activity_at
            .insert(thread.id.clone(), 1_000);
        app.resume_session(crate::protocol::ResumeSessionInput {
            thread_id: thread.id.clone(),
            approval_policy: None,
            sandbox: None,
            effort: None,
            device_id: Some("device-1".to_string()),
            provider: None,
        })
        .await
        .expect("resume");

        let tracked = app
            .relay
            .read()
            .await
            .thread_last_activity_at
            .get(&thread.id)
            .copied()
            .expect("tracked");
        assert!(
            tracked > 1_000,
            "an honest provider's selection must max-fold and heal the stale value (got {tracked})"
        );
    }

    #[tokio::test]
    async fn review_fails_when_recap_has_no_assistant_text() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // The recap turn completes but produces no assistant message; the
        // orchestrator must not reuse a stale reply.
        providers
            .get("codex")
            .unwrap()
            .emit_assistant
            .store(false, Ordering::Relaxed);
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "failed", "expected the review to fail");
        assert!(
            job.error.as_deref().unwrap_or_default().contains("recap"),
            "error should mention the missing recap: {:?}",
            job.error
        );
    }

    #[tokio::test]
    async fn decide_approval_on_a_reviewed_thread_is_blocked() {
        use crate::protocol::{ApprovalDecision, ApprovalDecisionInput};
        use crate::state::{ApprovalKind, PendingApproval};

        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        providers
            .get("codex")
            .unwrap()
            .complete_turns
            .store(false, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;
        app.request_review(review_input("codex"))
            .await
            .expect("review should start");

        // Simulate an approval surfacing on the reviewed thread.
        app.relay.write().await.pending_approvals.insert(
            "req-1".to_string(),
            PendingApproval {
                request_id: "req-1".to_string(),
                raw_request_id: serde_json::json!("req-1"),
                kind: ApprovalKind::Command,
                thread_id: parent.id.clone(),
                summary: "run".to_string(),
                detail: None,
                command: Some("true".to_string()),
                cwd: Some(cwd.to_string()),
                context_preview: None,
                requested_permissions: None,
                available_decisions: vec!["approve".to_string()],
                supports_session_scope: false,
            },
        );

        let error = app
            .decide_approval(
                "req-1",
                ApprovalDecisionInput {
                    decision: ApprovalDecision::Approve,
                    scope: None,
                    device_id: Some("device-1".to_string()),
                },
            )
            .await
            .expect_err("approving the reviewed thread's approval must be blocked");
        let message = match error {
            crate::state::ApprovalError::Bridge(message) => message,
            other => panic!("unexpected approval error: {other:?}"),
        };
        assert!(message.contains("being reviewed"), "got: {message}");
    }

    #[tokio::test]
    async fn reviewer_approval_is_auto_denied() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // The (recap) turn parks on an approval instead of replying.
        providers
            .get("codex")
            .unwrap()
            .raise_approval
            .store(true, Ordering::Relaxed);
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(job.status, "failed", "review must fail on an approval");
        assert!(
            job.error
                .as_deref()
                .unwrap_or_default()
                .contains("approval"),
            "error should mention the approval: {:?}",
            job.error
        );
        // The reviewer's approval was auto-denied, not left pending.
        assert!(
            app.relay.read().await.pending_approvals.is_empty(),
            "pending approvals must be cleared after auto-deny"
        );
    }

    #[tokio::test]
    async fn apply_file_change_is_blocked_during_review() {
        use crate::protocol::{ApplyFileChangeInput, FileChangeApplyDirection};

        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        providers
            .get("codex")
            .unwrap()
            .complete_turns
            .store(false, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;
        app.request_review(review_input("codex"))
            .await
            .expect("review should start and hold the guard");

        let error = app
            .apply_file_change(
                "turn-diff:whatever",
                ApplyFileChangeInput {
                    device_id: Some("device-1".to_string()),
                    direction: FileChangeApplyDirection::Rollback,
                    thread_id: parent.id,
                },
            )
            .await
            .expect_err("apply_file_change must be blocked during a review");
        assert!(error.contains("being reviewed"), "got: {error}");
    }

    #[tokio::test]
    async fn auto_deny_failure_interrupts_the_parked_turn() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let codex = providers.get("codex").unwrap();
        codex.raise_approval.store(true, Ordering::Relaxed);
        codex.deny_fails.store(true, Ordering::Relaxed); // provider rejects the denial
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "failed");
        // Deny failed, so the orchestrator interrupted the parked turn instead and
        // then cleared the approval.
        assert!(
            !codex.interrupts.lock().await.is_empty(),
            "a failed deny must fall back to interrupting the turn"
        );
        assert!(
            app.relay.read().await.pending_approvals.is_empty(),
            "an interrupted turn's approval should be cleared"
        );
    }

    #[tokio::test]
    async fn approval_double_failure_blocks_and_holds_the_lock_until_resolved() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_drain_max_ms(200);
        let codex = providers.get("codex").unwrap();
        codex.raise_approval.store(true, Ordering::Relaxed);
        codex.deny_fails.store(true, Ordering::Relaxed);
        codex.interrupt_fails.store(true, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review_status(&app, &receipt.review_job_id, &["blocked"]).await;
        assert_eq!(
            job.status, "blocked",
            "unrecoverable cleanup must block, not fail"
        );
        // The approval is retained and the session lock stays held: no new work.
        assert!(!app.relay.read().await.pending_approvals.is_empty());
        let send_err = app
            .send_message(crate::protocol::SendMessageInput {
                text: "hi".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: parent.id.clone(),
            })
            .await
            .expect_err("the reviewed thread must stay frozen while blocked");
        assert!(send_err.contains("being reviewed"), "got: {send_err}");

        // Authorization is workspace path-scope (not active-session control): a device
        // scoped to a DIFFERENT directory than the reviewed thread cannot resolve it.
        let other = TempDir::new().expect("other tmpdir");
        {
            let mut relay = app.relay.write().await;
            relay.paired_devices.insert(
                "other-device".to_string(),
                crate::state::relay::PairedDevice {
                    device_id: "other-device".to_string(),
                    label: "other-device".to_string(),
                    payload_secret: "test-payload-secret".to_string(),
                    device_verify_key: "test-verify-key".to_string(),
                    created_at: 1,
                    last_seen_at: Some(1),
                    last_peer_id: Some("peer-test".to_string()),
                    broker_join_ticket_expires_at: None,
                    path_scope: vec![other.path().to_str().unwrap().to_string()],
                },
            );
        }
        let scope_err = app
            .resolve_blocked_review(Some("other-device".to_string()))
            .await
            .expect_err("a device outside the workspace scope must not resolve");
        assert!(
            scope_err.to_lowercase().contains("allowed paths"),
            "got: {scope_err}"
        );

        // "Stop reviewer & unlock" is the escape hatch: it unlocks even though the turn
        // still can't be stopped (interrupt_fails stays true) — a best-effort interrupt,
        // then the review is forced terminal and the workspace unlocked. (It used to stay
        // blocked here and return an error, leaving the user no way out.)
        let resolved = app
            .resolve_blocked_review(Some("device-1".to_string()))
            .await
            .expect("resolve must unlock even when the turn can't be stopped");
        assert_eq!(resolved.status.status, "failed");

        let job = wait_for_review_status(&app, &receipt.review_job_id, &["failed"]).await;
        assert_eq!(job.status, "failed");
        assert!(
            app.relay.read().await.pending_approvals.is_empty(),
            "resolve clears the reviewer's approval"
        );
        // The lock is released: a send now passes the guard (no active thread, so
        // it fails for a different reason — never the review-lock error).
        let after = app
            .send_message(crate::protocol::SendMessageInput {
                text: "hi".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: parent.id.clone(),
            })
            .await;
        if let Err(error) = after {
            assert!(
                !error.contains("being reviewed"),
                "lock should be released after resolve: {error}"
            );
        }
    }

    #[tokio::test]
    async fn resolve_stops_a_working_thread_with_no_turn_id() {
        // A Claude clean reviewer can be `working` (status) with no surfaced turn
        // id during the pending→promotion window. Cancel-by-session must still work
        // so the review doesn't wedge in Blocked forever.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_drain_max_ms(200);
        let codex = providers.get("codex").unwrap();
        codex.raise_approval.store(true, Ordering::Relaxed);
        codex.deny_fails.store(true, Ordering::Relaxed);
        codex.interrupt_fails.store(true, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        wait_for_review_status(&app, &receipt.review_job_id, &["blocked"]).await;

        // Reshape the blocked thread into "working, but no turn id".
        {
            let mut relay = app.relay.write().await;
            relay.set_active_turn(None);
            relay.set_thread_status(&parent.id, "active".to_string(), Vec::new());
        }
        assert!(app.relay.read().await.active_turn_id.is_none());

        // The provider can now stop on a session-level cancel (empty turn id).
        codex.interrupt_fails.store(false, Ordering::Relaxed);
        app.resolve_blocked_review(Some("device-1".to_string()))
            .await
            .expect("a working-but-turn-id-less thread must still be resolvable");
        let job = wait_for_review_status(&app, &receipt.review_job_id, &["failed"]).await;
        assert_eq!(job.status, "failed");
        assert!(!codex.interrupts.lock().await.is_empty());
    }

    // Repro (capture): a SAVED Codex thread that isn't running carries Codex's own
    // status vocabulary — "unknown" (a `thread/list` summary with no live status field,
    // see parse_status) or "completed" — NOT the literal "idle" that Claude's bridge
    // hardcodes (claude.rs read_thread). Two review gates keyed off "idle"-ness then
    // wrongly refuse on an idle-but-not-running Codex thread even though no turn is in
    // flight:
    //   1. request_review: `current_status != "idle"` (strict literal).
    //   2. has_working_thread_in_cwd: `is_working()` → thread_status_is_working() treats
    //      ANY status except idle/viewing/empty as "working", so the parent self-blocks.
    // Liveness is authoritatively `active_turn_id` (see runtime.rs is_working() docs), so
    // a not-running thread must allow a review regardless of the status string. Both gates
    // now go semantic via `thread_status_is_working` (which classifies `unknown`/`completed`
    // as not-working), so this passes for the full Codex terminal vocabulary.
    #[tokio::test]
    async fn review_starts_when_codex_reports_a_non_idle_saved_status() {
        // Cover the FULL Codex terminal vocabulary, not just one string: a fix via an
        // allow/deny-list could get one right and miss the other, so the guard loops over
        // both statuses `thread/list` can surface for a persisted, not-running thread.
        for saved_status in ["unknown", "completed"] {
            let dir = TempDir::new().expect("tmpdir");
            let cwd = dir.path().to_str().unwrap();
            let (app, _providers) = build_review_app(cwd, &["codex"]).await;
            let parent = start_parent(&app, cwd, "codex").await;

            // Reshape the active thread into "saved Codex thread, not running": no live
            // turn, but a non-idle status string (what `thread/list` yields for a
            // persisted thread).
            {
                let mut relay = app.relay.write().await;
                relay.set_active_turn(None);
                relay.set_thread_status(&parent.id, saved_status.to_string(), Vec::new());
                assert_eq!(relay.current_status, saved_status);
                assert!(relay.active_turn_id.is_none());
            }

            let receipt = app
                .request_review(review_input("codex"))
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "a not-running Codex thread (status `{saved_status}`, no live \
turn) must allow a review: {error:?}"
                    )
                });
            let job = wait_for_review(&app, &receipt.review_job_id).await;
            assert_eq!(
                job.status, "complete",
                "status `{saved_status}` job failed: {:?}",
                job.error
            );
        }
    }

    #[tokio::test]
    async fn take_over_control_is_blocked_during_review() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        providers
            .get("codex")
            .unwrap()
            .complete_turns
            .store(false, Ordering::Relaxed);
        start_parent(&app, cwd, "codex").await;
        app.request_review(review_input("codex"))
            .await
            .expect("review should start and hold the guard");

        let reviewed_thread_id = app
            .relay
            .read()
            .await
            .active_thread_id
            .clone()
            .expect("active thread");
        let error = app
            .take_over_control(crate::protocol::TakeOverInput {
                device_id: Some("other-device".to_string()),
                thread_id: reviewed_thread_id,
            })
            .await
            .expect_err("take-over of the reviewed thread must be blocked during a review");
        assert!(error.contains("being reviewed"), "got: {error}");
    }

    #[tokio::test]
    async fn resolve_without_a_blocked_review_errors() {
        let dir = TempDir::new().expect("tmpdir");
        let (app, _providers) = build_review_app(dir.path().to_str().unwrap(), &["codex"]).await;
        let error = app
            .resolve_blocked_review(Some("device-1".to_string()))
            .await
            .expect_err("nothing to resolve");
        assert!(error.contains("no blocked review"), "got: {error}");
    }

    #[tokio::test]
    async fn reviewer_block_keeps_the_reviewed_thread_frozen_until_resolved() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_drain_max_ms(200);
        let codex = providers.get("codex").unwrap();
        // Recap completes; the REVIEWER (background) turn parks on an approval that
        // can't be denied or interrupted — so the block happens on the reviewer.
        codex
            .approval_on_reviewer_turn
            .store(true, Ordering::Relaxed);
        codex.deny_fails.store(true, Ordering::Relaxed);
        codex.interrupt_fails.store(true, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review_status(&app, &receipt.review_job_id, &["blocked"]).await;
        assert_eq!(job.status, "blocked");

        // No handoff: the parent was never displaced, so it is STILL the active
        // thread — the reviewer ran in the background.
        let reviewer_thread = job.reviewer_thread_id.clone().expect("reviewer thread id");
        let active = app.snapshot().await.active_thread_id;
        assert_eq!(
            active.as_deref(),
            Some(parent.id.as_str()),
            "the parent is never displaced by the reviewer"
        );
        assert_ne!(active.as_deref(), Some(reviewer_thread.as_str()));

        // While blocked, the reviewed parent stays frozen for sending.
        let send_err = app
            .send_message(crate::protocol::SendMessageInput {
                text: "hi".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: parent.id.clone(),
            })
            .await
            .expect_err("the reviewed thread must stay frozen while blocked");
        assert!(send_err.contains("being reviewed"), "got: {send_err}");

        // Resolve (now stoppable) → reviewer stopped, job failed, parent unfreezes.
        codex.interrupt_fails.store(false, Ordering::Relaxed);
        app.resolve_blocked_review(Some("device-1".to_string()))
            .await
            .expect("resolve should unblock");
        let job = wait_for_review_status(&app, &receipt.review_job_id, &["failed"]).await;
        assert_eq!(job.status, "failed");

        // The parent is unlocked again.
        if let Err(error) = app
            .send_message(crate::protocol::SendMessageInput {
                text: "hi again".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: parent.id.clone(),
            })
            .await
        {
            assert!(
                !error.contains("being reviewed"),
                "the parent should be unlocked after resolve: {error}"
            );
        }
    }

    #[tokio::test]
    async fn reviewer_start_error_stops_before_handing_back_to_parent() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let codex = providers.get("codex").unwrap();
        codex.fail_reviewer_start.store(true, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(job.status, "failed");
        assert!(job
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("reviewer turn start response was lost"));
        assert!(
            !codex.interrupts.lock().await.is_empty(),
            "an uncertain reviewer start must go through confirmed stop"
        );
        assert_eq!(
            app.snapshot().await.active_thread_id.as_deref(),
            Some(parent.id.as_str()),
            "the parent can be restored only after the reviewer is stopped"
        );
    }

    #[tokio::test]
    async fn delete_review_removes_terminal_job_and_archives_reviewer_thread() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
        let reviewer_thread = job.reviewer_thread_id.clone().expect("reviewer thread id");
        assert!(providers
            .get("codex")
            .unwrap()
            .threads
            .lock()
            .await
            .contains_key(&reviewer_thread));

        let deleted = app
            .delete_review(receipt.review_job_id.clone(), Some("device-1".to_string()))
            .await
            .expect("delete should succeed for a terminal review");
        assert_eq!(deleted.review_job_id, receipt.review_job_id);
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .all(|job| job.id != receipt.review_job_id),
            "the deleted job must be gone"
        );
        assert!(
            !providers
                .get("codex")
                .unwrap()
                .threads
                .lock()
                .await
                .contains_key(&reviewer_thread),
            "delete must archive the reviewer thread"
        );
    }

    #[tokio::test]
    async fn deleting_a_parent_deletes_its_reviewer_thread_by_default() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
        let reviewer = job.reviewer_thread_id.clone().expect("reviewer thread id");
        // The reviewer is hidden and tracked in the durable map.
        assert!(app
            .relay
            .read()
            .await
            .reviewer_thread_ids()
            .contains(&reviewer));
        wait_for_active_turn_idle(&app).await;

        // Delete the parent with the default (None) → delete the reviewer too.
        app.delete_thread_permanently(&parent.id, None)
            .await
            .expect("deleting the parent should succeed");

        assert!(
            !providers
                .get("codex")
                .unwrap()
                .threads
                .lock()
                .await
                .contains_key(&reviewer),
            "the reviewer thread is deleted along with its parent by default"
        );
        assert!(
            !app.relay
                .read()
                .await
                .reviewer_thread_ids()
                .contains(&reviewer),
            "the reviewer is no longer tracked"
        );
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .all(|job| job.id != receipt.review_job_id),
            "the review job is dropped so no stale panel card remains"
        );
    }

    #[tokio::test]
    async fn deleting_a_parent_can_keep_the_reviewer_as_a_normal_thread() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete");
        let reviewer = job.reviewer_thread_id.clone().expect("reviewer thread id");

        // Before deletion the reviewer is hidden from the thread list.
        let before = app.list_threads(50, None).await.expect("list_threads");
        assert!(before.threads.iter().all(|t| t.id != reviewer));
        wait_for_active_turn_idle(&app).await;

        // Delete the parent but KEEP the reviewer thread.
        app.delete_thread_permanently(&parent.id, Some(false))
            .await
            .expect("deleting the parent should succeed");

        // The reviewer thread still exists on the provider...
        assert!(
            providers
                .get("codex")
                .unwrap()
                .threads
                .lock()
                .await
                .contains_key(&reviewer),
            "the reviewer thread is kept on disk"
        );
        // ...and is now un-hidden — a normal, navigable thread.
        assert!(!app
            .relay
            .read()
            .await
            .reviewer_thread_ids()
            .contains(&reviewer));
        let after = app.list_threads(50, None).await.expect("list_threads");
        assert!(
            after.threads.iter().any(|t| t.id == reviewer),
            "the kept reviewer thread now appears as a normal thread"
        );
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .all(|job| job.id != receipt.review_job_id),
            "the review job is dropped"
        );
    }

    #[tokio::test]
    async fn deleting_a_parent_unhides_reviewer_when_its_delete_fails() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
        let reviewer = job.reviewer_thread_id.clone().expect("reviewer thread id");
        wait_for_active_turn_idle(&app).await;

        // The reviewer thread can't be deleted (only it — the parent deletes fine).
        providers
            .get("codex")
            .unwrap()
            .fail_delete_thread_ids
            .lock()
            .await
            .insert(reviewer.clone());

        // Delete the parent with default (delete reviewers too). The parent deletes,
        // but the reviewer delete fails → it must be un-hidden, not stranded.
        let delete_receipt = app
            .delete_thread_permanently(&parent.id, None)
            .await
            .expect("deleting the parent should still succeed");

        // The reviewer thread is still on disk (its delete failed)...
        assert!(
            providers
                .get("codex")
                .unwrap()
                .threads
                .lock()
                .await
                .contains_key(&reviewer),
            "the reviewer thread survived its failed delete"
        );
        // ...and is now un-hidden so it can never be a stranded, entryless thread.
        assert!(
            !app.relay
                .read()
                .await
                .reviewer_thread_ids()
                .contains(&reviewer),
            "a reviewer that can't be deleted is converted to a normal thread"
        );
        let after = app.list_threads(50, None).await.expect("list_threads");
        assert!(
            after.threads.iter().any(|t| t.id == reviewer),
            "the un-deletable reviewer now appears as a normal thread"
        );
        // The partial failure is surfaced in the receipt message.
        assert!(
            delete_receipt.message.contains("could not be deleted"),
            "receipt should report the partial failure, got: {}",
            delete_receipt.message
        );
        // The in-memory review job is still dropped.
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .all(|job| job.id != receipt.review_job_id),
            "the review job is dropped even when the reviewer delete fails"
        );
    }

    #[tokio::test]
    async fn archiving_a_parent_deletes_its_reviewer_thread_when_requested() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
        let reviewer = job.reviewer_thread_id.clone().expect("reviewer thread id");
        assert!(app
            .relay
            .read()
            .await
            .reviewer_thread_ids()
            .contains(&reviewer));
        wait_for_active_turn_idle(&app).await;

        // Archive the parent with an explicit `true` → delete the reviewer (a
        // reviewer thread has no archived state of its own).
        app.archive_thread(&parent.id, Some(true))
            .await
            .expect("archiving the parent should succeed");

        assert!(
            !providers
                .get("codex")
                .unwrap()
                .threads
                .lock()
                .await
                .contains_key(&reviewer),
            "the reviewer thread is deleted when archive explicitly requests it"
        );
        assert!(
            !app.relay
                .read()
                .await
                .reviewer_thread_ids()
                .contains(&reviewer),
            "the reviewer is no longer tracked"
        );
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .all(|job| job.id != receipt.review_job_id),
            "the review job is dropped"
        );
    }

    #[tokio::test]
    async fn archiving_a_parent_keeps_its_reviewer_thread_by_default() {
        // Archive is a soft, non-destructive operation: a bodyless request (no
        // explicit choice) must KEEP the reviewer as a normal thread, never silently
        // delete its transcript.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
        let reviewer = job.reviewer_thread_id.clone().expect("reviewer thread id");
        wait_for_active_turn_idle(&app).await;

        // Archive the parent with the default (None) → keep the reviewer.
        app.archive_thread(&parent.id, None)
            .await
            .expect("archiving the parent should succeed");

        // The reviewer thread is NOT deleted...
        assert!(
            providers
                .get("codex")
                .unwrap()
                .threads
                .lock()
                .await
                .contains_key(&reviewer),
            "a bodyless archive must not delete the reviewer transcript"
        );
        // ...and is now un-hidden — a normal, navigable thread.
        assert!(
            !app.relay
                .read()
                .await
                .reviewer_thread_ids()
                .contains(&reviewer),
            "the kept reviewer is un-hidden, not stranded"
        );
        let after = app.list_threads(50, None).await.expect("list_threads");
        assert!(
            after.threads.iter().any(|t| t.id == reviewer),
            "the kept reviewer now appears as a normal thread"
        );
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .all(|job| job.id != receipt.review_job_id),
            "the review job is dropped"
        );
    }

    #[tokio::test]
    async fn archiving_a_parent_can_keep_the_reviewer_as_a_normal_thread() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete");
        let reviewer = job.reviewer_thread_id.clone().expect("reviewer thread id");
        wait_for_active_turn_idle(&app).await;

        // Archive the parent but KEEP the reviewer thread.
        app.archive_thread(&parent.id, Some(false))
            .await
            .expect("archiving the parent should succeed");

        // The reviewer thread still exists on the provider...
        assert!(
            providers
                .get("codex")
                .unwrap()
                .threads
                .lock()
                .await
                .contains_key(&reviewer),
            "the reviewer thread is kept on disk"
        );
        // ...and is now un-hidden — a normal, navigable thread.
        assert!(!app
            .relay
            .read()
            .await
            .reviewer_thread_ids()
            .contains(&reviewer));
        let after = app.list_threads(50, None).await.expect("list_threads");
        assert!(
            after.threads.iter().any(|t| t.id == reviewer),
            "the kept reviewer thread now appears as a normal thread"
        );
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .all(|job| job.id != receipt.review_job_id),
            "the review job is dropped"
        );
    }

    #[tokio::test]
    async fn delete_review_falls_back_to_thread_delete_when_archive_fails() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
        let reviewer_thread = job.reviewer_thread_id.clone().expect("reviewer thread id");

        // Archive fails; delete should succeed and remove the thread.
        providers
            .get("codex")
            .unwrap()
            .fail_archive
            .store(true, Ordering::Relaxed);

        app.delete_review(receipt.review_job_id.clone(), Some("device-1".to_string()))
            .await
            .expect("delete should succeed");

        // Thread was removed via delete, not archive.
        assert!(
            !providers
                .get("codex")
                .unwrap()
                .threads
                .lock()
                .await
                .contains_key(&reviewer_thread),
            "reviewer thread must be deleted when archive fails"
        );
        // Job is gone.
        assert!(app
            .list_review_jobs()
            .await
            .iter()
            .all(|j| j.id != receipt.review_job_id));
    }

    #[tokio::test]
    async fn delete_review_tombstones_thread_when_both_archive_and_thread_delete_fail() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
        let reviewer_thread = job.reviewer_thread_id.clone().expect("reviewer thread id");

        // Both archive and delete fail — the thread must be tombstoned.
        let codex = providers.get("codex").unwrap();
        codex.fail_archive.store(true, Ordering::Relaxed);
        codex.fail_delete.store(true, Ordering::Relaxed);

        app.delete_review(receipt.review_job_id.clone(), Some("device-1".to_string()))
            .await
            .expect("delete should still succeed");

        // Job removed; thread still hidden via tombstone.
        assert!(app
            .list_review_jobs()
            .await
            .iter()
            .all(|j| j.id != receipt.review_job_id));
        let listed = app.list_threads(50, None).await.expect("list_threads");
        assert!(
            listed.threads.iter().all(|t| t.id != reviewer_thread),
            "tombstoned reviewer thread must remain hidden from nav after job removal"
        );
    }

    #[tokio::test]
    async fn list_threads_fetches_extra_slots_to_avoid_reviewer_starvation() {
        // This test verifies that reviewer threads don't crowd out normal threads
        // when the provider's page is exactly `limit` entries.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        // Run a review so there is one reviewer thread in flight.
        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete");
        let reviewer_thread = job.reviewer_thread_id.clone().expect("reviewer thread id");

        // Verify the reviewer thread is present in the provider but absent from
        // the listed threads — proving the fetch-limit buffer is working (the
        // reviewer thread was fetched but then filtered, leaving room for normal
        // threads to fill the result).
        assert!(
            providers
                .get("codex")
                .unwrap()
                .threads
                .lock()
                .await
                .contains_key(&reviewer_thread),
            "reviewer thread should still be in the provider"
        );
        let listed = app.list_threads(50, None).await.expect("list_threads");
        assert!(
            listed.threads.iter().all(|t| t.id != reviewer_thread),
            "reviewer thread must be excluded from listed results"
        );
    }

    #[tokio::test]
    async fn review_job_cap_is_exact_at_max_review_jobs() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        // Run one review to completion so we have a terminal job to evict.
        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("first review");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete");

        // Fill remaining slots with synthetic terminal jobs up to the cap.
        {
            let mut relay = app.relay.write().await;
            let existing = relay.active_review_jobs_view().len();
            for i in existing..crate::state::relay::MAX_REVIEW_JOBS_PUB {
                let mut synthetic = crate::state::ReviewJob::new(
                    format!("synthetic-{i}"),
                    "parent".to_string(),
                    "codex".to_string(),
                    "codex".to_string(),
                    None,
                    crate::state::ReviewMode::CleanThread,
                    cwd.to_string(),
                    "device-1".to_string(),
                    None,
                    1,
                );
                synthetic.set_status(crate::state::ReviewJobStatus::Complete);
                relay.insert_review_job(synthetic);
            }
            assert_eq!(
                relay.active_review_jobs_view().len(),
                crate::state::relay::MAX_REVIEW_JOBS_PUB,
                "should be exactly at cap after filling"
            );
        }

        // Inserting one more must evict exactly one and stay at the cap.
        {
            let mut relay = app.relay.write().await;
            let mut extra = crate::state::ReviewJob::new(
                "extra-job".to_string(),
                "parent".to_string(),
                "codex".to_string(),
                "codex".to_string(),
                None,
                crate::state::ReviewMode::CleanThread,
                cwd.to_string(),
                "device-1".to_string(),
                None,
                1,
            );
            extra.set_status(crate::state::ReviewJobStatus::Complete);
            relay.insert_review_job(extra);
            assert_eq!(
                relay.active_review_jobs_view().len(),
                crate::state::relay::MAX_REVIEW_JOBS_PUB,
                "inserting beyond cap must evict exactly one to stay at exactly MAX_REVIEW_JOBS"
            );
        }
    }

    #[tokio::test]
    async fn delete_review_drops_the_job_even_when_archival_fails() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);

        // The reviewer thread can't be archived, but delete must still drop the
        // job (the user asked to clear the card) rather than silently no-op.
        providers
            .get("codex")
            .unwrap()
            .fail_archive
            .store(true, Ordering::Relaxed);

        let deleted = app
            .delete_review(receipt.review_job_id.clone(), Some("device-1".to_string()))
            .await
            .expect("delete should still succeed when archival fails");
        assert_eq!(deleted.review_job_id, receipt.review_job_id);
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .all(|job| job.id != receipt.review_job_id),
            "the deleted job must be gone even though archival failed"
        );
    }

    #[tokio::test]
    async fn terminal_review_jobs_persist_until_deleted() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);

        // Backdate the terminal job far past the old 120s retention window: it must
        // still surface, since the persistent Reviewer panel keeps it until delete.
        {
            let mut relay = app.relay.write().await;
            relay.update_review_job(&receipt.review_job_id, |job| {
                job.updated_at = job.updated_at.saturating_sub(10_000);
            });
        }
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .any(|job| job.id == receipt.review_job_id),
            "a long-finished terminal review must remain visible until deleted"
        );
        assert!(
            app.snapshot()
                .await
                .active_review_jobs
                .iter()
                .any(|job| job.id == receipt.review_job_id),
            "the snapshot must keep surfacing the terminal review job"
        );
    }

    #[tokio::test]
    async fn list_threads_hides_the_reviewer_thread_even_while_it_is_active() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "complete", "job failed: {:?}", job.error);
        let reviewer_thread = job.reviewer_thread_id.clone().expect("reviewer thread id");

        // Simulate the mid-review handoff where the reviewer is the active thread:
        // it must STILL be hidden from the nav (the user should never see it as a
        // transient conversation).
        {
            let mut relay = app.relay.write().await;
            relay.active_thread_id = Some(reviewer_thread.clone());
        }

        let listed = app.list_threads(50, None).await.expect("list_threads");
        assert!(
            listed
                .threads
                .iter()
                .all(|thread| thread.id != reviewer_thread),
            "the reviewer thread must stay hidden from nav even while it is active"
        );
    }

    #[tokio::test]
    async fn failed_review_unfreezes_the_reviewed_thread() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // The recap completes but produces no assistant text → the review fails
        // cleanly (no Blocked state). The parent must auto-unfreeze.
        providers
            .get("codex")
            .unwrap()
            .emit_assistant
            .store(false, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;
        assert_eq!(job.status, "failed");

        // The job is terminal, so the parent is no longer review-locked.
        assert!(
            !app.relay.read().await.is_thread_review_locked(&parent.id),
            "a failed review must release the reviewed thread's lock"
        );
        if let Err(error) = app
            .send_message(crate::protocol::SendMessageInput {
                text: "back to work".to_string(),
                model: None,
                effort: None,
                device_id: Some("device-1".to_string()),
                thread_id: parent.id.clone(),
            })
            .await
        {
            assert!(
                !error.contains("being reviewed"),
                "the parent must be sendable after a failed review: {error}"
            );
        }
    }

    #[tokio::test]
    async fn promote_background_thread_rewrites_job_and_moves_runtime() {
        // Directly exercises the Claude background-promotion logic: a clean reviewer
        // runs off to the side under a synthetic `claude-pending-…` id and is
        // promoted to the real session id without ever becoming the active thread.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;

        let pending = "claude-pending-xyz";
        let real = "real-session-9";
        {
            let mut relay = app.relay.write().await;
            let job = crate::state::ReviewJob::new(
                "review-promote".to_string(),
                parent.id.clone(),
                "codex".to_string(),
                "claude_code".to_string(),
                None,
                crate::state::ReviewMode::CleanThread,
                cwd.to_string(),
                "device-1".to_string(),
                None,
                1,
            );
            relay.insert_review_job(job);
            relay.update_review_job("review-promote", |job| {
                job.reviewer_thread_id = Some(pending.to_string())
            });
            relay.register_background_thread(
                ThreadSummaryView {
                    id: pending.to_string(),
                    name: None,
                    preview: String::new(),
                    cwd: cwd.to_string(),
                    updated_at: 1,
                    source: "claude_code".to_string(),
                    status: "active".to_string(),
                    model_provider: "anthropic".to_string(),
                    provider: "claude_code".to_string(),
                    forked_from: None,
                },
                cwd,
                "claude-model",
                "on-request",
                "workspace-write",
                "medium",
            );
            relay.register_reviewer_thread(pending.to_string(), parent.id.clone());
            // The active thread (parent) must NOT change across promotion.
            assert_eq!(relay.active_thread_id.as_deref(), Some(parent.id.as_str()));
            relay.promote_background_thread(pending, real);
            assert_eq!(
                relay.active_thread_id.as_deref(),
                Some(parent.id.as_str()),
                "promotion must not touch the active thread"
            );
        }

        let relay = app.relay.read().await;
        let job = relay.review_job("review-promote").expect("job present");
        assert_eq!(
            job.reviewer_thread_id.as_deref(),
            Some(real),
            "the job's reviewer id is rewritten pending -> real"
        );
        assert!(
            relay.runtime_for_thread(pending).is_none(),
            "the pending runtime is moved away"
        );
        assert!(
            relay.runtime_for_thread(real).is_some(),
            "the real-id runtime exists"
        );
        assert!(
            !relay.threads.iter().any(|thread| thread.id == pending),
            "the stale pending thread row is dropped"
        );
        assert!(
            relay.reviewer_thread_ids().contains(real),
            "nav-hiding follows the real id"
        );
        // The durable reviewer→parent map entry also moves pending -> real.
        assert_eq!(
            relay.reviewer_threads_of_parent(&parent.id),
            vec![real.to_string()],
            "the persisted reviewer map entry moves pending -> real"
        );
        assert!(
            relay.is_thread_review_locked(real),
            "the real reviewer thread is review-locked"
        );
    }

    #[tokio::test]
    async fn delete_review_rejects_an_active_review() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // The recap never completes, so the review stays non-terminal.
        providers
            .get("codex")
            .unwrap()
            .complete_turns
            .store(false, Ordering::Relaxed);
        start_parent(&app, cwd, "codex").await;
        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");

        let error = app
            .delete_review(receipt.review_job_id.clone(), Some("device-1".to_string()))
            .await
            .expect_err("an active review must not be deletable");
        assert!(error.contains("stop the reviewer"), "got: {error}");
    }

    #[tokio::test]
    async fn timeout_interrupts_the_running_turn() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_step_timeout_ms(150);
        let codex = providers.get("codex").unwrap();
        // The recap turn never completes, so the step times out.
        codex.complete_turns.store(false, Ordering::Relaxed);
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(job.status, "failed");
        assert!(
            job.error.as_deref().unwrap_or_default().contains("stop"),
            "timeout error should mention the turn was stopped: {:?}",
            job.error
        );
        assert!(
            !codex.interrupts.lock().await.is_empty(),
            "a timed-out turn must be interrupted"
        );
    }

    // The user can stop a review that's stuck mid-turn (NOT just the cleanup-failed
    // `Blocked` state): cancel_active_review interrupts the running turn, marks the
    // job `Cancelled`, and unlocks the reviewed parent.
    #[tokio::test]
    async fn cancel_stops_an_in_progress_review_and_unlocks_the_parent() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // Long step timeout so the review stays stuck (not auto-timed-out), and turns
        // never complete so the recap turn hangs — i.e. a review in flight.
        app.set_review_step_timeout_ms(60_000);
        let codex = providers.get("codex").unwrap();
        codex.complete_turns.store(false, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        // Wait until the recap turn is actually in flight (non-terminal, in progress).
        wait_for_review_status(&app, &receipt.review_job_id, &["waiting_for_parent_recap"]).await;
        for _ in 0..200 {
            let working = app
                .relay
                .read()
                .await
                .runtime_for_thread(&parent.id)
                .map(|runtime| runtime.is_working())
                .unwrap_or(false);
            if working {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        assert!(
            app.relay.read().await.is_thread_review_locked(&parent.id),
            "parent should be review-locked while the review is in flight"
        );

        // User cancels the stuck review.
        let cancel = app
            .cancel_active_review(Some("device-1".to_string()))
            .await
            .expect("cancel should succeed");
        assert_eq!(cancel.status.status, "cancelled");

        let job = wait_for_review_status(&app, &receipt.review_job_id, &["cancelled"]).await;
        assert_eq!(job.status, "cancelled", "job error: {:?}", job.error);
        assert!(
            !app.relay.read().await.is_thread_review_locked(&parent.id),
            "the reviewed parent must be unlocked after cancel"
        );
        assert!(
            !codex.interrupts.lock().await.is_empty(),
            "cancel must interrupt the running turn"
        );
    }

    // Regression for the between-turns lost-update race: the orchestrator writes job
    // status between wait checkpoints, while a user cancel marks the job terminal. A
    // status write that lands AFTER the cancel must NOT resurrect the job — otherwise it
    // is left non-terminal and its threads stay review-locked forever, even though
    // `cancel_active_review` reported success.
    #[tokio::test]
    async fn a_cancelled_review_cannot_be_resurrected_by_a_racing_status_write() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_step_timeout_ms(60_000);
        let codex = providers.get("codex").unwrap();
        codex.complete_turns.store(false, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        wait_for_review_status(&app, &receipt.review_job_id, &["waiting_for_parent_recap"]).await;

        let cancel = app
            .cancel_active_review(Some("device-1".to_string()))
            .await
            .expect("cancel should succeed");
        assert_eq!(cancel.status.status, "cancelled");
        wait_for_review_status(&app, &receipt.review_job_id, &["cancelled"]).await;

        // Simulate the orchestrator's next between-turns status write landing AFTER the
        // cancel (the exact lost-update the terminal-status guard must reject). This is
        // the same path `set_job_status` takes: update_review_job → ReviewJob::set_status.
        app.relay
            .write()
            .await
            .update_review_job(&receipt.review_job_id, |job| {
                job.set_status(crate::state::ReviewJobStatus::WaitingForReviewer)
            });

        let status = app
            .relay
            .read()
            .await
            .review_job(&receipt.review_job_id)
            .map(|job| job.status);
        assert_eq!(
            status,
            Some(crate::state::ReviewJobStatus::Cancelled),
            "a cancelled review must not be resurrected by a later status write",
        );
        assert!(
            !app.relay.read().await.is_thread_review_locked(&parent.id),
            "the reviewed parent must stay unlocked after a racing status write",
        );
    }

    // "Stop review" MUST unlock the reviewed thread even when the in-flight turn can't be
    // confirmed stopped (a stale "working" thread, or a turn that ignores interrupts).
    // Before the fix cancel left the review Blocked + returned an error, so the workspace
    // stayed locked — the escape hatch didn't escape.
    #[tokio::test]
    async fn cancel_unlocks_even_when_the_turn_cannot_be_stopped() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_step_timeout_ms(60_000); // don't auto-timeout the review
        let codex = providers.get("codex").unwrap();
        codex.complete_turns.store(false, Ordering::Relaxed); // recap turn hangs
        codex.interrupt_fails.store(true, Ordering::Relaxed); // ...and ignores interrupts
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        wait_for_review_status(&app, &receipt.review_job_id, &["waiting_for_parent_recap"]).await;
        assert!(app.relay.read().await.is_thread_review_locked(&parent.id));

        let cancel = app.cancel_active_review(Some("device-1".to_string())).await;
        assert!(
            cancel.is_ok(),
            "Stop review must not error when the turn can't be stopped: {cancel:?}"
        );
        assert_eq!(cancel.unwrap().status.status, "cancelled");
        let job = wait_for_review_status(&app, &receipt.review_job_id, &["cancelled"]).await;
        assert_eq!(job.status, "cancelled", "error: {:?}", job.error);
        assert!(
            !app.relay.read().await.is_thread_review_locked(&parent.id),
            "Stop review must unlock the reviewed thread even for an un-stoppable turn"
        );
    }

    // "Stop reviewer & unlock" on a BLOCKED review must also force the unlock through, even
    // if the stuck turn still won't stop. (A review reaches Blocked when the orchestrator's
    // own stop attempt fails.)
    #[tokio::test]
    async fn resolve_unlocks_a_blocked_review_even_when_the_turn_cannot_be_stopped() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_step_timeout_ms(120); // recap times out fast
        app.set_review_drain_max_ms(100); // the orchestrator's stop-drain gives up fast → Blocked
        let codex = providers.get("codex").unwrap();
        codex.complete_turns.store(false, Ordering::Relaxed); // recap hangs
        codex.interrupt_fails.store(true, Ordering::Relaxed); // can't be stopped → orchestrator blocks
        let parent = start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        // The recap times out and the orchestrator can't stop the turn → review goes Blocked.
        let job = wait_for_review_status(&app, &receipt.review_job_id, &["blocked"]).await;
        assert_eq!(job.status, "blocked");
        assert!(app.relay.read().await.is_thread_review_locked(&parent.id));

        // "Stop reviewer & unlock" → cancel delegates to resolve_blocked_review.
        let resolved = app.cancel_active_review(Some("device-1".to_string())).await;
        assert!(
            resolved.is_ok(),
            "unblock must not error when the turn can't be stopped: {resolved:?}"
        );
        wait_for_review_status(&app, &receipt.review_job_id, &["failed", "cancelled"]).await;
        assert!(
            !app.relay.read().await.is_thread_review_locked(&parent.id),
            "unblock must unlock the reviewed thread even for an un-stoppable turn"
        );
    }

    // A reviewer that keeps producing output must NOT be timed out, no matter how long the
    // whole turn runs — the step timeout is a STALL window (reset on progress), not a fixed
    // cap. (Before the fix a thorough review that ran past the fixed 10-min cap got killed
    // mid-write with "timed out waiting for the reviewer".)
    #[tokio::test]
    async fn review_wait_does_not_time_out_while_the_reviewer_keeps_producing_output() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_step_timeout_ms(400); // short STALL window for the test
        {
            let mut relay = app.relay.write().await;
            relay.bg_set_active_turn("rev", Some("t1".to_string()), 0);
            relay.bg_set_thread_status("rev", "active".to_string(), Vec::new(), 0);
        }
        let app2 = app.clone();
        let waiter = tokio::spawn(async move {
            app2.wait_for_thread_idle_outcome_label("job-x", "rev")
                .await
        });

        // Stream output for ~600ms (well past the 400ms window); each delta bumps the
        // thread's transcript revision and must reset the stall deadline.
        for i in 0..12 {
            sleep(Duration::from_millis(50)).await;
            let mut relay = app.relay.write().await;
            relay.bg_append_agent_delta("rev", "item-1", &format!("chunk{i} "), "t1", 0);
            relay.notify();
        }
        // The reviewer finishes.
        {
            let mut relay = app.relay.write().await;
            relay.bg_set_active_turn("rev", None, 0);
            relay.bg_set_thread_status("rev", "idle".to_string(), Vec::new(), 0);
            relay.notify();
        }

        let outcome = waiter.await.expect("waiter joins");
        assert_eq!(
            outcome, "completed",
            "a reviewer that kept producing output past the fixed cap must complete, not time out"
        );
    }

    // The motivating scenario specifically: the reviewer resets the stall window by
    // running TOOL calls (read-only commands / file reads), not just by streaming text.
    // Tool/command transcript items bump the same per-thread revision, so they must reset
    // the deadline too.
    #[tokio::test]
    async fn review_wait_does_not_time_out_while_the_reviewer_runs_tool_calls() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_step_timeout_ms(400);
        {
            let mut relay = app.relay.write().await;
            relay.bg_set_active_turn("rev", Some("t1".to_string()), 0);
            relay.bg_set_thread_status("rev", "active".to_string(), Vec::new(), 0);
        }
        let app2 = app.clone();
        let waiter = tokio::spawn(async move {
            app2.wait_for_thread_idle_outcome_label("job-x", "rev")
                .await
        });

        // The reviewer runs read-only commands for ~600ms (past the 400ms window); each
        // command result is a transcript mutation that must reset the stall deadline.
        for i in 0..12 {
            sleep(Duration::from_millis(50)).await;
            let mut relay = app.relay.write().await;
            relay.bg_add_command_result(
                "rev",
                format!("cmd-{i}"),
                "grep diff-group".to_string(),
                Some("match".to_string()),
                "completed".to_string(),
                "t1".to_string(),
                0,
            );
            relay.notify();
        }
        {
            let mut relay = app.relay.write().await;
            relay.bg_set_active_turn("rev", None, 0);
            relay.bg_set_thread_status("rev", "idle".to_string(), Vec::new(), 0);
            relay.notify();
        }

        let outcome = waiter.await.expect("waiter joins");
        assert_eq!(
            outcome, "completed",
            "a reviewer actively running tool calls past the fixed cap must not time out"
        );
    }

    // The flip side: a reviewer that produces NOTHING for the whole stall window still
    // times out (the stall timeout must still fire on a genuine hang).
    #[tokio::test]
    async fn review_wait_times_out_when_the_reviewer_makes_no_progress() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_step_timeout_ms(120);
        {
            let mut relay = app.relay.write().await;
            relay.bg_set_active_turn("rev", Some("t1".to_string()), 0);
            relay.bg_set_thread_status("rev", "active".to_string(), Vec::new(), 0);
        }
        let outcome = app.wait_for_thread_idle_outcome_label("job-x", "rev").await;
        assert_eq!(
            outcome, "timed_out",
            "a reviewer with no progress for the whole stall window must time out"
        );
    }

    #[tokio::test]
    async fn unrelated_background_approval_does_not_fail_the_review() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        providers
            .get("codex")
            .unwrap()
            .inject_unrelated_approval
            .store(true, Ordering::Relaxed);
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        // The review completed despite an unrelated background-thread approval...
        assert_eq!(
            job.status, "complete",
            "an unrelated approval must not fail the review: {:?}",
            job.error
        );
        // ...and that approval was left untouched (not auto-denied).
        let pending = app.relay.read().await;
        assert!(
            pending
                .pending_approvals
                .values()
                .any(|approval| approval.thread_id == "unrelated-bg-thread"),
            "the unrelated approval must survive the review"
        );
    }

    #[tokio::test]
    async fn review_allowed_while_a_background_thread_works_the_same_cwd() {
        // A review targets a SPECIFIC idle thread; the workspace as a whole no longer
        // has to be quiet. Another thread running a turn in the same cwd must NOT block
        // it (the diff is a point-in-time snapshot of the working tree — accepting that
        // beats forcing the whole workspace idle; worktree isolation is the future
        // stronger guarantee). The parent's OWN idleness + path-scope are still enforced.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let parent = start_parent(&app, cwd, "codex").await;
        let parent_cwd = app.snapshot().await.current_cwd;

        // A backgrounded thread is still running a turn in the same workspace.
        {
            let mut relay = app.relay.write().await;
            relay.threads.push(ThreadSummaryView {
                id: "bg-thread".to_string(),
                name: None,
                preview: String::new(),
                cwd: parent_cwd.clone(),
                updated_at: 0,
                source: "codex".to_string(),
                status: "active".to_string(),
                model_provider: "codex".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            });
            relay.bg_set_active_turn("bg-thread", Some("bg-turn".to_string()), unix_now());
        }

        // The review starts regardless of the busy workspace.
        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("a review may start even while another thread works the same cwd");
        assert!(
            !receipt.review_job_id.is_empty(),
            "the review was accepted and a job recorded"
        );
        // Sanity: the parent itself is the active idle thread.
        assert_eq!(
            app.snapshot().await.active_thread_id.as_deref(),
            Some(parent.id.as_str())
        );
    }

    #[tokio::test]
    async fn multi_round_review_also_allowed_while_a_background_thread_works_the_same_cwd() {
        // Product decision (2026-06-17): the workspace-busy relaxation applies to ALL
        // reviews, INCLUDING iterative (max_rounds>1) ones that later drive an author-fix
        // WRITE turn on the parent. We knowingly accept the concurrent-writer risk for now
        // (worktree/snapshot isolation is the future stronger guarantee). This test pins
        // that decision so the guard isn't silently re-added for the multi-round case.
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        let _parent = start_parent(&app, cwd, "codex").await;
        let parent_cwd = app.snapshot().await.current_cwd;

        {
            let mut relay = app.relay.write().await;
            relay.threads.push(ThreadSummaryView {
                id: "bg-thread".to_string(),
                name: None,
                preview: String::new(),
                cwd: parent_cwd.clone(),
                updated_at: 0,
                source: "codex".to_string(),
                status: "active".to_string(),
                model_provider: "codex".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            });
            relay.bg_set_active_turn("bg-thread", Some("bg-turn".to_string()), unix_now());
        }

        let receipt = app
            .request_review(RequestReviewInput {
                max_rounds: Some(2),
                ..review_input("codex")
            })
            .await
            .expect("a multi-round review may also start while another thread works the cwd");
        assert!(!receipt.review_job_id.is_empty());
    }

    #[tokio::test]
    async fn timeout_drains_until_turn_ends_when_interrupt_fails() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        app.set_review_step_timeout_ms(120);
        let codex = providers.get("codex").unwrap();
        // Interrupt fails, but the turn finishes shortly after the timeout — the
        // orchestrator must hold the lock and drain until it ends.
        codex.interrupt_fails.store(true, Ordering::Relaxed);
        codex.complete_delay_ms.store(280, Ordering::Relaxed);
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(job.status, "failed");
        assert!(
            job.error.as_deref().unwrap_or_default().contains("stop"),
            "drained timeout should report the turn stopped: {:?}",
            job.error
        );
        // The turn really did finish (active turn cleared) before we went terminal.
        assert!(app.relay.read().await.active_turn_id.is_none());
    }

    #[tokio::test]
    async fn review_fails_when_reviewer_asks_a_question() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        // The (recap) turn parks on an AskUserQuestion instead of replying.
        providers
            .get("codex")
            .unwrap()
            .raise_ask_user
            .store(true, Ordering::Relaxed);
        start_parent(&app, cwd, "codex").await;

        let receipt = app
            .request_review(review_input("codex"))
            .await
            .expect("review should start");
        let job = wait_for_review(&app, &receipt.review_job_id).await;

        assert_eq!(job.status, "failed");
        assert!(
            job.error
                .as_deref()
                .unwrap_or_default()
                .contains("question"),
            "error should mention the question: {:?}",
            job.error
        );
        // The reviewer's question was dismissed, not left for the user to answer.
        assert!(
            app.relay.read().await.pending_ask_user_questions.is_empty(),
            "pending questions must be cleared"
        );
    }

    #[tokio::test]
    async fn submit_ask_user_answer_on_a_reviewed_thread_is_blocked() {
        use crate::protocol::SubmitAskUserAnswerInput;
        use crate::state::PendingAskUserQuestion;

        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, providers) = build_review_app(cwd, &["codex"]).await;
        providers
            .get("codex")
            .unwrap()
            .complete_turns
            .store(false, Ordering::Relaxed);
        let parent = start_parent(&app, cwd, "codex").await;
        app.request_review(review_input("codex"))
            .await
            .expect("review should start");

        // Simulate a question surfacing on the reviewed thread.
        app.relay.write().await.pending_ask_user_questions.insert(
            "ask:1".to_string(),
            PendingAskUserQuestion {
                request_id: "ask:1".to_string(),
                tool_use_id: "tool-1".to_string(),
                thread_id: parent.id.clone(),
                requested_at: crate::state::unix_now(),
                questions: Vec::new(),
            },
        );

        let mut answers = serde_json::Map::new();
        answers.insert("Q?".to_string(), serde_json::Value::String("A".to_string()));
        let error = app
            .submit_ask_user_answer(
                "ask:1",
                SubmitAskUserAnswerInput {
                    answers,
                    device_id: Some("device-1".to_string()),
                },
            )
            .await
            .expect_err("answering the reviewed thread's question must be blocked");
        let message = match error {
            crate::state::AskUserAnswerError::Bridge(message) => message,
            other => panic!("unexpected error: {other:?}"),
        };
        assert!(message.contains("being reviewed"), "got: {message}");
    }
}

// The "slow approve button" double-tap: approving a pairing makes two sequential
// broker HTTP calls BEFORE marking the request decided, so a second tap that
// lands inside that window used to (a) issue a second credential — rotating the
// first tap's freshly-delivered tokens out from under the phone — and then,
// after losing the decide race, (b) roll back by revoking the device credential
// by device_id, deleting the winner's grant (and its client-relay grant) outright.
// Net effect: the device the operator just approved was bricked, and the DB was
// left with an orphan client identity and zero grants. The approve flow must
// claim the pairing request atomically before issuing anything, so the losing
// tap fails fast without issuing or revoking.
#[cfg(test)]
mod double_approve_race {
    use super::super::*;
    use crate::protocol::{PairingDecision, PairingDecisionInput};
    use crate::state::security::SecurityProfile;
    use axum::{extract::Path as AxumPath, routing::post, Json, Router};
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::sync::{watch, RwLock};

    struct MockCounts {
        device_grants: AtomicUsize,
        revokes: AtomicUsize,
    }

    /// Mock public control plane whose device-grant endpoint responds slowly,
    /// holding the approve flow inside its broker window long enough for an
    /// overlapping second tap to enter it too.
    async fn spawn_slow_control_plane(counts: Arc<MockCounts>) -> String {
        let grant_counts = counts.clone();
        let device_grant = move |Json(body): Json<serde_json::Value>| {
            let grant_counts = grant_counts.clone();
            async move {
                grant_counts.device_grants.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(250)).await;
                Json(serde_json::json!({
                    "relay_id": "relay-owner-1",
                    "broker_room_id": "demo-room",
                    "device_id": body["device_id"],
                    "device_refresh_token": "dref-attempt",
                    "device_ws_token": "ws-attempt",
                    "device_ws_token_expires_at": 4102444800_u64,
                }))
            }
        };
        let client_grant = |Json(body): Json<serde_json::Value>| async move {
            Json(serde_json::json!({
                "client_id": "client-1",
                "client_refresh_token": "cref-attempt",
                "relay_id": "relay-owner-1",
                "broker_room_id": "demo-room",
                "device_id": body["device_id"],
                "relay_label": "Demo Relay",
            }))
        };
        let revoke_counts = counts;
        let revoke = move |AxumPath(device_id): AxumPath<String>,
                           Json(_body): Json<serde_json::Value>| {
            let revoke_counts = revoke_counts.clone();
            async move {
                revoke_counts.revokes.fetch_add(1, Ordering::SeqCst);
                Json(serde_json::json!({
                    "relay_id": "relay-owner-1",
                    "broker_room_id": "demo-room",
                    "device_id": device_id,
                    "revoked": true,
                    "revoked_grant_count": 1,
                }))
            }
        };
        let app = Router::new()
            .route("/api/public/devices", post(device_grant))
            .route("/api/public/clients/grants", post(client_grant))
            .route("/api/public/devices/:device_id/revoke", post(revoke));
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("mock control plane should bind");
        let address = listener.local_addr().expect("mock address");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("mock control plane should serve");
        });
        format!("http://{address}")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn double_approve_must_not_reissue_or_revoke_the_winning_credential() {
        let counts = Arc::new(MockCounts {
            device_grants: AtomicUsize::new(0),
            revokes: AtomicUsize::new(0),
        });
        let control_url = spawn_slow_control_plane(counts.clone()).await;

        // decide_pairing_request resolves its broker config from env.
        let broker_env = [
            ("RELAY_BROKER_URL", "wss://broker.example.com"),
            ("RELAY_BROKER_CONTROL_URL", control_url.as_str()),
            ("RELAY_BROKER_CHANNEL_ID", "demo-room"),
            ("RELAY_BROKER_PEER_ID", "relay-1"),
            ("RELAY_BROKER_AUTH_MODE", "public"),
            ("RELAY_BROKER_RELAY_ID", "relay-owner-1"),
            ("RELAY_BROKER_RELAY_REFRESH_TOKEN", "relay-refresh-1"),
        ];
        for (key, value) in broker_env {
            std::env::set_var(key, value);
        }

        let (change_tx, _change_rx) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            "/tmp/project".to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let pairing_id = {
            let mut relay = relay.write().await;
            let prepared = relay
                .prepare_pairing_ticket(Some(600), Vec::new())
                .expect("pairing ticket should prepare");
            relay
                .register_pairing_request(
                    &prepared.pairing_id,
                    Some("phone-1".to_string()),
                    Some("Phone".to_string()),
                    "surface-1",
                    "vk-double-approve".to_string(),
                    crate::state::unix_now(),
                )
                .expect("pairing request should register");
            prepared.pairing_id
        };
        let app = AppState::from_parts(relay, HashMap::new(), change_tx);

        let first_tap = {
            let app = app.clone();
            let pairing_id = pairing_id.clone();
            tokio::spawn(async move {
                app.decide_pairing_request(
                    &pairing_id,
                    PairingDecisionInput {
                        decision: PairingDecision::Approve,
                    },
                )
                .await
            })
        };
        // The second tap lands while the first is waiting on the slow broker.
        tokio::time::sleep(Duration::from_millis(80)).await;
        let second_tap = {
            let app = app.clone();
            let pairing_id = pairing_id.clone();
            tokio::spawn(async move {
                app.decide_pairing_request(
                    &pairing_id,
                    PairingDecisionInput {
                        decision: PairingDecision::Approve,
                    },
                )
                .await
            })
        };
        let first = first_tap.await.expect("first tap should not panic");
        let second = second_tap.await.expect("second tap should not panic");

        for (key, _) in broker_env {
            std::env::remove_var(key);
        }

        assert_eq!(
            u8::from(first.is_ok()) + u8::from(second.is_ok()),
            1,
            "exactly one tap must win (first ok: {}, second ok: {})",
            first.is_ok(),
            second.is_ok()
        );
        assert_eq!(
            counts.device_grants.load(Ordering::SeqCst),
            1,
            "the losing tap must not issue (and thereby rotate) a second device credential"
        );
        assert_eq!(
            counts.revokes.load(Ordering::SeqCst),
            0,
            "the losing tap must not revoke the winner's freshly-delivered credential"
        );
    }
}
