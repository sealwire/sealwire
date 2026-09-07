// Public task-team mechanism tests.
//
// These pin relay-owned behavior only: thread-id promotion, git safety,
// workspace/path isolation, public views, and lifecycle authorization. The
// workflow scenarios and prompt-shaped assertions live in the private crate.

async fn init_team_repo() -> (TempDir, String) {
    let dir = TempDir::new().expect("tmpdir");
    let path = dir.path().canonicalize().expect("canonicalize");
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "T"],
    ] {
        let out = tokio::process::Command::new("git")
            .args(&args)
            .current_dir(&path)
            .output()
            .await
            .expect("git");
        assert!(out.status.success(), "git {args:?} failed");
    }
    std::fs::write(path.join("seed.txt"), "line1\n").unwrap();
    for args in [vec!["add", "-A"], vec!["commit", "-q", "-m", "seed"]] {
        let out = tokio::process::Command::new("git")
            .args(&args)
            .current_dir(&path)
            .output()
            .await
            .expect("git");
        assert!(out.status.success(), "git {args:?} failed");
    }
    let display = path.to_string_lossy().into_owned();
    (dir, display)
}

fn team_git_stdout(cwd: &str, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git should run");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn team_git_commit_all(cwd: &str, message: &str) -> String {
    let add = std::process::Command::new("git")
        .args(["add", "-A"])
        .current_dir(cwd)
        .output()
        .expect("git add should run");
    assert!(
        add.status.success(),
        "git add failed: {}",
        String::from_utf8_lossy(&add.stderr)
    );
    let commit = std::process::Command::new("git")
        .args(["commit", "-q", "-m", message])
        .current_dir(cwd)
        .output()
        .expect("git commit should run");
    assert!(
        commit.status.success(),
        "git commit failed: {}",
        String::from_utf8_lossy(&commit.stderr)
    );
    team_git_stdout(cwd, &["rev-parse", "HEAD"])
}

fn team_input(cwd: &str) -> crate::state::app::team::TeamStartRequest {
    crate::state::app::team::TeamStartRequest {
        spec: crate::state::TaskSpec {
            title: "Add a parser".to_string(),
            context: "The loader needs one.".to_string(),
            acceptance_criteria: "Parses all three encodings.".to_string(),
            agreed_scope: "Parser only; no loader refactor.".to_string(),
            quality_rules: "No unwrap in library code.".to_string(),
        },
        origin_cwd: cwd.to_string(),
        target_branch: None,
        device_id: "device-1".to_string(),
        tl_model: String::new(),
        dev_model: String::new(),
        reviewer_model: String::new(),
        tl_effort: String::new(),
        dev_effort: String::new(),
        reviewer_effort: String::new(),
        dev_agents: None,
        starting_proposal_id: None,
        tl_provider: "codex".to_string(),
        dev_provider: "codex".to_string(),
        reviewer_provider: "codex".to_string(),
    }
}

fn cloud_backend() -> relay_api::orchestration::OrchestrationBackendRef {
    relay_api::orchestration::OrchestrationBackendRef::Cloud {
        protocol_version: relay_api::orchestration::SupportedProtocolVersion::current(),
        driver_version: relay_api::orchestration::DriverVersion::new("driver.1").unwrap(),
        cloud_run_id: relay_api::orchestration::DriverRunId::new("cloud-run-1").unwrap(),
    }
}

struct ReturningTeamDriver;
struct PanickingTeamDriver;
struct BlockingTeamDriver;
struct RecordingTeamDriver {
    drove: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
struct ResumeAttemptDriver {
    finished: std::sync::Arc<std::sync::atomic::AtomicBool>,
    finished_notify: std::sync::Arc<tokio::sync::Notify>,
    outcome: std::sync::Arc<Mutex<Option<relay_api::team::TeamTurnOutcome>>>,
}
struct ParkedTeamDriver {
    entered: std::sync::Arc<std::sync::atomic::AtomicBool>,
    release: std::sync::Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for ReturningTeamDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, _port: std::sync::Arc<dyn relay_api::TeamPort>, _run_id: String) {}
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for PanickingTeamDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, _port: std::sync::Arc<dyn relay_api::TeamPort>, _run_id: String) {
        panic!("intentional test-driver panic");
    }
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for BlockingTeamDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        port.block_run(&run_id, "intentional test block".to_string())
            .await;
    }
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for RecordingTeamDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, _port: std::sync::Arc<dyn relay_api::TeamPort>, _run_id: String) {
        self.drove.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for ResumeAttemptDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskDev(0),
                relay_api::team::TeamRole::Dev,
                "resume should not reach the provider",
            )
            .await;
        *self.outcome.lock().await = Some(outcome);
        self.finished
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self.finished_notify.notify_one();
    }
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for ParkedTeamDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, _port: std::sync::Arc<dyn relay_api::TeamPort>, _run_id: String) {
        self.entered.store(true, Ordering::Relaxed);
        self.release.notified().await;
    }
}

async fn wait_for_team_status(
    app: &AppState,
    run_id: &str,
    expected: crate::state::TeamRunStatus,
) -> crate::state::TeamRun {
    for _ in 0..600 {
        if let Some(run) = app.relay.read().await.team_run(run_id).cloned() {
            if run.status == expected {
                return run;
            }
        }
        sleep(Duration::from_millis(5)).await;
    }
    panic!("task {run_id} never reached {expected:?}");
}

async fn wait_until_condition(label: &str, mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{label}"));
}

async fn wait_for_released_threads(
    provider: &ReviewTestProvider,
    expected: &[String],
) -> Vec<String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let released = provider.released_threads().await;
            if expected
                .iter()
                .all(|thread_id| released.contains(thread_id))
            {
                return released;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("expected provider releases for {expected:?}"))
}

#[tokio::test]
async fn start_team_run_records_legacy_backend_before_driver_spawn() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let drove = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let app = app.with_team_driver(std::sync::Arc::new(RecordingTeamDriver {
        drove: drove.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Interrupted).await;

    assert!(
        drove.load(std::sync::atomic::Ordering::Relaxed),
        "the embedded backend gate must allow the freshly-created legacy run to reach the driver"
    );
    assert_eq!(
        run.orchestration_backend,
        relay_api::orchestration::OrchestrationBackendRef::LegacyEmbedded
    );
}

#[tokio::test]
async fn resume_team_run_refuses_non_embedded_backend_before_status_flip() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let mut run = crate::state::TeamRun::new(
        "team-cloud-resume".to_string(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Paused;
    run.orchestration_backend = cloud_backend();
    app.relay.write().await.insert_team_run(run);

    let pause_error = app
        .pause_team_run(
            Some("team-cloud-resume".to_string()),
            Some("device-1".to_string()),
        )
        .await
        .expect_err("Pause must refuse a Cloud-pinned run in this build");
    assert!(pause_error.contains("Cloud orchestration"), "{pause_error}");

    let error = app
        .resume_team_run(
            Some("team-cloud-resume".to_string()),
            Some("device-1".to_string()),
        )
        .await
        .expect_err("resume must refuse a Cloud-pinned run in this build");

    assert!(error.contains("Cloud orchestration"), "{error}");
    let run = app
        .relay
        .read()
        .await
        .team_run("team-cloud-resume")
        .cloned()
        .unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Paused);
    assert_eq!(run.orchestration_backend, cloud_backend());
}

#[tokio::test]
async fn resume_team_run_allows_malformed_progress_on_legacy_backend() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let drove = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let app = app.with_team_driver(std::sync::Arc::new(RecordingTeamDriver {
        drove: drove.clone(),
    }));
    let run_id = "team-legacy-malformed-progress-resume".to_string();
    let mut run = crate::state::TeamRun::new(
        run_id.clone(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Paused;
    run.driver_progress = serde_json::from_str(r#"{"future_progress_field":1}"#)
        .expect("unknown progress fields must decode fail-closed");
    assert!(run.driver_progress.is_malformed());
    app.relay.write().await.insert_team_run(run);

    let status = app
        .resume_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect("legacy embedded runs may continue without consuming driver progress");

    assert_eq!(status, crate::state::TeamRunStatus::Running);
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Interrupted).await;
    assert!(
        run.driver_progress.is_malformed(),
        "resuming the legacy driver must not clear a future progress marker"
    );
    assert!(
        drove.load(std::sync::atomic::Ordering::Relaxed),
        "malformed future progress must not block the legacy embedded driver"
    );
}

#[tokio::test]
async fn stop_on_an_already_paused_embedded_run_is_a_truthful_noop() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let mut run = crate::state::TeamRun::new(
        "team-paused-stop".to_string(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Paused;
    app.relay.write().await.insert_team_run(run);

    let status = app
        .force_stop_team_run(
            Some("team-paused-stop".to_string()),
            Some("device-1".to_string()),
        )
        .await
        .expect("stopping an already paused local task is a no-op");

    assert_eq!(status, crate::state::TeamRunStatus::Paused);
    let run = app
        .relay
        .read()
        .await
        .team_run("team-paused-stop")
        .cloned()
        .unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Paused);
    assert!(!run.pause_requested);
    assert!(!run.stopping);
    assert_eq!(run.in_flight_thread, None);
}

#[tokio::test]
async fn stop_on_a_paused_embedded_run_still_drains_unconfirmed_turns() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let mut run = crate::state::TeamRun::new(
        "team-paused-stop-hung".to_string(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Paused;
    run.in_flight_thread = Some("stale-mid-start".to_string());
    app.relay.write().await.insert_team_run(run);

    let error = app
        .force_stop_team_run(
            Some("team-paused-stop-hung".to_string()),
            Some("device-1".to_string()),
        )
        .await
        .expect_err("a paused run with an unconfirmed turn is not quiescent");

    assert!(error.contains("did not confirm stopping"), "{error}");
    let run = app
        .relay
        .read()
        .await
        .team_run("team-paused-stop-hung")
        .cloned()
        .unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Blocked);
    assert!(!run.pause_requested);
    assert!(!run.stopping);
    assert_eq!(run.in_flight_thread.as_deref(), Some("stale-mid-start"));
}

#[tokio::test(flavor = "current_thread")]
async fn stop_revalidates_after_a_queued_resume_wins_the_drive_gate() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let codex = providers.get("codex").unwrap().clone();
    codex
        .settle_turn_before_start_returns
        .store(true, Ordering::Relaxed);

    let run_id = "team-stop-after-resume".to_string();
    let dev_thread = codex.summary("codex-resume-dev", &root);
    codex
        .threads
        .lock()
        .await
        .insert(dev_thread.id.clone(), dev_thread.clone());
    codex
        .start_thread_cwds
        .lock()
        .await
        .push((dev_thread.id.clone(), root.clone()));
    {
        let mut relay = app.relay.write().await;
        relay.register_background_thread(
            dev_thread.clone(),
            &root,
            "codex-model",
            "on-request",
            "workspace-write",
            "medium",
        );
        let mut run = crate::state::TeamRun::new(
            run_id.clone(),
            crate::state::TaskSpec::default(),
            root.clone(),
            "device-1".to_string(),
        );
        run.status = crate::state::TeamRunStatus::Paused;
        run.phase = relay_api::team::TeamPhase::SubTasks;
        run.sub_tasks.push(crate::state::SubTask {
            id: "st-1".to_string(),
            title: "Parser".to_string(),
            brief: "write the parser".to_string(),
            status: crate::state::SubTaskStatus::Pending,
            dev_thread_id: Some(dev_thread.id.clone()),
            ..Default::default()
        });
        relay.insert_team_run(run);
    }

    let driver_finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let driver_finished_notify = std::sync::Arc::new(tokio::sync::Notify::new());
    let driver_outcome = std::sync::Arc::new(Mutex::new(None));
    let app = app.with_team_driver(std::sync::Arc::new(ResumeAttemptDriver {
        finished: driver_finished.clone(),
        finished_notify: driver_finished_notify.clone(),
        outcome: driver_outcome.clone(),
    }));

    let driver_pre_gate = app.hold_team_gated_barrier().await;
    let gate = app.team_drive_gate.lock().await;
    let stop_pre_gate = app.hold_team_stop_pre_gate_barrier().await;
    let stop_pre_gate_before = app.team_stop_pre_gate_arrivals();
    let stop_waiter_before = app.team_stop_gate_waiter_arrivals();

    let resume_task = {
        let app = app.clone();
        let run_id = run_id.clone();
        tokio::spawn(async move {
            app.resume_team_run(Some(run_id), Some("device-1".to_string()))
                .await
        })
    };
    wait_until_condition("resume should queue at the held drive gate", || {
        app.driving_team_runs
            .lock()
            .expect("drive set")
            .contains(&run_id)
    })
    .await;

    let stop_task = {
        let app = app.clone();
        let run_id = run_id.clone();
        tokio::spawn(async move {
            app.force_stop_team_run(Some(run_id), Some("device-1".to_string()))
                .await
        })
    };
    wait_until_condition("stop should park before drive-gate admission", || {
        app.team_stop_pre_gate_arrivals() > stop_pre_gate_before
    })
    .await;

    drop(stop_pre_gate);
    wait_until_condition("stop should queue behind Resume at the drive gate", || {
        app.team_stop_gate_waiter_arrivals() > stop_waiter_before
    })
    .await;
    drop(gate);

    let resumed = tokio::time::timeout(Duration::from_secs(5), resume_task)
        .await
        .expect("resume should not hang behind Stop")
        .expect("resume task should not panic")
        .expect("resume should win the gate first");
    assert_eq!(resumed, crate::state::TeamRunStatus::Running);

    let stopped = tokio::time::timeout(Duration::from_secs(5), stop_task)
        .await
        .expect("Stop should not hang after gate admission")
        .expect("stop task should not panic")
        .expect("stop should re-read the resumed Running status and stop it");
    assert_eq!(stopped, crate::state::TeamRunStatus::Paused);
    let run = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("run remains recorded");
    assert_eq!(run.status, crate::state::TeamRunStatus::Paused);
    assert_eq!(run.pause_kind, Some(relay_api::team::TeamPauseKind::User));
    assert_eq!(run.pause_reason.as_deref(), Some("stopped by the user"));
    assert!(
        codex.turns.lock().await.is_empty(),
        "Stop returned before any resumed provider turn dispatched"
    );

    drop(driver_pre_gate);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !driver_finished.load(Ordering::Relaxed) {
            driver_finished_notify.notified().await;
        }
    })
    .await
    .expect("the resumed driver should release its ticket after Stop settles");

    match driver_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => {
            assert!(reason.contains("settled as paused"), "{reason}");
        }
        other => panic!("the resumed driver should be refused after Stop settles: {other:?}"),
    }
    assert!(
        codex.turns.lock().await.is_empty(),
        "the resumed driver must never dispatch a provider turn after Stop settles"
    );
    wait_until_condition(
        "the resumed driver's drive ticket should release after the refused turn",
        || {
            !app.driving_team_runs
                .lock()
                .expect("drive set")
                .contains(&run_id)
        },
    )
    .await;
}

#[tokio::test(flavor = "current_thread")]
async fn pause_revalidates_after_a_queued_resume_wins_the_drive_gate() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let run_id = "team-pause-after-resume".to_string();
    let driver_entered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let release_driver = std::sync::Arc::new(tokio::sync::Notify::new());
    let app = app.with_team_driver(std::sync::Arc::new(ParkedTeamDriver {
        entered: driver_entered.clone(),
        release: release_driver.clone(),
    }));
    let mut run = crate::state::TeamRun::new(
        run_id.clone(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Paused;
    app.relay.write().await.insert_team_run(run);

    let gate = app.team_drive_gate.lock().await;
    let pause_arrivals_before = app.team_pause_pre_gate_arrivals();
    let resume_task = {
        let app = app.clone();
        let run_id = run_id.clone();
        tokio::spawn(async move {
            app.resume_team_run(Some(run_id), Some("device-1".to_string()))
                .await
        })
    };
    wait_until_condition("resume should queue at the held drive gate", || {
        app.driving_team_runs
            .lock()
            .expect("drive set")
            .contains(&run_id)
    })
    .await;

    let pause_task = {
        let app = app.clone();
        let run_id = run_id.clone();
        tokio::spawn(async move {
            app.pause_team_run(Some(run_id), Some("device-1".to_string()))
                .await
        })
    };
    wait_until_condition("Pause should queue behind Resume at the drive gate", || {
        app.team_pause_pre_gate_arrivals() > pause_arrivals_before
    })
    .await;
    drop(gate);

    let resumed = tokio::time::timeout(Duration::from_secs(5), resume_task)
        .await
        .expect("resume should not hang behind Pause")
        .expect("resume task should not panic")
        .expect("resume should win the gate first");
    assert_eq!(resumed, crate::state::TeamRunStatus::Running);
    let pause_status = tokio::time::timeout(Duration::from_secs(5), pause_task)
        .await
        .expect("Pause should not hang after gate admission")
        .expect("pause task should not panic")
        .expect("Pause should re-read the resumed Running status");
    assert_eq!(pause_status, crate::state::TeamRunStatus::PausePending);

    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::PausePending);
    assert!(run.pause_requested);

    wait_until_condition("the resumed driver should start", || {
        driver_entered.load(Ordering::Relaxed)
    })
    .await;
    release_driver.notify_one();
    wait_until_condition("the resumed driver should release its drive ticket", || {
        !app.driving_team_runs
            .lock()
            .expect("drive set")
            .contains(&run_id)
    })
    .await;
}

