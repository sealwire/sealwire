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
    use crate::fake_provider::FakeProviderBridge;
    use crate::protocol::{
        ApprovalDecision, ApprovalDecisionInput, ApprovalScope, AskUserOptionView,
        AskUserQuestionView, ReadThreadTranscriptInput, ResumeSessionInput, SendMessageInput,
        StartSessionInput, SubmitAskUserAnswerInput, UpdateSessionSettingsInput,
    };
    use crate::state::security::SecurityProfile;
    use crate::state::{
        ApprovalKind, PendingApproval, PendingAskUserQuestion, DEFAULT_APPROVAL_POLICY,
        DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_SANDBOX,
    };
    use std::sync::{
        atomic::{AtomicU64, Ordering},
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
        threads: Arc<Mutex<HashMap<String, crate::protocol::ThreadSummaryView>>>,
        approval_thread_ids: Arc<Mutex<Vec<String>>>,
        ask_request_ids: Arc<Mutex<Vec<String>>>,
        turn_thread_ids: Arc<Mutex<Vec<String>>>,
        interrupt_thread_ids: Arc<Mutex<Vec<String>>>,
    }

    impl RecordingProvider {
        fn new(name: &'static str) -> Self {
            Self {
                name,
                threads: Arc::new(Mutex::new(HashMap::new())),
                approval_thread_ids: Arc::new(Mutex::new(Vec::new())),
                ask_request_ids: Arc::new(Mutex::new(Vec::new())),
                turn_thread_ids: Arc::new(Mutex::new(Vec::new())),
                interrupt_thread_ids: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn thread_summary(&self, id: &str, cwd: &str) -> crate::protocol::ThreadSummaryView {
            crate::protocol::ThreadSummaryView {
                id: id.to_string(),
                name: Some(format!("{} thread", self.name)),
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: self.name.to_string(),
                status: "idle".to_string(),
                model_provider: self.name.to_string(),
                provider: self.name.to_string(),
            }
        }
    }

    #[async_trait::async_trait]
    impl ProviderBridge for RecordingProvider {
        async fn list_threads(
            &self,
            limit: usize,
        ) -> Result<Vec<crate::protocol::ThreadSummaryView>, String> {
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

        async fn list_models(&self) -> Result<Vec<crate::protocol::ModelOptionView>, String> {
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
                Ok(())
            } else {
                Err(format!("{} thread '{thread_id}' was not found", self.name))
            }
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
            Ok(crate::provider::ThreadSyncData {
                thread,
                status: "idle".to_string(),
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
            _effort: &str,
        ) -> Result<Option<String>, String> {
            self.turn_thread_ids
                .lock()
                .await
                .push(thread_id.to_string());
            Ok(Some(format!("turn:{thread_id}")))
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
        let codex = RecordingProvider::new("codex");
        let claude = RecordingProvider::new("claude_code");
        let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
        providers.insert("codex".to_string(), Arc::new(codex.clone()));
        providers.insert("claude_code".to_string(), Arc::new(claude.clone()));
        (
            AppState::from_parts(relay, providers, change_tx),
            codex,
            claude,
        )
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
                crate::protocol::ThreadSummaryView {
                    id: "thread-1".to_string(),
                    name: Some("AskUser thread".to_string()),
                    preview: "pending ask-user".to_string(),
                    cwd: "/tmp/project".to_string(),
                    updated_at: 1,
                    source: "fake".to_string(),
                    status: "active".to_string(),
                    model_provider: "fake".to_string(),
                    provider: "fake".to_string(),
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
        summary: crate::protocol::ThreadSummaryView,
        transcript: Vec<crate::protocol::TranscriptEntryView>,
    }

    #[derive(Default)]
    struct ConsumedInitialPromptProvider {
        threads: Arc<Mutex<HashMap<String, ConsumedInitialThread>>>,
        next_id: AtomicU64,
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

        fn thread_summary(
            thread_id: String,
            cwd: &str,
            preview: String,
        ) -> crate::protocol::ThreadSummaryView {
            crate::protocol::ThreadSummaryView {
                id: thread_id,
                name: Some("Consumed Initial Prompt Session".to_string()),
                preview,
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "consumed-initial".to_string(),
                status: "idle".to_string(),
                model_provider: "consumed-initial".to_string(),
                provider: "consumed-initial".to_string(),
            }
        }
    }

    #[async_trait::async_trait]
    impl ProviderBridge for ConsumedInitialPromptProvider {
        async fn list_threads(
            &self,
            limit: usize,
        ) -> Result<Vec<crate::protocol::ThreadSummaryView>, String> {
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
                });
            }

            self.threads.lock().await.insert(
                thread.id.clone(),
                ConsumedInitialThread {
                    summary: thread.clone(),
                    transcript,
                },
            );

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
        app.start_session(StartSessionInput {
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

        // Hand controller to scoped device — required so ensure_device_can_send_message passes,
        // then the scope check fires.
        {
            let mut relay = app.relay.write().await;
            relay.assign_active_controller("scoped-device", unix_now());
        }

        let error = app
            .send_message(SendMessageInput {
                device_id: Some("scoped-device".to_string()),
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
        threads: Arc<Mutex<HashMap<String, crate::protocol::ThreadSummaryView>>>,
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
        async fn list_threads(
            &self,
            _limit: usize,
        ) -> Result<Vec<crate::protocol::ThreadSummaryView>, String> {
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
            let thread = crate::protocol::ThreadSummaryView {
                id: id.clone(),
                name: Some(format!("{} thread", self.name)),
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: self.name.to_string(),
                status: "idle".to_string(),
                model_provider: self.name.to_string(),
                provider: self.name.to_string(),
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
        ModelOptionView, RequestReviewInput, StartSessionInput, ThreadSummaryView,
        TranscriptEntryKind, TranscriptEntryView,
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
        // When true, only the *reviewer* turn parks on an approval (recap completes
        // normally) — exercises the reviewer-handoff cleanup path.
        approval_on_reviewer_turn: Arc<AtomicBool>,
        // Simulate losing/rejecting the reviewer turn-start response after the
        // reviewer thread became active.
        fail_reviewer_start: Arc<AtomicBool>,
        // When true, `archive_thread` errors — exercises the dismiss path where
        // the reviewer thread can't be archived but the job is still dropped.
        fail_archive: Arc<AtomicBool>,
        // When true, `delete_thread_permanently` also errors — forces the tombstone
        // path when both archive and delete fail.
        fail_delete: Arc<AtomicBool>,
        // Delay before a turn completes (ms). Lets tests complete a turn *after* a
        // short step timeout, exercising the drain path.
        complete_delay_ms: Arc<AtomicU64>,
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
                approval_on_reviewer_turn: Arc::new(AtomicBool::new(false)),
                fail_reviewer_start: Arc::new(AtomicBool::new(false)),
                fail_archive: Arc::new(AtomicBool::new(false)),
                fail_delete: Arc::new(AtomicBool::new(false)),
                complete_delay_ms: Arc::new(AtomicU64::new(15)),
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
            _approval_policy: &str,
            _sandbox: &str,
        ) -> Result<(), String> {
            if self.threads.lock().await.contains_key(thread_id) {
                Ok(())
            } else {
                Err(format!("{} thread '{thread_id}' was not found", self.name))
            }
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
            if self.fail_delete.load(Ordering::Relaxed) {
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
            _model: &str,
            _effort: &str,
        ) -> Result<Option<String>, String> {
            self.turns
                .lock()
                .await
                .push((thread_id.to_string(), text.to_string()));
            if text.contains("You are reviewing another agent's work")
                && self.fail_reviewer_start.load(Ordering::Relaxed)
            {
                // Model a response-loss race: the provider has started work and
                // published liveness, but the start request itself returns an
                // error to the orchestrator.
                let mut relay = self.state.write().await;
                relay.set_thread_status(thread_id, "active".to_string(), Vec::new());
                relay.notify();
                return Err("reviewer turn start response was lost".to_string());
            }
            let turn_id = self.next_token("turn");
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
            let emit_assistant = self.emit_assistant.load(Ordering::Relaxed);
            let is_reviewer_turn = text.contains("You are reviewing another agent's work");
            let raise_approval = self.raise_approval.load(Ordering::Relaxed)
                || (is_reviewer_turn && self.approval_on_reviewer_turn.load(Ordering::Relaxed));
            let inject_unrelated = self
                .inject_unrelated_approval
                .swap(false, Ordering::Relaxed);
            let raise_ask_user = self.raise_ask_user.load(Ordering::Relaxed);
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
                                REVIEW_REPLY.to_string(),
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
                                REVIEW_REPLY.to_string(),
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
                });
                if emit_assistant {
                    entries.push(TranscriptEntryView {
                        item_id: Some(assistant_item),
                        kind: TranscriptEntryKind::AgentText,
                        text: Some(REVIEW_REPLY.to_string()),
                        status: "completed".to_string(),
                        turn_id: Some(turn),
                        tool: None,
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
        }
    }

    async fn wait_for_review(app: &AppState, job_id: &str) -> crate::protocol::ReviewJobView {
        wait_for_review_status(app, job_id, &["complete", "failed", "blocked"]).await
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
        for _ in 0..400 {
            if let Some(job) = app
                .list_review_jobs()
                .await
                .into_iter()
                .find(|job| job.id == job_id)
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
            reviewer_thread_id: None,
            instructions: Some("focus on the tests".to_string()),
            device_id: Some("device-1".to_string()),
        }
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
    async fn review_rejects_when_no_active_parent() {
        let dir = TempDir::new().expect("tmpdir");
        let (app, _providers) = build_review_app(dir.path().to_str().unwrap(), &["codex"]).await;
        let error = app
            .request_review(review_input("codex"))
            .await
            .expect_err("review without an active parent should fail");
        assert!(error.contains("no active"), "got: {error}");
    }

    #[tokio::test]
    async fn review_rejects_when_parent_running() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;
        app.relay.write().await.active_turn_id = Some("turn-in-flight".to_string());

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
    async fn review_rejects_existing_reviewer_thread() {
        let dir = TempDir::new().expect("tmpdir");
        let cwd = dir.path().to_str().unwrap();
        let (app, _providers) = build_review_app(cwd, &["codex"]).await;
        start_parent(&app, cwd, "codex").await;

        let mut input = review_input("codex");
        input.reviewer_thread_id = Some("some-existing-thread".to_string());
        let error = app
            .request_review(input)
            .await
            .expect_err("existing reviewer thread should be rejected in v1");
        assert!(error.contains("clean reviewer"), "got: {error}");
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
            );
            relay.insert_review_job(job);
            // Atomic: register the row AND assign reviewer_thread_id together.
            relay.register_background_thread(
                crate::protocol::ThreadSummaryView {
                    id: pending.to_string(),
                    name: None,
                    preview: String::new(),
                    cwd: cwd.to_string(),
                    updated_at: 1,
                    source: "claude_code".to_string(),
                    status: "active".to_string(),
                    model_provider: "anthropic".to_string(),
                    provider: "claude_code".to_string(),
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
        start_parent(&app, cwd, "codex").await;
        app.request_review(review_input("codex"))
            .await
            .expect("review should start and hold the guard");

        let error = app
            .apply_file_change(
                "turn-diff:whatever",
                ApplyFileChangeInput {
                    device_id: Some("device-1".to_string()),
                    direction: FileChangeApplyDirection::Rollback,
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
        start_parent(&app, cwd, "codex").await;

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
            })
            .await
            .expect_err("the reviewed thread must stay frozen while blocked");
        assert!(send_err.contains("being reviewed"), "got: {send_err}");

        // A passive (non-controller) device must not be able to resolve.
        let scope_err = app
            .resolve_blocked_review(Some("other-device".to_string()))
            .await
            .expect_err("a non-controller device must not resolve");
        assert!(scope_err.contains("control"), "got: {scope_err}");

        // A resolve that can't stop the turn stays blocked (guard never leaves the
        // slot), and the lock is still held.
        let resolve_err = app
            .resolve_blocked_review(Some("device-1".to_string()))
            .await
            .expect_err("resolve must fail while the turn can't be stopped");
        assert!(resolve_err.contains("still running"), "got: {resolve_err}");
        assert_eq!(
            app.list_review_jobs()
                .await
                .into_iter()
                .find(|job| job.id == receipt.review_job_id)
                .map(|job| job.status),
            Some("blocked".to_string()),
            "a failed resolve must stay blocked"
        );
        app.send_message(crate::protocol::SendMessageInput {
            text: "hi".to_string(),
            model: None,
            effort: None,
            device_id: Some("device-1".to_string()),
        })
        .await
        .expect_err("the lock must still be held after a failed resolve");

        // Now the provider can stop the turn; resolving unlocks the workspace.
        codex.interrupt_fails.store(false, Ordering::Relaxed);
        let resolved = app
            .resolve_blocked_review(Some("device-1".to_string()))
            .await
            .expect("resolve should unblock");
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

        let error = app
            .take_over_control(crate::protocol::TakeOverInput {
                device_id: Some("other-device".to_string()),
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
    async fn dismiss_review_removes_terminal_job_and_archives_reviewer_thread() {
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

        let dismissed = app
            .dismiss_review(receipt.review_job_id.clone(), Some("device-1".to_string()))
            .await
            .expect("dismiss should succeed for a terminal review");
        assert_eq!(dismissed.review_job_id, receipt.review_job_id);
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .all(|job| job.id != receipt.review_job_id),
            "the dismissed job must be gone"
        );
        assert!(
            !providers
                .get("codex")
                .unwrap()
                .threads
                .lock()
                .await
                .contains_key(&reviewer_thread),
            "dismiss must archive the reviewer thread"
        );
    }

    #[tokio::test]
    async fn dismiss_review_falls_back_to_delete_when_archive_fails() {
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

        app.dismiss_review(receipt.review_job_id.clone(), Some("device-1".to_string()))
            .await
            .expect("dismiss should succeed");

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
    async fn dismiss_review_tombstones_thread_when_both_archive_and_delete_fail() {
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

        app.dismiss_review(receipt.review_job_id.clone(), Some("device-1".to_string()))
            .await
            .expect("dismiss should still succeed");

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
    async fn dismiss_review_drops_the_job_even_when_archival_fails() {
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

        // The reviewer thread can't be archived, but dismiss must still drop the
        // job (the user asked to clear the card) rather than silently no-op.
        providers
            .get("codex")
            .unwrap()
            .fail_archive
            .store(true, Ordering::Relaxed);

        let dismissed = app
            .dismiss_review(receipt.review_job_id.clone(), Some("device-1".to_string()))
            .await
            .expect("dismiss should still succeed when archival fails");
        assert_eq!(dismissed.review_job_id, receipt.review_job_id);
        assert!(
            app.list_review_jobs()
                .await
                .iter()
                .all(|job| job.id != receipt.review_job_id),
            "the dismissed job must be gone even though archival failed"
        );
    }

    #[tokio::test]
    async fn terminal_review_jobs_persist_until_dismissed() {
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
        // still surface, since the persistent Reviewer panel keeps it until dismiss.
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
            "a long-finished terminal review must remain visible until dismissed"
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
            );
            relay.insert_review_job(job);
            relay.update_review_job("review-promote", |job| {
                job.reviewer_thread_id = Some(pending.to_string())
            });
            relay.register_background_thread(
                crate::protocol::ThreadSummaryView {
                    id: pending.to_string(),
                    name: None,
                    preview: String::new(),
                    cwd: cwd.to_string(),
                    updated_at: 1,
                    source: "claude_code".to_string(),
                    status: "active".to_string(),
                    model_provider: "anthropic".to_string(),
                    provider: "claude_code".to_string(),
                },
                cwd,
                "claude-model",
                "on-request",
                "workspace-write",
                "medium",
            );
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
        assert!(
            relay.is_thread_review_locked(real),
            "the real reviewer thread is review-locked"
        );
    }

    #[tokio::test]
    async fn dismiss_review_rejects_an_active_review() {
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
            .dismiss_review(receipt.review_job_id.clone(), Some("device-1".to_string()))
            .await
            .expect_err("an active review must not be dismissable");
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
    async fn review_rejected_when_background_thread_works_same_cwd() {
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
            });
            relay.bg_set_active_turn("bg-thread", Some("bg-turn".to_string()), unix_now());
        }

        let error = app
            .request_review(review_input("codex"))
            .await
            .expect_err("review must be refused while another thread works the cwd");
        assert!(
            error.contains("another thread is running in this workspace"),
            "got: {error}"
        );
        // Sanity: the parent itself is the active idle thread.
        assert_eq!(
            app.snapshot().await.active_thread_id.as_deref(),
            Some(parent.id.as_str())
        );
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
