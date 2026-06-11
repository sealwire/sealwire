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
                crate::protocol::ThreadSummaryView {
                    id: thread_id.to_string(),
                    name: None,
                    preview: String::new(),
                    cwd: cwd.clone(),
                    updated_at: unix_now(),
                    source: "fake".to_string(),
                    status: "idle".to_string(),
                    model_provider: "fake".to_string(),
                    provider: "fake".to_string(),
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
        assert_eq!(tool.file_changes[0].diff, "-old\n+new");
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
                approval_on_reviewer_turn: Arc::new(AtomicBool::new(false)),
                fail_reviewer_start: Arc::new(AtomicBool::new(false)),
                fail_archive: Arc::new(AtomicBool::new(false)),
                fail_delete: Arc::new(AtomicBool::new(false)),
                fail_delete_thread_ids: Arc::new(Mutex::new(std::collections::HashSet::new())),
                turn_models: Arc::new(Mutex::new(Vec::new())),
                suppress_reviewer_reply: Arc::new(AtomicBool::new(false)),
                reviewer_verdicts: Arc::new(Mutex::new(std::collections::VecDeque::new())),
                raise_approval_on_fix_turn: Arc::new(AtomicBool::new(false)),
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
            // A reviewer/re-review turn always carries the relay-collected workspace
            // diff; recap/other turns do not.
            let is_reviewer_diff_turn = text.contains("Workspace diff collected by the relay");
            let emit_assistant = self.emit_assistant.load(Ordering::Relaxed)
                && !(is_reviewer_diff_turn && self.suppress_reviewer_reply.load(Ordering::Relaxed));
            let is_reviewer_turn = text.contains("You are reviewing another agent's work");
            // The parent fix turn (driven between rounds) carries this marker.
            let is_fix_turn = text.contains("Address the findings below");
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
                });
                if emit_assistant {
                    entries.push(TranscriptEntryView {
                        item_id: Some(assistant_item),
                        kind: TranscriptEntryKind::AgentText,
                        text: Some(reply_text.clone()),
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
            let thread = crate::protocol::ThreadSummaryView {
                id: reviewer_id.to_string(),
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "codex".to_string(),
                status: "idle".to_string(),
                model_provider: "codex".to_string(),
                provider: "codex".to_string(),
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
            let mut thread = crate::protocol::ThreadSummaryView {
                id: reviewer_id.to_string(),
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "codex".to_string(),
                status: "idle".to_string(),
                model_provider: "codex".to_string(),
                provider: "codex".to_string(),
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
        let _parent = start_parent(&app, cwd, "codex").await;

        // Seed a last assistant message on the parent (the fake replies REVIEW_REPLY).
        app.send_message(crate::protocol::SendMessageInput {
            text: "implement the storage refactor".to_string(),
            model: None,
            effort: None,
            device_id: Some("device-1".to_string()),
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
        start_parent(&app, cwd, "codex").await;

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
        start_parent(&app, cwd, "codex").await;

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
        start_parent(&app, cwd, "codex").await;

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
        start_parent(&app, cwd, "codex").await;

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

        // Simulate a restart where the in-process summary is gone (runtime + cache
        // row), so the provider must be re-derived by probing.
        {
            let mut relay = app.relay.write().await;
            relay.runtimes.remove(&reviewer);
            relay.threads.retain(|thread| thread.id != reviewer);
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
            )
            .await
            .expect("workflow should start");

        let status = wait_for_workflow_status(&app, &run_id, WORKFLOW_TERMINAL).await;
        assert_eq!(status, "escalated", "budget exhausted without approval");

        let round = app.relay.read().await.workflow_run(&run_id).unwrap().round;
        assert_eq!(round, 2, "ran both rounds");
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
        // ...but NOT in the review-owned map, so review's per-parent FIFO eviction
        // can never delete a workflow reviewer's transcript.
        assert!(
            !relay
                .reviewer_threads_of_parent(&parent.id)
                .contains(&reviewer),
            "workflow reviewer must not be in the review-owned reviewer_threads map"
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
            )
            .await
            .expect("first workflow should start");

        // A second workflow is refused...
        let err = app
            .start_workflow(
                Some("device-1".to_string()),
                workflow_code_flow("codex", 3),
                "anchor-item".to_string(),
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
                1,
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
                1,
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