#[tokio::test]
async fn stop_refuses_non_embedded_backend_without_setting_markers() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let mut run = crate::state::TeamRun::new(
        "team-cloud-stop".to_string(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Running;
    run.orchestration_backend = cloud_backend();
    app.relay.write().await.insert_team_run(run);

    let error = app
        .force_stop_team_run(
            Some("team-cloud-stop".to_string()),
            Some("device-1".to_string()),
        )
        .await
        .expect_err("stop must refuse a Cloud-pinned run in this build");

    assert!(error.contains("Cloud orchestration"), "{error}");
    let run = app
        .relay
        .read()
        .await
        .team_run("team-cloud-stop")
        .cloned()
        .unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Running);
    assert!(!run.pause_requested);
    assert!(!run.stopping);
}

#[tokio::test]
async fn stranded_cleanup_leaves_non_embedded_records_inert() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let mut run = crate::state::TeamRun::new(
        "team-cloud-stranded".to_string(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Running;
    run.orchestration_backend = cloud_backend();
    app.relay.write().await.insert_team_run(run);

    app.interrupt_team_run_if_stranded("team-cloud-stranded")
        .await;

    let run = app
        .relay
        .read()
        .await
        .team_run("team-cloud-stranded")
        .cloned()
        .expect("run remains visible");
    assert_eq!(run.status, crate::state::TeamRunStatus::Running);
    assert_eq!(run.error, None);
    assert!(!run.stopping);
}

#[tokio::test]
async fn inert_records_can_be_archived_but_not_marked_done() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let mut run = crate::state::TeamRun::new(
        "team-cloud-archive".to_string(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Paused;
    run.orchestration_backend = cloud_backend();
    app.relay.write().await.insert_team_run(run);

    let error = app
        .mark_team_run(
            Some("team-cloud-archive".to_string()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Done,
        )
        .await
        .expect_err("mark_done would be a false success on an inert run");
    assert!(error.contains("Cloud orchestration"), "{error}");

    let status = app
        .mark_team_run(
            Some("team-cloud-archive".to_string()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect("mark_cancelled is the explicit archival escape");
    assert_eq!(status, crate::state::TeamRunStatus::Cancelled);

    let status = app
        .mark_team_run(
            Some("team-cloud-archive".to_string()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect("archival is idempotent");
    assert_eq!(status, crate::state::TeamRunStatus::Cancelled);

    app.relay
        .write()
        .await
        .update_team_run("team-cloud-archive", |run| {
            run.force_mark_status(crate::state::TeamRunStatus::Done);
        });

    let status = app
        .mark_team_run(
            Some("team-cloud-archive".to_string()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Done,
        )
        .await
        .expect("mark_done should acknowledge an already-done inert row as a no-op");
    assert_eq!(status, crate::state::TeamRunStatus::Done);

    let status = app
        .mark_team_run(
            Some("team-cloud-archive".to_string()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect("explicit archival may relabel an already-done inert row");
    assert_eq!(status, crate::state::TeamRunStatus::Cancelled);
}

#[tokio::test]
async fn mark_cancelled_archives_inert_blocked_run_and_releases_provider_seats() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let codex = providers.get("codex").unwrap().clone();
    let run_id = "team-cloud-archive-release".to_string();
    {
        let mut run = crate::state::TeamRun::new(
            run_id.clone(),
            crate::state::TaskSpec::default(),
            root.clone(),
            "device-1".to_string(),
        );
        run.tl_provider = "codex".to_string();
        run.dev_provider = "codex".to_string();
        run.reviewer_provider = "codex".to_string();
        app.relay.write().await.insert_team_run(run);
    }

    let tl_thread = relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Tl)
        .await
        .expect("tl provider-backed thread");
    let dev_thread =
        relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev provider-backed thread");
    let reviewer_thread =
        relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Reviewer)
            .await
            .expect("reviewer provider-backed thread");
    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.tl_thread_id = tl_thread.clone();
            run.phase = relay_api::team::TeamPhase::SubTasks;
            run.sub_tasks.push(crate::state::SubTask {
                id: "st-1".to_string(),
                title: "Parser".to_string(),
                brief: "write the parser".to_string(),
                status: crate::state::SubTaskStatus::Pending,
                dev_thread_id: Some(dev_thread.clone()),
                reviewer_thread_id: Some(reviewer_thread.clone()),
                ..Default::default()
            });
        });
        relay.notify();
    }

    let backend = cloud_backend();
    let backend_reason = backend.non_executing_reason().unwrap().to_string();
    let owned = {
        let mut relay = app.relay.write().await;
        let mut run = relay
            .remove_team_run(&run_id)
            .expect("test run should be recorded");
        let owned = run.owned_thread_ids();
        assert_eq!(
            owned.len(),
            3,
            "the fixture should own the TL, dev, and reviewer seats"
        );
        run.status = crate::state::TeamRunStatus::Paused;
        run.orchestration_backend = backend;
        run.error = Some(backend_reason.clone());
        relay.insert_team_run(run);
        relay.notify();
        owned
    };
    assert!(
        codex.released_threads().await.is_empty(),
        "making the run inert is only restore modelling; archival is what releases seats"
    );

    std::fs::remove_dir_all(&root).expect("remove temporary task worktree");
    app.validate_paused_team_runs().await;

    let run = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("run remains visible after validation");
    assert_eq!(run.status, crate::state::TeamRunStatus::Blocked);
    let error = run.error.as_deref().unwrap_or_default();
    assert!(
        error.contains("no longer exists"),
        "missing worktree validation should make an inert pause diagnostically blocked: {error}"
    );
    assert!(
        error.contains(backend_reason.as_str()),
        "the blocked diagnostic should retain the unsupported-backend reason: {error}"
    );

    let resolve_error = app
        .resolve_blocked_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect_err("blocked recovery cannot execute an inert backend");
    assert!(
        resolve_error.contains(backend_reason.as_str()),
        "blocked recovery should refuse the inert backend before pretending to drain: {resolve_error}"
    );

    let status = app
        .mark_team_run(
            Some(run_id.clone()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect("mark_cancelled is the current-build archival escape for inert runs");
    assert_eq!(status, crate::state::TeamRunStatus::Cancelled);

    let released = wait_for_released_threads(&codex, &owned).await;
    for thread_id in &owned {
        assert!(
            released.contains(thread_id),
            "explicit archival should release every restored local seat: {thread_id} missing from {released:?}"
        );
    }
    assert_eq!(
        app.relay
            .read()
            .await
            .team_run(&run_id)
            .map(|run| run.status),
        Some(crate::state::TeamRunStatus::Cancelled)
    );
}

#[tokio::test]
async fn mark_cancelled_drains_malformed_legacy_run_and_releases_provider_seats() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let codex = providers.get("codex").unwrap().clone();
    let run_id = "team-legacy-malformed-progress-cancel".to_string();
    let mut run = crate::state::TeamRun::new(
        run_id.clone(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.tl_provider = "codex".to_string();
    run.dev_provider = "codex".to_string();
    run.reviewer_provider = "codex".to_string();
    run.status = crate::state::TeamRunStatus::Running;
    run.driver_progress = serde_json::from_str(r#"{"future_progress_field":1}"#)
        .expect("unknown progress fields must decode fail-closed");
    assert!(run.driver_progress.is_malformed());
    app.relay.write().await.insert_team_run(run);

    let tl_thread = relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Tl)
        .await
        .expect("tl provider-backed thread");
    let dev_thread =
        relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev provider-backed thread");
    let reviewer_thread =
        relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Reviewer)
            .await
            .expect("reviewer provider-backed thread");
    let owned = vec![
        tl_thread.clone(),
        dev_thread.clone(),
        reviewer_thread.clone(),
    ];
    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.tl_thread_id = tl_thread;
            run.phase = relay_api::team::TeamPhase::SubTasks;
            run.sub_tasks.push(crate::state::SubTask {
                id: "st-1".to_string(),
                status: crate::state::SubTaskStatus::Pending,
                dev_thread_id: Some(dev_thread),
                reviewer_thread_id: Some(reviewer_thread),
                ..Default::default()
            });
        });
        relay.notify();
    }

    let status = app
        .mark_team_run(
            Some(run_id.clone()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect("malformed progress must not remove the legacy run's archival exit");

    assert_eq!(status, crate::state::TeamRunStatus::Cancelled);
    let released = wait_for_released_threads(&codex, &owned).await;
    for thread_id in &owned {
        assert!(
            released.contains(thread_id),
            "ordinary cancellation should release the legacy run's seat {thread_id}"
        );
    }
}

#[tokio::test]
async fn reopen_team_run_refuses_non_embedded_backend_before_mutating() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let mut run = crate::state::TeamRun::new(
        "team-cloud-reopen".to_string(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Failed;
    run.phase = relay_api::team::TeamPhase::MrGate;
    run.error = Some("older failure".to_string());
    run.orchestration_backend = cloud_backend();
    app.relay.write().await.insert_team_run(run);

    let error = app
        .reopen_team_run(
            Some("team-cloud-reopen".to_string()),
            "try again",
            &relay_api::team::TaskSpecUpdates::default(),
            Some("device-1".to_string()),
        )
        .await
        .expect_err("reopen must refuse a Cloud-pinned run in this build");

    assert!(error.contains("Cloud orchestration"), "{error}");
    let run = app
        .relay
        .read()
        .await
        .team_run("team-cloud-reopen")
        .cloned()
        .unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Failed);
    assert_eq!(run.phase, relay_api::team::TeamPhase::MrGate);
    assert_eq!(run.error.as_deref(), Some("older failure"));
    assert!(run.pending_user_notes.is_empty());
    assert_eq!(run.orchestration_backend, cloud_backend());
}

#[tokio::test]
async fn paused_restore_validation_blocks_missing_non_embedded_worktree() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let backend = cloud_backend();
    let reason = backend.non_executing_reason().unwrap().to_string();
    let mut run = crate::state::TeamRun::new(
        "team-cloud-restore".to_string(),
        crate::state::TaskSpec::default(),
        std::path::Path::new(&root)
            .join("missing-worktree")
            .to_string_lossy()
            .into_owned(),
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Paused;
    run.orchestration_backend = backend;
    run.error = Some(reason.clone());
    app.relay.write().await.insert_team_run(run);

    app.validate_paused_team_runs().await;

    let run = app
        .relay
        .read()
        .await
        .team_run("team-cloud-restore")
        .cloned()
        .unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Blocked);
    let error = run.error.as_deref().unwrap_or_default();
    assert!(
        error.contains("no longer exists"),
        "missing worktree validation must still run for inert pauses: {error}"
    );
    assert!(
        error.contains(reason.as_str()),
        "the backend refusal reason should remain visible beside the worktree diagnosis: {error}"
    );
}

#[tokio::test]
async fn paused_restore_validation_does_not_reseed_an_inert_run() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let mut run = crate::state::TeamRun::new(
        "team-cloud-dead-tl".to_string(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Paused;
    run.tl_thread_id = "missing-cloud-tl".to_string();
    run.orchestration_backend = cloud_backend();
    app.relay.write().await.insert_team_run(run);

    app.validate_paused_team_runs().await;

    let run = app
        .relay
        .read()
        .await
        .team_run("team-cloud-dead-tl")
        .cloned()
        .unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Paused);
    assert_eq!(run.tl_thread_id, "missing-cloud-tl");
    assert!(
        run.tl_reseed_reason.is_none(),
        "a backend this build cannot execute must not schedule local TL recovery"
    );
}

#[tokio::test]
async fn spawned_team_driver_refuses_non_embedded_backend_without_driving() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let drove = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let app = app.with_team_driver(std::sync::Arc::new(RecordingTeamDriver {
        drove: drove.clone(),
    }));
    let mut run = crate::state::TeamRun::new(
        "team-cloud-drive".to_string(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.orchestration_backend = cloud_backend();
    app.relay.write().await.insert_team_run(run);

    let ticket = app
        .claim_team_drive("team-cloud-drive")
        .expect("test run is not already driving");
    app.spawn_team_driver_for_test("team-cloud-drive".to_string(), ticket);
    let run = wait_for_team_status(
        &app,
        "team-cloud-drive",
        crate::state::TeamRunStatus::Failed,
    )
    .await;

    assert!(
        !drove.load(std::sync::atomic::Ordering::Relaxed),
        "the driver body must not run once the backend gate refuses it"
    );
    assert!(
        run.error
            .as_deref()
            .unwrap_or_default()
            .contains("Cloud orchestration"),
        "the failure should surface the backend-pin reason: {:?}",
        run.error
    );
}

#[tokio::test]
async fn the_public_host_reconciles_a_private_driver_that_returns_without_settling() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let app = app.with_team_driver(std::sync::Arc::new(ReturningTeamDriver));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Interrupted).await;

    assert!(
        run.error.as_deref().unwrap_or_default().contains("driver"),
        "the public crash net should explain the reconciliation: {:?}",
        run.error
    );
    for _ in 0..200 {
        if let Some(ticket) = app.claim_team_drive(&run_id) {
            drop(ticket);
            return;
        }
        sleep(Duration::from_millis(5)).await;
    }
    panic!("the returned driver kept its public drive ticket");
}

#[tokio::test]
async fn the_public_host_reconciles_a_private_driver_that_panics() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let app = app.with_team_driver(std::sync::Arc::new(PanickingTeamDriver));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Interrupted).await;
    assert!(
        run.error.as_deref().unwrap_or_default().contains("driver"),
        "the host-owned Drop guard must reconcile an unwind: {:?}",
        run.error
    );
}

#[tokio::test]
async fn the_public_host_preserves_a_deliberately_blocked_driver_return() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let app = app.with_team_driver(std::sync::Arc::new(BlockingTeamDriver));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Blocked).await;
    sleep(Duration::from_millis(50)).await;
    let still_blocked = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(still_blocked.status, crate::state::TeamRunStatus::Blocked);
    assert_eq!(still_blocked.error, run.error);
}

#[tokio::test]
async fn team_port_update_run_records_rejected_backend_retargets() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    {
        let mut run = crate::state::TeamRun::new(
            "team-retarget".to_string(),
            crate::state::TaskSpec::default(),
            root,
            "device-1".to_string(),
        );
        run.status = crate::state::TeamRunStatus::Running;
        app.relay.write().await.insert_team_run(run);
    }

    let before_revision = app.snapshot().await.revision;
    let cloud = cloud_backend();

    let updated = relay_api::TeamPort::update_run(
        &app,
        "team-retarget",
        Box::new(move |run| {
            run.orchestration_backend = cloud;
            run.phase = crate::state::TeamPhase::MrGate;
        }),
    )
    .await;

    assert!(!updated, "the TeamPort wrapper must surface the rejection");
    assert_ne!(
        app.snapshot().await.revision,
        before_revision,
        "rejected updates must notify surfaces because a failure was recorded"
    );
    let run = app
        .relay
        .read()
        .await
        .team_run("team-retarget")
        .cloned()
        .unwrap();
    assert_eq!(
        run.orchestration_backend,
        relay_api::orchestration::OrchestrationBackendRef::LegacyEmbedded
    );
    assert_eq!(run.phase, crate::state::TeamPhase::MrGate);
    assert_eq!(run.status, crate::state::TeamRunStatus::Failed);
    assert!(
        run.error
            .as_deref()
            .is_some_and(|error| error.contains("orchestration backend after execution began")),
        "the immutable-backend rejection should be recorded explicitly: {:?}",
        run.error
    );
}

#[tokio::test]
async fn rejected_backend_retarget_notifies_for_settled_runs_but_not_missing_ids() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let mut run = crate::state::TeamRun::new(
        "team-paused-retarget".to_string(),
        crate::state::TaskSpec::default(),
        root,
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Paused;
    app.relay.write().await.insert_team_run(run);

    let before_revision = app.snapshot().await.revision;
    let updated = relay_api::TeamPort::update_run(
        &app,
        "team-paused-retarget",
        Box::new(|run| {
            run.orchestration_backend = cloud_backend();
            run.phase = crate::state::TeamPhase::MrGate;
        }),
    )
    .await;
    assert!(!updated);
    assert_ne!(app.snapshot().await.revision, before_revision);

    let run = app
        .relay
        .read()
        .await
        .team_run("team-paused-retarget")
        .cloned()
        .unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Paused);
    assert_eq!(run.phase, crate::state::TeamPhase::MrGate);
    assert!(run.orchestration_backend.is_legacy_embedded());

    let before_missing = app.snapshot().await.revision;
    let updated = relay_api::TeamPort::update_run(
        &app,
        "team-does-not-exist",
        Box::new(|run| run.phase = crate::state::TeamPhase::Finished),
    )
    .await;
    assert!(!updated);
    assert_eq!(
        app.snapshot().await.revision,
        before_missing,
        "an unknown run id must not fabricate a state change"
    );
}

