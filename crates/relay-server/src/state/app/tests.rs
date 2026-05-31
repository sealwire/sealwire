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
        ReadThreadTranscriptInput, ResumeSessionInput, SendMessageInput, StartSessionInput,
        UpdateSessionSettingsInput,
    };
    use crate::state::security::SecurityProfile;
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

        async fn interrupt_turn(&self, _thread_id: &str, _turn_id: &str) -> Result<(), String> {
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
            .expect("resume A after background stream");
        assert!(
            snap_a_back.transcript.iter().any(|entry| {
                entry.kind == TranscriptEntryKind::AgentText
                    && entry
                        .text
                        .as_deref()
                        .unwrap_or("")
                        .contains("STREAM-A-LINE-20")
            }),
            "thread A should retain its completed background stream: {:?}",
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
            // Switch to a brand-new session B (stashes A into background).
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

        app.start_session(StartSessionInput {
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
}