#[tokio::test]
async fn missing_workspace_is_not_flattened_into_an_absent_commit_or_merge_base() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let app = app.with_team_driver(std::sync::Arc::new(ReturningTeamDriver));
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Interrupted).await;
    std::fs::remove_dir_all(&run.cwd).expect("remove temporary task worktree");

    for result in [
        relay_api::TeamPort::checkpoint_commit(&app, &run_id)
            .await
            .map(|_| ()),
        relay_api::TeamPort::merge_base(&app, &run_id, &run.target_ref)
            .await
            .map(|_| ()),
    ] {
        match result {
            Err(relay_api::TeamPortError::Blocked(message)) => {
                assert!(message.contains(&run.cwd), "{message}");
            }
            other => panic!("missing workspace must stay typed as Blocked, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_claude_style_pending_promotion_keeps_every_team_seat_addressable() {
    // The failure this pins: Claude mints a synthetic `claude-pending-*` id and
    // only swaps in the real session id once the first turn starts. Every team
    // seat is background-started, so any of them can be promoted mid-turn. A
    // driver still holding the pending id finds no runtime, reads that as "not
    // working", and treats a running turn as finished — losing that agent's
    // output entirely. No fake provider models this, so it has to be asserted
    // on the record directly.
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .complete_turns
        .store(false, Ordering::Relaxed);
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    // Put a pending id in every seat the driver can address.
    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.tl_thread_id = "claude-pending-1".to_string();
            run.run_owned_thread_ids = vec!["claude-pending-1".to_string()];
            run.sub_tasks = vec![crate::state::SubTask {
                id: "s1".to_string(),
                dev_thread_id: Some("claude-pending-1".to_string()),
                reviewer_thread_id: Some("claude-pending-1".to_string()),
                owned_thread_ids: vec!["claude-pending-1".to_string()],
                ..crate::state::SubTask::default()
            }];
        });
        relay.promote_background_thread("claude-pending-1", "sess-real");
    }

    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(
        run.tl_thread_id, "sess-real",
        "the TL seat must follow the promotion"
    );
    assert_eq!(
        run.thread_in_slot(crate::state::TeamThreadSlot::Tl)
            .as_deref(),
        Some("sess-real")
    );
    assert_eq!(
        run.thread_in_slot(crate::state::TeamThreadSlot::SubTaskDev(0))
            .as_deref(),
        Some("sess-real"),
    );
    assert_eq!(
        run.thread_in_slot(crate::state::TeamThreadSlot::SubTaskReviewer(0))
            .as_deref(),
        Some("sess-real"),
    );
    assert_eq!(
        run.thread_in_slot(crate::state::TeamThreadSlot::RunOwned(0))
            .as_deref(),
        Some("sess-real"),
        "design/MR reviewers live here and were previously unreachable",
    );
    assert!(
        !run.owned_thread_ids()
            .iter()
            .any(|id| id.starts_with("claude-pending-")),
        "no seat may still name a dead pending id: {:?}",
        run.owned_thread_ids()
    );
}

#[tokio::test]
async fn commit_failures_propagate_instead_of_being_swallowed() {
    // The shape being pinned: "nothing to commit" is success, but a git
    // failure must NOT be mistaken for it. Swallowing one means the MR gate
    // reviews an uncommitted tree, head_commit points at the old HEAD, and the
    // run reports Done with the work still sitting in the working tree.
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let workspace = TrustedWorkspace::granted_for_test(&root).expect("workspace");
    let path = std::path::Path::new(&root);

    assert_eq!(
        app.commit_worktree(&workspace, "noop").await,
        Ok(false),
        "a clean tree is a no-op, not a failure"
    );

    std::fs::write(path.join("work.txt"), "first\n").unwrap();
    assert_eq!(
        app.commit_worktree(&workspace, "work").await,
        Ok(true),
        "a real change commits"
    );

    // A locked index is the deterministic stand-in for any git failure: the
    // old code turned a non-zero exit here into "nothing staged" and carried on.
    std::fs::write(path.join(".git").join("index.lock"), "").unwrap();
    std::fs::write(path.join("work2.txt"), "second\n").unwrap();
    let error = app
        .commit_worktree(&workspace, "blocked")
        .await
        .expect_err("a git failure must surface");
    assert!(
        error.contains("git add") || error.contains("git commit"),
        "the error should name the failing command: {error}"
    );
    std::fs::remove_file(path.join(".git").join("index.lock")).unwrap();
}

#[tokio::test]
async fn committing_never_executes_repository_hooks() {
    // `--no-verify` is NOT enough: it skips `pre-commit` and `commit-msg`, but
    // `prepare-commit-msg` and `post-commit` still run, which would reopen the
    // arbitrary-code surface provisioning already closes.
    let (_repo, root) = init_team_repo().await;
    let path = std::path::Path::new(&root);
    let hooks = path.join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for name in ["post-commit", "prepare-commit-msg"] {
        let sentinel = path.join(format!("{name}-RAN"));
        let hook = hooks.join(name);
        std::fs::write(
            &hook,
            format!("#!/bin/sh\ntouch {}\n", sentinel.to_string_lossy()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let workspace = TrustedWorkspace::granted_for_test(&root).expect("workspace");
    std::fs::write(path.join("work.txt"), "x\n").unwrap();
    assert_eq!(app.commit_worktree(&workspace, "work").await, Ok(true));

    for name in ["post-commit", "prepare-commit-msg"] {
        assert!(
            !path.join(format!("{name}-RAN")).exists(),
            "{name} must not run for an agent-authored commit"
        );
    }
}

#[tokio::test]
async fn team_collect_diff_renders_only_the_committed_candidate_range() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let path = std::path::Path::new(&root);
    std::fs::write(path.join("old-name.txt"), "rename me\n").unwrap();
    std::fs::write(path.join("deleted.txt"), "delete me\n").unwrap();
    let base = team_git_commit_all(&root, "base for review");

    std::fs::rename(path.join("old-name.txt"), path.join("new-name.txt")).unwrap();
    std::fs::remove_file(path.join("deleted.txt")).unwrap();
    std::fs::write(
        path.join("added.txt"),
        "RAW_COMMITTED_PATCH_CONTENT_SHOULD_NOT_APPEAR\n",
    )
    .unwrap();
    let candidate = team_git_commit_all(&root, "candidate for review");
    std::fs::write(path.join("new-name.txt"), "DIRTY_WORKTREE_CONTENT\n").unwrap();
    std::fs::write(path.join("untracked.txt"), "UNTRACKED_WORKTREE_CONTENT\n").unwrap();

    let run_id = "team-review-target".to_string();
    let mut run = crate::state::TeamRun::new(
        run_id.clone(),
        crate::state::TaskSpec::default(),
        root.clone(),
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Running;
    run.phase = relay_api::team::TeamPhase::SubTasks;
    run.tl_provider = "codex".to_string();
    run.dev_provider = "codex".to_string();
    run.reviewer_provider = "codex".to_string();
    run.sub_tasks.push(crate::state::SubTask {
        id: "st-1".to_string(),
        base_commit: base.clone(),
        last_verdict: Some(relay_api::WorkflowVerdict {
            approved: false,
            summary: None,
            findings: vec!["previous reviewer finding".to_string()],
        }),
        ..Default::default()
    });
    app.relay.write().await.insert_team_run(run);

    let rendered = relay_api::TeamPort::collect_diff(&app, &run_id, Some(&base))
        .await
        .expect("collect committed review target");
    assert!(
        rendered.contains("Committed review target")
            && rendered.contains(&format!("Base commit: {base}"))
            && rendered.contains(&format!("Candidate commit: {candidate}"))
            && rendered.contains(&format!("Range: {base}..{candidate}")),
        "the private seam must identify the immutable Git range: {rendered}"
    );
    assert!(
        rendered.contains("A\tadded.txt")
            && rendered.contains("D\tdeleted.txt")
            && rendered.contains("old-name.txt")
            && rendered.contains("new-name.txt"),
        "committed additions, deletions, and renames must be represented in the manifest: {rendered}"
    );
    assert!(
        rendered.contains("previous reviewer finding"),
        "prior findings must survive into the next committed review: {rendered}"
    );
    assert!(
        rendered.contains("git diff --find-renames")
            && rendered.contains("git show")
            && !rendered.contains("@@")
            && !rendered.contains("RAW_COMMITTED_PATCH_CONTENT_SHOULD_NOT_APPEAR")
            && !rendered.contains("DIRTY_WORKTREE_CONTENT")
            && !rendered.contains("UNTRACKED_WORKTREE_CONTENT")
            && !rendered.contains("untracked.txt"),
        "the prompt body must instruct object inspection without inlining raw or dirty content: {rendered}"
    );

    let run = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("run recorded");
    assert_eq!(run.sub_tasks[0].candidate_sha, candidate);
    assert!(
        run.sub_tasks[0].verdict_candidate_sha.is_empty(),
        "collecting a new target must invalidate any previous approval binding"
    );
}

#[tokio::test]
async fn a_task_cannot_fork_from_a_worktree_outside_the_allowed_roots() {
    // Guarding only the DESTINATION is not enough. Provisioning reads and
    // MUTATES the origin's repository — it writes info/exclude in the common
    // git dir and creates a branch there.
    //
    // The two checks only come apart when the destination is in scope while
    // the origin is not, which is exactly what a linked worktree outside the
    // allowed roots produces: the task worktree still lands under the MAIN
    // worktree (in scope), so a destination-only guard would wave it through.
    let (_repo, root) = init_team_repo().await;
    let outside = TempDir::new().expect("tmpdir");
    let linked = outside.path().canonicalize().unwrap().join("linked");
    let out = tokio::process::Command::new("git")
        .args([
            "worktree",
            "add",
            "-q",
            "--no-track",
            "-b",
            "side",
            linked.to_str().unwrap(),
            "main",
        ])
        .current_dir(&root)
        .output()
        .await
        .expect("git");
    assert!(out.status.success(), "worktree add failed");

    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    // Only the main repository is in scope; the linked worktree is not.
    app.relay.write().await.allowed_roots = vec![root.clone()];

    let mut input = team_input(&root);
    input.origin_cwd = linked.to_string_lossy().into_owned();
    let error = app
        .start_team_run(input)
        .await
        .expect_err("an out-of-scope origin must be refused even when the destination is fine");
    assert!(
        error.contains("allowed roots"),
        "the error should name the scope: {error}"
    );
    assert!(
        !std::path::Path::new(&root).join(".sealwire").exists(),
        "nothing may be created from a repository we refused to touch"
    );
}

#[tokio::test]
async fn an_enormous_change_set_is_bounded_and_says_what_it_dropped() {
    // Tracked output is capped globally, but each untracked file adds up to
    // 64 KiB and nothing bounds the file COUNT. One generated directory would
    // otherwise build a prompt big enough to exhaust the model's context.
    let (_repo, root) = init_team_repo().await;
    let (_app, _providers) = build_review_app(&root, &["codex"]).await;
    let path = std::path::Path::new(&root);
    let blob = "x".repeat(40 * 1024);
    for index in 0..40 {
        std::fs::write(path.join(format!("generated_{index}.txt")), &blob).unwrap();
    }

    let workspace = TrustedWorkspace::granted_for_test(&root).expect("workspace");
    let response = collect_workspace_diff_against(&workspace, None)
        .await
        .expect("diff");
    let rendered = crate::state::app::team::render_review_diff(&response);

    assert!(
        rendered.len() < 400 * 1024,
        "the rendered prompt must stay bounded, got {} bytes",
        rendered.len()
    );
    assert!(
        rendered.contains("omitted"),
        "a reviewer must be told it was not shown everything"
    );
    assert!(
        rendered.contains("unreviewed"),
        "and told what that means: {}",
        &rendered[rendered.len().saturating_sub(200)..]
    );
}

#[tokio::test]
async fn the_sub_task_view_names_its_developer_and_reviewer_threads() {
    // A team diagram whose Dev and Reviewer nodes open a transcript needs
    // those thread ids, and only the team lead's is on the run view. They are
    // identity rather than TL-authored instruction, so exposing them leaves
    // the "briefs are deliberately absent" decision intact.
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;

    let mut run = crate::state::TeamRun::new(
        "team-view-1".to_string(),
        crate::state::TaskSpec::default(),
        root.clone(),
        "device-1".to_string(),
    );
    run.tl_thread_id = "tl-1".to_string();
    run.sub_tasks = vec![
        crate::state::SubTask {
            id: "s1".to_string(),
            title: "Write the parser".to_string(),
            brief: "Never leaves the backend.".to_string(),
            dev_thread_id: Some("dev-1".to_string()),
            reviewer_thread_id: Some("rev-1".to_string()),
            ..Default::default()
        },
        // Not yet started: nobody is seated, and the view must say so rather
        // than inventing an id the UI would then try to open.
        crate::state::SubTask {
            id: "s2".to_string(),
            title: "Wire the loader".to_string(),
            ..Default::default()
        },
    ];
    app.relay.write().await.insert_team_run(run);

    let teams = app.teams().await;
    let view = teams
        .teams
        .iter()
        .find(|team| team.team_run_id == "team-view-1")
        .expect("the task should be listed");

    assert_eq!(
        view.sub_tasks[0].dev_thread_id.as_deref(),
        Some("dev-1"),
        "the Dev node has nothing to open without this"
    );
    assert_eq!(
        view.sub_tasks[0].reviewer_thread_id.as_deref(),
        Some("rev-1"),
        "nor does the Reviewer node"
    );
    assert_eq!(view.sub_tasks[1].dev_thread_id, None);
    assert_eq!(view.sub_tasks[1].reviewer_thread_id, None);
}

#[tokio::test]
async fn a_session_already_living_in_the_worktree_cannot_be_resumed_into_it() {
    // The outer guard only knows a thread's id, so a session the team does not
    // own — restored, or created before the task started — slipped through and
    // became the active thread inside a worktree three agents are editing.
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .complete_turns
        .store(false, Ordering::Relaxed);

    let outsider = start_parent(&app, &root, "codex").await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let cwd = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .map(|run| run.cwd.clone())
        .expect("cwd");

    // Point the outsider at a subdirectory of the task worktree, the way a
    // restored session rooted there would look.
    let subdir = std::path::Path::new(&cwd).join("src");
    std::fs::create_dir_all(&subdir).expect("subdir");
    let subdir = subdir.to_string_lossy().into_owned();
    {
        let mut relay = app.relay.write().await;
        relay.ensure_runtime_for_thread(&outsider.id).current_cwd = subdir.clone();
        if let Some(thread) = relay.threads.iter_mut().find(|item| item.id == outsider.id) {
            thread.cwd = subdir.clone();
        }
    }
    // The guard reads the cwd the PROVIDER reports, which is the one the thread
    // will actually run in — so the double has to report it too, or the test
    // would be checking relay bookkeeping rather than where work lands.
    {
        let mut threads = providers.get("codex").unwrap().threads.lock().await;
        if let Some(thread) = threads.get_mut(&outsider.id) {
            thread.cwd = subdir.clone();
        }
    }

    let error = app
        .resume_session(ResumeSessionInput {
            device_id: Some("device-1".to_string()),
            thread_id: outsider.id.clone(),
            approval_policy: None,
            sandbox: None,
            effort: None,
            provider: None,
        })
        .await
        .expect_err("a session living in the task's worktree must not be resumed into it");
    assert!(error.contains("belongs to a running task"), "{error}");
}

/// Tasks run concurrently. Each still gets its own worktree and branch, which
/// is what kept them apart when only one could run.
#[tokio::test]
async fn a_second_task_starts_alongside_a_live_one_on_its_own_worktree() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .complete_turns
        .store(false, Ordering::Relaxed);

    let first = app
        .start_team_run(team_input(&root))
        .await
        .expect("the first task should start");
    let second = app
        .start_team_run(team_input(&root))
        .await
        .expect("a second task runs alongside the first");
    assert_ne!(first, second);

    let relay = app.relay.read().await;
    let first_run = relay.team_run(&first).expect("first").clone();
    let second_run = relay.team_run(&second).expect("second").clone();
    assert_ne!(
        first_run.cwd, second_run.cwd,
        "two live tasks sharing a worktree would write over each other"
    );
    assert_ne!(first_run.branch, second_run.branch);
}

#[tokio::test]
async fn whole_run_stops_refuse_a_device_outside_the_tasks_path_scope() {
    // Stops are authorized by the task's WORKTREE path scope, the same way
    // starting one is. A device that could never have started this task must
    // not be able to reach into its worktree and drain its turns.
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .complete_turns
        .store(false, Ordering::Relaxed);
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    let elsewhere = TempDir::new().expect("tmpdir");
    app.relay.write().await.allowed_roots = vec![elsewhere.path().to_string_lossy().into_owned()];

    for error in [
        app.pause_team_run(Some(run_id.clone()), Some("device-1".to_string()))
            .await
            .expect_err("pause must be authorized"),
        app.force_stop_team_run(Some(run_id.clone()), Some("device-1".to_string()))
            .await
            .expect_err("force stop must be authorized"),
        app.cancel_team_run(Some(run_id.clone()), Some("device-1".to_string()))
            .await
            .expect_err("cancel must be authorized"),
    ] {
        assert!(
            error.contains("allowed roots"),
            "the refusal should name the scope: {error}"
        );
    }

    let error = app
        .pause_team_run(Some(run_id.clone()), None)
        .await
        .expect_err("an unidentified caller cannot stop a task");
    assert!(error.contains("device_id"), "{error}");

    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert!(
        !run.pause_requested && run.status != crate::state::TeamRunStatus::Blocked,
        "a refused stop must leave the run untouched: {:?}",
        run.status
    );
}

#[tokio::test]
async fn only_a_paused_task_can_be_resumed() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .complete_turns
        .store(false, Ordering::Relaxed);
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    for status in [
        crate::state::TeamRunStatus::Running,
        crate::state::TeamRunStatus::Blocked,
        crate::state::TeamRunStatus::Cancelled,
    ] {
        app.relay.write().await.update_team_run(&run_id, |run| {
            // Reach past the guards: this is about what Resume refuses, not
            // about how a run got there.
            run.status = status;
        });
        let error = app
            .resume_team_run(Some(run_id.clone()), Some("device-1".to_string()))
            .await
            .expect_err("only a paused task is resumable");
        assert!(
            error.contains("only a paused task can be resumed"),
            "{status:?}: {error}"
        );
        assert_eq!(
            app.relay
                .read()
                .await
                .team_run(&run_id)
                .map(|run| run.status),
            Some(status),
            "a refused resume must leave the status alone"
        );
    }
}

/// Drives exactly one Dev-seat turn, the way the private driver does, and records
/// the id it sent to plus the outcome it got back.
struct OneDevTurnDriver {
    observed: std::sync::Arc<Mutex<Option<(String, relay_api::team::TeamTurnOutcome)>>>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for OneDevTurnDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev seat thread");
        let slot = port.record_run_thread(&run_id, &thread).await;
        let outcome = port
            .turn(
                &run_id,
                slot,
                relay_api::team::TeamRole::Dev,
                "write the parser",
            )
            .await;
        *self.observed.lock().await = Some((thread, outcome));
        port.settle_run(
            &run_id,
            crate::state::TeamRunStatus::Failed,
            "test driver done",
        )
        .await;
    }
}

#[tokio::test]
async fn a_dev_seat_start_that_fails_after_promotion_stops_the_session_it_really_started() {
    // The worst instance of the deferred-start orphan, because a Dev seat is
    // WRITE-CAPABLE: `team_thread_settings` gives a non-reviewer Claude seat
    // ("bypass", default_sandbox) — full write access with no approval prompts.
    //
    // A clean seat is a `claude-pending-…` placeholder until its FIRST turn creates
    // the SDK session, and that promotion happens inside `start_turn`. On a start
    // that fails only AFTER the session was created, the id the driver sent to has
    // no runtime left — so `observe_turn_liveness` saw nothing, skipped the stop
    // entirely, and the run settled and released its cwd lock while a bypass-mode
    // agent kept editing the task worktree.
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex", "claude_code"]).await;
    let claude = providers.get("claude_code").unwrap().clone();
    claude.deferred_start.store(true, Ordering::Relaxed);
    claude
        .fail_turn_after_promotion
        .store(true, Ordering::Relaxed);
    let observed = std::sync::Arc::new(Mutex::new(None));
    let app = app.with_team_driver(std::sync::Arc::new(OneDevTurnDriver {
        observed: observed.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "claude_code".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    let (sent_to, outcome) = observed
        .lock()
        .await
        .clone()
        .expect("the driver ran a dev turn");
    assert!(
        sent_to.starts_with("claude-pending-"),
        "the seat starts as a placeholder: {sent_to}"
    );
    assert!(
        matches!(outcome, relay_api::team::TeamTurnOutcome::Failed(_)),
        "the lost start response surfaces as a failed turn: {outcome:?}"
    );

    let promoted = {
        let relay = app.relay.read().await;
        relay
            .runtimes
            .keys()
            .find(|id| id.starts_with("claude_code-session-"))
            .cloned()
            .expect("the seat was promoted to a real session id")
    };
    let interrupts = claude.interrupts.lock().await.clone();
    assert!(
        interrupts.iter().any(|id| id == &promoted),
        "the write-capable session that actually started must be interrupted, not \
abandoned (interrupted: {interrupts:?})"
    );
    assert!(
        !app.relay
            .read()
            .await
            .runtime_for_thread(&promoted)
            .is_some_and(|runtime| runtime.is_working()),
        "no seat may still be writing the worktree once the run has settled"
    );
}

/// The root-cause regression this whole task exists to fix: a Dev turn that
/// STARTS, RUNS, and ends with a FAILED provider terminal must be reported
/// `Failed`, not `Silent`. The failure lands as a transcript `Error` entry,
/// never an `AgentText` one, so `latest_assistant_entry` cannot see it —
/// `team_turn` (state/app/team.rs) must instead read the bridge's own
/// `last_turn_failure` record (state/relay/runtime.rs), which claude.rs and
/// codex/rpc.rs write at the same point they already write that Error entry.
#[tokio::test]
async fn a_dev_turn_that_ends_failed_is_reported_failed_not_silent() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    // Deliberately UNCLASSIFIED (`kind: None`): this test is only about the
    // Silent-vs-Failed classification a plain provider failure gets, decoupled
    // from the halt-the-run behavior a `usage_limit` kind now also triggers
    // (see `a_dev_turn_that_hits_a_usage_limit_halts_the_run_before_any_review`
    // in this same file) — conflating the two would make this assert on
    // whichever one happened to change most recently.
    providers
        .get("codex")
        .unwrap()
        .fail_completed_turn_with
        .lock()
        .await
        .replace(("the provider had an internal error".to_string(), None));
    let observed = std::sync::Arc::new(Mutex::new(None));
    let app = app.with_team_driver(std::sync::Arc::new(OneDevTurnDriver {
        observed: observed.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    let (_sent_to, outcome) = observed
        .lock()
        .await
        .clone()
        .expect("the driver ran a dev turn");
    match outcome {
        relay_api::team::TeamTurnOutcome::Failed(reason) => {
            assert!(
                reason.contains("the provider had an internal error"),
                "the failed turn's reason must say why: {reason}"
            );
        }
        other => panic!(
            "a turn that started, ran, and ended with a FAILED terminal must not read as \
{other:?}"
        ),
    }
}

/// A run-owned thread — the design reviewer, the MR-gate reviewer, or the dev
/// that addresses MR findings — must bill under the seat it was started as.
#[tokio::test]
async fn a_run_owned_thread_attributes_to_the_seat_it_was_started_as() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.record_run_thread("mr-reviewer-1");
            run.record_run_thread_role("mr-reviewer-1", relay_api::team::TeamRole::Reviewer);
        });
    }

    let relay = app.relay.read().await;
    let attribution = relay.thread_attribution("mr-reviewer-1");
    assert_eq!(
        attribution.team_run_id.as_deref(),
        Some(run_id.as_str()),
        "the run is known"
    );
    assert_eq!(
        attribution.role.as_deref(),
        Some("reviewer"),
        "a run-owned seat that billed under no role at all is spend nobody can \
trace: 38% of one real run landed in that bucket"
    );
}

/// The role map is keyed BY the thread id, so a promotion that skipped it
/// strands the role on a dead thread and the live seat bills under none.
#[tokio::test]
async fn a_promoted_run_owned_seat_keeps_the_role_it_was_started_as() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.record_run_thread("claude-pending-mr-dev");
            run.record_run_thread_role("claude-pending-mr-dev", relay_api::team::TeamRole::Dev);
        });
        relay.promote_background_thread("claude-pending-mr-dev", "sess-mr-dev");
    }

    let relay = app.relay.read().await;
    let run = relay.team_run(&run_id).cloned().expect("the run is live");
    assert!(
        run.run_owned_thread_ids
            .iter()
            .any(|id| id == "sess-mr-dev"),
        "the id itself has always followed the promotion"
    );
    assert_eq!(
        run.run_owned_thread_roles
            .get("sess-mr-dev")
            .map(String::as_str),
        Some("dev"),
        "the role is keyed by thread id, so it has to be re-keyed with it"
    );
    assert!(
        !run.run_owned_thread_roles
            .contains_key("claude-pending-mr-dev"),
        "the dead id must not linger as a second entry"
    );
    assert_eq!(
        relay.thread_attribution("sess-mr-dev").role.as_deref(),
        Some("dev"),
        "spend after a promotion must still name the seat that made it"
    );
}

/// This seat WRITES, so a drain that missed it would leave files changing after
/// the run's locks were released.
#[tokio::test]
async fn the_mr_revision_dev_is_rekeyed_and_drained_like_every_other_seat() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.mr_dev_thread_id = Some("claude-pending-mr".to_string());
        });
        relay.promote_background_thread("claude-pending-mr", "sess-mr");
    }

    let run = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("the run is live");
    assert_eq!(
        run.mr_dev_thread_id.as_deref(),
        Some("sess-mr"),
        "a seat still holding a promoted-away id reads as idle while it is working"
    );
    assert_eq!(
        run.thread_in_slot(crate::state::TeamThreadSlot::MrDev)
            .as_deref(),
        Some("sess-mr"),
        "the slot re-resolves rather than handing back what it captured"
    );
    assert!(
        run.owned_thread_ids().iter().any(|id| id == "sess-mr"),
        "the seat that writes must be in the set the drain walks"
    );
}

/// A replan supersedes only what never finished, so without the stamp a
/// reopened run's old and new implementers are indistinguishable.
#[test]
fn a_replan_stamps_the_cycle_that_planned_each_sub_task() {
    let mut run = crate::state::TeamRun::new(
        "run-1".to_string(),
        Default::default(),
        "/tmp/wt".to_string(),
        "device-1".to_string(),
    );
    run.replan_sub_tasks(vec![crate::state::SubTask {
        id: "a".to_string(),
        title: "first".to_string(),
        ..Default::default()
    }]);
    run.sub_tasks[0].status = crate::state::SubTaskStatus::Done;
    run.sub_tasks[0].dev_thread_id = Some("dev-old".to_string());

    run.reopened_count = 1;
    run.replan_sub_tasks(vec![crate::state::SubTask {
        id: "b".to_string(),
        title: "second".to_string(),
        ..Default::default()
    }]);

    assert_eq!(
        run.sub_tasks.len(),
        2,
        "a finished sub-task survives the replan that follows a reopen"
    );
    assert_eq!(run.sub_tasks[0].cycle, 0);
    assert_eq!(
        run.sub_tasks[1].cycle, 1,
        "the new plan belongs to the cycle that asked for it"
    );
}

/// The driver names the session it wants; only the relay can say whether it is
/// still reachable.
#[tokio::test]
async fn a_recorded_seat_is_reused_when_reachable_and_replaced_when_not() {
    use relay_api::TeamPort as _;

    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    let started = app
        .resume_or_start_thread(&run_id, relay_api::team::TeamRole::Dev, &[])
        .await
        .expect("a seat starts when nothing is offered");

    assert_eq!(
        app.resume_or_start_thread(&run_id, relay_api::team::TeamRole::Dev, &[started.clone()])
            .await
            .expect("the offered seat is still reachable"),
        started,
        "a routable session must be handed straight back, not duplicated"
    );

    assert_eq!(
        app.resume_or_start_thread(
            &run_id,
            relay_api::team::TeamRole::Dev,
            &["sess-that-never-existed".to_string(), started.clone()]
        )
        .await
        .expect("the list is walked in order"),
        started,
        "a dead first choice must fall through to a live second, not past it"
    );

    let replaced = app
        .resume_or_start_thread(
            &run_id,
            relay_api::team::TeamRole::Dev,
            &["sess-that-never-existed".to_string()],
        )
        .await
        .expect("an unroutable seat is replaced rather than fatal");
    assert_ne!(
        replaced, "sess-that-never-existed",
        "a session the relay cannot route to must not be sent a turn"
    );
    assert_ne!(replaced, started, "and it must be a genuinely new seat");
}

/// The thread cache outlives the session behind it: archive one and the route
/// still resolves, so a route-only check returns a seat whose turn will fail.
#[tokio::test]
async fn a_seat_whose_session_is_gone_is_not_reused_just_because_it_still_routes() {
    use relay_api::TeamPort as _;

    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    let seat = app
        .resume_or_start_thread(&run_id, relay_api::team::TeamRole::Dev, &[])
        .await
        .expect("a seat starts");

    // Take the session out from under it, leaving the relay's cache untouched.
    providers
        .get("codex")
        .unwrap()
        .archive_thread(&seat)
        .await
        .expect("the provider drops the session");

    assert!(
        app.find_thread_provider(&seat).await.is_ok(),
        "the route still resolves — which is exactly why it is not enough"
    );

    let replacement = app
        .resume_or_start_thread(&run_id, relay_api::team::TeamRole::Dev, &[seat.clone()])
        .await
        .expect("a seat is still produced");
    assert_ne!(
        replacement, seat,
        "the session is gone, so reusing it would fail the run on its first turn"
    );
}

/// A standalone review is reviewing too. Billing it under no role at all puts it
/// in the same bucket as an ordinary chat session, where nobody can find it.
#[tokio::test]
async fn a_standalone_reviewer_thread_bills_under_reviewer_with_no_run() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;

    {
        let mut relay = app.relay.write().await;
        relay.register_reviewer_thread("solo-reviewer-1".to_string(), "parent-1".to_string());
    }

    let relay = app.relay.read().await;
    let attribution = relay.thread_attribution("solo-reviewer-1");
    assert_eq!(
        attribution.role.as_deref(),
        Some("reviewer"),
        "a review outside a run is still a review"
    );
    assert_eq!(
        attribution.team_run_id, None,
        "and `team_run_id` is what tells it apart from a run's reviewer"
    );
}

/// `role` alone cannot tell the three review prompts apart — design review, the
/// per-sub-task review, and the MR gate all bill as `reviewer`. The run's phase
/// at the time the turn STARTED is what names the prompt, and it must be stamped
/// then: the TL seat is one long session that crosses every phase, so reading
/// the run's phase when the `done` event lands would label a digest turn with
/// whatever phase the driver had already advanced to.
#[tokio::test]
async fn a_team_turn_stamps_the_phase_it_ran_in_not_the_phase_it_ended_in() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.phase = relay_api::team::TeamPhase::DesignReview;
            run.record_run_thread("design-reviewer-1");
            run.record_run_thread_role("design-reviewer-1", relay_api::team::TeamRole::Reviewer);
        });
        // What `team_turn` records before driving the seat.
        relay.note_team_turn_phase(
            "design-reviewer-1",
            relay_api::team::TeamPhase::DesignReview,
        );
        // The driver moves on while the reviewer's `done` is still in flight.
        relay.update_team_run(&run_id, |run| {
            run.phase = relay_api::team::TeamPhase::MrGate;
        });
    }

    let relay = app.relay.read().await;
    let attribution = relay.thread_attribution("design-reviewer-1");
    assert_eq!(attribution.role.as_deref(), Some("reviewer"));
    assert_eq!(
        attribution.phase.as_deref(),
        Some("design_review"),
        "the design reviewer's spend must not be filed under the MR gate: they \
are different prompts and the whole point is to price them apart"
    );
}

/// Drives one TL turn, but first loses the seat's runtime and moves the session
/// mirror to another chat's model — what a relay restart mid-run looks like.
struct RestartedTlTurnDriver {
    relay: std::sync::Arc<RwLock<RelayState>>,
    thread: std::sync::Arc<Mutex<Option<String>>>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for RestartedTlTurnDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Tl)
            .await
            .expect("tl seat thread");
        let slot = port.record_run_thread(&run_id, &thread).await;
        {
            let mut relay = self.relay.write().await;
            // Runtimes are process-local; the remembered settings are persisted. So a
            // restart mid-run loses one and keeps the other.
            relay.runtimes.remove(&thread);
            // Meanwhile the user is chatting in another provider's session, which is
            // all `RelayState.model` ever holds: the last thing anyone used.
            relay.model = "cursor-auto".to_string();
            relay.reasoning_effort = "none".to_string();
            // Any background event for the seat rebuilds its runtime before the turn.
            relay.bg_set_thread_status(&thread, "idle".to_string(), Vec::new(), 0);
        }
        let _ = port
            .turn(
                &run_id,
                slot,
                relay_api::team::TeamRole::Tl,
                "plan the work",
            )
            .await;
        *self.thread.lock().await = Some(thread);
        port.settle_run(
            &run_id,
            crate::state::TeamRunStatus::Failed,
            "test driver done",
        )
        .await;
    }
}

#[tokio::test]
async fn a_tl_turn_after_a_lost_runtime_still_runs_on_the_seats_model() {
    // The seat is configured `opus[1m]` and every turn before the restart ran on it.
    // Then the rebuilt runtime took its model from the session mirror — the user's
    // Cursor chat — and the TL's next turn went out as a model Claude cannot resolve,
    // which reads as "There's an issue with the selected model" and fails the run.
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex", "claude_code"]).await;
    let claude = providers.get("claude_code").unwrap().clone();
    let observed = std::sync::Arc::new(Mutex::new(None));
    let relay = app.relay.clone();
    let app = app.with_team_driver(std::sync::Arc::new(RestartedTlTurnDriver {
        relay,
        thread: observed.clone(),
    }));

    let mut input = team_input(&root);
    input.tl_provider = "claude_code".to_string();
    input.tl_model = "opus[1m]".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    let thread = observed
        .lock()
        .await
        .clone()
        .expect("the driver ran a tl turn");
    let turn_models = claude.turn_models.lock().await.clone();
    let sent = turn_models
        .iter()
        .filter(|(id, _, _)| id == &thread)
        .last()
        .map(|(_, model, _)| model.clone())
        .expect("the tl seat should have run a turn");
    assert_eq!(
        sent, "opus[1m]",
        "a TL turn must run on the seat's own model, never on whatever the user last \
chatted with: {turn_models:?}"
    );
}

/// Replays the private driver's dev-then-review sequence for one sub-task, far
/// enough to exercise the provider-halt and reviewer-gate mechanisms this
/// sub-task adds. Round bookkeeping (`rounds_used`/`Escalated`) is normally the
/// PRIVATE driver's job; this fakes just enough of it (a NEEDS_CHANGES verdict
/// every round) to prove the new gate does not interfere with a review loop
/// that legitimately reaches `Escalated`.
struct DevThenReviewDriver {
    /// Set right after the dev turn, before the first reviewer attempt — models
    /// a stop landing in exactly the window the driver would otherwise use to
    /// start reviewing, ahead of its own next boundary check.
    request_stop_before_review: bool,
    /// How many reviewer turns to attempt. Zero skips reviewing (and starting
    /// the reviewer thread) entirely — the sane thing a real driver does after
    /// a dev turn that did not land.
    reviewer_rounds: u32,
    /// Test fixture for review-open paths: create work the port can ask the
    /// same developer session to commit before review.
    write_work_before_dev: bool,
    dev_outcome: std::sync::Arc<Mutex<Option<relay_api::team::TeamTurnOutcome>>>,
    reviewer_outcomes: std::sync::Arc<Mutex<Vec<relay_api::team::TeamTurnOutcome>>>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for DevThenReviewDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let dev_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev seat thread");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                run.sub_tasks.push(crate::state::SubTask {
                    id: "st-1".to_string(),
                    dev_thread_id: Some(dev_thread),
                    ..Default::default()
                });
            }),
        )
        .await;
        if self.write_work_before_dev {
            let cwd = port.run_snapshot(&run_id).await.expect("run exists").cwd;
            std::fs::write(
                std::path::Path::new(&cwd).join("parser.rs"),
                "pub fn parse() {}\n",
            )
            .expect("candidate work for the dev turn");
        }

        let dev_outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskDev(0),
                relay_api::team::TeamRole::Dev,
                "write the parser",
            )
            .await;
        *self.dev_outcome.lock().await = Some(dev_outcome);

        if self.reviewer_rounds > 0 {
            if self.request_stop_before_review {
                // The flags a user's stop sets, without the full drain — the
                // `PausePending` race window the reviewer gate exists for.
                port.update_run(&run_id, Box::new(|run| run.request_stop("device-stop")))
                    .await;
            }

            let reviewer_thread = port
                .start_thread(&run_id, relay_api::team::TeamRole::Reviewer)
                .await
                .expect("reviewer seat thread");
            port.update_run(
                &run_id,
                Box::new(move |run| {
                    if let Some(task) = run.sub_tasks.get_mut(0) {
                        task.reviewer_thread_id = Some(reviewer_thread);
                    }
                }),
            )
            .await;

            for _ in 0..self.reviewer_rounds {
                let outcome = port
                    .turn(
                        &run_id,
                        relay_api::team::TeamThreadSlot::SubTaskReviewer(0),
                        relay_api::team::TeamRole::Reviewer,
                        "review it",
                    )
                    .await;
                let refused = matches!(outcome, relay_api::team::TeamTurnOutcome::Failed(_));
                self.reviewer_outcomes.lock().await.push(outcome);
                if refused {
                    // The refusal may not have settled the run itself (F2: a
                    // draining stop settles it instead) — give that a moment
                    // to land before the wrap-up below treats an unsettled run
                    // as this driver's own to report. `boundary_status` is NOT
                    // this check: it returns `Some` the instant a pause is
                    // merely REQUESTED, before anyone has actually settled it.
                    for _ in 0..100 {
                        let settled = port.run_snapshot(&run_id).await.is_some_and(|run| {
                            run.status.is_terminal() || run.status.is_settled_without_driver()
                        });
                        if settled {
                            break;
                        }
                        sleep(Duration::from_millis(5)).await;
                    }
                    break;
                }
                // A NEEDS_CHANGES verdict every round, exactly the shape that
                // reaches `Escalated` once the round budget runs out.
                port.update_run(
                    &run_id,
                    Box::new(|run| {
                        if let Some(task) = run.sub_tasks.get_mut(0) {
                            task.rounds_used += 1;
                            if task.rounds_used >= relay_api::team::MAX_SUBTASK_REVIEW_ROUNDS {
                                task.status = relay_api::team::SubTaskStatus::Escalated;
                            }
                        }
                    }),
                )
                .await;
            }
        }

        // `fail_run`, not `settle_run`: `TeamRun::fail` no-ops while `stopping`,
        // so a refusal raced by a real stop's own settle cannot clobber it.
        port.fail_run(&run_id, "test driver done".to_string()).await;
    }
}

/// Same as [`DevThenReviewDriver`], but writes an uncommitted file in the task
/// worktree before the dev turn so the same-session commit retry can be
/// exercised without a usage figure.
struct UncommittedWorkThenReviewDriver {
    dev_outcome: std::sync::Arc<Mutex<Option<relay_api::team::TeamTurnOutcome>>>,
    reviewer_outcomes: std::sync::Arc<Mutex<Vec<relay_api::team::TeamTurnOutcome>>>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for UncommittedWorkThenReviewDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let dev_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev seat thread");
        // The private driver checkpoints the sub-task at start. Without this,
        // falling back to the run base would let prior run work open the gate.
        let checkpoint = port
            .checkpoint_commit(&run_id)
            .await
            .expect("checkpoint")
            .expect("the task worktree has a HEAD");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                run.sub_tasks.push(crate::state::SubTask {
                    id: "st-1".to_string(),
                    base_commit: checkpoint,
                    dev_thread_id: Some(dev_thread),
                    ..Default::default()
                });
            }),
        )
        .await;
        let cwd = port.run_snapshot(&run_id).await.expect("run exists").cwd;
        std::fs::write(
            std::path::Path::new(&cwd).join("parser.rs"),
            "pub fn parse() {}\n",
        )
        .expect("uncommitted work relative to the checkpoint");

        let dev_outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskDev(0),
                relay_api::team::TeamRole::Dev,
                "write the parser",
            )
            .await;
        *self.dev_outcome.lock().await = Some(dev_outcome);

        let reviewer_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Reviewer)
            .await
            .expect("reviewer seat thread");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                if let Some(task) = run.sub_tasks.get_mut(0) {
                    task.reviewer_thread_id = Some(reviewer_thread);
                }
            }),
        )
        .await;
        let outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskReviewer(0),
                relay_api::team::TeamRole::Reviewer,
                "review it",
            )
            .await;
        self.reviewer_outcomes.lock().await.push(outcome);
        port.fail_run(&run_id, "test driver done".to_string()).await;
    }
}

/// Commits prior run work, then drives a sub-task with an empty checkpoint and
/// no new tree change — the shape that wrongly lands if the gate falls back to
/// `run.base_commit`.
struct PriorRunWorkEmptyCheckpointDriver {
    reviewer_outcomes: std::sync::Arc<Mutex<Vec<relay_api::team::TeamTurnOutcome>>>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for PriorRunWorkEmptyCheckpointDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let cwd = port.run_snapshot(&run_id).await.expect("run exists").cwd;
        std::fs::write(
            std::path::Path::new(&cwd).join("prior.rs"),
            "fn prior() {}\n",
        )
        .expect("prior run work");
        // Commit so HEAD moves past run.base_commit — visible if someone diffs
        // the run base, invisible if the empty sub-task checkpoint is respected.
        assert!(
            port.commit(&run_id, "prior work")
                .await
                .expect("commit prior work"),
            "prior run work must land on the branch"
        );

        let dev_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev seat thread");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                run.sub_tasks.push(crate::state::SubTask {
                    id: "st-1".to_string(),
                    // Deliberately empty — the bug under test.
                    base_commit: String::new(),
                    dev_thread_id: Some(dev_thread),
                    ..Default::default()
                });
            }),
        )
        .await;

        let _ = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskDev(0),
                relay_api::team::TeamRole::Dev,
                "write the parser",
            )
            .await;

        let reviewer_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Reviewer)
            .await
            .expect("reviewer seat thread");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                if let Some(task) = run.sub_tasks.get_mut(0) {
                    task.reviewer_thread_id = Some(reviewer_thread);
                }
            }),
        )
        .await;
        let outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskReviewer(0),
                relay_api::team::TeamRole::Reviewer,
                "review it",
            )
            .await;
        self.reviewer_outcomes.lock().await.push(outcome);
        port.fail_run(&run_id, "test driver done".to_string()).await;
    }
}

#[tokio::test]
async fn a_dev_turn_that_hits_a_usage_limit_halts_the_run_before_any_review() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .fail_completed_turn_with
        .lock()
        .await
        .replace((
            "Usage limit reached".to_string(),
            Some("usage_limit".to_string()),
        ));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 0,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    match dev_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => {
            assert!(
                reason.contains("Usage limit reached"),
                "the dev turn's own reason should say so: {reason}"
            );
        }
        other => panic!("the dev turn should have failed on the provider limit: {other:?}"),
    }
    assert!(
        run.pause_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Usage limit reached")),
        "pause_reason must name the limit, got {:?}",
        run.pause_reason
    );
    assert_eq!(
        run.pause_kind,
        Some(relay_api::team::TeamPauseKind::Provider)
    );
    assert!(
        reviewer_outcomes.lock().await.is_empty(),
        "the reviewer thread must never be given a turn after a provider halt"
    );
    assert_eq!(run.sub_tasks[0].rounds_used, 0);
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// A kind from a worker NEWER than this build. It must decode to "no kind" and
/// take the ordinary-failure path: every kind that halts settles the run
/// `Paused` — resumable, and read by the user as "waiting for quota" — so an
/// unrecognised one must never reach that path on the strength of being unknown.
#[tokio::test]
async fn an_unrecognised_failure_kind_fails_the_turn_without_pausing_the_run() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .fail_completed_turn_with
        .lock()
        .await
        .replace((
            "The provider rejected the request".to_string(),
            Some("bad_request_v2".to_string()),
        ));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 0,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    // Reaching `Failed` at all is the assertion: a halt would settle `Paused`
    // first, and every later mutator — this one included — is then a no-op.
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    match dev_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => {
            assert!(
                reason.contains("The provider rejected the request"),
                "the turn still fails, and still says why: {reason}"
            );
        }
        other => panic!("an unclassified failure is still a failed turn: {other:?}"),
    }
    assert_eq!(
        run.pause_kind, None,
        "an unknown kind must not be read as a provider limit"
    );
}

/// The same policy as the usage-limit halt, reached from Codex's OTHER session
/// limit. Ending a session-budget failure terminally throws away the branch,
/// the worktree and every finished sub-task; paused, they are all still there
/// when the budget is raised.
#[tokio::test]
async fn a_dev_turn_that_exhausts_the_session_budget_halts_the_run_before_any_review() {
    // Asserted, not assumed: the harness below speaks the Claude worker's wire
    // string, so without this the test would ride the usage-limit path and
    // prove nothing about Codex's session-budget variant.
    let kind = crate::codex::codex_error_info_kind(&serde_json::json!("sessionBudgetExceeded"))
        .expect("a session budget is a session limit and must be classified");
    assert!(
        kind.halts_the_run(),
        "a classified session limit must pause the run rather than end it"
    );

    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .fail_completed_turn_with
        .lock()
        .await
        .replace((
            "Session budget exhausted".to_string(),
            Some("usage_limit".to_string()),
        ));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 0,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    match dev_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => {
            assert!(
                reason.contains("Session budget exhausted"),
                "the dev turn's own reason should say so: {reason}"
            );
        }
        other => panic!("the dev turn should have failed on the session budget: {other:?}"),
    }
    assert!(
        run.pause_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Session budget exhausted")),
        "pause_reason must name the limit, got {:?}",
        run.pause_reason
    );
    assert_eq!(
        run.pause_kind,
        Some(relay_api::team::TeamPauseKind::Provider)
    );
    assert!(
        reviewer_outcomes.lock().await.is_empty(),
        "the reviewer thread must never be given a turn after a provider halt"
    );
    assert_eq!(
        run.sub_tasks[0].rounds_used, 0,
        "a paused run has spent no review budget"
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// The worker's own concurrency eviction (`failure_kind: "session_capacity"`),
/// not an Anthropic spend limit. Same halt as a usage/session budget: the run
/// must stay resumable so the branch, worktree and finished sub-tasks survive
/// until a seat is free again. Ending it `Failed` would throw those away, and
/// treating a bare `done` as success would open review on a branch nothing more
/// will land on.
#[tokio::test]
async fn a_dev_turn_that_hits_session_capacity_halts_the_run_before_any_review() {
    let kind = crate::state::TurnFailureKind::from_wire("session_capacity")
        .expect("the worker's capacity eviction must be classified");
    assert!(
        kind.halts_the_run(),
        "a classified capacity eviction must pause the run rather than end it"
    );

    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .fail_completed_turn_with
        .lock()
        .await
        .replace((
            "Claude background session was evicted because the session limit was reached"
                .to_string(),
            Some("session_capacity".to_string()),
        ));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 0,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    match dev_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => {
            assert!(
                reason.contains("session limit was reached"),
                "the dev turn's own reason should say so: {reason}"
            );
        }
        other => panic!("the dev turn should have failed on the capacity eviction: {other:?}"),
    }
    assert!(
        run.pause_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("session limit was reached")),
        "pause_reason must name the eviction, got {:?}",
        run.pause_reason
    );
    assert_eq!(
        run.pause_kind,
        Some(relay_api::team::TeamPauseKind::Provider)
    );
    let reviewer_thread =
        relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Reviewer)
            .await
            .expect("a paused run still keeps its reviewer seat");
    let reviewer_thread_for_run = reviewer_thread.clone();
    relay_api::TeamPort::update_run(
        &app,
        &run_id,
        Box::new(move |run| {
            if let Some(task) = run.sub_tasks.get_mut(0) {
                task.reviewer_thread_id = Some(reviewer_thread_for_run.clone());
            }
        }),
    )
    .await;
    let reviewer_outcome = relay_api::TeamPort::turn(
        &app,
        &run_id,
        relay_api::team::TeamThreadSlot::SubTaskReviewer(0),
        relay_api::team::TeamRole::Reviewer,
        "review it",
    )
    .await;
    match reviewer_outcome {
        relay_api::team::TeamTurnOutcome::Failed(_) => {}
        other => panic!("the reviewer attempt must be refused once the run is paused: {other:?}"),
    }
    let codex_turns = providers.get("codex").unwrap().turns.lock().await.clone();
    assert!(
        codex_turns.len() == 1 && codex_turns[0].1 == "write the parser",
        "the provider must see only the dev turn, never a reviewer turn: {codex_turns:?}"
    );
    assert!(
        app.relay
            .read()
            .await
            .last_turn_spend(&reviewer_thread)
            .is_none(),
        "a refused reviewer attempt must not bill tokens"
    );
    assert_eq!(
        run.sub_tasks[0].rounds_used, 0,
        "a paused run has spent no review budget"
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// `Replied` proves the agent SPOKE, not that it worked. A dev that answers
/// "I couldn't do this" and spends nothing must not open the reviewer gate —
/// otherwise a reviewer runs against an unchanged branch, burns both rounds and
/// escalates, which is the false failure this whole feature exists to stop.
#[tokio::test]
async fn a_dev_turn_that_replies_but_bills_nothing_leaves_the_gate_shut() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    // The provider reports a figure, and that figure is zero.
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((0, None, false));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    // A gate refusal settles the run `Paused` at a boundary, the same terminal
    // `a_reviewer_turn_is_refused_without_a_landed_dev_turn` waits for.
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Replied(_))
        ),
        "the premise: the dev DID reply, it just did no work"
    );
    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 0,
        "a turn that billed nothing has not landed"
    );
    match reviewer_outcomes.lock().await.first() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => assert_eq!(
            reason, "This step hasn't produced any work yet. You can resume to run it again.",
            "the reviewer must be refused by the gate"
        ),
        other => panic!("the reviewer must not run against an unchanged branch: {other:?}"),
    }
    assert_eq!(
        run.sub_tasks[0].rounds_used, 0,
        "no review budget was spent"
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// The other half: real spend plus a committed candidate opens the gate, so
/// ordinary work still reviews.
#[tokio::test]
async fn a_dev_turn_that_bills_tokens_and_commits_opens_the_reviewer_gate() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, None, false));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        write_work_before_dev: true,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 1,
        "matching usage with billed tokens > 0 and a committed candidate has landed"
    );
    assert!(
        !matches!(
            reviewer_outcomes.lock().await.first(),
            Some(relay_api::team::TeamTurnOutcome::Failed(reason))
                if reason == "This step hasn't produced any work yet. You can resume to run it again."
        ),
        "the gate must not refuse a dev turn that really spent and committed"
    );
}

/// Missing usage, a mismatched turn id, and an absent record are all empty.
/// A reply without matching successful spend and without work vs the
/// checkpoint must not open review or burn rounds into Escalated.
#[tokio::test]
async fn a_dev_turn_with_no_usage_figure_at_all_leaves_the_gate_shut() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    // Deliberately NOT setting `report_turn_usage`: nothing is reported.
    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));
    let _ = &providers;

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 0,
        "absent usage is empty, not a fallback yes"
    );
    match reviewer_outcomes.lock().await.first() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => assert_eq!(
            reason, "This step hasn't produced any work yet. You can resume to run it again.",
            "the reviewer must be refused by the gate"
        ),
        other => panic!("empty output must not schedule a reviewer: {other:?}"),
    }
    assert_eq!(run.sub_tasks[0].rounds_used, 0);
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// The record is never cleared, so a leftover figure for another turn is not
/// this turn's evidence. Mismatched ids are empty, same as a missing record.
#[tokio::test]
async fn a_spend_figure_from_another_turn_is_empty_output() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, Some("turn-from-an-earlier-life".to_string()), false));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 0,
        "a figure for a different turn is not this turn's evidence"
    );
    match reviewer_outcomes.lock().await.first() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => assert_eq!(
            reason,
            "This step hasn't produced any work yet. You can resume to run it again."
        ),
        other => panic!("mismatched usage must not schedule a reviewer: {other:?}"),
    }
    assert_eq!(run.sub_tasks[0].rounds_used, 0);
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// Uncommitted work relative to the checkpoint can land only after the relay
/// sends the same developer session back to commit it.
#[tokio::test]
async fn a_dev_turn_with_an_uncommitted_diff_commits_before_review() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let _ = &providers;

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(UncommittedWorkThenReviewDriver {
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 1,
        "a nonempty diff relative to the checkpoint lands only as a committed candidate"
    );
    assert!(
        !run.sub_tasks[0].round_base_sha.is_empty()
            && !run.sub_tasks[0].candidate_sha.is_empty()
            && run.sub_tasks[0].candidate_sha != run.sub_tasks[0].round_base_sha,
        "the dev round must record both its base and the committed candidate"
    );
    assert!(
        !run.sub_tasks[0].base_commit.is_empty(),
        "this path must exercise a real sub-task checkpoint, not a run-base fallback"
    );
    assert!(
        !matches!(
            reviewer_outcomes.lock().await.first(),
            Some(relay_api::team::TeamTurnOutcome::Failed(reason))
                if reason == "This step hasn't produced any work yet. You can resume to run it again."
        ),
        "the gate must not refuse the committed candidate made from dirty work"
    );
    let dev_thread = run.sub_tasks[0]
        .dev_thread_id
        .as_deref()
        .expect("dev thread");
    let turns = providers.get("codex").unwrap().turns.lock().await.clone();
    assert!(
        turns.iter().any(|(thread, text)| {
            thread == dev_thread && text.contains("needs a committed candidate")
        }),
        "the same developer session must be asked to commit before review: {turns:?}"
    );
}

#[tokio::test]
async fn a_later_sub_task_correction_with_no_commit_keeps_the_reviewer_gate_shut() {
    let (_repo, root) = init_team_repo().await;
    let prior_candidate = team_git_stdout(&root, &["rev-parse", "HEAD"]);
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let codex = providers.get("codex").unwrap();
    codex
        .auto_commit_author_changes
        .store(false, Ordering::Relaxed);

    let run_id = "team-subtask-correction-no-commit".to_string();
    let mut run = crate::state::TeamRun::new(
        run_id.clone(),
        crate::state::TaskSpec::default(),
        root.clone(),
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Running;
    run.phase = relay_api::team::TeamPhase::SubTasks;
    run.tl_provider = "codex".to_string();
    run.dev_provider = "codex".to_string();
    run.reviewer_provider = "codex".to_string();
    run.sub_tasks.push(crate::state::SubTask {
        id: "st-1".to_string(),
        title: "Parser".to_string(),
        brief: "write the parser".to_string(),
        status: crate::state::SubTaskStatus::Pending,
        base_commit: "previous-base".to_string(),
        round_base_sha: "previous-round-base".to_string(),
        candidate_sha: prior_candidate.clone(),
        dev_turns_landed: 1,
        rounds_used: 1,
        ..Default::default()
    });
    app.relay.write().await.insert_team_run(run);
    let dev_thread =
        relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev thread");
    relay_api::TeamPort::update_run(
        &app,
        &run_id,
        Box::new({
            let dev_thread = dev_thread.clone();
            move |run| {
                run.sub_tasks[0].dev_thread_id = Some(dev_thread.clone());
            }
        }),
    )
    .await;
    std::fs::write(
        std::path::Path::new(&root).join("dirty-only.rs"),
        "pub fn dirty_only() {}\n",
    )
    .expect("dirty-only correction");

    let dev_outcome = relay_api::TeamPort::turn(
        &app,
        &run_id,
        relay_api::team::TeamThreadSlot::SubTaskDev(0),
        relay_api::team::TeamRole::Dev,
        "address the review finding",
    )
    .await;
    match dev_outcome {
        relay_api::team::TeamTurnOutcome::Blocked(reason) => assert!(
            reason.contains("did not create a commit"),
            "blocked reason should ask for a commit: {reason}"
        ),
        other => panic!("dirty-only correction must not look successful: {other:?}"),
    }

    let reviewer_thread =
        relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Reviewer)
            .await
            .expect("reviewer thread");
    relay_api::TeamPort::update_run(
        &app,
        &run_id,
        Box::new({
            let reviewer_thread = reviewer_thread.clone();
            move |run| {
                run.sub_tasks[0].reviewer_thread_id = Some(reviewer_thread.clone());
            }
        }),
    )
    .await;
    let reviewer_outcome = relay_api::TeamPort::turn(
        &app,
        &run_id,
        relay_api::team::TeamThreadSlot::SubTaskReviewer(0),
        relay_api::team::TeamRole::Reviewer,
        "review the correction",
    )
    .await;
    match reviewer_outcome {
        relay_api::team::TeamTurnOutcome::Failed(reason) => assert!(
            reason.contains("current developer correction round has no new committed candidate"),
            "reviewer refusal should be round-local: {reason}"
        ),
        other => panic!("reviewer must be refused before provider dispatch: {other:?}"),
    }

    let run = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("run");
    assert_eq!(run.sub_tasks[0].round_base_sha, prior_candidate);
    assert!(
        run.sub_tasks[0].candidate_sha.is_empty(),
        "the stale prior candidate must be cleared for the correction round"
    );
    assert_eq!(run.sub_tasks[0].rounds_used, 1);
    let turns = codex.turns.lock().await.clone();
    assert!(
        turns.iter().any(|(thread, text)| {
            thread == &dev_thread && text.contains("needs a committed candidate")
        }),
        "the same dev must be asked to commit: {turns:?}"
    );
    assert!(
        turns
            .iter()
            .all(|(_, text)| text != "review the correction"),
        "a refused reviewer turn must not reach the provider: {turns:?}"
    );
}

#[tokio::test]
async fn a_later_mr_correction_with_no_commit_keeps_the_reviewer_gate_shut() {
    let (_repo, root) = init_team_repo().await;
    let prior_candidate = team_git_stdout(&root, &["rev-parse", "HEAD"]);
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let codex = providers.get("codex").unwrap();
    codex
        .auto_commit_author_changes
        .store(false, Ordering::Relaxed);

    let run_id = "team-mr-correction-no-commit".to_string();
    let mut run = crate::state::TeamRun::new(
        run_id.clone(),
        crate::state::TaskSpec::default(),
        root.clone(),
        "device-1".to_string(),
    );
    run.status = crate::state::TeamRunStatus::Running;
    run.phase = relay_api::team::TeamPhase::MrGate;
    run.tl_provider = "codex".to_string();
    run.dev_provider = "codex".to_string();
    run.reviewer_provider = "codex".to_string();
    run.mr_rounds_used = 1;
    run.mr_round_base_sha = "previous-mr-round-base".to_string();
    run.mr_candidate_sha = prior_candidate.clone();
    run.mr_verdict = Some(crate::state::WorkflowVerdict {
        approved: false,
        summary: None,
        findings: vec!["fix the final review issue".to_string()],
    });
    app.relay.write().await.insert_team_run(run);
    let dev_thread =
        relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev thread");
    relay_api::TeamPort::update_run(
        &app,
        &run_id,
        Box::new({
            let dev_thread = dev_thread.clone();
            move |run| {
                run.mr_dev_thread_id = Some(dev_thread.clone());
            }
        }),
    )
    .await;
    std::fs::write(
        std::path::Path::new(&root).join("dirty-mr-only.rs"),
        "pub fn dirty_mr_only() {}\n",
    )
    .expect("dirty-only MR correction");

    let dev_outcome = relay_api::TeamPort::turn(
        &app,
        &run_id,
        relay_api::team::TeamThreadSlot::MrDev,
        relay_api::team::TeamRole::Dev,
        "address final review findings",
    )
    .await;
    match dev_outcome {
        relay_api::team::TeamTurnOutcome::Blocked(reason) => assert!(
            reason.contains("did not create a commit"),
            "blocked reason should ask for a commit: {reason}"
        ),
        other => panic!("dirty-only MR correction must not look successful: {other:?}"),
    }

    let reviewer_thread =
        relay_api::TeamPort::start_thread(&app, &run_id, relay_api::team::TeamRole::Reviewer)
            .await
            .expect("reviewer thread");
    let reviewer_slot =
        relay_api::TeamPort::record_run_thread(&app, &run_id, &reviewer_thread).await;
    let reviewer_outcome = relay_api::TeamPort::turn(
        &app,
        &run_id,
        reviewer_slot,
        relay_api::team::TeamRole::Reviewer,
        "review final candidate",
    )
    .await;
    match reviewer_outcome {
        relay_api::team::TeamTurnOutcome::Failed(reason) => assert!(
            reason.contains("current developer correction round has no new committed candidate"),
            "reviewer refusal should be round-local: {reason}"
        ),
        other => panic!("MR reviewer must be refused before provider dispatch: {other:?}"),
    }

    let run = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("run");
    assert_eq!(run.mr_round_base_sha, prior_candidate);
    assert!(
        run.mr_candidate_sha.is_empty(),
        "the stale prior MR candidate must be cleared for the correction round"
    );
    assert_eq!(run.mr_rounds_used, 1);
    let turns = codex.turns.lock().await.clone();
    assert!(
        turns.iter().any(|(thread, text)| {
            thread == &dev_thread && text.contains("needs a committed candidate")
        }),
        "the same MR dev must be asked to commit: {turns:?}"
    );
    assert!(
        turns
            .iter()
            .all(|(_, text)| text != "review final candidate"),
        "a refused MR reviewer turn must not reach the provider: {turns:?}"
    );
}

/// Billed tokens that the funnel itself flagged `failed` are waste, not
/// successful usage. A reply that only spent on a failed turn must not open
/// review — matching `failed=0, billed>0` from the brief.
#[tokio::test]
async fn a_dev_turn_with_billed_but_failed_usage_leaves_the_gate_shut() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, None, true));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Replied(_))
        ),
        "the premise: the turn replied; only its spend was flagged failed"
    );
    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 0,
        "failed usage is not successful usage"
    );
    match reviewer_outcomes.lock().await.first() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => assert_eq!(
            reason,
            "This step hasn't produced any work yet. You can resume to run it again."
        ),
        other => panic!("failed usage must not schedule a reviewer: {other:?}"),
    }
    assert_eq!(run.sub_tasks[0].rounds_used, 0);
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// Prior run work vs `run.base_commit` must not land an empty current
/// sub-task. With no sub-task checkpoint, the tree is empty for this step —
/// falling back to the run base would schedule review on someone else's diff.
#[tokio::test]
async fn prior_run_work_does_not_land_a_sub_task_without_its_own_checkpoint() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let _ = &providers;

    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(PriorRunWorkEmptyCheckpointDriver {
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        run.sub_tasks[0].base_commit.is_empty(),
        "the premise: this sub-task has no checkpoint of its own"
    );
    assert!(
        !run.base_commit.is_empty(),
        "the run still has a base — the unsafe fallback's temptation"
    );
    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 0,
        "prior run work must not count as this sub-task's output"
    );
    match reviewer_outcomes.lock().await.first() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => assert_eq!(
            reason,
            "This step hasn't produced any work yet. You can resume to run it again."
        ),
        other => panic!("empty sub-task checkpoint must not schedule a reviewer: {other:?}"),
    }
    assert_eq!(run.sub_tasks[0].rounds_used, 0);
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

#[tokio::test]
async fn a_reviewer_turn_is_refused_without_a_landed_dev_turn() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    // The dev turn completes (active turn clears, thread goes idle) but emits no
    // assistant message at all — the `Silent` shape, not a failure. This must
    // NOT count as landed, or the gate this test exists to pin would never fire
    // for the very case the brief calls out.
    providers
        .get("codex")
        .unwrap()
        .emit_assistant
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Silent)
        ),
        "the dev turn must land nothing (Silent) — not fail — to exercise the \
zero-landed gate rather than the provider-halt one"
    );
    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 0,
        "a Silent dev turn must not count as landed"
    );
    let reviewer_outcomes = reviewer_outcomes.lock().await.clone();
    assert_eq!(reviewer_outcomes.len(), 1);
    assert!(
        matches!(
            reviewer_outcomes[0],
            relay_api::team::TeamTurnOutcome::Failed(_)
        ),
        "a reviewer turn with nothing landed to review must be refused: {:?}",
        reviewer_outcomes[0]
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated,
        "a refused reviewer turn must never escalate the sub-task"
    );
}

#[tokio::test]
async fn a_stop_mid_run_refuses_the_next_reviewer_turn() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, None, false));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: true,
        reviewer_rounds: 1,
        write_work_before_dev: true,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    // The driver's `request_stop` only sets the flags, same as the window a
    // real stop's drain briefly leaves the run in. Under the fix this refusal
    // does not settle the run itself (F2), so wait on the refusal directly
    // rather than on a status this step no longer reaches.
    for _ in 0..600 {
        if reviewer_outcomes.lock().await.len() == 1 {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        reviewer_outcomes.lock().await.len(),
        1,
        "the reviewer turn should have been attempted and refused by now"
    );

    // Finish the stop for real — this is what must settle the run, carrying
    // the user's own reason rather than whatever the gate refused it with.
    app.force_stop_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect("a stopping run can still be stopped for real");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Replied(_))
        ),
        "the dev turn itself must land normally; only the reviewer turn after \
the stop is refused"
    );
    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 1,
        "the refusal must be attributable to the stop, not to a missing dev turn"
    );
    let reviewer_outcomes = reviewer_outcomes.lock().await.clone();
    assert_eq!(reviewer_outcomes.len(), 1);
    assert!(
        matches!(
            reviewer_outcomes[0],
            relay_api::team::TeamTurnOutcome::Failed(_)
        ),
        "a reviewer turn requested while stopping must be refused: {:?}",
        reviewer_outcomes[0]
    );
    assert_eq!(
        run.sub_tasks[0].rounds_used, 0,
        "a refused round must never be counted against the review budget"
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
    assert_eq!(
        run.pause_kind,
        Some(relay_api::team::TeamPauseKind::User),
        "the real stop's own reason must land, not the gate's internal wording \
it refused the turn with"
    );
    assert_eq!(run.pause_reason.as_deref(), Some("stopped by the user"));
}

/// Drives a landed Dev turn, then waits to be released before attempting the
/// Reviewer turn — giving a test full control over exactly when that second
/// turn starts, so it can arrange a stop to land in the specific window
/// between the reviewer gate's early check and the drive gate.
struct RaceWindowDriver {
    dev_outcome: std::sync::Arc<Mutex<Option<relay_api::team::TeamTurnOutcome>>>,
    reviewer_outcome: std::sync::Arc<Mutex<Option<relay_api::team::TeamTurnOutcome>>>,
    dev_landed: std::sync::Arc<tokio::sync::Notify>,
    proceed_to_reviewer: std::sync::Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for RaceWindowDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let dev_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev seat thread");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                run.sub_tasks.push(crate::state::SubTask {
                    id: "st-1".to_string(),
                    dev_thread_id: Some(dev_thread),
                    ..Default::default()
                });
            }),
        )
        .await;
        let cwd = port.run_snapshot(&run_id).await.expect("run exists").cwd;
        std::fs::write(
            std::path::Path::new(&cwd).join("parser.rs"),
            "pub fn parse() {}\n",
        )
        .expect("candidate work for the dev turn");
        let dev_outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskDev(0),
                relay_api::team::TeamRole::Dev,
                "write the parser",
            )
            .await;
        *self.dev_outcome.lock().await = Some(dev_outcome);
        // The dev turn's own `dev_turns_landed` bump has already happened by
        // now — it runs before `team_turn` returns, and this await only
        // resolves once that call has returned.
        self.dev_landed.notify_one();
        self.proceed_to_reviewer.notified().await;

        let reviewer_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Reviewer)
            .await
            .expect("reviewer seat thread");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                if let Some(task) = run.sub_tasks.get_mut(0) {
                    task.reviewer_thread_id = Some(reviewer_thread);
                }
            }),
        )
        .await;
        let reviewer_outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskReviewer(0),
                relay_api::team::TeamRole::Reviewer,
                "review it",
            )
            .await;
        let refused = matches!(
            reviewer_outcome,
            relay_api::team::TeamTurnOutcome::Failed(_)
        );
        *self.reviewer_outcome.lock().await = Some(reviewer_outcome);
        if refused {
            // The refusal may not have settled the run itself (F2: a draining
            // stop settles it instead) — give that a moment to land before the
            // wrap-up below treats an unsettled run as this driver's own.
            // `boundary_status` is NOT this check: it returns `Some` the
            // instant a pause is merely REQUESTED, before anyone settles it.
            for _ in 0..100 {
                let settled = port.run_snapshot(&run_id).await.is_some_and(|run| {
                    run.status.is_terminal() || run.status.is_settled_without_driver()
                });
                if settled {
                    break;
                }
                sleep(Duration::from_millis(5)).await;
            }
        }
        // `fail_run`, not `settle_run`: `TeamRun::fail` no-ops while `stopping`,
        // so a refusal raced by a real stop's own settle cannot clobber it.
        port.fail_run(&run_id, "test driver done".to_string()).await;
    }
}

/// [P1 fix] The early reviewer-gate check (before any thread is resolved) is
/// NOT sufficient by itself: `team_turn` still has to resolve the thread and
/// reach `team_drive_gate` before it can dispatch. A user Stop reaches
/// `request_stop` through that same drive gate, but a driver-side
/// `TeamPort::update_run` can set the same flags while holding only the relay
/// write lock, so it can land in exactly that window. This pins that the
/// refusal is REPEATED once `team_drive_gate` is held, using the pre-side-effect
/// latch (`hold_team_turn_barrier`) to land the stop deterministically rather
/// than racing real wall-clock timing.
#[tokio::test]
async fn a_stop_landing_between_the_reviewer_gates_early_check_and_the_drive_gate_is_still_caught()
{
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, None, false));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcome = std::sync::Arc::new(Mutex::new(None));
    let dev_landed = std::sync::Arc::new(tokio::sync::Notify::new());
    let proceed_to_reviewer = std::sync::Arc::new(tokio::sync::Notify::new());
    let app = app.with_team_driver(std::sync::Arc::new(RaceWindowDriver {
        dev_outcome: dev_outcome.clone(),
        reviewer_outcome: reviewer_outcome.clone(),
        dev_landed: dev_landed.clone(),
        proceed_to_reviewer: proceed_to_reviewer.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    // The dev turn has landed (and bumped `dev_turns_landed`) by the time this
    // resolves; the driver is now parked before even starting the reviewer
    // thread, so `team_turn_barrier` is uncontended.
    dev_landed.notified().await;

    let before = app.team_turn_arrivals();
    let latch = app.hold_team_turn_barrier().await;
    // Release the driver NOW, while we hold the latch: its reviewer turn's
    // early check runs and PASSES (dev_turns_landed is 1, nothing pausing
    // yet), then it parks on the latch we are holding — never resolving the
    // reviewer thread or reaching `team_drive_gate` until we say so.
    proceed_to_reviewer.notify_one();

    for _ in 0..2_000 {
        if app.team_turn_arrivals() > before {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    assert!(
        app.team_turn_arrivals() > before,
        "the reviewer turn should have reached the pre-gate latch by now"
    );

    // The stop lands in exactly the window the early check cannot see: past
    // its own check (already passed), before any later check has run.
    app.relay
        .write()
        .await
        .update_team_run(&run_id, |run| run.request_stop("device-stop"));
    drop(latch);

    // Under the fix this refusal does not settle the run itself while
    // `stopping` (F2) — wait on the refusal directly, then finish the stop for
    // real, the same as any actual drain would.
    for _ in 0..600 {
        if reviewer_outcome.lock().await.is_some() {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    assert!(
        reviewer_outcome.lock().await.is_some(),
        "the reviewer turn should have been attempted and refused by now"
    );
    app.force_stop_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect("a stopping run can still be stopped for real");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Replied(_))
        ),
        "the dev turn itself must land normally"
    );
    match reviewer_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(_)) => {}
        other => panic!(
            "a stop landing between the reviewer turn's early check and the \
drive gate must still refuse it, not merely a stop that lands before the \
early check runs at all: {other:?}"
        ),
    }
    assert_eq!(
        run.sub_tasks[0].rounds_used, 0,
        "a refused round must never be counted against the review budget"
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// [P2 fix] A run can settle after the reviewer's cheap early gate passes but
/// before the later preflight under `team_drive_gate`. That late preflight
/// still refuses the turn, but too late if `team_turn` already paid for the
/// provider baseline read and stamped bookkeeping. A settled run must become a
/// no-side-effect refusal before either of those happens.
#[tokio::test]
async fn a_stop_settling_after_reviewer_early_check_must_not_probe_or_stamp() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, None, false));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcome = std::sync::Arc::new(Mutex::new(None));
    let dev_landed = std::sync::Arc::new(tokio::sync::Notify::new());
    let proceed_to_reviewer = std::sync::Arc::new(tokio::sync::Notify::new());
    let app = app.with_team_driver(std::sync::Arc::new(RaceWindowDriver {
        dev_outcome: dev_outcome.clone(),
        reviewer_outcome: reviewer_outcome.clone(),
        dev_landed: dev_landed.clone(),
        proceed_to_reviewer: proceed_to_reviewer.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    dev_landed.notified().await;

    let before = app.team_turn_arrivals();
    let latch = app.hold_team_turn_barrier().await;
    proceed_to_reviewer.notify_one();

    for _ in 0..2_000 {
        if app.team_turn_arrivals() > before {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    assert!(
        app.team_turn_arrivals() > before,
        "the reviewer turn should have reached the pre-side-effect latch by now"
    );

    let reviewer_thread_id = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .and_then(|run| run.sub_tasks.first())
        .and_then(|task| task.reviewer_thread_id.clone())
        .expect("reviewer thread recorded before the reviewer turn parks");

    let stopped = app
        .force_stop_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect("a quiescent run stops while the reviewer is parked");
    assert_eq!(stopped, crate::state::TeamRunStatus::Paused);
    drop(latch);

    for _ in 0..600 {
        if reviewer_outcome.lock().await.is_some() {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    match reviewer_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(_)) => {}
        other => panic!("the settled reviewer turn should fail without running: {other:?}"),
    }
    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Replied(_))
        ),
        "the dev turn itself must land normally"
    );

    assert!(
        !providers
            .get("codex")
            .unwrap()
            .read_thread_calls()
            .await
            .contains(&reviewer_thread_id),
        "a reviewer turn that lost the race to a settled stop must not probe the provider"
    );
    assert!(
        !app.relay
            .read()
            .await
            .team_turn_phase_stamped(&reviewer_thread_id),
        "a reviewer turn that lost the race to a settled stop must not stamp bookkeeping"
    );
}

/// [P2 fix] A stop can settle the run while the provider baseline read is in
/// flight. That read cannot be un-done once started, but the phase stamp happens
/// under a relay write lock immediately after it, so it must re-check the run
/// status in that same lock and skip the stamp.
#[tokio::test]
async fn a_stop_settling_during_reviewer_baseline_read_must_not_stamp_phase() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let codex = providers.get("codex").unwrap().clone();
    codex
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, None, false));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcome = std::sync::Arc::new(Mutex::new(None));
    let dev_landed = std::sync::Arc::new(tokio::sync::Notify::new());
    let proceed_to_reviewer = std::sync::Arc::new(tokio::sync::Notify::new());
    let app = app.with_team_driver(std::sync::Arc::new(RaceWindowDriver {
        dev_outcome: dev_outcome.clone(),
        reviewer_outcome: reviewer_outcome.clone(),
        dev_landed: dev_landed.clone(),
        proceed_to_reviewer: proceed_to_reviewer.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    dev_landed.notified().await;

    let before = codex.read_thread_arrivals();
    let read_latch = codex.hold_read_thread_barrier().await;
    proceed_to_reviewer.notify_one();
    for _ in 0..2_000 {
        if codex.read_thread_arrivals() > before {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    assert!(
        codex.read_thread_arrivals() > before,
        "the reviewer turn should be parked inside its provider baseline read"
    );

    let reviewer_thread_id = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .and_then(|run| run.sub_tasks.first())
        .and_then(|task| task.reviewer_thread_id.clone())
        .expect("reviewer thread recorded before baseline read returns");

    let stopped = app
        .force_stop_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect("a quiescent run stops while the provider read is parked");
    assert_eq!(stopped, crate::state::TeamRunStatus::Paused);
    drop(read_latch);

    for _ in 0..600 {
        if reviewer_outcome.lock().await.is_some() {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    match reviewer_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(_)) => {}
        other => panic!("the settled reviewer turn should fail without running: {other:?}"),
    }
    assert!(
        codex
            .read_thread_calls()
            .await
            .contains(&reviewer_thread_id),
        "sanity: this test settles the run during the provider read, not before it"
    );
    assert!(
        !app.relay
            .read()
            .await
            .team_turn_phase_stamped(&reviewer_thread_id),
        "a run that settled during provider read must not get a later phase stamp"
    );
}

/// [P2 coverage] If a stop lands after the phase stamp but before `team_turn`
/// takes the drive gate, the later gated refusal must still prevent a reviewer
/// dispatch. This keeps coverage for the old pre-gate window after the earlier
/// latch moved to the stricter pre-side-effect point.
#[tokio::test]
async fn a_stop_settling_after_phase_stamp_before_drive_gate_must_not_dispatch() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let codex = providers.get("codex").unwrap().clone();
    codex
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, None, false));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcome = std::sync::Arc::new(Mutex::new(None));
    let dev_landed = std::sync::Arc::new(tokio::sync::Notify::new());
    let proceed_to_reviewer = std::sync::Arc::new(tokio::sync::Notify::new());
    let app = app.with_team_driver(std::sync::Arc::new(RaceWindowDriver {
        dev_outcome: dev_outcome.clone(),
        reviewer_outcome: reviewer_outcome.clone(),
        dev_landed: dev_landed.clone(),
        proceed_to_reviewer: proceed_to_reviewer.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    dev_landed.notified().await;

    let before = app.team_gated_arrivals();
    let latch = app.hold_team_gated_barrier().await;
    proceed_to_reviewer.notify_one();
    for _ in 0..2_000 {
        if app.team_gated_arrivals() > before {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    assert!(
        app.team_gated_arrivals() > before,
        "the reviewer turn should have reached the post-phase pre-gate latch"
    );

    let reviewer_thread_id = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .and_then(|run| run.sub_tasks.first())
        .and_then(|task| task.reviewer_thread_id.clone())
        .expect("reviewer thread recorded before the reviewer turn parks");
    assert!(
        app.relay
            .read()
            .await
            .team_turn_phase_stamped(&reviewer_thread_id),
        "sanity: this test settles after the phase stamp already happened"
    );
    let turns_before = codex.turns.lock().await.len();

    let stopped = app
        .force_stop_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect("a quiescent run stops before the parked reviewer reaches the drive gate");
    assert_eq!(stopped, crate::state::TeamRunStatus::Paused);
    drop(latch);

    for _ in 0..600 {
        if reviewer_outcome.lock().await.is_some() {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    match reviewer_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(_)) => {}
        other => panic!("the settled reviewer turn should fail without running: {other:?}"),
    }
    assert_eq!(
        codex.turns.lock().await.len(),
        turns_before,
        "a reviewer turn that loses the pre-gate race must not be dispatched"
    );
}

/// [P1 fix] `reviewer_turn_refusal` used to read the run's flags, return a
/// decision, and let the CALLER reset the sub-task and settle separately —
/// two lock acquisitions with a gap between them. A `request_stop` landing in
/// that gap left a stale `Boundary` decision to settle `Paused` anyway, and
/// the real stop's own later settle (with the user's reason) then no-op'd
/// against it — the exact bug F2 fixes, reopened through a different window.
///
/// The fix folds decide-and-commit into ONE write-lock hold, so nothing can
/// land between them. This proves it directly: park the refusal on a latch
/// AFTER it has decided but BEFORE it commits — still holding the write lock a
/// driver-side `TeamPort::update_run` needs to call `request_stop` — and show
/// that update cannot even start until the refusal releases it, so it can only
/// ever observe an already-consistent outcome, never corrupt one mid-flight.
#[tokio::test]
async fn a_stop_racing_the_atomic_refusal_cannot_land_between_its_decision_and_its_commit() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    // Silent, so `dev_turns_landed` stays 0 and the reviewer gate's `landed ==
    // 0` branch is the one being raced — the branch that both decides AND
    // mutates (the sub-task reset), making it the sharpest test of atomicity.
    providers
        .get("codex")
        .unwrap()
        .emit_assistant
        .store(false, Ordering::Relaxed);

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let before = app.reviewer_refusal_arrivals();
    let latch = app.hold_reviewer_refusal_barrier().await;

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    // The refusal has now decided (fresh flags: nothing pausing, landed == 0)
    // and is parked on our latch — still holding the SAME write lock this test's
    // driver-side `request_stop` update needs.
    for _ in 0..2_000 {
        if app.reviewer_refusal_arrivals() > before {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    assert!(
        app.reviewer_refusal_arrivals() > before,
        "the refusal should have reached its decided-but-not-committed latch by now"
    );

    let stop_update_task = {
        let app = app.clone();
        let run_id = run_id.clone();
        tokio::spawn(async move {
            relay_api::TeamPort::update_run(
                &app,
                &run_id,
                Box::new(|run| run.request_stop("driver-stop")),
            )
            .await
        })
    };
    // Give the spawned stop every chance to run if it somehow could; it must
    // not, because it cannot even acquire the lock the parked refusal holds.
    sleep(Duration::from_millis(50)).await;
    assert!(
        !stop_update_task.is_finished(),
        "a driver-side stop update cannot complete while the refusal it raced \
still holds the write lock its `request_stop` mutation requires"
    );

    drop(latch);

    let stop_updated = tokio::time::timeout(Duration::from_secs(5), stop_update_task)
        .await
        .expect("the driver-side stop update should finish after the refusal releases")
        .expect("the stop update task must not panic");
    assert!(
        stop_updated,
        "the driver-side stop update must still find the run after the refusal commits"
    );
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    // The refusal's own decision — made and committed atomically before the
    // stop could interleave — is what must have stuck: `Boundary`, not
    // corrupted, and not silently overwritten by the stop that arrived after.
    assert_eq!(
        run.pause_kind,
        Some(relay_api::team::TeamPauseKind::Boundary),
        "the refusal committed before the stop could ever run; its own \
decision must be the one that stuck"
    );
    // Exact, not a substring: card copy a person reads, not the internal
    // "sub-task N"/"landed" wording it used to leak.
    assert_eq!(
        run.pause_reason.as_deref(),
        Some("This step hasn't produced any work yet. You can resume to run it again.")
    );
    assert_eq!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Pending,
        "F1's reset must still land atomically with the settle, even though a \
stop was racing to apply right after"
    );
    assert_eq!(
        reviewer_outcomes.lock().await.len(),
        1,
        "the driver's own reviewer attempt is the one that got refused"
    );
}

/// Drives a Silent dev turn — so `dev_turns_landed` stays 0, the branch that
/// still mutates the sub-task below — moves the sub-task on the way the
/// private driver's action table would, then waits to be released before
/// attempting the reviewer turn. Gives a test a deterministic window to
/// settle the run for real before that late reviewer attempt runs.
struct SettledBeforeReviewDriver {
    dev_outcome: std::sync::Arc<Mutex<Option<relay_api::team::TeamTurnOutcome>>>,
    reviewer_outcome: std::sync::Arc<Mutex<Option<relay_api::team::TeamTurnOutcome>>>,
    dev_landed: std::sync::Arc<tokio::sync::Notify>,
    proceed_to_reviewer: std::sync::Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for SettledBeforeReviewDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let dev_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev seat thread");
        let reviewer_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Reviewer)
            .await
            .expect("reviewer seat thread");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                run.sub_tasks.push(crate::state::SubTask {
                    id: "st-1".to_string(),
                    dev_thread_id: Some(dev_thread),
                    reviewer_thread_id: Some(reviewer_thread),
                    ..Default::default()
                });
            }),
        )
        .await;

        let dev_outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskDev(0),
                relay_api::team::TeamRole::Dev,
                "write the parser",
            )
            .await;
        *self.dev_outcome.lock().await = Some(dev_outcome);
        // Mirrors the private driver's action table: any non-terminal dev
        // outcome moves the sub-task on, even a Silent one — the reviewer
        // gate is what actually catches "nothing landed", not this step.
        port.update_run(
            &run_id,
            Box::new(|run| {
                if let Some(task) = run.sub_tasks.get_mut(0) {
                    task.status = relay_api::team::SubTaskStatus::Implementing;
                }
            }),
        )
        .await;
        self.dev_landed.notify_one();
        self.proceed_to_reviewer.notified().await;

        let reviewer_outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskReviewer(0),
                relay_api::team::TeamRole::Reviewer,
                "review it",
            )
            .await;
        *self.reviewer_outcome.lock().await = Some(reviewer_outcome);
    }
}

/// [Settled-run guard] The reviewer gate decides and commits atomically, but
/// never checked whether the run had ALREADY settled before deciding
/// anything. `settle_paused` clears both `stopping` and `pause_requested`, so
/// a reviewer attempt that only reaches the gate AFTER a real Stop has
/// already settled the run sees neither flag, falls into the no-landed
/// branch, and force-resets the sub-task — discarding the progress the Stop
/// preserved.
#[tokio::test]
async fn a_reviewer_turn_after_the_run_already_settled_must_not_touch_it() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    // Silent, so `dev_turns_landed` stays 0 — the no-landed branch is the one
    // that still mutates even once the run has settled.
    providers
        .get("codex")
        .unwrap()
        .emit_assistant
        .store(false, Ordering::Relaxed);

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcome = std::sync::Arc::new(Mutex::new(None));
    let dev_landed = std::sync::Arc::new(tokio::sync::Notify::new());
    let proceed_to_reviewer = std::sync::Arc::new(tokio::sync::Notify::new());
    let app = app.with_team_driver(std::sync::Arc::new(SettledBeforeReviewDriver {
        dev_outcome: dev_outcome.clone(),
        reviewer_outcome: reviewer_outcome.clone(),
        dev_landed: dev_landed.clone(),
        proceed_to_reviewer: proceed_to_reviewer.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    dev_landed.notified().await;
    assert!(
        dev_outcome.lock().await.is_some(),
        "the dev turn must have run before the settle below"
    );

    // Nothing is in flight yet, so this drains trivially and settles `Paused`
    // synchronously — BEFORE the reviewer turn below is even attempted.
    app.force_stop_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect("a quiescent run stops synchronously");
    let settled = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("run recorded");
    assert_eq!(settled.status, crate::state::TeamRunStatus::Paused);
    assert_eq!(
        settled.sub_tasks[0].status,
        crate::state::SubTaskStatus::Implementing,
        "sanity: the sub-task's progress just before the late reviewer attempt"
    );

    proceed_to_reviewer.notify_one();
    for _ in 0..600 {
        if reviewer_outcome.lock().await.is_some() {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    assert!(
        reviewer_outcome.lock().await.is_some(),
        "the late reviewer attempt should have resolved by now"
    );

    let run = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("run still recorded");
    assert_eq!(
        run.status,
        crate::state::TeamRunStatus::Paused,
        "a settled run must not be re-decided by a late reviewer attempt"
    );
    assert_eq!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Implementing,
        "the settled run's progress must survive a late reviewer attempt \
untouched, not be reset to Pending"
    );
    assert_eq!(
        run.pause_kind,
        Some(relay_api::team::TeamPauseKind::User),
        "the real stop's own reason must stick, not be silently overwritten \
by the gate's Boundary kind"
    );
    assert_eq!(run.pause_reason.as_deref(), Some("stopped by the user"));

    // Beyond `TeamRun` fields: a settled run must cost nothing extra either.
    // `latest_assistant_entry` falls through to a provider round-trip when the
    // thread has no cached transcript entry yet — exactly this reviewer
    // thread's situation, since its turn never actually ran.
    let reviewer_thread_id = run.sub_tasks[0]
        .reviewer_thread_id
        .clone()
        .expect("reviewer thread recorded");
    assert!(
        !providers
            .get("codex")
            .unwrap()
            .read_thread_calls()
            .await
            .contains(&reviewer_thread_id),
        "a turn that must not run on a settled task must not probe the \
provider for it either"
    );
    assert!(
        !app.relay
            .read()
            .await
            .team_turn_phase_stamped(&reviewer_thread_id),
        "a turn that never runs must not stamp bookkeeping for one"
    );
}

/// `settle_team_run` releases every owned thread's provider seat after
/// settling `Paused` (`release_seats_when_settled`). The reviewer gate settles
/// `Paused` too, through its own direct `settle_paused` call rather than
/// through `settle_team_run` — it must release seats just the same, or a
/// refused reviewer turn pins the dev's and reviewer's child processes for as
/// long as the pause lasts.
#[tokio::test]
async fn a_refused_reviewer_turn_that_settles_the_run_releases_its_seats() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let codex = providers.get("codex").unwrap().clone();
    // Silent, so the reviewer gate's own no-landed branch is what settles the
    // run — not some other path already wired to `release_seats_when_settled`.
    codex.emit_assistant.store(false, Ordering::Relaxed);
    codex
        .auto_commit_author_changes
        .store(false, Ordering::Relaxed);

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        write_work_before_dev: false,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;
    let owned = run.owned_thread_ids();
    assert_eq!(
        owned.len(),
        2,
        "a dev and a reviewer thread must both be owned"
    );

    for _ in 0..600 {
        if codex.released_threads().await.len() >= owned.len() {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    let released = codex.released_threads().await;
    for thread_id in &owned {
        assert!(
            released.contains(thread_id),
            "the reviewer gate's own settle must release every owned seat, \
same as `settle_team_run` does: {thread_id} missing from {released:?}"
        );
    }
}

/// Regression: the new gate must not weaken the ordinary path. A dev turn that
/// lands, followed by a reviewer that rejects it twice, must still reach
/// `Escalated` exactly as it did before this sub-task.
#[tokio::test]
async fn a_landed_dev_turn_and_two_reviewer_rejections_still_escalate() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, None, false));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: crate::state::MAX_SUBTASK_REVIEW_ROUNDS,
        write_work_before_dev: true,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    let reviewer_outcomes = reviewer_outcomes.lock().await.clone();
    assert_eq!(
        reviewer_outcomes.len(),
        crate::state::MAX_SUBTASK_REVIEW_ROUNDS as usize,
        "both review rounds must actually run: {reviewer_outcomes:?}"
    );
    for outcome in &reviewer_outcomes {
        assert!(
            !matches!(outcome, relay_api::team::TeamTurnOutcome::Failed(_)),
            "a landed dev turn must not have its reviewer refused: {outcome:?}"
        );
    }
    let relay = app.relay.read().await;
    let run = relay
        .team_run(&run_id)
        .cloned()
        .expect("run still recorded");
    assert_eq!(
        run.sub_tasks[0].rounds_used,
        crate::state::MAX_SUBTASK_REVIEW_ROUNDS
    );
    assert_eq!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

#[tokio::test]
async fn a_finished_task_can_be_marked_cancelled_or_done() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Escalated;
        run.phase = relay_api::team::TeamPhase::Finished;
        run.error = Some("ran out of rounds".into());
    });

    let error = app
        .cancel_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect_err("cancel must refuse a terminal run");
    assert!(
        error.contains("already finished"),
        "the old cancel path must stay strict: {error}"
    );

    let status = app
        .mark_team_run(
            Some(run_id.clone()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect("mark cancelled");
    assert_eq!(status, crate::state::TeamRunStatus::Cancelled);

    let status = app
        .mark_team_run(
            Some(run_id.clone()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Done,
        )
        .await
        .expect("mark done");
    assert_eq!(status, crate::state::TeamRunStatus::Done);
    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert!(run.error.is_none(), "done clears the error");
}

#[tokio::test]
async fn a_blocked_task_cannot_be_marked_while_a_turn_is_unconfirmed() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Blocked;
        run.in_flight_thread = Some("thread-mid-start".to_string());
        run.error = Some("drain unconfirmed".into());
    });

    let error = app
        .mark_team_run(
            Some(run_id.clone()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect_err("mark must refuse an unconfirmed blocked run");
    assert!(
        error.contains("did not confirm stopping"),
        "the refusal must name the drain failure: {error}"
    );
    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Blocked);
}

#[tokio::test]
async fn mark_quiescent_refuses_when_the_run_is_no_longer_paused_or_terminal() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Running;
    });

    let error = app
        .mark_quiescent_team_run(&run_id, crate::state::TeamRunStatus::Cancelled)
        .await
        .expect_err("mark must not relabel a live run without stopping it");
    assert!(
        error.contains("no longer be marked"),
        "the refusal must name the race loser: {error}"
    );
    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Running);
}

#[tokio::test]
async fn mark_refuses_a_run_that_is_being_resolved() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Resolving;
    });

    let error = app
        .mark_team_run(
            Some(run_id.clone()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect_err("mark must refuse a recovery in flight");
    assert!(
        error.contains("being resolved"),
        "the refusal must name the recovery owner: {error}"
    );
    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Resolving);
}

#[tokio::test]
async fn reopen_rollback_does_not_clobber_a_concurrent_mark() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Escalated;
    });
    let restore = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("run");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Cancelled;
    });

    app.rollback_reopen_provision(&run_id, &restore).await;

    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Cancelled);
}

/// Mimics the private driver's action table just enough to prove F1: at the
/// top of every loop pass — including a resume, which is a fresh `drive()`
/// call with no memory of the last one — it reads the sub-task's PERSISTED
/// `status` and runs whatever that status maps to: `Pending` a dev turn,
/// `Implementing` a reviewer turn. It never special-cases "this is a resume";
/// the whole point of F1 is that the record alone must steer it correctly.
struct ActionTableDriver {
    dev_outcomes: std::sync::Arc<Mutex<Vec<relay_api::team::TeamTurnOutcome>>>,
    reviewer_outcomes: std::sync::Arc<Mutex<Vec<relay_api::team::TeamTurnOutcome>>>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for ActionTableDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let existing = port.run_snapshot(&run_id).await.expect("run exists");
        if existing.sub_tasks.is_empty() {
            let dev_thread = port
                .start_thread(&run_id, relay_api::team::TeamRole::Dev)
                .await
                .expect("dev seat thread");
            let reviewer_thread = port
                .start_thread(&run_id, relay_api::team::TeamRole::Reviewer)
                .await
                .expect("reviewer seat thread");
            port.update_run(
                &run_id,
                Box::new(move |run| {
                    run.sub_tasks.push(crate::state::SubTask {
                        id: "st-1".to_string(),
                        dev_thread_id: Some(dev_thread),
                        reviewer_thread_id: Some(reviewer_thread),
                        ..Default::default()
                    });
                }),
            )
            .await;
        }

        loop {
            // The pause boundary is the top of the loop and nowhere else (see
            // `team.rs` module docs): a settled run means someone else already
            // decided this run's fate, so there is nothing left to drive.
            if port.boundary_status(&run_id).await.is_some() {
                return;
            }
            let run = port.run_snapshot(&run_id).await.expect("run exists");
            match run.sub_tasks[0].status {
                crate::state::SubTaskStatus::Pending => {
                    let dev_attempt = self.dev_outcomes.lock().await.len();
                    std::fs::write(
                        std::path::Path::new(&run.cwd).join(format!("parser-{dev_attempt}.rs")),
                        format!("pub fn parse_{dev_attempt}() {{}}\n"),
                    )
                    .expect("candidate work for the dev turn");
                    let outcome = port
                        .turn(
                            &run_id,
                            relay_api::team::TeamThreadSlot::SubTaskDev(0),
                            relay_api::team::TeamRole::Dev,
                            "write the parser",
                        )
                        .await;
                    let progressed = !matches!(
                        outcome,
                        relay_api::team::TeamTurnOutcome::Failed(_)
                            | relay_api::team::TeamTurnOutcome::Blocked(_)
                    );
                    self.dev_outcomes.lock().await.push(outcome);
                    if !progressed {
                        port.fail_run(&run_id, "dev turn failed".to_string()).await;
                        return;
                    }
                    port.update_run(
                        &run_id,
                        Box::new(|run| {
                            if let Some(task) = run.sub_tasks.get_mut(0) {
                                task.status = crate::state::SubTaskStatus::Implementing;
                            }
                        }),
                    )
                    .await;
                }
                crate::state::SubTaskStatus::Implementing => {
                    let outcome = port
                        .turn(
                            &run_id,
                            relay_api::team::TeamThreadSlot::SubTaskReviewer(0),
                            relay_api::team::TeamRole::Reviewer,
                            "review it",
                        )
                        .await;
                    let refused = matches!(outcome, relay_api::team::TeamTurnOutcome::Failed(_));
                    self.reviewer_outcomes.lock().await.push(outcome);
                    if !refused {
                        port.settle_run(
                            &run_id,
                            crate::state::TeamRunStatus::Done,
                            "test driver done",
                        )
                        .await;
                        return;
                    }
                    // A refused reviewer turn already settled (or is deferring
                    // to a real stop) itself; loop back to the boundary check.
                }
                other => panic!("test driver hit an unmodelled sub-task status: {other:?}"),
            }
        }
    }
}

/// The root-cause regression F1 fixes: a refused reviewer turn used to leave
/// the sub-task at `Implementing`, which the private driver's action table
/// maps straight back to a review action — so a resume re-entered review,
/// got refused again, and re-paused forever. The fix puts the sub-task back
/// to `Pending` on that refusal, so a resume redrives the DEV turn instead.
#[tokio::test]
async fn a_refused_review_resets_the_sub_task_so_a_resume_drives_dev_not_review() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let codex = providers.get("codex").unwrap().clone();
    // Round one's dev turn completes but emits no assistant text (Silent) —
    // the shape `dev_turns_landed` must not count — so the reviewer gate
    // refuses it.
    codex.emit_assistant.store(false, Ordering::Relaxed);
    codex
        .auto_commit_author_changes
        .store(false, Ordering::Relaxed);

    let dev_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(ActionTableDriver {
        dev_outcomes: dev_outcomes.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert_eq!(dev_outcomes.lock().await.len(), 1);
    assert_eq!(reviewer_outcomes.lock().await.len(), 1);
    assert_eq!(run.sub_tasks[0].dev_turns_landed, 0);
    assert_eq!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Pending,
        "a refused review must not leave the sub-task where the action table \
sends straight back into another refused review on resume"
    );

    // The resumed dev turn actually lands this time: it replies AND bills.
    codex.emit_assistant.store(true, Ordering::Relaxed);
    codex
        .auto_commit_author_changes
        .store(true, Ordering::Relaxed);
    codex
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, None, false));
    app.resume_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect("a paused task can be resumed");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Done).await;

    let dev_outcomes = dev_outcomes.lock().await.clone();
    assert_eq!(
        dev_outcomes.len(),
        2,
        "the resume must drive a second DEV turn, not another refused review: {dev_outcomes:?}"
    );
    assert!(
        matches!(
            dev_outcomes[1],
            relay_api::team::TeamTurnOutcome::Replied(_)
        ),
        "the resumed dev turn must actually land, proving real progress: {:?}",
        dev_outcomes[1]
    );
    assert_eq!(run.sub_tasks[0].dev_turns_landed, 1);
    let reviewer_outcomes = reviewer_outcomes.lock().await.clone();
    assert_eq!(
        reviewer_outcomes.len(),
        2,
        "the dev turn landing must unlock a real review this time: {reviewer_outcomes:?}"
    );
    assert!(
        !matches!(
            reviewer_outcomes[1],
            relay_api::team::TeamTurnOutcome::Failed(_)
        ),
        "the second review must not be refused now that dev work landed: {:?}",
        reviewer_outcomes[1]
    );
}

/// F2's other branch: a GRACEFUL pause (`request_pause`, `stopping` stays
/// false) never drains anything, so nothing besides this refusal will ever
/// settle the run — it must settle `Paused` with the user's own `pause_kind`,
/// and must never fall through to `Failed`.
#[tokio::test]
async fn a_graceful_pause_that_refuses_a_reviewer_turn_settles_paused_not_failed() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcome = std::sync::Arc::new(Mutex::new(None));
    let dev_landed = std::sync::Arc::new(tokio::sync::Notify::new());
    let proceed_to_reviewer = std::sync::Arc::new(tokio::sync::Notify::new());
    let app = app.with_team_driver(std::sync::Arc::new(RaceWindowDriver {
        dev_outcome: dev_outcome.clone(),
        reviewer_outcome: reviewer_outcome.clone(),
        dev_landed: dev_landed.clone(),
        proceed_to_reviewer: proceed_to_reviewer.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    dev_landed.notified().await;

    app.pause_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect("a running task can be paused");
    proceed_to_reviewer.notify_one();

    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Replied(_))
        ),
        "the dev turn itself must land normally"
    );
    match reviewer_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(_)) => {}
        other => {
            panic!("a reviewer turn requested during a graceful pause must be refused: {other:?}")
        }
    }
    assert_eq!(
        run.pause_kind,
        Some(relay_api::team::TeamPauseKind::User),
        "a graceful pause is the user's own request taking effect, not the gate's"
    );
    // Exact, not a substring: card copy a person reads, not log-speak.
    assert_eq!(
        run.pause_reason.as_deref(),
        Some("The task paused before its next step began. You can resume from where it left off.")
    );

    // `fail()` is not suppressed for a graceful pause, so a bare refusal here
    // would have let the run fall through to `Failed`; confirm it did not.
    sleep(Duration::from_millis(50)).await;
    let still = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(still.status, crate::state::TeamRunStatus::Paused);
}
