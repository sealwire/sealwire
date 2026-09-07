use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::json;
use std::{env, path::PathBuf};
use tokio::sync::watch;

use crate::{
    protocol::{
        ApprovalReceipt, DeviceLifecycleState, FileChangeDiffView, ModelOptionView,
        SessionSnapshot, ThreadSummaryView, ThreadsResponse, ToolCallView, TranscriptEntryKind,
        TranscriptEntryView,
    },
    provider::ThreadSyncData,
};

use super::{
    persistence::{PersistedRelayState, PersistenceStore},
    *,
};

const TEST_VERIFY_KEY_B64: &str = "dGVzdC12ZXJpZnkta2V5";

fn test_persisted_state() -> PersistedRelayState {
    let mut device_records = std::collections::HashMap::new();
    device_records.insert(
        "phone-1".to_string(),
        DeviceRecord {
            device_id: "phone-1".to_string(),
            label: "Primary Phone".to_string(),
            lifecycle_state: crate::protocol::DeviceLifecycleState::Approved,
            created_at: 7,
            state_changed_at: 7,
            last_seen_at: Some(9),
            last_peer_id: Some("surface-1".to_string()),
            device_verify_key: TEST_VERIFY_KEY_B64.to_string(),
            broker_join_ticket_expires_at: None,
            path_scope: Vec::new(),
        },
    );
    let mut paired_devices = std::collections::HashMap::new();
    paired_devices.insert(
        "phone-1".to_string(),
        PairedDevice {
            device_id: "phone-1".to_string(),
            label: "Primary Phone".to_string(),
            payload_secret: "payload-secret".to_string(),
            device_verify_key: TEST_VERIFY_KEY_B64.to_string(),
            created_at: 7,
            last_seen_at: Some(9),
            last_peer_id: Some("surface-1".to_string()),
            broker_join_ticket_expires_at: None,
            path_scope: Vec::new(),
        },
    );
    let mut thread_settings = std::collections::HashMap::new();
    thread_settings.insert(
        "thread-1".to_string(),
        ThreadSessionSettings::new(
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            DEFAULT_MODEL,
        ),
    );
    PersistedRelayState {
        trusted_workspaces: Vec::new(),
        // No budget: these fixtures are about session restoration, and a cap
        // would gate turns in tests that have nothing to say about spending.
        usage_daily_cap: None,
        usage_budget_policy: String::new(),
        // A state file written by the CURRENT version: the legacy `allowed_roots`
        // carry-over already happened, so `allowed_roots` below stays a pure fence and
        // these fixtures keep meaning what they meant. The migration itself is covered
        // in `state::relay::tests`, on a file that predates the marker.
        allowed_roots_trust_migrated: true,
        schema_version: PERSISTED_STATE_VERSION,
        active_thread_id: Some("thread-1".to_string()),
        active_controller_device_id: Some("device-a".to_string()),
        active_controller_last_seen_at: Some(123),
        current_status: "running".to_string(),
        active_flags: vec!["busy".to_string()],
        current_cwd: "/tmp/project".to_string(),
        model: DEFAULT_MODEL.to_string(),
        approval_policy: DEFAULT_APPROVAL_POLICY.to_string(),
        sandbox: DEFAULT_SANDBOX.to_string(),
        reasoning_effort: DEFAULT_EFFORT.to_string(),
        provider_name: "codex".to_string(),
        thread_settings,
        thread_last_activity_at: std::collections::HashMap::new(),
        thread_last_turn_base_sha: std::collections::HashMap::new(),
        allowed_roots: vec!["/tmp/project".to_string()],
        device_records,
        paired_devices,
        reviewer_threads: std::collections::HashMap::new(),
        review_jobs: std::collections::HashMap::new(),
        workflow_jobs: std::collections::HashMap::new(),
        team_runs: std::collections::HashMap::new(),
        orchestrator_thread_id: None,
        orchestrator_device_id: None,
        orchestrator_system_prompt: None,
        orchestrator_system_prompt_version: None,
        orchestrator_proposals: Vec::new(),
        thread_forked_from: Default::default(),
        thread_promoted_from: Default::default(),
        thread_workspace: Default::default(),
        push_subscriptions: std::collections::HashMap::new(),
        projects: Default::default(),
        thread_project_id: Default::default(),
        thread_custom_name: Default::default(),
        projects_revision: 0,
        transcript_clock: 0,
    }
}

fn test_state() -> RelayState {
    let (change_tx, _) = watch::channel(0_u64);
    RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )
}

async fn test_broker_config(
    broker_url: &str,
    channel_id: &str,
    peer_id: &str,
) -> crate::broker::BrokerConfig {
    crate::broker::BrokerConfig::from_parts(
        Some(broker_url.to_string()),
        None,
        None,
        Some(channel_id.to_string()),
        Some(peer_id.to_string()),
        None,
        Some("test-broker-ticket-secret".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("broker config should parse")
    .expect("broker config should be enabled")
}

fn issue_test_pairing_ticket(
    relay: &mut RelayState,
    broker_url: &str,
    channel_id: &str,
    peer_id: &str,
    expires_in_seconds: Option<u64>,
) -> crate::protocol::PairingTicketView {
    issue_test_pairing_ticket_with_scope(
        relay,
        broker_url,
        channel_id,
        peer_id,
        expires_in_seconds,
        Vec::new(),
    )
}

fn issue_test_pairing_ticket_with_scope(
    relay: &mut RelayState,
    broker_url: &str,
    channel_id: &str,
    peer_id: &str,
    expires_in_seconds: Option<u64>,
    path_scope: Vec<String>,
) -> crate::protocol::PairingTicketView {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime should build");
    let broker = runtime.block_on(test_broker_config(broker_url, channel_id, peer_id));
    let prepared = relay
        .prepare_pairing_ticket(expires_in_seconds, path_scope)
        .expect("pairing ticket should prepare");
    relay.render_pairing_ticket_view(
        &prepared,
        broker.public_base_url(),
        broker.broker_room_id(),
        "test-pairing-join-ticket",
        broker.relay_peer_id(),
    )
}

fn test_thread(id: &str, cwd: &str) -> ThreadSummaryView {
    ThreadSummaryView {
        workspace_trusted: false,
        id: id.to_string(),
        name: Some("Test Thread".to_string()),
        preview: "Test preview".to_string(),
        cwd: cwd.to_string(),
        updated_at: 1,
        source: "codex".to_string(),
        status: "idle".to_string(),
        model_provider: "openai".to_string(),
        provider: "codex".to_string(),
        forked_from: None,
        renamed: false,
    }
}

#[test]
fn sort_threads_by_recency_orders_threads_across_providers() {
    let mut codex_old = test_thread("codex-old", "/tmp/project");
    codex_old.provider = "codex".to_string();
    codex_old.updated_at = 10;
    let mut claude_new = test_thread("claude-new", "/tmp/project");
    claude_new.provider = "claude_code".to_string();
    claude_new.updated_at = 30;
    let mut codex_middle = test_thread("codex-middle", "/tmp/project");
    codex_middle.provider = "codex".to_string();
    codex_middle.updated_at = 20;

    let mut threads = vec![codex_old, codex_middle, claude_new];
    sort_threads_by_recency(&mut threads);

    assert_eq!(
        threads
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<Vec<_>>(),
        vec!["claude-new", "codex-middle", "codex-old"]
    );
}

fn test_pending_ask_user_question(thread_id: &str) -> crate::state::PendingAskUserQuestion {
    crate::state::PendingAskUserQuestion {
        request_id: "ask:1".to_string(),
        tool_use_id: "toolu_x".to_string(),
        thread_id: thread_id.to_string(),
        requested_at: 100,
        questions: vec![crate::protocol::AskUserQuestionView {
            question: "Which?".to_string(),
            header: "Pick".to_string(),
            multi_select: false,
            options: vec![
                crate::protocol::AskUserOptionView {
                    label: "A".to_string(),
                    description: "alpha".to_string(),
                },
                crate::protocol::AskUserOptionView {
                    label: "B".to_string(),
                    description: "beta".to_string(),
                },
            ],
        }],
    }
}

fn test_pending_approval(thread_id: &str) -> PendingApproval {
    PendingApproval {
        request_id: "req-1".to_string(),
        raw_request_id: json!(1),
        kind: ApprovalKind::Command,
        thread_id: thread_id.to_string(),
        summary: "Need approval".to_string(),
        detail: Some("Test command".to_string()),
        command: Some("ls".to_string()),
        cwd: Some("/tmp/project".to_string()),
        context_preview: Some("cwd\n/tmp/project".to_string()),
        requested_permissions: None,
        available_decisions: vec!["approve".to_string(), "deny".to_string()],
        supports_session_scope: true,
    }
}

fn test_cached_remote_action_result(action_kind: &str, ok: bool) -> CachedRemoteActionResult {
    CachedRemoteActionResult {
        action_kind: action_kind.to_string(),
        ok,
        snapshot: Some(SessionSnapshot {
            provider_fork_capabilities: Vec::new(),
            provider_archive_capabilities: Vec::new(),
            provider_status: Vec::new(),
            revision: 7,
            transcript_revision: 3,
            server_time: 11,
            provider: "codex".to_string(),
            service_ready: true,
            provider_connected: true,
            broker_connected: true,
            broker_channel_id: Some("room-a".to_string()),
            broker_peer_id: Some("relay-a".to_string()),
            security_mode: crate::protocol::SecurityMode::Private,
            e2ee_enabled: true,
            broker_can_read_content: false,
            audit_enabled: false,
            beta_features_enabled: false,
            active_thread_id: Some("thread-1".to_string()),
            active_thread_promoted_from: None,
            active_thread_task_reviewer: false,
            active_controller_device_id: Some("device-a".to_string()),
            active_controller_last_seen_at: Some(100),
            controller_lease_expires_at: Some(115),
            controller_lease_seconds: CONTROLLER_LEASE_SECS,
            active_turn_id: None,
            current_status: "idle".to_string(),
            current_phase: None,
            current_tool: None,
            last_progress_at: None,
            active_flags: Vec::new(),
            thread_activity: Vec::new(),
            current_cwd: "/tmp/project".to_string(),
            thread_workspace_cwd: None,
            workspace_missing: None,
            model: DEFAULT_MODEL.to_string(),
            available_models: Vec::new(),
            approval_policy: DEFAULT_APPROVAL_POLICY.to_string(),
            sandbox: DEFAULT_SANDBOX.to_string(),
            reasoning_effort: DEFAULT_EFFORT.to_string(),
            allowed_roots: vec!["/tmp/project".to_string()],
            device_records: Vec::new(),
            paired_devices: Vec::new(),
            pending_pairing_requests: Vec::new(),
            devices_revision: 0,
            pending_approvals: Vec::new(),
            pending_ask_user_questions: Vec::new(),
            transcript_truncated: false,
            transcript: Vec::new(),
            logs: Vec::new(),
            active_review_jobs: Vec::new(),
            reviewer_threads: Vec::new(),
            review_activity: Vec::new(),
            review_activity_total: 0,
            review_blocked: false,
            reviews_revision: 0,
            active_workflow_runs: Vec::new(),
            workflow_activity: Vec::new(),
            workflows_revision: 0,
            push_vapid_public_key: None,
            projects_revision: 0,
            threads_revision: 0,
            thread_workspaces_revision: 0,
            teams_revision: 0,
            orchestrator_thread_id: None,
            orchestrator_proposals: Vec::new(),
        }),
        receipt: Some(ApprovalReceipt {
            request_id: "req-1".to_string(),
            decision: crate::protocol::ApprovalDecision::Approve,
            resulting_state: "approval_response_sent".to_string(),
            message: "approved".to_string(),
        }),
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: Some(ThreadsResponse {
            threads: vec![test_thread("thread-1", "/tmp/project")],
            unavailable_providers: Vec::new(),
        }),
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        session_claim: Some("claim-1".to_string()),
        session_claim_expires_at: Some(120),
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        response_secret: None,
        error: if ok {
            None
        } else {
            Some("replayed failure".to_string())
        },
    }
}

#[test]
fn available_models_update_default_model_and_effort() {
    let mut relay = test_state();
    relay.model = DEFAULT_MODEL.to_string();
    relay.reasoning_effort = DEFAULT_EFFORT.to_string();

    relay.set_available_models(vec![
        ModelOptionView {
            model: "gpt-5.4".to_string(),
            display_name: "gpt-5.4".to_string(),
            supported_reasoning_efforts: vec![
                "low".to_string(),
                "medium".to_string(),
                "high".to_string(),
                "xhigh".to_string(),
            ],
            default_reasoning_effort: "medium".to_string(),
            provider: "codex".to_string(),
            hidden: false,
            is_default: true,
        },
        ModelOptionView {
            model: "gpt-5.1-codex-mini".to_string(),
            display_name: "gpt-5.1-codex-mini".to_string(),
            supported_reasoning_efforts: vec!["medium".to_string(), "high".to_string()],
            default_reasoning_effort: "medium".to_string(),
            provider: "codex".to_string(),
            hidden: false,
            is_default: false,
        },
    ]);

    assert_eq!(relay.model, "gpt-5.4");
    assert_eq!(relay.reasoning_effort, "medium");
    assert_eq!(relay.available_models.len(), 2);
}

#[test]
fn switching_active_provider_drops_the_previous_providers_catalog() {
    // Repro for: "Codex shows Claude's models." Boot leaves the relay on Claude
    // with Claude's catalog (Claude heads `DEFAULT_PROVIDER_PREFERENCE`, and the
    // startup refresh stamps `available_models`).
    let mut relay = test_state();
    relay.set_provider_name("claude_code".to_string());
    relay.set_available_models(vec![ModelOptionView {
        model: "default".to_string(),
        display_name: "Default (Opus 4.8)".to_string(),
        supported_reasoning_efforts: vec!["high".to_string()],
        default_reasoning_effort: "high".to_string(),
        provider: "anthropic".to_string(),
        hidden: false,
        is_default: true,
    }]);
    assert_eq!(relay.available_models.len(), 1);

    // Restoring a persisted Codex session switches the active provider to codex,
    // but its catalog isn't available yet (load_provider_model_catalog → None, so
    // restore_persisted_session never calls set_available_models). The stale
    // Claude catalog must NOT survive the switch — otherwise the snapshot reports
    // provider="codex" with available_models=Claude, and the model/review pickers
    // surface Claude's models under Codex.
    relay.set_provider_name("codex".to_string());

    assert!(
        relay.available_models.is_empty(),
        "switching the active provider must drop the prior provider's stale catalog \
         (got {} stale models)",
        relay.available_models.len()
    );
}

#[test]
fn set_available_models_preserves_user_chosen_effort_across_catalog_reload() {
    let mut relay = test_state();
    relay.active_thread_id = Some("thread-1".to_string());
    // User deliberately picked a Claude model + "max" thinking effort (not the
    // defaults). This is the state resume/switch/update leaves in the relay.
    relay.model = "claude-opus-4".to_string();
    relay.reasoning_effort = "max".to_string();

    // A catalog (re)load fires — on resume, provider switch, or the startup
    // refresh. The freshly-fetched catalog's default model does not list "max"
    // (the active model isn't in this list, so it resolves to the default).
    relay.set_available_models(vec![ModelOptionView {
        model: "claude-sonnet-4".to_string(),
        display_name: "Claude Sonnet 4".to_string(),
        supported_reasoning_efforts: vec!["low".to_string(), "high".to_string()],
        default_reasoning_effort: "high".to_string(),
        provider: "claude_code".to_string(),
        hidden: false,
        is_default: true,
    }]);

    // BUG: merely loading the model list silently rewrote the user's choice.
    assert_eq!(
        relay.reasoning_effort, "max",
        "loading the model catalog must not overwrite a user-chosen effort"
    );
    // The model still resolved to a catalog entry, so the picker stays matched.
    assert_settings_invariants(&relay.snapshot(), "after catalog reload");
}

#[test]
fn activate_thread_sets_active_controller_on_start() {
    let mut relay = test_state();

    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );

    assert_eq!(relay.active_thread_id.as_deref(), Some("thread-1"));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("device-a")
    );
    assert!(relay.can_device_send_message("device-a"));
    assert!(!relay.can_device_send_message("device-b"));
}

#[test]
fn append_agent_delta_reports_utf16_text_offset() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );

    // The first chunk creates the entry, so its append offset is 0.
    let first = relay.append_agent_delta("item-1", "Hello", "turn-1");
    assert_eq!(first.text_offset, Some(0));

    // The second chunk appends after "Hello" (5 chars).
    let second = relay.append_agent_delta("item-1", " world", "turn-1");
    assert_eq!(second.text_offset, Some(5));

    // text_offset counts UTF-16 code units so it lines up with the browser's
    // String.length. An astral emoji is one Unicode scalar value but two UTF-16
    // code units, so the following chunk must report offset 13, not 12.
    let third = relay.append_agent_delta("item-1", "💡", "turn-1");
    assert_eq!(third.text_offset, Some(11));
    let fourth = relay.append_agent_delta("item-1", "!", "turn-1");
    assert_eq!(fourth.text_offset, Some(13));
}

#[test]
fn append_command_delta_has_no_text_offset() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );

    // Command output joins chunks with a server-side separator, so its on-wire
    // text diverges from a plain client-side append; we deliberately omit the
    // offset and let the client fall back to base_revision gap detection.
    let meta = relay.append_command_delta("cmd-1", "output");
    assert_eq!(meta.text_offset, None);
}

#[test]
fn snapshot_strips_file_change_diffs_but_keeps_stored_diffs() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );

    let tool = ToolCallView {
        item_type: "turnDiff".to_string(),
        name: "turn_diff".to_string(),
        title: "Changed files".to_string(),
        kind: None,
        detail: None,
        query: None,
        path: None,
        url: None,
        command: None,
        input_preview: None,
        result_preview: None,
        diff: Some("@@ big joined diff @@".to_string()),
        file_changes: vec![FileChangeDiffView {
            path: "src/a.rs".to_string(),
            change_type: "modify".to_string(),
            diff: "-old\n+new".to_string(),
        }],
        apply_state: None,
        file_changes_omitted: false,
        can_apply: None,
    };
    relay.upsert_transcript_item(
        "turn-diff:turn-1".to_string(),
        TranscriptEntryKind::ToolCall,
        Some("Edited files".to_string()),
        "completed".to_string(),
        Some("turn-1".to_string()),
        Some(tool),
    );

    // The snapshot projection carries only the file-change summary.
    let snapshot = relay.snapshot();
    let entry = snapshot
        .transcript
        .iter()
        .find(|entry| entry.item_id.as_deref() == Some("turn-diff:turn-1"))
        .expect("turn-diff entry in snapshot");
    let snap_tool = entry.tool.as_ref().expect("tool in snapshot");
    assert!(snap_tool.file_changes_omitted);
    assert!(snap_tool.diff.is_none());
    assert_eq!(snap_tool.file_changes.len(), 1);
    assert_eq!(snap_tool.file_changes[0].path, "src/a.rs");
    assert_eq!(snap_tool.file_changes[0].change_type, "modify");
    assert!(snap_tool.file_changes[0].diff.is_empty());

    // The authoritative stored record keeps the full diffs (the detail-fetch
    // source), so snapshotting is non-destructive.
    let stored = relay
        .selected_runtime()
        .expect("runtime")
        .transcript
        .iter()
        .find(|record| record.item_id == "turn-diff:turn-1")
        .expect("stored record");
    let stored_tool = stored.tool.as_ref().expect("stored tool");
    assert!(!stored_tool.file_changes_omitted);
    assert_eq!(stored_tool.diff.as_deref(), Some("@@ big joined diff @@"));
    assert_eq!(stored_tool.file_changes[0].diff, "-old\n+new");
}

#[test]
fn thread_last_activity_or_prefers_tracked_value_over_provider_mtime() {
    let mut relay = test_state();
    // Untracked thread (never resumed by us): the provider mtime is honest, so
    // we fall back to it.
    assert_eq!(relay.thread_last_activity_or("ghost", 4242), 4242);

    // `observe` (honest-provider resume path) folds in last-activity times,
    // keeping the most recent: a newer real-activity time advances the key
    // (heals unwitnessed CLI use), but an older observation can't drag it back.
    relay.observe_thread_last_activity("honest", 1_000);
    relay.observe_thread_last_activity("honest", 9_000);
    assert_eq!(relay.thread_last_activity_or("honest", 0), 9_000);
    relay.observe_thread_last_activity("honest", 5_000);
    assert_eq!(relay.thread_last_activity_or("honest", 0), 9_000);

    // `seed` (non-honest provider resume path) freezes the first observation,
    // so a later resume-bumped mtime can't creep the key up the list.
    relay.seed_thread_last_activity("frozen", 1_000);
    relay.seed_thread_last_activity("frozen", 9_999_999);
    assert_eq!(relay.thread_last_activity_or("frozen", 0), 1_000);
}

#[test]
fn transcript_write_advances_thread_last_activity() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    // Force an ancient baseline, then prove a genuine transcript write (agent
    // output) advances the honest sort key to ~now. Resume's bulk history load
    // does NOT go through this path, so it can't move the thread.
    relay
        .thread_last_activity_at
        .insert("thread-1".to_string(), 1_000);
    relay.upsert_transcript_item(
        "item-1".to_string(),
        TranscriptEntryKind::AgentText,
        Some("hi".to_string()),
        "complete".to_string(),
        Some("turn-1".to_string()),
        None,
    );
    assert!(relay.thread_last_activity_or("thread-1", 0) > 1_000);
}

#[test]
fn thread_last_activity_survives_persistence_round_trip() {
    let mut relay = test_state();
    relay
        .thread_last_activity_at
        .insert("thread-1".to_string(), 1_234);

    let persisted = PersistedRelayState::from_relay(&relay);
    assert_eq!(
        persisted.thread_last_activity_at.get("thread-1"),
        Some(&1_234)
    );

    let mut restored = test_state();
    restored.apply_persisted(&persisted);
    assert_eq!(restored.thread_last_activity_or("thread-1", 0), 1_234);
}

// Both halves of a thread's working tree outlive the process, for different reasons.
//
// The PROVEN half exists precisely to outlive the process-local evidence it came from: a
// restart is the case that matters most, because the thread has no runtime, so nothing
// else can say it ever left the tree it was born in — and a review that assumes it didn't
// strands the reviewer in the wrong tree.
//
// The PINNED half is a person's explicit choice, and nobody expects one of those to last
// only until the next relay restart.
#[test]
fn a_threads_working_tree_survives_a_persistence_round_trip() {
    const WORKTREE: &str = "/tmp/project/.claude/worktrees/feature";
    let mut relay = test_state();
    relay.record_proven_thread_workspace("thread-1", WORKTREE);
    relay.set_thread_workspace("thread-2", Some("/tmp/project"));

    let persisted = PersistedRelayState::from_relay(&relay);
    assert_eq!(
        persisted
            .thread_workspace
            .get("thread-1")
            .and_then(|workspace| workspace.proven.as_deref()),
        Some(WORKTREE),
        "the proven tree must be written to disk"
    );
    assert_eq!(
        persisted
            .thread_workspace
            .get("thread-2")
            .and_then(|workspace| workspace.pinned.as_deref()),
        Some("/tmp/project"),
        "so must the pin"
    );

    let mut restored = test_state();
    restored.apply_persisted(&persisted);
    assert_eq!(
        restored.thread_workspace("thread-1").proven.as_deref(),
        Some(WORKTREE),
        "and read back, or every review after a restart re-targets the birth tree"
    );
    assert_eq!(
        restored.thread_workspace("thread-2").pinned.as_deref(),
        Some("/tmp/project")
    );
    // The two must not be conflated in either direction: which of them holds the value is
    // exactly how a caller tells "a user chose this" from "we worked it out".
    assert_eq!(restored.thread_workspace("thread-1").pinned, None);
    assert_eq!(restored.thread_workspace("thread-2").proven, None);
}

// Un-pinning a thread that was never proven anywhere must not leave an empty row behind:
// this map is PERSISTED and (unlike its predecessor) writable by a paired device, so a
// row nothing can reach again holds a slot forever.
#[test]
fn clearing_a_pin_with_nothing_else_remembered_drops_the_row() {
    let mut relay = test_state();
    relay.set_thread_workspace("thread-1", Some("/tmp/project"));
    assert!(
        relay.set_thread_workspace("thread-1", None),
        "a real change"
    );
    assert!(
        PersistedRelayState::from_relay(&relay)
            .thread_workspace
            .is_empty(),
        "an emptied entry must not be persisted"
    );

    // But a thread that is still PROVEN somewhere keeps its row — un-pinning hands it
    // back to the inference, it does not erase what the inference learned.
    relay.record_proven_thread_workspace("thread-2", "/tmp/project/wt");
    relay.set_thread_workspace("thread-2", Some("/tmp/project"));
    relay.set_thread_workspace("thread-2", None);
    assert_eq!(
        relay.thread_workspace("thread-2").proven.as_deref(),
        Some("/tmp/project/wt")
    );
}

// Same reasoning as `clearing_fork_lineage_notifies_so_the_removal_reaches_disk`:
// recording the proven tree in memory is only half the job. A review that refuses (the
// cross-tree reuse gate) returns without touching job state, so nothing else on that path
// notifies — and the persistence task only saves in response to a notification. Without a
// wake here, the very fact that would have prevented the NEXT review from re-targeting the
// birth tree is lost on restart.
#[test]
fn a_stale_resolver_writeback_does_not_clobber_a_newer_cwd_observation() {
    let mut relay = test_state();
    relay.observe_thread_cwd("thread-1", "/tmp/project/.claude/worktrees/feature");
    let observed = relay.thread_workspace("thread-1");
    assert_eq!(
        observed.proven.as_deref(),
        Some("/tmp/project/.claude/worktrees/feature")
    );
    let observed_at = observed.proven_at.expect("observation stamps recency");

    relay.record_proven_thread_workspace_at("thread-1", "/tmp/project", 0);
    let after = relay.thread_workspace("thread-1");
    assert_eq!(
        after.proven.as_deref(),
        Some("/tmp/project/.claude/worktrees/feature"),
        "a stale write-back must not replace a newer cwd observation"
    );
    assert_eq!(after.proven_at, Some(observed_at));
}

#[test]
fn recording_a_proven_workspace_notifies_so_it_reaches_disk() {
    let (change_tx, mut change_rx) = watch::channel(0_u64);
    let mut relay = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    relay.notify();
    let _ = change_rx.borrow_and_update();

    relay.record_proven_thread_workspace("thread-1", "/tmp/project/.claude/worktrees/feature");
    assert!(
        change_rx.has_changed().expect("channel stays open"),
        "a newly proven tree must wake the persistence task"
    );

    // The flip side: re-proving the SAME tree happens on every review round AND every
    // diff-panel refresh now that they share one resolver, so waking every connected
    // client for a value that did not change would be constant noise.
    let _ = change_rx.borrow_and_update();
    relay.record_proven_thread_workspace("thread-1", "/tmp/project/.claude/worktrees/feature");
    assert!(
        !change_rx.has_changed().expect("channel stays open"),
        "re-proving the same tree must not notify"
    );
}

#[test]
fn promote_background_thread_carries_the_orchestrator_pin() {
    // Observed against a real Claude session, not reasoned about. The Orchestrator
    // opens with no prompt, so Claude defers the session and hands back a synthetic
    // `claude-pending-…` id, which is what gets pinned. The FIRST message promotes
    // it to a real id — and if the pin does not follow, this happens:
    //
    //   live_orchestrator_thread_id -> find_thread_provider(pending) -> not found
    //     -> clears the pin (its self-heal for a deleted thread)
    //     -> the next ensure builds a BRAND NEW Orchestrator
    //
    // i.e. the conversation resets after the first message, on the provider the
    // ranking deliberately prefers. The self-heal is right; it just cannot tell a
    // promoted thread from a deleted one unless promotion says so.
    let (change_tx, _rx) = watch::channel(0_u64);
    let mut relay = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    relay.orchestrator_thread_id = Some("claude-pending-7".to_string());

    relay.promote_background_thread("claude-pending-7", "real-session-id");

    assert_eq!(
        relay.orchestrator_thread_id.as_deref(),
        Some("real-session-id"),
        "the pin must follow its thread, or the Orchestrator resets every first turn"
    );
}

#[test]
fn promotion_keeps_a_reviewed_parent_review_locked() {
    // Promotion re-keys the reviewer id, workflow step threads and team seats — but
    // the PARENT id of a review/workflow is the same class of pointer and was left
    // behind. A review of a Claude session that has never been messaged promotes that
    // session on its first (recap) turn, and the lock is what stops the user typing
    // into a thread the orchestrator is driving. Keyed to a dead id, it evaporates.
    let mut relay = test_state();
    let job = crate::state::ReviewJob::new(
        "review-1".to_string(),
        "claude-pending-1".to_string(),
        "claude_code".to_string(),
        "codex".to_string(),
        None,
        crate::state::ReviewMode::CleanThread,
        "/tmp/project".to_string(),
        "device-1".to_string(),
        None,
        1,
    );
    relay.insert_review_job(job);
    assert!(relay.is_thread_review_locked("claude-pending-1"));

    relay.promote_background_thread("claude-pending-1", "real-1");

    assert!(
        relay.is_thread_review_locked("real-1"),
        "the reviewed thread must stay locked across its own promotion"
    );
    assert!(
        !relay.is_thread_review_locked("claude-pending-1"),
        "and the dead placeholder must not stay locked"
    );
}

#[test]
fn registering_a_thread_from_a_working_summary_does_not_make_it_working() {
    // `ThreadRuntime::new` copies the summary's status VERBATIM, so the settling is
    // done by the `upsert_thread` that `register_background_thread` ends with. A
    // Claude deferred-start placeholder is reported `"active"` before it has ever
    // had a turn, so if that upsert stops settling, registration alone leaves a
    // permanently-working ghost: `update_session_settings` refuses a working thread,
    // and the review's uncertain-start cleanup tries to interrupt an SDK session
    // that was never created and can leave the job stuck in `Blocked`.
    //
    // Upserting the same summary again (a list refresh) must not revive it either.
    let mut relay = test_state();
    let mut pending = test_thread("claude-pending-1", "/tmp/project");
    pending.provider = "claude_code".to_string();
    pending.source = "claude_code".to_string();
    pending.status = "active".to_string();
    relay.register_background_thread(
        pending.clone(),
        "/tmp/project",
        "claude-sonnet-4-6",
        "on-request",
        "workspace-write",
        "medium",
    );

    assert!(
        !relay
            .runtime_for_thread("claude-pending-1")
            .expect("the runtime is registered")
            .is_working(),
        "a placeholder that has never had a turn must not register as working"
    );

    relay.upsert_thread(pending);
    assert!(
        !relay
            .runtime_for_thread("claude-pending-1")
            .expect("the runtime is still there")
            .is_working(),
        "re-reading the same working summary must not revive it either"
    );
}

#[test]
fn a_summary_still_cannot_mark_an_idle_turnless_thread_working() {
    // The other half of the same rule, and the reason it exists: a provider
    // list/read row is NOT a liveness signal. A settled runtime with no live turn
    // must stay settled however working the summary claims to be, or a stale
    // `status.type` from a Codex read/list resurrects a finished turn.
    let mut relay = test_state();
    relay.register_background_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        "gpt-5-codex",
        "on-request",
        "workspace-write",
        "medium",
    );
    relay.set_thread_status("thread-1", "idle".to_string(), Vec::new());

    let mut working = test_thread("thread-1", "/tmp/project");
    working.status = "active".to_string();
    relay.upsert_thread(working);

    assert!(
        !relay
            .runtime_for_thread("thread-1")
            .expect("runtime present")
            .is_working(),
        "a summary must never resurrect a settled, turn-less thread"
    );
}

#[test]
fn promote_background_thread_leaves_an_unrelated_orchestrator_pin_alone() {
    let (change_tx, _rx) = watch::channel(0_u64);
    let mut relay = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    relay.orchestrator_thread_id = Some("orch-thread".to_string());

    relay.promote_background_thread("claude-pending-7", "real-session-id");

    assert_eq!(relay.orchestrator_thread_id.as_deref(), Some("orch-thread"));
}

#[test]
fn promote_background_thread_migrates_last_activity_keeping_most_recent() {
    // A background reviewer logs activity under its synthetic `claude-pending-…`
    // id; promotion to the real session id must carry that honest timestamp over
    // and drop the pending entry (which is otherwise orphaned in a persisted
    // map). When both ids have a value, the most-recent wins — either could have
    // logged a transcript write during the handoff.
    let mut relay = test_state();
    relay
        .thread_last_activity_at
        .insert("claude-pending-1".to_string(), 8_000);
    relay
        .thread_last_activity_at
        .insert("real-1".to_string(), 5_000);
    relay.promote_background_thread("claude-pending-1", "real-1");
    assert_eq!(
        relay.thread_last_activity_at.get("real-1"),
        Some(&8_000),
        "the more recent pending timestamp must win"
    );
    assert!(
        !relay
            .thread_last_activity_at
            .contains_key("claude-pending-1"),
        "the pending entry must not orphan after promotion"
    );

    // When only the pending id has a value, it carries over wholesale.
    let mut relay = test_state();
    relay
        .thread_last_activity_at
        .insert("claude-pending-2".to_string(), 9_000);
    relay.promote_background_thread("claude-pending-2", "real-2");
    assert_eq!(relay.thread_last_activity_at.get("real-2"), Some(&9_000));
    assert!(!relay
        .thread_last_activity_at
        .contains_key("claude-pending-2"));
}

// Removing the lineage row is only half the job: the persistence task saves
// exclusively in response to watch-channel notifications, so a silent in-memory
// removal never reaches disk. The fork's own activation already notified and
// (after the debounce) wrote the STALE row — and a first turn can fail slowly,
// e.g. a 30s Claude worker timeout, long after that save. Without a notify here
// the orphan simply comes back on the next restart.
#[test]
fn clearing_fork_lineage_notifies_so_the_removal_reaches_disk() {
    let (change_tx, mut change_rx) = watch::channel(0_u64);
    let mut relay = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    relay.set_thread_forked_from("fork-1", "source-1");
    relay.notify();
    // Model the persistence task having already saved that stale row.
    let _ = change_rx.borrow_and_update();
    assert!(!change_rx.has_changed().expect("channel stays open"));

    relay.clear_thread_forked_from("fork-1");

    assert!(
        change_rx.has_changed().expect("channel stays open"),
        "removing lineage must wake the persistence task, or the stale row survives a restart"
    );
    assert!(relay.thread_forked_from("fork-1").is_none());
}

// The flip side: clearing a row that was never there must not bump the
// revision. A spurious notification wakes every connected client and schedules
// a pointless save on a path that runs for ordinary non-fork sessions too.
#[test]
fn clearing_absent_fork_lineage_does_not_notify() {
    let (change_tx, mut change_rx) = watch::channel(0_u64);
    let mut relay = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    relay.notify();
    let _ = change_rx.borrow_and_update();

    relay.clear_thread_forked_from("never-forked");

    assert!(
        !change_rx.has_changed().expect("channel stays open"),
        "a no-op removal must not notify"
    );
}

// A Claude replay fork that carries pasted images has to withhold the prompt
// from `start_thread` (that call cannot take image bytes), which puts Claude on
// its deferred-start path: the fork is recorded against a synthetic
// `claude-pending-…` id and only becomes a real session on the first turn.
// `thread_forked_from` must therefore ride promotion like every other
// thread-keyed map, or the branch loses its lineage and the pending key is
// orphaned in a PERSISTED map — leaking across restarts forever.
#[test]
fn promote_background_thread_migrates_fork_lineage() {
    let mut relay = test_state();
    relay.set_thread_forked_from("claude-pending-3", "source-thread");
    relay.promote_background_thread("claude-pending-3", "real-3");

    assert_eq!(
        relay.thread_forked_from("real-3"),
        Some("source-thread".to_string()),
        "the promoted thread must keep the source it was forked from"
    );
    assert!(
        !relay.thread_forked_from.contains_key("claude-pending-3"),
        "the pending lineage entry must not orphan in a persisted map"
    );
}

// Promotion must not clobber lineage the real id already has: the event stream
// can create the real-id thread first, and its own lineage is the honest one.
#[test]
fn promotion_keeps_existing_fork_lineage_on_the_real_thread() {
    let mut relay = test_state();
    relay.set_thread_forked_from("claude-pending-4", "pending-source");
    relay.set_thread_forked_from("real-4", "real-source");
    relay.promote_background_thread("claude-pending-4", "real-4");

    assert_eq!(
        relay.thread_forked_from("real-4"),
        Some("real-source".to_string()),
        "an existing real-id lineage wins over the pending one"
    );
    assert!(!relay.thread_forked_from.contains_key("claude-pending-4"));
}

#[test]
fn promotion_records_lineage_and_rides_the_snapshot() {
    // The pending->real id transition is, from a client's point of view,
    // indistinguishable from another device switching the relay to an
    // unrelated thread. The snapshot must therefore carry the lineage
    // authoritatively so every client (observers included) can rekey its
    // scroll bookkeeping / pinned view only on REAL promotions.
    let mut relay = test_state();
    relay.promote_background_thread("claude-pending-9", "real-9");
    assert_eq!(
        relay.thread_promoted_from.get("real-9"),
        Some(&"claude-pending-9".to_string()),
        "promotion must record its lineage"
    );

    relay.active_thread_id = Some("real-9".to_string());
    assert_eq!(
        relay.snapshot().active_thread_promoted_from,
        Some("claude-pending-9".to_string()),
        "the active thread's pending lineage must ride the snapshot"
    );

    // An unrelated active thread exposes no lineage.
    relay.active_thread_id = Some("other-thread".to_string());
    assert_eq!(relay.snapshot().active_thread_promoted_from, None);

    // Lineage survives persistence (mirrors thread_forked_from).
    let persisted = PersistedRelayState::from_relay(&relay);
    let mut restored = test_state();
    restored.apply_persisted(&persisted);
    assert_eq!(
        restored.thread_promoted_from.get("real-9"),
        Some(&"claude-pending-9".to_string()),
        "promotion lineage must survive a relay restart"
    );
}

#[test]
fn snapshot_thread_activity_tracks_active_and_background_running_threads() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-active", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.set_active_turn(Some("turn-active".to_string()));
    relay.touch_progress(Some("tool"), Some("Bash"));

    // A backgrounded thread mid-turn must surface as working...
    relay.bg_set_active_turn("thread-bg", Some("turn-bg".to_string()), 1_000);
    relay.bg_set_thread_status(
        "thread-bg-phase-only",
        "active".to_string(),
        Vec::new(),
        1_000,
    );
    // ...while a backgrounded thread without an in-flight turn must not.
    relay.bg_set_thread_status("thread-idle", "idle".to_string(), Vec::new(), 1_000);

    let snapshot = relay.snapshot();
    let ids: Vec<&str> = snapshot
        .thread_activity
        .iter()
        .map(|activity| activity.thread_id.as_str())
        .collect();
    assert!(
        ids.contains(&"thread-active"),
        "active thread should be working"
    );
    assert!(
        ids.contains(&"thread-bg"),
        "backgrounded turn should be working"
    );
    assert!(
        ids.contains(&"thread-bg-phase-only"),
        "backgrounded active status without a turn id should still be working"
    );
    assert!(
        !ids.contains(&"thread-idle"),
        "idle backgrounded thread must not appear as working"
    );

    let active = snapshot
        .thread_activity
        .iter()
        .find(|activity| activity.thread_id == "thread-active")
        .expect("active thread activity present");
    assert_eq!(active.phase.as_deref(), Some("tool"));
    assert_eq!(active.tool.as_deref(), Some("Bash"));
}

#[test]
fn snapshot_thread_activity_empty_when_active_thread_idle() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );

    // No active turn and no progress phase => nothing is working.
    assert!(relay.snapshot().thread_activity.is_empty());
}

#[test]
fn snapshot_surfaces_failed_provider_with_reason_and_connected_provider() {
    use crate::protocol::ProviderStatusKind;
    let mut relay = test_state();
    relay.set_provider_status_base(vec![
        crate::provider::ProviderStatusBase {
            provider_key: "codex".to_string(),
            display_name: "Codex".to_string(),
            spawn_error: None,
        },
        crate::provider::ProviderStatusBase {
            provider_key: "claude_code".to_string(),
            display_name: "Claude Code".to_string(),
            spawn_error: Some(
                "failed to start `claude`: No such file or directory (os error 2)".to_string(),
            ),
        },
        crate::provider::ProviderStatusBase {
            provider_key: "fake".to_string(),
            display_name: "Fake".to_string(),
            spawn_error: Some("handshake rejected the session".to_string()),
        },
    ]);
    relay.set_provider_connection("codex", true);

    let statuses = relay.snapshot().provider_status;
    assert_eq!(statuses.len(), 3, "one row per configured provider");

    // Configured order is preserved.
    let codex = &statuses[0];
    assert_eq!(codex.provider, "codex");
    assert_eq!(codex.status, ProviderStatusKind::Connected);
    assert!(codex.connected);
    assert!(codex.reason.is_none());

    // ENOENT-shaped spawn error => NotInstalled, with the reason surfaced.
    let claude = &statuses[1];
    assert_eq!(claude.provider, "claude_code");
    assert_eq!(claude.status, ProviderStatusKind::NotInstalled);
    assert!(!claude.connected);
    assert!(claude.reason.is_some());

    // Any other spawn error => Failed (not NotInstalled).
    let fake = &statuses[2];
    assert_eq!(fake.provider, "fake");
    assert_eq!(fake.status, ProviderStatusKind::Failed);
    assert!(fake.reason.is_some());
}

#[test]
fn set_provider_connection_false_flips_provider_status_to_disconnected() {
    use crate::protocol::ProviderStatusKind;
    let mut relay = test_state();
    relay.set_provider_status_base(vec![crate::provider::ProviderStatusBase {
        provider_key: "codex".to_string(),
        display_name: "Codex".to_string(),
        spawn_error: None,
    }]);

    // Spawned but no connection signal yet => Starting.
    assert_eq!(
        relay.snapshot().provider_status[0].status,
        ProviderStatusKind::Starting
    );

    relay.set_provider_connection("codex", true);
    assert_eq!(
        relay.snapshot().provider_status[0].status,
        ProviderStatusKind::Connected
    );

    relay.set_provider_connection("codex", false);
    let row = &relay.snapshot().provider_status[0];
    assert_eq!(row.status, ProviderStatusKind::Disconnected);
    assert!(!row.connected);
}

#[test]
fn snapshot_exposes_private_security_mode_defaults() {
    let relay = test_state();
    let snapshot = relay.snapshot();

    assert_eq!(
        snapshot.security_mode,
        crate::protocol::SecurityMode::Private
    );
    assert!(!snapshot.broker_connected);
    assert_eq!(snapshot.broker_channel_id, None);
    assert_eq!(snapshot.broker_peer_id, None);
    assert!(snapshot.e2ee_enabled);
    assert!(!snapshot.broker_can_read_content);
    assert!(!snapshot.audit_enabled);
    assert!(snapshot.paired_devices.is_empty());
}

#[test]
fn passive_device_cannot_send_message_until_takeover() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );

    let error = relay
        .ensure_device_can_send_message("device-b")
        .expect_err("passive device should be blocked from sending");

    assert!(error.contains("another device currently has control"));

    assert!(relay.set_active_controller("device-b"));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("device-b")
    );
    assert!(relay.ensure_device_can_send_message("device-b").is_ok());
}

#[test]
fn approval_is_allowed_from_passive_owner_device() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay
        .pending_approvals
        .insert("req-1".to_string(), test_pending_approval("thread-1"));

    assert!(relay.can_device_approve("device-a"));
    assert!(relay.can_device_approve("device-b"));
    assert!(relay.ensure_device_can_approve("device-b").is_ok());
    assert!(!relay.can_device_send_message("device-b"));
}

#[test]
fn load_thread_data_sets_active_controller_on_resume() {
    let mut relay = test_state();
    relay.load_thread_data(
        ThreadSyncData {
            thread: test_thread("thread-9", "/tmp/project"),
            status: "running".to_string(),
            active_flags: vec!["busy".to_string()],
            transcript: Vec::new(),
        },
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        DEFAULT_MODEL,
        "phone-device",
    );

    assert_eq!(relay.active_thread_id.as_deref(), Some("thread-9"));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("phone-device")
    );
    // The read reports a working status ("running") but carries no live turn, and
    // there is no prior runtime to merge into — so this is a read-derived working
    // status with no liveness behind it. It settles to idle (see
    // ThreadRuntime::from_sync_data): a resume/switch-in must not resurrect a ghost
    // "working" thread. Real liveness re-asserts via the provider's turn/status events.
    assert_eq!(relay.current_status, "idle");
    assert_eq!(
        relay
            .thread_settings("thread-9")
            .expect("thread settings should be remembered"),
        ThreadSessionSettings::new(
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            DEFAULT_MODEL
        )
    );
}

#[test]
fn load_thread_data_preserves_pending_requests_from_other_threads() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay
        .pending_approvals
        .insert("req-1".to_string(), test_pending_approval("thread-1"));
    relay.pending_ask_user_questions.insert(
        "ask:1".to_string(),
        test_pending_ask_user_question("thread-1"),
    );

    relay.load_thread_data(
        ThreadSyncData {
            thread: test_thread("thread-2", "/tmp/project"),
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript: Vec::new(),
        },
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        DEFAULT_MODEL,
        "device-a",
    );

    assert!(relay.pending_approvals.contains_key("req-1"));
    assert!(relay.pending_ask_user_questions.contains_key("ask:1"));
}

#[test]
fn turn_going_idle_drops_that_threads_pending_user_requests() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    // The agent paused mid-turn to ask the user a question (and to request an
    // approval) — the thread is active and waiting on input.
    relay.add_pending_ask_user_question(test_pending_ask_user_question("thread-1"));
    relay.add_pending_approval(test_pending_approval("thread-1"));
    relay.set_thread_status(
        "thread-1",
        "active".to_string(),
        vec!["waitingOnAskUser".to_string()],
    );
    assert!(relay.pending_ask_user_questions.contains_key("ask:1"));
    assert!(relay.pending_approvals.contains_key("req-1"));

    // The turn ends without an answer (completed / cancelled / stopped / the
    // reviewer was cancelled) — the thread goes idle.
    relay.set_thread_status("thread-1", "idle".to_string(), Vec::new());

    // An idle thread has no live turn, so a lingering ask-user question or
    // approval is ORPHANED: there is nothing to consume an answer. It must be
    // dropped, otherwise the snapshot keeps surfacing it and the UI pins a
    // permanent "needs input" badge that can never resolve.
    assert!(
        !relay.pending_ask_user_questions.contains_key("ask:1"),
        "going idle must drop the thread's orphaned pending ask-user question"
    );
    assert!(
        relay.pending_approvals.is_empty(),
        "going idle must drop the thread's orphaned pending approval"
    );
}

#[test]
fn turn_going_idle_keeps_other_threads_pending_requests() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    // A DIFFERENT thread (thread-2) is mid-turn, genuinely waiting on the user.
    relay.add_pending_ask_user_question(test_pending_ask_user_question("thread-2"));
    relay.add_pending_approval(test_pending_approval("thread-2"));
    relay.set_thread_status(
        "thread-2",
        "active".to_string(),
        vec!["waitingOnAskUser".to_string()],
    );

    // thread-1 finishing its own turn must NOT disturb thread-2's live requests
    // (guards the per-thread `thread_id` filter in drop_pending_requests_for_thread).
    relay.set_thread_status("thread-1", "idle".to_string(), Vec::new());

    assert!(
        relay.pending_ask_user_questions.contains_key("ask:1"),
        "another thread going idle must not drop thread-2's pending ask-user question"
    );
    assert!(
        relay.pending_approvals.contains_key("req-1"),
        "another thread going idle must not drop thread-2's pending approval"
    );
}

#[test]
fn background_turn_going_idle_drops_its_orphaned_request() {
    let mut relay = test_state();
    // A backgrounded thread paused on an ask-user question, then its turn ends
    // via the background status path (bg_set_thread_status -> set_thread_status).
    relay.add_pending_ask_user_question(test_pending_ask_user_question("bg-thread"));
    relay.bg_set_thread_status(
        "bg-thread",
        "active".to_string(),
        vec!["waitingOnAskUser".to_string()],
        0,
    );
    assert!(relay.pending_ask_user_questions.contains_key("ask:1"));

    relay.bg_set_thread_status("bg-thread", "idle".to_string(), Vec::new(), 0);

    assert!(
        !relay.pending_ask_user_questions.contains_key("ask:1"),
        "a background thread going idle must drop its orphaned ask-user question"
    );
}

// SAFETY-CONTRACT guard for the Codex review-gate fix: classifying `unknown` as
// not-working (so it no longer freezes the review CTA) must NOT also make it drop a
// live pending approval. `unknown` is indeterminate, not settled — only the strict
// settled set (idle/viewing/empty) drops orphaned requests. This pins the decoupling
// between `thread_status_is_working` (liveness) and `thread_status_is_settled` (drop).
#[test]
fn unknown_status_keeps_pending_approval_yet_reads_as_not_working() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.add_pending_approval(test_pending_approval("thread-1"));
    relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
    assert!(relay.pending_approvals.contains_key("req-1"));

    // A stray refresh / malformed event reports an indeterminate status mid-turn.
    relay.set_thread_status("thread-1", "unknown".to_string(), Vec::new());
    assert!(
        relay.pending_approvals.contains_key("req-1"),
        "an indeterminate `unknown` status must NOT orphan-drop a live approval"
    );
    assert!(
        !relay.active_agent_is_working(),
        "`unknown` must read as not-working so the review CTA isn't frozen"
    );
}

// The review-gate liveness predicate (active_agent_is_working) must read Codex's
// settled/terminal vocabulary as idle, but a genuinely-working status with no turn
// id yet (the pre-turn-id window) must still read as working — preserving the
// C5-reverse semantics in runtime.rs so a review can't start on a live turn.
#[test]
fn active_agent_is_working_classifies_status_for_the_review_gate() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    for status in ["idle", "viewing", "completed", "unknown", ""] {
        relay.set_thread_status("thread-1", status.to_string(), Vec::new());
        assert!(
            !relay.active_agent_is_working(),
            "`{status}` must read as not-working (review allowed)"
        );
    }
    for status in ["active", "working", "running", "requires_action"] {
        relay.set_thread_status("thread-1", status.to_string(), Vec::new());
        assert!(
            relay.active_agent_is_working(),
            "`{status}` must read as working (review blocked)"
        );
    }
}

#[test]
fn clear_active_session_clears_selected_runtime_mirror() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.upsert_user_message(
        "user:1".to_string(),
        "hello".to_string(),
        "turn-1".to_string(),
    );
    assert_eq!(relay.snapshot().transcript.len(), 1);
    let reported_before = relay.snapshot().transcript_revision;

    relay.clear_active_session();

    let snapshot = relay.snapshot();
    assert!(snapshot.active_thread_id.is_none());
    assert!(snapshot.transcript.is_empty());
    // The empty transcript above is the cleared mirror. Its revision, though, may
    // not be reported below one already issued — the snapshot falls back to the
    // clock, not the cleared mirror. A snapshot is how a client repairs, and one
    // that moves backwards gets rejected.
    assert!(
        snapshot.transcript_revision >= reported_before,
        "clearing reported revision {} after {reported_before}",
        snapshot.transcript_revision
    );
}

#[test]
fn thread_switch_back_keeps_single_user_message_when_ids_agree() {
    // Regression for the reported "duplicate user message when Claude asks a
    // question" hydration bug.
    //
    // When Claude asks a question the turn stays in-flight, so users often
    // switch to another thread and come back. The relay keeps each thread's live
    // transcript in its own runtime; on switch-back load_thread_data merges a
    // fresh worker history read into that runtime, keyed by item_id.
    //
    // The bug was that the live send path used a relay-only id
    // (`user:claude-turn-N`) while the history read mapped the SAME message to
    // the SDK uuid (`user:<sdk-uuid>`), so the merge could not dedupe them and
    // pushed the live copy as a second entry. The fix makes both paths share one
    // uuid (claude.rs send_message + worker createUserTurn), so the id below is
    // identical in the live transcript and the history read, and the merge keeps
    // a single entry.
    let user_item_id = "user:7b3c1d04-1111-4222-8333-444455556666";
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );

    // Live turn: relay records the prompt under the canonical uuid id. turn_id
    // stays the per-turn counter; only the message identity is the uuid.
    relay.upsert_user_message(
        user_item_id.to_string(),
        "what should I name this?".to_string(),
        "claude-turn-1".to_string(),
    );

    // Switch away while the question is pending. thread-1's live transcript stays
    // in its per-thread runtime.
    relay.load_thread_data(
        ThreadSyncData {
            thread: test_thread("thread-2", "/tmp/project"),
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript: Vec::new(),
        },
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        DEFAULT_MODEL,
        "device-a",
    );

    // Switch back to thread-1. The fresh worker read reproduces the SAME id the
    // worker stamped onto the SDK message, so it matches the runtime live copy.
    relay.load_thread_data(
        ThreadSyncData {
            thread: test_thread("thread-1", "/tmp/project"),
            status: "active".to_string(),
            active_flags: vec!["waitingOnAskUser".to_string()],
            transcript: vec![TranscriptEntryView {
                item_id: Some(user_item_id.to_string()),
                kind: TranscriptEntryKind::UserText,
                text: Some("what should I name this?".to_string()),
                status: "completed".to_string(),
                turn_id: Some("7b3c1d04-1111-4222-8333-444455556666".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            }],
        },
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        DEFAULT_MODEL,
        "device-a",
    );

    let user_messages = relay
        .transcript
        .iter()
        .filter(|entry| {
            entry.kind == TranscriptEntryKind::UserText
                && entry.text.as_deref() == Some("what should I name this?")
        })
        .count();
    assert_eq!(
        user_messages, 1,
        "user message duplicated on switch-back: live id and history id diverged"
    );
}

#[test]
fn stale_controller_lease_expires_and_releases_session() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.active_controller_last_seen_at = Some(100);

    let expired = relay.expire_stale_controller(100 + CONTROLLER_LEASE_SECS);

    assert_eq!(expired.as_deref(), Some("device-a"));
    assert_eq!(relay.active_controller_device_id, None);
    assert_eq!(relay.active_controller_last_seen_at, None);
    assert!(relay.can_device_send_message("device-b"));
}

#[test]
fn active_controller_heartbeat_extends_lease() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.active_controller_last_seen_at = Some(100);

    assert!(relay.refresh_controller_lease("device-a", 112));
    assert_eq!(
        relay.controller_lease_expires_at(),
        Some(112 + CONTROLLER_LEASE_SECS)
    );
    assert_eq!(
        relay.expire_stale_controller(100 + CONTROLLER_LEASE_SECS),
        None
    );
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("device-a")
    );
}

#[test]
fn normalize_cwd_expands_home_directory() {
    let home = env::var("HOME").expect("HOME should be set for tests");
    let normalized = normalize_cwd("~/git/agent-relay");

    assert_eq!(
        normalized,
        PathBuf::from(home)
            .join("git/agent-relay")
            .display()
            .to_string()
    );
}

#[test]
fn normalize_allowed_roots_expands_home_and_deduplicates() {
    let home = env::var("HOME").expect("HOME should be set for tests");
    let unique = format!(
        "agent-relay-allowed-roots-{}-{}",
        std::process::id(),
        unix_now()
    );
    let root = PathBuf::from(home).join(unique);
    std::fs::create_dir_all(&root).expect("allowed root should be creatable");

    let normalized = normalize_allowed_roots(vec![
        format!("~/{}", root.file_name().unwrap().to_string_lossy()),
        root.display().to_string(),
        "  ".to_string(),
    ])
    .expect("allowed roots should normalize");

    assert_eq!(normalized, vec![root.display().to_string()]);

    std::fs::remove_dir_all(&root).expect("temp allowed root should be removable");
}

#[test]
fn ensure_path_within_allowed_roots_rejects_outside_workspace() {
    let unique = format!("agent-relay-roots-{}-{}", std::process::id(), unix_now());
    let root = std::env::temp_dir().join(unique);
    let nested = root.join("subdir");
    std::fs::create_dir_all(&nested).expect("workspace root should be creatable");
    let roots = normalize_allowed_roots(vec![root.display().to_string()])
        .expect("allowed roots should normalize");

    assert!(ensure_path_within_allowed_roots(&root.display().to_string(), &roots).is_ok());
    assert!(ensure_path_within_allowed_roots(&nested.display().to_string(), &roots).is_ok());
    assert!(ensure_path_within_allowed_roots("/tmp/other", &roots).is_err());

    std::fs::remove_dir_all(&root).expect("temp workspace root should be removable");
}

#[test]
fn normalize_cwd_collapses_parent_segments_for_missing_paths() {
    let unique = format!(
        "agent-relay-normalize-{}-{}",
        std::process::id(),
        unix_now()
    );
    let root = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(root.join("allowed")).expect("allowed root should be creatable");

    let escaped = root.join("allowed/../outside");
    let normalized = normalize_cwd(&escaped.display().to_string());
    let expected = root
        .canonicalize()
        .expect("temp root should canonicalize")
        .join("outside");

    assert_eq!(normalized, expected.display().to_string());

    std::fs::remove_dir_all(&root).expect("temp normalize directory should be removable");
}

#[test]
fn nearest_enumerated_root_picks_the_longest_containing_worktree() {
    let roots = ["/repo", "/repo/.claude/worktrees/feature"];
    assert_eq!(
        nearest_enumerated_root("/repo", &roots).as_deref(),
        Some("/repo")
    );
    assert_eq!(
        nearest_enumerated_root("/repo/src", &roots).as_deref(),
        Some("/repo")
    );
    assert_eq!(
        nearest_enumerated_root("/repo/.claude/worktrees/feature", &roots).as_deref(),
        Some("/repo/.claude/worktrees/feature")
    );
    assert_eq!(
        nearest_enumerated_root("/repo/.claude/worktrees/feature/src", &roots).as_deref(),
        Some("/repo/.claude/worktrees/feature")
    );
    assert_eq!(nearest_enumerated_root("/other", &roots), None);
    assert!(!matches!(
        nearest_enumerated_root("/repo", &roots).as_deref(),
        Some("/repo/.claude/worktrees/feature")
    ));
}

#[test]
fn ensure_path_within_allowed_roots_rejects_parent_dir_escape_for_missing_paths() {
    let unique = format!(
        "agent-relay-allowed-roots-{}-{}",
        std::process::id(),
        unix_now()
    );
    let root = std::env::temp_dir().join(unique);
    let allowed = root.join("allowed");
    std::fs::create_dir_all(&allowed).expect("allowed root should be creatable");

    let escaped = allowed.join("../outside");
    let roots = vec![allowed.display().to_string()];

    let error = ensure_path_within_allowed_roots(&escaped.display().to_string(), &roots)
        .expect_err("parent-dir traversal should be rejected");
    assert!(error.contains("outside this relay's allowed roots"));

    std::fs::remove_dir_all(&root).expect("temp allowed-roots directory should be removable");
}

#[test]
fn passive_device_cannot_refresh_another_devices_lease() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.active_controller_last_seen_at = Some(100);

    assert!(!relay.refresh_controller_lease("device-b", 112));
    assert_eq!(relay.active_controller_last_seen_at, Some(100));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("device-a")
    );
}

#[test]
fn require_device_id_rejects_empty_values() {
    assert_eq!(
        require_device_id(Some("   ".to_string())).unwrap_err(),
        "device_id is required"
    );
    assert_eq!(
        require_device_id(None).unwrap_err(),
        "device_id is required"
    );
    assert_eq!(
        require_device_id(Some("device-a".to_string())).unwrap(),
        "device-a"
    );
}

#[test]
fn persisted_state_round_trip_drops_ephemeral_fields() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.active_controller_last_seen_at = Some(99);
    relay.active_turn_id = Some("turn-ephemeral".to_string());
    relay.allowed_roots = vec!["/tmp/project".to_string()];
    relay.transcript.push(TranscriptRecord {
        item_id: "history-0".to_string(),
        kind: TranscriptEntryKind::AgentText,
        text: Some("hello".to_string()),
        status: "completed".to_string(),
        turn_id: Some("turn-1".to_string()),
        tool: None,
        seq: None,
    });
    relay
        .pending_approvals
        .insert("req-1".to_string(), test_pending_approval("thread-1"));
    relay.push_log("info", "runtime-only log");

    let persisted = PersistedRelayState::from_relay(&relay);
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/other".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);

    assert_eq!(restored.active_thread_id.as_deref(), Some("thread-1"));
    assert_eq!(
        restored.active_controller_device_id.as_deref(),
        Some("device-a")
    );
    assert_eq!(restored.active_controller_last_seen_at, Some(99));
    assert_eq!(restored.active_turn_id, None);
    assert_eq!(restored.pending_approvals.len(), 0);
    assert_eq!(restored.paired_devices.len(), 0);
    assert_eq!(restored.transcript.len(), 0);
    assert_eq!(restored.logs.len(), 1);
    // The point is that a restore resets the log to exactly the fresh boot line,
    // not what that line says — the copy is provider-neutral now that a relay
    // can be running only Cursor.
    assert_eq!(
        restored.logs[0].message,
        "Relay booted. Waiting for an agent provider."
    );
    assert_eq!(restored.allowed_roots, vec!["/tmp/project".to_string()]);
    assert_eq!(
        restored
            .thread_settings("thread-1")
            .expect("thread settings should persist"),
        ThreadSessionSettings::new(
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            DEFAULT_MODEL
        )
    );
}

#[test]
fn reviewer_thread_hiding_persists_across_restart() {
    let mut relay = test_state();
    // A reviewer thread is registered for a parent, but there is NO live review
    // job (e.g. it was evicted, or this is a fresh process restoring from disk).
    relay.register_reviewer_thread("reviewer-1".to_string(), "parent-1".to_string());
    assert!(relay.reviewer_thread_ids().contains("reviewer-1"));

    // Round-trip through the persisted snapshot into a fresh RelayState.
    let persisted = PersistedRelayState::from_relay(&relay);
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/other".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);

    // Hiding survives the restart even with no review jobs in memory.
    assert!(
        restored.reviewer_thread_ids().contains("reviewer-1"),
        "reviewer-thread hiding must persist across a restart"
    );
    assert_eq!(
        restored.reviewer_threads_of_parent("parent-1"),
        vec!["reviewer-1".to_string()]
    );
    // But it is NOT review-locked (no live job) — hiding is durable, freezing isn't.
    assert!(!restored.is_thread_review_locked("reviewer-1"));
    assert!(!restored.is_thread_review_locked("parent-1"));
}

#[test]
fn task_reviewer_navigation_visibility_persists_without_its_run() {
    let mut relay = test_state();
    let reviewer_id = "task-reviewer-1";
    let mut run = TeamRun::new(
        "task-run-1".to_string(),
        TaskSpec::default(),
        "/tmp/project/.worktrees/task".to_string(),
        "device-1".to_string(),
    );
    run.sub_tasks.push(relay_api::team::SubTask {
        reviewer_thread_id: Some(reviewer_id.to_string()),
        owned_thread_ids: vec![reviewer_id.to_string()],
        ..Default::default()
    });
    relay.insert_team_run(run);
    relay.register_task_reviewer_thread(reviewer_id.to_string(), "task-tl-1".to_string());

    assert!(relay.reviewer_thread_ids().contains(reviewer_id));
    assert!(!relay
        .navigation_hidden_reviewer_thread_ids()
        .contains(reviewer_id));

    relay.remove_team_run("task-run-1");
    assert!(
        !relay
            .navigation_hidden_reviewer_thread_ids()
            .contains(reviewer_id),
        "removing bounded task history must not re-hide its reviewer Session"
    );

    let persisted = PersistedRelayState::from_relay(&relay);
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/other".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);
    assert!(
        !restored
            .navigation_hidden_reviewer_thread_ids()
            .contains(reviewer_id),
        "task reviewer visibility must survive restart even after the run record is gone"
    );
}

#[test]
fn restore_migrates_legacy_task_reviewer_visibility_from_run_ownership() {
    let mut relay = test_state();
    let reviewer_id = "legacy-task-reviewer";
    let explicitly_hidden_id = "current-session-reviewer";
    let pruned_legacy_id = "pruned-legacy-reviewer";
    // Build both durable reviewer identities, then erase only the legacy record's
    // origin marker below to model a pre-field snapshot.
    relay.register_reviewer_thread(reviewer_id.to_string(), "task-tl-1".to_string());
    relay.register_reviewer_thread(
        explicitly_hidden_id.to_string(),
        "foreground-session".to_string(),
    );
    relay.register_reviewer_thread(
        pruned_legacy_id.to_string(),
        "already-pruned-task-tl".to_string(),
    );
    let mut run = TeamRun::new(
        "legacy-task-run".to_string(),
        TaskSpec::default(),
        "/tmp/project/.worktrees/task".to_string(),
        "device-1".to_string(),
    );
    run.sub_tasks.push(relay_api::team::SubTask {
        reviewer_thread_id: Some(reviewer_id.to_string()),
        // Include an explicitly hidden current record too: migration may infer only
        // the legacy `None`, never override a present `false`.
        owned_thread_ids: vec![reviewer_id.to_string(), explicitly_hidden_id.to_string()],
        ..Default::default()
    });
    relay.insert_team_run(run);

    let mut persisted = PersistedRelayState::from_relay(&relay);
    persisted
        .reviewer_threads
        .get_mut(reviewer_id)
        .expect("legacy reviewer persisted")
        .navigation_visible = None;
    persisted
        .reviewer_threads
        .get_mut(pruned_legacy_id)
        .expect("pruned legacy reviewer persisted")
        .navigation_visible = None;
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/other".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);
    assert!(
        !restored
            .navigation_hidden_reviewer_thread_ids()
            .contains(reviewer_id),
        "restore must preserve task-reviewer visibility from pre-flag snapshots"
    );
    assert!(
        restored
            .navigation_hidden_reviewer_thread_ids()
            .contains(explicitly_hidden_id),
        "migration must not expose a current Session-bound reviewer"
    );
    assert!(
        restored
            .navigation_hidden_reviewer_thread_ids()
            .contains(pruned_legacy_id),
        "a legacy reviewer whose task run was already pruned has no durable evidence of task origin and intentionally remains hidden"
    );
}

#[test]
fn terminal_review_cards_persist_across_restart_but_in_progress_ones_do_not() {
    let mut relay = test_state();

    // A finished (terminal) review card the user wants to keep.
    let mut done = ReviewJob::new(
        "job-done".to_string(),
        "parent-1".to_string(),
        "codex".to_string(),
        "codex".to_string(),
        None,
        ReviewMode::CleanThread,
        "/tmp/project".to_string(),
        "device-1".to_string(),
        None,
        1,
    );
    done.reviewer_thread_id = Some("rev-done".to_string());
    done.review_text = Some("looks good".to_string());
    done.set_status(ReviewJobStatus::Complete);
    relay.insert_review_job(done);

    // An in-flight review whose orchestrator would die with the process.
    let mut live = ReviewJob::new(
        "job-live".to_string(),
        "parent-2".to_string(),
        "codex".to_string(),
        "codex".to_string(),
        None,
        ReviewMode::CleanThread,
        "/tmp/project".to_string(),
        "device-1".to_string(),
        None,
        1,
    );
    live.reviewer_thread_id = Some("rev-live".to_string());
    live.set_status(ReviewJobStatus::WaitingForReviewer);
    relay.insert_review_job(live);

    // The snapshot keeps ONLY the terminal card.
    let persisted = PersistedRelayState::from_relay(&relay);
    assert!(
        persisted.review_jobs.contains_key("job-done"),
        "a completed review card must be persisted"
    );
    assert!(
        !persisted.review_jobs.contains_key("job-live"),
        "an in-progress review must NOT be persisted (its orchestrator dies on restart)"
    );

    // Restore into a fresh process.
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/other".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);

    let card = restored
        .review_job("job-done")
        .expect("terminal card restored");
    assert_eq!(card.status, ReviewJobStatus::Complete);
    assert_eq!(card.review_text.as_deref(), Some("looks good"));
    assert_eq!(card.reviewer_thread_id.as_deref(), Some("rev-done"));
    assert!(
        restored.review_job("job-live").is_none(),
        "the in-progress job must not come back after a restart"
    );
    // A restored terminal card never re-locks its parent/reviewer (terminal = unlocked).
    assert!(!restored.is_thread_review_locked("parent-1"));
    assert!(!restored.is_thread_review_locked("rev-done"));
}

#[test]
fn restore_drops_a_non_terminal_review_job_from_a_corrupt_or_future_snapshot() {
    // Defense-in-depth: the writer only persists terminal jobs, but the restore side
    // re-applies the same filter so a non-terminal job that somehow reaches the snapshot
    // (a hand-edited/corrupt file, or a future build that persists in-progress jobs) is
    // dropped — never restored as a parent-locking job with no orchestrator to release it.
    let mut relay = test_state();
    let mut done = ReviewJob::new(
        "job-done".to_string(),
        "parent-done".to_string(),
        "codex".to_string(),
        "codex".to_string(),
        None,
        ReviewMode::CleanThread,
        "/tmp/project".to_string(),
        "device-1".to_string(),
        None,
        1,
    );
    done.set_status(ReviewJobStatus::Complete);
    relay.insert_review_job(done);

    // Start from a valid snapshot, then inject an in-progress job the writer would never
    // produce, simulating a corrupt/future-build state file on the read path.
    let mut persisted = PersistedRelayState::from_relay(&relay);
    let mut live = ReviewJob::new(
        "job-live".to_string(),
        "parent-live".to_string(),
        "codex".to_string(),
        "codex".to_string(),
        None,
        ReviewMode::CleanThread,
        "/tmp/project".to_string(),
        "device-1".to_string(),
        None,
        1,
    );
    live.reviewer_thread_id = Some("rev-live".to_string());
    live.set_status(ReviewJobStatus::WaitingForReviewer);
    persisted.review_jobs.insert("job-live".to_string(), live);

    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/other".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);

    assert!(
        restored.review_job("job-done").is_some(),
        "the terminal card is still restored"
    );
    assert!(
        restored.review_job("job-live").is_none(),
        "a non-terminal job in the snapshot must be dropped on restore"
    );
    assert!(
        !restored.is_thread_review_locked("parent-live"),
        "a dropped in-progress job must not re-lock its parent"
    );
}

#[test]
fn review_jobs_view_shows_one_card_per_reviewer_thread_keeping_the_latest() {
    // Design: one reviewer thread → one card (the latest run). Reusing a reviewer across
    // several reviews must collapse to a single card in the snapshot, not accumulate one
    // per run.
    let mut relay = test_state();
    let mk = |id: &str, reviewer: &str, updated: u64| {
        let mut job = ReviewJob::new(
            id.to_string(),
            "parent-1".to_string(),
            "codex".to_string(),
            "codex".to_string(),
            None,
            ReviewMode::CleanThread,
            "/tmp/project".to_string(),
            "device-1".to_string(),
            None,
            1,
        );
        job.reviewer_thread_id = Some(reviewer.to_string());
        job.set_status(ReviewJobStatus::Complete);
        job.updated_at = updated;
        job
    };
    relay.insert_review_job(mk("job-old", "rev-shared", 100));
    relay.insert_review_job(mk("job-new", "rev-shared", 200));
    relay.insert_review_job(mk("job-other", "rev-other", 150));

    let view = relay.active_review_jobs_view();
    let ids: Vec<&str> = view.iter().map(|v| v.id.as_str()).collect();
    assert_eq!(view.len(), 2, "one card per reviewer thread, got {ids:?}");
    assert_eq!(
        ids,
        vec!["job-new", "job-other"],
        "review cards should show recently used reviewers first"
    );
    assert!(
        ids.contains(&"job-new"),
        "the latest run for the shared reviewer is shown"
    );
    assert!(
        !ids.contains(&"job-old"),
        "the older run for the shared reviewer is hidden"
    );
    assert!(
        ids.contains(&"job-other"),
        "a different reviewer thread keeps its own card"
    );
}

#[test]
fn review_jobs_view_keeps_an_in_progress_run_visible_over_a_same_second_terminal_run() {
    // The deduped view backs the Stop / in-progress affordances, so a live (non-terminal)
    // run must never be hidden behind a just-completed one for the same reviewer — even
    // when both share the same whole-second updated_at (unix_now is seconds).
    let mut relay = test_state();
    let mk = |id: &str, status: ReviewJobStatus, updated: u64| {
        let mut job = ReviewJob::new(
            id.to_string(),
            "parent-1".to_string(),
            "codex".to_string(),
            "codex".to_string(),
            None,
            ReviewMode::CleanThread,
            "/tmp/project".to_string(),
            "device-1".to_string(),
            None,
            1,
        );
        job.reviewer_thread_id = Some("rev-shared".to_string());
        job.set_status(status);
        job.updated_at = updated;
        job
    };
    relay.insert_review_job(mk("job-done", ReviewJobStatus::Complete, 500));
    relay.insert_review_job(mk("job-live", ReviewJobStatus::WaitingForReviewer, 500));

    let view = relay.active_review_jobs_view();
    assert_eq!(view.len(), 1, "still one card per reviewer thread");
    assert_eq!(
        view[0].id, "job-live",
        "the in-progress run must be the visible card on a same-second tie"
    );
    let activity = relay.review_activity_view();
    assert_eq!(activity.len(), 1);
    assert_eq!(activity[0].id, "job-live");
    assert_eq!(activity[0].parent_thread_id, "parent-1");
}

#[test]
fn drop_terminal_review_jobs_for_reviewer_keeps_an_in_progress_run() {
    // delete_review uses this: it clears a reviewer's finished run-cards but must never
    // delete a concurrently-started in-progress job (which would orphan its orchestrator
    // and unlock its threads mid-turn).
    let mut relay = test_state();
    let mk = |id: &str, reviewer: &str, status: ReviewJobStatus| {
        let mut job = ReviewJob::new(
            id.to_string(),
            "parent-1".to_string(),
            "codex".to_string(),
            "codex".to_string(),
            None,
            ReviewMode::CleanThread,
            "/tmp/project".to_string(),
            "device-1".to_string(),
            None,
            1,
        );
        job.reviewer_thread_id = Some(reviewer.to_string());
        job.set_status(status);
        job
    };
    relay.insert_review_job(mk("done-1", "rev-x", ReviewJobStatus::Complete));
    relay.insert_review_job(mk("live-1", "rev-x", ReviewJobStatus::WaitingForReviewer));
    relay.insert_review_job(mk("done-other", "rev-y", ReviewJobStatus::Complete));

    relay.drop_terminal_review_jobs_for_reviewer("rev-x");

    assert!(
        relay.review_job("done-1").is_none(),
        "the finished run for rev-x is dropped"
    );
    assert!(
        relay.review_job("live-1").is_some(),
        "a concurrent in-progress run for rev-x is kept"
    );
    assert!(
        relay.review_job("done-other").is_some(),
        "a different reviewer's job is untouched"
    );
}

#[test]
fn persist_skips_pending_claude_reviewer_ids() {
    let mut relay = test_state();
    // A real (promoted) reviewer id alongside a synthetic Claude pending id. The
    // pending id only exists in memory — it has no real SDK session — so persisting
    // it would leave a ghost hiding entry that never resolves after a restart.
    relay.register_reviewer_thread("reviewer-real".to_string(), "parent-1".to_string());
    relay.register_reviewer_thread("claude-pending-abc".to_string(), "parent-2".to_string());

    let persisted = PersistedRelayState::from_relay(&relay);
    assert!(
        persisted.reviewer_threads.contains_key("reviewer-real"),
        "the real reviewer id is persisted"
    );
    assert!(
        !persisted
            .reviewer_threads
            .contains_key("claude-pending-abc"),
        "synthetic claude-pending reviewer ids must be dropped from the snapshot"
    );

    // Restoring keeps the real one hidden and never resurrects the pending ghost.
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/other".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);
    assert!(restored.reviewer_thread_ids().contains("reviewer-real"));
    assert!(!restored
        .reviewer_thread_ids()
        .contains("claude-pending-abc"));
}

#[test]
fn reviewer_thread_views_enrich_provider_and_label_from_summary() {
    let mut relay = test_state();
    // A reviewer thread whose summary is known in-process (its row is cached).
    let mut summary = test_thread("reviewer-1", "/tmp/project");
    summary.name = Some("Codex reviewer".to_string());
    summary.updated_at = 99;
    summary.provider = "codex".to_string();
    relay.upsert_thread(summary);
    relay.register_reviewer_thread("reviewer-1".to_string(), "parent-1".to_string());

    let views = relay.reviewer_thread_views();
    let view = views
        .iter()
        .find(|v| v.reviewer_thread_id == "reviewer-1")
        .expect("reviewer-1 view");
    assert_eq!(view.parent_thread_id, "parent-1");
    assert_eq!(view.reviewer_provider.as_deref(), Some("codex"));
    assert_eq!(view.name.as_deref(), Some("Codex reviewer"));
    assert_eq!(view.updated_at, Some(99));

    // A reviewer with NO in-process summary (e.g. after a restart, where only the
    // durable id→parent map survives) degrades to None — the picker still offers it
    // and the backend re-derives the provider on submit.
    relay.register_reviewer_thread("reviewer-ghost".to_string(), "parent-1".to_string());
    let views = relay.reviewer_thread_views();
    let ghost = views
        .iter()
        .find(|v| v.reviewer_thread_id == "reviewer-ghost")
        .expect("ghost view");
    assert_eq!(ghost.reviewer_provider, None);
    assert_eq!(ghost.name, None);
    assert_eq!(ghost.updated_at, None);
}

#[test]
fn visible_task_reviewers_have_an_independent_lifecycle_and_no_reuse_picker_entry() {
    let mut relay = test_state();
    let parent = "task-tl";
    relay.register_reviewer_thread("bound-reviewer".to_string(), parent.to_string());
    relay.register_task_reviewer_thread("task-reviewer".to_string(), parent.to_string());

    assert_eq!(
        relay.reviewer_threads_of_parent(parent),
        vec!["bound-reviewer".to_string()],
        "parent delete/reuse fan-out includes only the hidden implementation child"
    );
    let picker_ids: Vec<_> = relay
        .reviewer_thread_views()
        .into_iter()
        .map(|view| view.reviewer_thread_id)
        .collect();
    assert_eq!(
        picker_ids,
        vec!["bound-reviewer".to_string()],
        "a task reviewer already visible in Sessions must not also appear in the reuse picker"
    );
}

// The reuse picker exists to offer reviewer threads `request_review` will actually
// accept — and it refuses any reviewer that is not in the tree under review ("that
// reviewer thread works in X, but the work to review is in Y — start a clean reviewer
// instead"). A reviewer's tree is NOT a property of its parent: an author that moves
// into a worktree mid-session leaves reviewers behind in both trees, and only one of
// them is reusable at any moment.
//
// So the candidate list has to say which tree each reviewer is bound to. Without it no
// client can filter, and the picker keeps offering options that are guaranteed to be
// refused — which is exactly what the reported "start a clean reviewer instead" dead end
// looks like from the outside.
//
// Asserted on the SERIALIZED payload on purpose: the picker is a client, and all it can
// filter on is what crosses the wire.
#[test]
fn reviewer_reuse_candidates_carry_the_working_tree_they_are_bound_to() {
    let mut relay = test_state();
    relay.upsert_thread(test_thread("reviewer-main", "/tmp/project"));
    relay.register_reviewer_thread("reviewer-main".to_string(), "parent-1".to_string());
    relay.upsert_thread(test_thread(
        "reviewer-worktree",
        "/tmp/project/.claude/worktrees/feature",
    ));
    relay.register_reviewer_thread("reviewer-worktree".to_string(), "parent-1".to_string());

    let wire = serde_json::to_value(relay.reviewer_thread_views()).expect("views serialize");
    let tree_of = |reviewer: &str| -> Option<String> {
        wire.as_array()
            .expect("a list of candidates")
            .iter()
            .find(|view| view["reviewer_thread_id"] == reviewer)
            .unwrap_or_else(|| panic!("{reviewer} should be offered as a candidate"))
            .get("cwd")
            .and_then(|cwd| cwd.as_str())
            .map(str::to_string)
    };

    assert_eq!(
        tree_of("reviewer-main").as_deref(),
        Some("/tmp/project"),
        "a reuse candidate must name its own working tree, or a client cannot tell which \
reviewers a review would refuse as cross-tree: {wire}"
    );
    assert_eq!(
        tree_of("reviewer-worktree").as_deref(),
        Some("/tmp/project/.claude/worktrees/feature"),
        "two reviewers of the SAME parent can sit in different trees; the payload has to \
tell them apart: {wire}"
    );
}

#[test]
fn reviewers_to_evict_returns_oldest_beyond_cap() {
    let mut relay = test_state();
    // Six reviewers of parent-1, registered in order → strictly increasing seq, so
    // FIFO order is registration order even though they share a wall-clock second.
    for index in 1..=6u64 {
        relay.register_reviewer_thread(format!("rev-{index}"), "parent-1".to_string());
    }
    // A reviewer of a different parent is never considered.
    relay.register_reviewer_thread("rev-other".to_string(), "parent-2".to_string());

    // Keep 5 → evict the single oldest (the first registered).
    assert_eq!(
        relay.reviewers_to_evict("parent-1", 5),
        vec!["rev-1".to_string()]
    );
    // A parent under the cap evicts nothing.
    assert!(relay.reviewers_to_evict("parent-2", 5).is_empty());
    // A lower cap evicts the oldest first, in registration order.
    assert_eq!(
        relay.reviewers_to_evict("parent-1", 3),
        vec![
            "rev-1".to_string(),
            "rev-2".to_string(),
            "rev-3".to_string()
        ]
    );
    assert!(relay.reviewers_to_evict("parent-1", 6).is_empty());
}

#[test]
fn reviewer_fifo_cap_never_counts_or_evicts_visible_task_reviewers() {
    let mut relay = test_state();
    let parent = "task-tl";
    for index in 1..=6 {
        relay.register_task_reviewer_thread(format!("task-rev-{index}"), parent.to_string());
    }
    for index in 1..=5 {
        relay.register_reviewer_thread(format!("bound-rev-{index}"), parent.to_string());
    }
    assert!(
        relay.reviewers_to_evict(parent, 5).is_empty(),
        "six task seats do not consume the foreground reviewer's five-row cap"
    );

    relay.register_reviewer_thread("bound-rev-6".to_string(), parent.to_string());
    assert_eq!(
        relay.reviewers_to_evict(parent, 5),
        vec!["bound-rev-1".to_string()],
        "only the oldest nav-hidden foreground reviewer is evicted"
    );
}

#[test]
fn reviewers_to_evict_protects_active_review_reviewer() {
    let mut relay = test_state();
    for index in 1..=6u64 {
        relay.register_reviewer_thread(format!("rev-{index}"), "parent-1".to_string());
    }
    // The OLDEST reviewer (rev-1) is bound to a non-terminal review job.
    let mut job = ReviewJob::new(
        "job-1".to_string(),
        "parent-1".to_string(),
        "codex".to_string(),
        "codex".to_string(),
        None,
        ReviewMode::CleanThread,
        "/tmp/project".to_string(),
        "device-1".to_string(),
        None,
        1,
    );
    job.reviewer_thread_id = Some("rev-1".to_string());
    relay.insert_review_job(job);

    // rev-1 is the oldest but protected → the next-oldest (rev-2) is evicted instead.
    assert_eq!(
        relay.reviewers_to_evict("parent-1", 5),
        vec!["rev-2".to_string()]
    );
}

#[test]
fn reviewers_to_evict_protects_active_workflow_reviewer() {
    let mut relay = test_state();
    for index in 1..=6u64 {
        relay.register_reviewer_thread(format!("rev-{index}"), "parent-1".to_string());
    }

    let mut active = WorkflowRun::new(
        "workflow-active".to_string(),
        "code_flow".to_string(),
        "parent-1".to_string(),
        "anchor".to_string(),
        "/tmp/project".to_string(),
        "device-1".to_string(),
    );
    active.set_status(RunStatus::Running);
    active
        .step_threads
        .insert("review".to_string(), "rev-1".to_string());
    relay.insert_workflow_run(active);

    assert_eq!(
        relay.reviewers_to_evict("parent-1", 5),
        vec!["rev-2".to_string()],
        "active workflow reviewer is protected, so the next-oldest evicts"
    );

    let mut terminal = WorkflowRun::new(
        "workflow-terminal".to_string(),
        "code_flow".to_string(),
        "parent-1".to_string(),
        "anchor".to_string(),
        "/tmp/project".to_string(),
        "device-1".to_string(),
    );
    terminal.set_status(RunStatus::Done);
    terminal
        .step_threads
        .insert("review".to_string(), "rev-2".to_string());
    relay.insert_workflow_run(terminal);

    assert_eq!(
        relay.reviewers_to_evict("parent-1", 5),
        vec!["rev-2".to_string()],
        "terminal workflow reviewers are eligible for bounded cleanup"
    );
}

#[test]
fn reviewer_thread_seq_resumes_past_restored_max() {
    let mut relay = test_state();
    relay.register_reviewer_thread("rev-1".to_string(), "parent-1".to_string());
    relay.register_reviewer_thread("rev-2".to_string(), "parent-1".to_string());

    // Round-trip the {parent, seq} form through the persisted snapshot.
    let persisted = PersistedRelayState::from_relay(&relay);
    let json = serde_json::to_string(&persisted).expect("serialize");
    let decoded: PersistedRelayState = serde_json::from_str(&json).expect("decode");
    let seq_1 = decoded.reviewer_threads.get("rev-1").expect("rev-1").seq;
    let seq_2 = decoded.reviewer_threads.get("rev-2").expect("rev-2").seq;
    assert!(seq_2 > seq_1, "registration seq is strictly increasing");

    // After restoring, a newly registered reviewer must sort AFTER the restored ones
    // (the counter resumes past the largest restored seq) — so FIFO order survives a
    // restart and an old reviewer is still evicted before a post-restart one.
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new("/tmp/x".to_string(), change_tx, SecurityProfile::private());
    restored.apply_persisted(&persisted);
    restored.register_reviewer_thread("rev-3".to_string(), "parent-1".to_string());
    assert_eq!(
        restored.reviewers_to_evict("parent-1", 2),
        vec!["rev-1".to_string()],
        "the pre-restart oldest is evicted before the post-restart reviewer"
    );
}

#[test]
fn parse_verdict_reads_the_trailing_verdict_line() {
    // Approve only from an explicit APPROVE keyword.
    assert_eq!(
        parse_verdict("findings...\n\nVERDICT: APPROVE"),
        Verdict::Approve
    );
    assert_eq!(
        parse_verdict("VERDICT: needs_changes"),
        Verdict::NeedsChanges
    );
    assert_eq!(
        parse_verdict("VERDICT: needs changes"),
        Verdict::NeedsChanges
    );
    assert_eq!(parse_verdict("blah\nverdict: Unsure\n"), Verdict::Unsure);
    // The LAST verdict line wins.
    assert_eq!(
        parse_verdict("VERDICT: NEEDS_CHANGES\nmore\nVERDICT: APPROVE"),
        Verdict::Approve
    );
    // Tolerates trailing words.
    assert_eq!(
        parse_verdict("VERDICT: approve — ship it"),
        Verdict::Approve
    );
    // Missing / garbled → Unknown, and never reads as approved.
    assert_eq!(parse_verdict("no verdict at all"), Verdict::Unknown);
    assert_eq!(parse_verdict("VERDICT: maybe"), Verdict::Unknown);
    assert!(!parse_verdict("VERDICT: maybe").is_approved());
    assert!(!parse_verdict("looks fine to me").is_approved());

    // NEGATED verdicts must never read as approve (only the LEADING keyword counts).
    assert_eq!(parse_verdict("VERDICT: NOT APPROVED"), Verdict::Unknown);
    assert!(!parse_verdict("VERDICT: NOT APPROVED").is_approved());
    assert_eq!(
        parse_verdict("VERDICT: NEEDS_CHANGES — not approved"),
        Verdict::NeedsChanges
    );
    // A hedged approval ("APPROVE?") is not a clean approve.
    assert_eq!(parse_verdict("VERDICT: APPROVE?"), Verdict::Unknown);
    assert!(!parse_verdict("VERDICT: APPROVE?").is_approved());
    // A buried "approved" after a non-approve keyword is ignored.
    assert!(!parse_verdict("VERDICT: unsure, but could be approved later").is_approved());
}

#[test]
fn restore_thread_data_keeps_persisted_controller_and_settings() {
    let mut relay = test_state();
    relay
        .pending_approvals
        .insert("req-1".to_string(), test_pending_approval("thread-1"));

    let mut persisted = test_persisted_state();
    persisted.thread_settings.insert(
        "thread-1".to_string(),
        ThreadSessionSettings::new("bypass", "danger-full-access", "high", DEFAULT_MODEL),
    );
    relay.restore_thread_data(
        ThreadSyncData {
            thread: test_thread("thread-1", "/tmp/project"),
            status: "running".to_string(),
            active_flags: vec!["busy".to_string()],
            transcript: vec![TranscriptEntryView {
                item_id: Some("history-1".to_string()),
                kind: TranscriptEntryKind::UserText,
                text: Some("ping".to_string()),
                status: "completed".to_string(),
                turn_id: Some("turn-2".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            }],
        },
        &persisted,
    );

    assert_eq!(relay.active_thread_id.as_deref(), Some("thread-1"));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("device-a")
    );
    assert_eq!(relay.active_controller_last_seen_at, Some(123));
    assert_eq!(relay.model, DEFAULT_MODEL);
    assert_eq!(relay.approval_policy, "bypass");
    assert_eq!(relay.sandbox, "danger-full-access");
    assert_eq!(relay.reasoning_effort, "high");
    assert_eq!(relay.paired_devices.len(), 1);
    assert_eq!(relay.pending_approvals.len(), 0);
    assert_eq!(relay.transcript.len(), 1);
    assert_eq!(relay.transcript[0].text.as_deref(), Some("ping"));
}

#[test]
fn pairing_ticket_registers_remote_device_and_persists_payload_secret() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let (device, token) = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            &ticket.pairing_secret,
            Some("My Phone".to_string()),
            Some("Primary Phone".to_string()),
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-a",
            100,
        )
        .expect("pairing should succeed");

    assert_eq!(device.device_id, "my-phone");
    assert_eq!(device.label, "Primary Phone");
    assert_eq!(relay.pending_pairings.len(), 0);
    assert_eq!(relay.paired_devices.len(), 1);

    assert_eq!(
        relay
            .paired_device_payload_secret(&device.device_id)
            .expect("payload secret should persist"),
        token
    );
    relay
        .mark_paired_device_seen(&device.device_id, "surface-b", 101)
        .expect("device should remain paired");
    assert_eq!(
        relay
            .paired_devices
            .get("my-phone")
            .and_then(|device| device.last_peer_id.as_deref()),
        Some("surface-b")
    );
}

#[test]
fn claim_challenge_keeps_payload_secret_stable_and_invalidates_old_challenge() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let (device, payload_secret) = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            &ticket.pairing_secret,
            Some("My Phone".to_string()),
            Some("Primary Phone".to_string()),
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-a",
            100,
        )
        .expect("pairing should succeed");

    let challenge = relay
        .issue_claim_challenge(&device.device_id, "surface-a", 101)
        .expect("challenge should issue");
    relay
        .complete_remote_claim(&device.device_id, &challenge.challenge_id, "surface-a", 102)
        .expect("claim should complete");
    assert_eq!(
        relay
            .paired_device_payload_secret(&device.device_id)
            .expect("payload secret should remain available"),
        payload_secret
    );
    let reused = relay
        .claim_challenge(&device.device_id, &challenge.challenge_id, "surface-a", 104)
        .expect_err("claim challenges should be one-time use");
    assert!(reused.contains("missing or expired"));
}

#[test]
fn broker_targets_require_online_surface_presence() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let (device, payload_secret) = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            &ticket.pairing_secret,
            Some("My Phone".to_string()),
            Some("Primary Phone".to_string()),
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-a",
            100,
        )
        .expect("pairing should succeed");

    assert!(relay.broker_targets().is_empty());

    assert!(relay.mark_surface_peer_online("surface-a"));
    assert_eq!(
        relay.broker_targets(),
        vec![(
            device.device_id.clone(),
            "surface-a".to_string(),
            payload_secret.clone(),
        )]
    );

    relay
        .mark_paired_device_seen(&device.device_id, "surface-b", 101)
        .expect("device should remain paired");
    assert_eq!(
        relay.broker_targets(),
        vec![(
            device.device_id.clone(),
            "surface-a".to_string(),
            payload_secret.clone(),
        )]
    );

    assert!(relay.mark_surface_peer_online("surface-b"));
    let mut targets = relay.broker_targets();
    targets.sort();
    assert_eq!(
        targets,
        vec![
            (
                device.device_id.clone(),
                "surface-a".to_string(),
                payload_secret.clone(),
            ),
            (
                device.device_id.clone(),
                "surface-b".to_string(),
                payload_secret.clone(),
            ),
        ]
    );

    assert!(relay.mark_surface_peer_offline("surface-b"));
    assert_eq!(
        relay.broker_targets(),
        vec![(device.device_id, "surface-a".to_string(), payload_secret,)]
    );
}

#[test]
fn broker_disconnect_clears_online_surface_targets() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let (device, payload_secret) = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            &ticket.pairing_secret,
            Some("My Phone".to_string()),
            Some("Primary Phone".to_string()),
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-a",
            100,
        )
        .expect("pairing should succeed");

    relay.set_broker_connection(true);
    relay.mark_surface_peer_online("surface-a");
    assert_eq!(
        relay.broker_targets(),
        vec![(device.device_id, "surface-a".to_string(), payload_secret,)]
    );

    relay.set_broker_connection(false);
    assert!(relay.broker_targets().is_empty());
}

#[test]
fn replacing_online_surface_peers_restores_targets_for_reconnected_broker_sessions() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let (device, payload_secret) = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            &ticket.pairing_secret,
            Some("My Phone".to_string()),
            Some("Primary Phone".to_string()),
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-a",
            100,
        )
        .expect("pairing should succeed");

    relay.set_broker_connection(true);
    relay.replace_online_surface_peers(["surface-a".to_string()]);
    assert_eq!(
        relay.broker_targets(),
        vec![(
            device.device_id.clone(),
            "surface-a".to_string(),
            payload_secret.clone(),
        )]
    );

    relay.set_broker_connection(false);
    assert!(relay.broker_targets().is_empty());

    relay.set_broker_connection(true);
    relay
        .mark_paired_device_seen(&device.device_id, "surface-b", 101)
        .unwrap();
    relay.replace_online_surface_peers(["surface-b".to_string()]);
    assert_eq!(
        relay.broker_targets(),
        vec![(device.device_id, "surface-b".to_string(), payload_secret,)]
    );
}

#[test]
fn claim_challenge_enforces_peer_binding_and_replaces_older_challenges() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let (device, _token) = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            &ticket.pairing_secret,
            Some("My Phone".to_string()),
            Some("Primary Phone".to_string()),
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-a",
            100,
        )
        .expect("pairing should succeed");

    let first = relay
        .issue_claim_challenge(&device.device_id, "surface-a", 101)
        .expect("first challenge should issue");
    let second = relay
        .issue_claim_challenge(&device.device_id, "surface-a", 102)
        .expect("second challenge should issue");

    let replaced = relay
        .claim_challenge(&device.device_id, &first.challenge_id, "surface-a", 103)
        .expect_err("issuing a new challenge should invalidate the older one");
    assert!(replaced.contains("missing or expired"));

    let wrong_peer = relay
        .claim_challenge(&device.device_id, &second.challenge_id, "surface-b", 103)
        .expect_err("challenge should stay bound to the broker peer");
    assert!(wrong_peer.contains("broker peer"));

    let expired = relay
        .claim_challenge(
            &device.device_id,
            &second.challenge_id,
            "surface-a",
            102 + 61,
        )
        .expect_err("challenge should expire quickly");
    assert!(expired.contains("missing or expired"));
}

#[test]
fn paired_device_requires_a_verify_key() {
    let mut relay = test_state();
    relay.paired_devices.insert(
        "phone-1".to_string(),
        PairedDevice {
            device_id: "phone-1".to_string(),
            label: "Primary Phone".to_string(),
            payload_secret: "payload-secret".to_string(),
            device_verify_key: String::new(),
            created_at: 7,
            last_seen_at: Some(9),
            last_peer_id: Some("surface-1".to_string()),
            broker_join_ticket_expires_at: None,
            path_scope: Vec::new(),
        },
    );

    let error = relay
        .paired_device_verify_key("phone-1")
        .expect_err("empty verify key should be rejected");
    assert!(error.contains("re-pair"));
}

#[test]
fn pairing_ticket_includes_scannable_broker_link() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "wss://relay.example.com",
        "room-a",
        "relay-a",
        Some(60),
    );

    // SECURITY: the payload carries the pairing_secret, which is the ONLY key
    // sealing the pairing handshake — the envelope that ships payload_secret and
    // the refresh tokens. It must ride in the URL fragment, never the query: the
    // broker serves this very page, so a query string puts the secret in its
    // request line (and in any proxy/CDN access log in front of it), letting the
    // broker decrypt a handshake that `private` mode promises it cannot read.
    // Fragments are never sent to the server.
    assert!(
        ticket
            .pairing_url
            .starts_with("https://relay.example.com/#pairing="),
        "pairing payload must ride in the fragment, got {}",
        ticket.pairing_url
    );
    assert!(
        !ticket.pairing_url.contains("?pairing="),
        "pairing payload must never appear in the query string, got {}",
        ticket.pairing_url
    );
    assert!(ticket.pairing_qr_svg.contains("<svg"));

    let encoded = ticket
        .pairing_url
        .split("pairing=")
        .nth(1)
        .expect("pairing url should include pairing param");
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .expect("pairing payload should decode");
    let payload: serde_json::Value =
        serde_json::from_slice(&decoded).expect("pairing payload should be valid json");

    assert_eq!(payload["pairing_id"], ticket.pairing_id);
    assert_eq!(payload["pairing_secret"], ticket.pairing_secret);
    assert_eq!(payload["broker_url"], "wss://relay.example.com");
    assert_eq!(payload["pairing_join_ticket"], ticket.pairing_join_ticket);
}

#[test]
fn pairing_rejects_invalid_secret_and_mints_a_fresh_payload_secret() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let error = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            "wrong-secret",
            Some("phone-2".to_string()),
            None,
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-a",
            100,
        )
        .expect_err("invalid pairing secret should fail");
    assert!(error.contains("invalid"));

    let replacement = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );
    let (device, token) = relay
        .consume_pairing_ticket(
            &replacement.pairing_id,
            &replacement.pairing_secret,
            Some("phone-2".to_string()),
            None,
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-a",
            100,
        )
        .expect("replacement ticket should pair");
    assert_eq!(
        relay
            .paired_device_payload_secret(&device.device_id)
            .expect("payload secret should exist"),
        token
    );
    assert_ne!(token, "bad-token");
}

#[test]
fn restore_prunes_orphaned_push_subscriptions() {
    let mut relay = test_state();
    let mut persisted = test_persisted_state();
    // An orphaned subscription whose device is NOT in persisted.paired_devices —
    // e.g. a state file written before revoke-time pruning existed.
    persisted.push_subscriptions.insert(
        "orphan-device".to_string(),
        vec![crate::state::PushSubscription {
            endpoint: "https://push.example.com/x".to_string(),
            p256dh: "p".to_string(),
            auth: "a".to_string(),
            device_id: "orphan-device".to_string(),
            created_at: 0,
        }],
    );
    relay.apply_persisted(&persisted);
    assert!(
        !relay.push_subscriptions.contains_key("orphan-device"),
        "an orphaned persisted subscription must be pruned from state on restore"
    );
}

#[test]
fn push_subscriptions_vec_excludes_unpaired_devices() {
    let mut relay = test_state();
    relay.push_subscriptions.insert(
        "ghost-device".to_string(),
        vec![crate::state::PushSubscription {
            endpoint: "https://push.example.com/y".to_string(),
            p256dh: "p".to_string(),
            auth: "a".to_string(),
            device_id: "ghost-device".to_string(),
            created_at: 0,
        }],
    );
    // ghost-device is not paired, so the dispatcher must not see its subscription.
    assert!(
        relay.push_subscriptions_vec().is_empty(),
        "push_subscriptions_vec must exclude subscriptions for unpaired devices"
    );
}

#[test]
fn revoking_paired_device_prunes_its_push_subscriptions() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );
    let (device, _token) = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            &ticket.pairing_secret,
            Some("tablet".to_string()),
            Some("Tablet".to_string()),
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-tablet",
            100,
        )
        .expect("pairing should succeed");

    relay.push_subscriptions.insert(
        device.device_id.clone(),
        vec![crate::state::PushSubscription {
            endpoint: "https://push.example.com/abc".to_string(),
            p256dh: "p".to_string(),
            auth: "a".to_string(),
            device_id: device.device_id.clone(),
            created_at: 0,
        }],
    );
    assert!(!relay.push_subscriptions_vec().is_empty());

    assert!(relay.revoke_paired_device(&device.device_id, 101));
    assert!(
        relay.push_subscriptions_vec().is_empty(),
        "revoking a device must prune its push subscriptions"
    );
}

#[test]
fn revoking_paired_device_removes_it() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );
    let (device, _token) = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            &ticket.pairing_secret,
            Some("tablet".to_string()),
            Some("Tablet".to_string()),
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-tablet",
            100,
        )
        .expect("pairing should succeed");

    assert!(relay.revoke_paired_device(&device.device_id, 101));
    assert!(!relay.revoke_paired_device(&device.device_id, 102));
    assert!(relay.paired_devices.is_empty());

    let devices = relay.devices_response();
    let record = devices
        .device_records
        .iter()
        .find(|record| record.device_id == device.device_id)
        .expect("revoked device record should remain visible");
    assert_eq!(record.lifecycle_state, DeviceLifecycleState::Revoked);
    assert_eq!(record.last_peer_id.as_deref(), Some("surface-tablet"));
}

#[test]
fn remove_thread_removes_non_active_thread_from_local_history() {
    let mut relay = test_state();
    relay.threads = vec![
        test_thread("thread-1", "/tmp/project"),
        test_thread("thread-2", "/tmp/project"),
    ];
    relay.active_thread_id = Some("thread-1".to_string());
    relay.remember_thread_settings(
        "thread-2",
        "bypass",
        "danger-full-access",
        "high",
        DEFAULT_MODEL,
    );

    let removed = relay.remove_thread("thread-2");

    assert!(removed);
    assert_eq!(relay.threads.len(), 1);
    assert_eq!(relay.threads[0].id, "thread-1");
    assert_eq!(relay.active_thread_id.as_deref(), Some("thread-1"));
    assert!(relay.thread_settings("thread-2").is_none());
}

#[test]
fn mark_thread_deleted_clears_settings_and_runtime() {
    let mut relay = test_state();
    relay.threads = vec![
        test_thread("thread-1", "/tmp/project"),
        test_thread("thread-2", "/tmp/project"),
    ];
    relay.active_thread_id = Some("thread-1".to_string());
    relay.remember_thread_settings(
        "thread-2",
        "bypass",
        "danger-full-access",
        "high",
        DEFAULT_MODEL,
    );
    relay.bg_upsert_user_message(
        "thread-2",
        "item-1".to_string(),
        "hello".to_string(),
        "turn-1".to_string(),
        0,
    );
    assert!(relay.thread_settings("thread-2").is_some());
    assert!(relay.runtime_for_thread("thread-2").is_some());
    // The bg transcript write above went through the bump chokepoint, so the
    // honest sort key is now tracked for this thread.
    assert!(relay.thread_last_activity_at.contains_key("thread-2"));
    relay
        .pending_approvals
        .insert("req-1".to_string(), test_pending_approval("thread-2"));
    relay.pending_ask_user_questions.insert(
        "ask:1".to_string(),
        test_pending_ask_user_question("thread-2"),
    );

    relay.mark_thread_deleted("thread-2");

    assert!(relay.thread_settings("thread-2").is_none());
    assert!(relay.runtime_for_thread("thread-2").is_none());
    // Persisted per-thread state must not leak past a delete (the map is
    // serialized on every save).
    assert!(!relay.thread_last_activity_at.contains_key("thread-2"));
    assert!(relay.pending_approvals.is_empty());
    assert!(relay.pending_ask_user_questions.is_empty());
    let filtered = relay.filter_deleted_threads(vec![test_thread("thread-2", "/tmp/project")]);
    assert!(filtered.is_empty());
    assert_eq!(relay.threads.len(), 1);
    assert_eq!(relay.threads[0].id, "thread-1");
}

#[test]
fn has_working_thread_in_cwd_ignores_reviewer_and_deleted_threads() {
    let mut relay = test_state();
    let cwd = "/tmp/project";

    // A working TASK REVIEWER is nav-visible but still a read-only semantic reviewer —
    // it can't mutate the workspace, so it must NOT block a new review request.
    // ("working" = a genuine in-flight turn; a bare phase is not liveness, see
    // is_working().)
    relay.register_task_reviewer_thread("reviewer-1".to_string(), "parent-1".to_string());
    {
        let rt = relay.ensure_runtime_for_thread("reviewer-1");
        rt.current_cwd = cwd.to_string();
        rt.active_turn_id = Some("rev-turn".to_string());
    }
    assert!(
        !relay.has_working_thread_in_cwd(cwd),
        "a working reviewer thread must not gate a review request"
    );

    // A normal user thread working in the cwd DOES gate it (it could mutate files).
    {
        let rt = relay.ensure_runtime_for_thread("user-1");
        rt.current_cwd = cwd.to_string();
        rt.active_turn_id = Some("user-turn".to_string());
    }
    assert!(
        relay.has_working_thread_in_cwd(cwd),
        "a working user thread blocks a review (it could mutate the workspace)"
    );

    // Deleting the user thread tombstones it + drops its runtime. A stray late event can
    // resurrect the runtime — but a deleted thread must never block a review again.
    relay.mark_thread_deleted("user-1");
    assert!(
        !relay.has_working_thread_in_cwd(cwd),
        "deleting the working thread unblocks reviews"
    );
    {
        let rt = relay.ensure_runtime_for_thread("user-1");
        rt.current_cwd = cwd.to_string();
        rt.active_turn_id = Some("user-turn-2".to_string());
    }
    assert!(
        !relay.has_working_thread_in_cwd(cwd),
        "a deleted thread's resurrected runtime must not gate a review"
    );
}

// C5 ghost cleanup: a worker that dies mid-turn never emits a terminal event, so
// its threads would keep a ghost active_turn_id forever (is_working() == true,
// blocking reviews in that cwd). fail_in_flight_turns_for_provider settles them on
// disconnect — and must touch ONLY that provider's threads, not another provider's
// genuinely-running turn. (This is where the "idle + stale turn" ghost is killed,
// NOT in merge_fresh_history, which is no longer authoritative about turn liveness.)
#[test]
fn worker_disconnect_fails_in_flight_turns_for_that_provider_only() {
    let mut relay = test_state();

    let mut claude_summary = test_thread("claude-1", "/tmp/project");
    claude_summary.provider = "claude_code".to_string();
    relay.upsert_thread(claude_summary.clone());
    let mut codex_summary = test_thread("codex-1", "/tmp/project");
    codex_summary.provider = "codex".to_string();
    relay.upsert_thread(codex_summary.clone());

    // Both threads are running a turn in the background; give each runtime its
    // provider summary so the per-provider filter can tell them apart.
    relay.bg_set_active_turn("claude-1", Some("turn-claude".to_string()), 0);
    relay.bg_set_active_turn("codex-1", Some("turn-codex".to_string()), 0);
    relay.ensure_runtime_for_thread("claude-1").summary = Some(claude_summary);
    relay.ensure_runtime_for_thread("codex-1").summary = Some(codex_summary);
    assert!(relay.runtime_for_thread("claude-1").unwrap().is_working());
    assert!(relay.runtime_for_thread("codex-1").unwrap().is_working());

    // The Claude worker dies.
    relay.fail_in_flight_turns_for_provider("claude_code");

    assert!(
        !relay.runtime_for_thread("claude-1").unwrap().is_working(),
        "the dead worker's in-flight turn is settled to idle (no ghost is_working)"
    );
    assert_eq!(
        relay.runtime_for_thread("claude-1").unwrap().active_turn_id,
        None
    );
    assert!(
        relay.runtime_for_thread("codex-1").unwrap().is_working(),
        "another provider's running turn must be untouched by a Claude disconnect"
    );
}

#[test]
fn completed_background_turn_clears_phase_so_the_thread_is_not_stuck_working() {
    // Repro: a review's recap runs on the parent in the BACKGROUND (the user switched
    // their active thread away after requesting). When the recap turn completes, the
    // provider event loops (codex/rpc.rs, claude.rs, fake_provider.rs) all run the same
    // background "done" sequence — bg_set_active_turn(None) + bg_set_thread_status(idle) —
    // but neither clears current_phase (the ACTIVE path clears it via clear_progress()).
    // So current_phase lingers, is_working() stays true forever, and the orchestrator's
    // recap-wait never sees the parent idle → the reviewer thread NEVER starts (the review
    // is stuck at waiting_for_parent_recap).
    let mut relay = test_state();
    relay.active_thread_id = Some("active-thread".to_string());

    // Background thread runs a turn: provider seeds the active turn + a "thinking" phase.
    relay.bg_set_active_turn("bg-thread", Some("turn-1".to_string()), 0);
    relay.touch_thread_progress("bg-thread", Some("thinking"), None);
    assert!(
        relay.runtime_for_thread("bg-thread").unwrap().is_working(),
        "the background thread is working mid-turn"
    );

    // The turn completes — exactly what the codex/claude/fake background `done` arms do.
    relay.bg_set_active_turn("bg-thread", None, 0);
    relay.bg_set_thread_status("bg-thread", "idle".to_string(), Vec::new(), 0);

    assert!(
        !relay.runtime_for_thread("bg-thread").unwrap().is_working(),
        "a completed background turn must clear its phase; otherwise is_working() stays \
         true and a review's recap-wait on this parent never starts the reviewer"
    );
}

#[test]
fn a_stale_phase_without_a_turn_is_not_working_and_does_not_block_reviews() {
    // Repro (live-confirmed): a thread runs a tool while ACTIVE (current_phase set via the
    // active-relative touch_progress), then the user switches the active thread away. Its
    // turn ends — status goes idle and active_turn_id clears — but the stale current_phase
    // is never cleared (phase is only refreshed for the active thread). is_working() used
    // to count current_phase, so the thread stayed "working" forever, and
    // has_working_thread_in_cwd falsely rejected every new review in that workspace with
    // "another thread is running" until the relay was restarted.
    let mut relay = test_state();
    let cwd = "/tmp/project";
    relay.active_thread_id = Some("other-active".to_string());
    {
        let rt = relay.ensure_runtime_for_thread("bg-1");
        rt.current_cwd = cwd.to_string();
        rt.active_turn_id = None; // the turn is over
        rt.current_status = "idle".to_string(); // the provider says idle
        rt.current_phase = Some("thinking".to_string()); // ...but a stale phase lingered
        rt.current_tool = None;
    }
    assert!(
        !relay.runtime_for_thread("bg-1").unwrap().is_working(),
        "phase is a descriptive label, not liveness: an idle thread with no in-flight turn \
         must not be 'working' just because a phase lingered"
    );
    assert!(
        !relay.has_working_thread_in_cwd(cwd),
        "a stale phase must not falsely block reviews in the workspace"
    );
}

#[test]
fn stale_turn_liveness_times_out_without_discarding_the_provider_turn_id() {
    let mut relay = test_state();
    let thread_id = "stale-turn";
    let cwd = "/tmp/project";
    relay.active_thread_id = Some(thread_id.to_string());
    {
        let runtime = relay.ensure_runtime_for_thread(thread_id);
        runtime.current_cwd = cwd.to_string();
    }
    relay.bg_set_active_turn(thread_id, Some("turn-1".to_string()), 100);
    relay.bg_set_thread_status(thread_id, "active".to_string(), Vec::new(), 100);

    assert!(relay.has_working_thread_in_cwd(cwd));
    assert!(relay
        .expire_stale_turn_liveness(100 + STALE_TURN_PROGRESS_TIMEOUT_SECS - 1)
        .is_empty());

    assert_eq!(
        relay.expire_stale_turn_liveness(100 + STALE_TURN_PROGRESS_TIMEOUT_SECS),
        vec![thread_id.to_string()]
    );
    let runtime = relay.runtime_for_thread(thread_id).unwrap();
    assert_eq!(runtime.active_turn_id.as_deref(), Some("turn-1"));
    assert!(runtime.liveness_timed_out);
    assert!(runtime.has_live_turn());
    assert!(runtime.is_working());
    assert!(relay.has_working_thread_in_cwd(cwd));
    assert_eq!(
        relay.stale_turn_stop_candidates(),
        vec![(thread_id.to_string(), "turn-1".to_string())]
    );

    let snapshot = relay.snapshot();
    assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-1"));
    assert_eq!(snapshot.current_status, "idle");
    assert_eq!(snapshot.thread_activity.len(), 1);
}

#[test]
fn background_provider_output_refreshes_turn_liveness() {
    let mut relay = test_state();
    let thread_id = "background-output";
    let started_at = 100;
    let progress_at = started_at + STALE_TURN_PROGRESS_TIMEOUT_SECS - 1;

    relay.active_thread_id = Some("other-thread".to_string());
    relay.bg_set_active_turn(thread_id, Some("turn-1".to_string()), started_at);
    relay.bg_start_agent_message(
        thread_id,
        "assistant-1".to_string(),
        "turn-1".to_string(),
        progress_at,
    );

    assert!(
        relay
            .expire_stale_turn_liveness(started_at + STALE_TURN_PROGRESS_TIMEOUT_SECS)
            .is_empty(),
        "recent output from a background provider turn must prevent the watchdog from \
         treating that turn as stale"
    );
    assert_eq!(
        relay
            .runtime_for_thread(thread_id)
            .and_then(|runtime| runtime.last_progress_at),
        Some(progress_at)
    );
}

#[test]
fn provider_progress_revives_a_turn_after_liveness_timeout() {
    let mut relay = test_state();
    let thread_id = "revived-turn";
    relay.active_thread_id = Some(thread_id.to_string());
    relay.bg_set_active_turn(thread_id, Some("turn-1".to_string()), 100);
    assert_eq!(
        relay.expire_stale_turn_liveness(100 + STALE_TURN_PROGRESS_TIMEOUT_SECS),
        vec![thread_id.to_string()]
    );

    relay.touch_thread_progress(thread_id, Some("thinking"), None);

    let runtime = relay.runtime_for_thread(thread_id).unwrap();
    assert_eq!(runtime.active_turn_id.as_deref(), Some("turn-1"));
    assert!(runtime.has_live_turn());
    assert!(runtime.is_working());
    assert_eq!(runtime.current_phase.as_deref(), Some("thinking"));
}

#[test]
fn going_idle_clears_a_threads_stale_phase() {
    // Defense in depth for the bug above: when a thread's status transitions to a
    // not-working value, drop its phase/tool so phase stays consistent with status (and
    // the activity badge can't show a ghost "thinking"/"tool"). A still-working status
    // must keep the phase.
    let mut relay = test_state();
    relay.active_thread_id = Some("other".to_string());
    {
        let rt = relay.ensure_runtime_for_thread("bg-1");
        rt.current_phase = Some("tool".to_string());
        rt.current_tool = Some("Bash".to_string());
    }
    relay.set_thread_status("bg-1", "idle".to_string(), Vec::new());
    {
        let rt = relay.runtime_for_thread("bg-1").unwrap();
        assert_eq!(
            rt.current_phase, None,
            "idle status must clear the stale phase"
        );
        assert_eq!(
            rt.current_tool, None,
            "idle status must clear the stale tool"
        );
    }
    // A working status must NOT clear the phase (it's a live turn's label).
    relay.touch_thread_progress("bg-1", Some("thinking"), None);
    relay.set_thread_status("bg-1", "active".to_string(), Vec::new());
    assert_eq!(
        relay
            .runtime_for_thread("bg-1")
            .unwrap()
            .current_phase
            .as_deref(),
        Some("thinking"),
        "a working status must keep the live phase"
    );
}

#[test]
fn deleted_thread_is_not_resurrected_by_late_background_events() {
    // SR3 repro: deleting a thread tombstones it + drops its runtime, but a stray late
    // provider event (dispatch routes background events to the bg_* handlers) used to flow
    // into ensure_runtime_for_thread's or_insert_with and RE-CREATE the runtime — a ghost
    // "working" thread that blocks reviews / shows in the activity view until restart.
    let mut relay = test_state();
    relay.active_thread_id = Some("active".to_string());

    // The thread is live (has a runtime), then the user deletes it.
    relay.bg_set_thread_status("ghost", "active".to_string(), Vec::new(), 0);
    assert!(relay.runtime_for_thread("ghost").is_some());
    relay.mark_thread_deleted("ghost");
    assert!(
        relay.runtime_for_thread("ghost").is_none(),
        "delete removes the runtime + tombstones the id"
    );

    // Late events for the deleted thread arrive (turn-in-flight on the provider, queued
    // events, etc.) — they must be dropped, not resurrect the thread.
    relay.bg_set_active_turn("ghost", Some("turn-9".to_string()), 0);
    relay.bg_set_thread_status("ghost", "active".to_string(), Vec::new(), 0);
    relay.bg_append_agent_delta("ghost", "item-1", "hi", "turn-9", 0);

    assert!(
        relay.runtime_for_thread("ghost").is_none(),
        "a late background event must not resurrect a deleted thread's runtime"
    );
}

#[test]
fn ensure_runtime_for_thread_does_not_create_a_ghost_working_runtime() {
    let mut relay = test_state();

    // (a) A list/read summary reporting a working status, materialized lazily with no
    // live turn, must not become a ghost is_working() runtime. upsert_thread keeps the
    // raw "active" on the self.threads display row; ensure_runtime_for_thread must
    // settle the runtime it creates from that summary.
    let mut working = test_thread("listed", "/tmp/project");
    working.status = "active".to_string();
    relay.upsert_thread(working);
    {
        let rt = relay.ensure_runtime_for_thread("listed");
        assert!(rt.active_turn_id.is_none());
        assert!(
            !rt.is_working(),
            "a read-derived working summary status with no turn must not be a ghost"
        );
    }

    // (b) No summary at all: ThreadRuntime::placeholder defaults current_status to
    // "active", so the materialized runtime would be working without ever having a turn.
    let rt = relay.ensure_runtime_for_thread("unlisted");
    assert!(
        !rt.is_working(),
        "the placeholder 'active' default must not surface as a ghost working runtime"
    );
}

#[test]
fn a_lazily_rebuilt_runtime_keeps_the_threads_own_settings() {
    // Seeding a rebuilt background runtime from the session mirror hands its next
    // turn whatever the user last chatted with — another provider's model, even.
    let mut relay = test_state();
    let mut tl = test_thread("tl-1", "/tmp/project");
    tl.provider = "claude_code".to_string();
    tl.source = "claude_code".to_string();
    relay.register_background_thread(
        tl,
        "/tmp/project",
        "opus[1m]",
        "on-request",
        "workspace-write",
        "xhigh",
    );

    // The user chats in a Cursor session; the mirror follows that thread instead.
    relay.model = "default[]".to_string();
    relay.reasoning_effort = "none".to_string();
    relay.approval_policy = "never".to_string();
    relay.sandbox = "danger-full-access".to_string();

    // A REAL restart, not just a dropped runtime: persist, then load into a fresh
    // relay. `runtimes` is not persisted and `thread_settings` is — that asymmetry
    // is the whole reason a rebuilt runtime has to look the settings up.
    let persisted = PersistedRelayState::from_relay(&relay);
    let mut relay = test_state();
    relay.model = "default[]".to_string();
    relay.reasoning_effort = "none".to_string();
    relay.approval_policy = "never".to_string();
    relay.sandbox = "danger-full-access".to_string();
    relay.apply_persisted(&persisted);
    assert!(
        !relay.runtimes.contains_key("tl-1"),
        "a restart must not carry runtimes over, or this proves nothing"
    );

    let rebuilt = relay.ensure_runtime_for_thread("tl-1");
    assert_eq!(
        rebuilt.model, "opus[1m]",
        "a rebuilt background runtime must keep its own model, not the session's"
    );
    assert_eq!(
        rebuilt.reasoning_effort, "xhigh",
        "and its own effort — an effort the session's model does not accept is a hard error"
    );
    assert_eq!(rebuilt.approval_policy, "on-request");
    assert_eq!(rebuilt.sandbox, "workspace-write");
}

#[test]
fn a_rebuilt_runtime_with_nothing_remembered_still_falls_back_to_the_session() {
    // No remembered settings: the session mirror is all there is, and it is better
    // than an empty model that no provider can resolve.
    let mut relay = test_state();
    relay.model = "gpt-5-codex".to_string();
    relay.reasoning_effort = "medium".to_string();
    relay.approval_policy = "on-request".to_string();
    relay.sandbox = "workspace-write".to_string();

    let rt = relay.ensure_runtime_for_thread("never-seen");
    assert_eq!(rt.model, "gpt-5-codex");
    assert_eq!(rt.reasoning_effort, "medium");
    assert_eq!(rt.approval_policy, "on-request");
    assert_eq!(rt.sandbox, "workspace-write");
}

#[test]
fn active_idle_thread_can_be_archived() {
    let mut relay = test_state();
    relay.threads = vec![test_thread("thread-1", "/tmp/project")];
    relay.active_thread_id = Some("thread-1".to_string());
    relay.active_turn_id = None;

    let is_active = relay
        .can_archive_thread("thread-1")
        .expect("idle active thread should be archivable");
    let removed = relay.remove_thread("thread-1");

    assert!(is_active);
    assert!(removed);
    assert!(relay.threads.is_empty());
}

#[test]
fn active_running_thread_cannot_be_archived() {
    let mut relay = test_state();
    relay.threads = vec![test_thread("thread-1", "/tmp/project")];
    relay.active_thread_id = Some("thread-1".to_string());
    relay.active_turn_id = Some("turn-1".to_string());

    let error = relay
        .can_archive_thread("thread-1")
        .expect_err("running active thread should not be archivable");

    // The `cannot archive` prefix is what the HTTP handler keys its 400-vs-502
    // split on, so it is part of the contract rather than prose.
    assert!(
        error.starts_with("cannot archive"),
        "the refusal must stay classifiable as a bad request, got: {error}"
    );
    assert!(error.contains("still running"));
    // Every provider reaches this guard, so naming one would tell most users
    // their session is held by an agent they are not running.
    assert!(
        !error.contains("Codex"),
        "the refusal must not name one vendor, got: {error}"
    );
    assert_eq!(relay.threads.len(), 1);
    assert_eq!(relay.threads[0].id, "thread-1");
}

#[test]
fn active_idle_thread_can_be_deleted() {
    let mut relay = test_state();
    relay.threads = vec![test_thread("thread-1", "/tmp/project")];
    relay.active_thread_id = Some("thread-1".to_string());
    relay.active_turn_id = None;

    let is_active = relay
        .can_delete_thread("thread-1")
        .expect("idle active thread should be deletable");
    let removed = relay.remove_thread("thread-1");

    assert!(is_active);
    assert!(removed);
    assert!(relay.threads.is_empty());
}

#[test]
fn active_running_thread_cannot_be_deleted() {
    let mut relay = test_state();
    relay.threads = vec![test_thread("thread-1", "/tmp/project")];
    relay.active_thread_id = Some("thread-1".to_string());
    relay.active_turn_id = Some("turn-1".to_string());

    let error = relay
        .can_delete_thread("thread-1")
        .expect_err("running active thread should not be deletable");

    // Same contract as the archive guard above: the prefix drives the status
    // code, and the message must not name a vendor every provider is not.
    assert!(
        error.starts_with("cannot permanently delete"),
        "the refusal must stay classifiable as a bad request, got: {error}"
    );
    assert!(error.contains("still running"));
    assert!(
        !error.contains("Codex"),
        "the refusal must not name one vendor, got: {error}"
    );
    assert_eq!(relay.threads.len(), 1);
    assert_eq!(relay.threads[0].id, "thread-1");
}

#[test]
fn filter_deleted_threads_hides_locally_purged_threads() {
    let mut relay = test_state();
    relay.mark_thread_deleted("thread-deleted");

    let filtered = relay.filter_deleted_threads(vec![
        test_thread("thread-keep", "/tmp/project"),
        test_thread("thread-deleted", "/tmp/project"),
    ]);

    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].id, "thread-keep");
}

#[tokio::test]
async fn persistence_store_round_trips_to_disk() {
    let unique = format!(
        "agent-relay-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos()
    );
    let directory = std::env::temp_dir().join(unique);
    let path = directory.join("session.json");
    let store = PersistenceStore::from_path(path.clone());
    let persisted = test_persisted_state();

    store.save(&persisted).await.expect("state should save");
    let saved_json: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(&path)
            .await
            .expect("saved state file should read"),
    )
    .expect("saved state should be valid json");
    assert!(
        saved_json.get("transcript").is_none(),
        "transcript is provider/cache data and should not be persisted in session.json"
    );
    assert!(
        saved_json.get("logs").is_none(),
        "logs are runtime UI cache and should not be persisted in session.json"
    );

    let loaded = store
        .load()
        .await
        .expect("state should load")
        .expect("state should exist");

    assert_eq!(loaded.active_thread_id, persisted.active_thread_id);
    assert_eq!(
        loaded.active_controller_device_id,
        persisted.active_controller_device_id
    );
    assert_eq!(
        loaded
            .thread_settings
            .get("thread-1")
            .expect("thread settings should load"),
        &ThreadSessionSettings::new(
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            DEFAULT_MODEL
        )
    );

    tokio::fs::remove_dir_all(&directory)
        .await
        .expect("temp persisted state directory should be removable");
}

#[tokio::test]
async fn persistence_store_loads_legacy_state_without_thread_settings() {
    let unique = format!(
        "agent-relay-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos()
    );
    let directory = std::env::temp_dir().join(unique);
    let path = directory.join("session.json");
    let store = PersistenceStore::from_path(path.clone());

    tokio::fs::create_dir_all(&directory)
        .await
        .expect("temp persisted state directory should exist");
    tokio::fs::write(
        &path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": PERSISTED_STATE_VERSION,
            "active_thread_id": "thread-legacy",
            "active_controller_device_id": null,
            "active_controller_last_seen_at": null,
            "current_status": "idle",
            "active_flags": [],
            "current_cwd": "/tmp/project",
            "model": DEFAULT_MODEL,
            "approval_policy": "bypass",
            "sandbox": "danger-full-access",
            "reasoning_effort": "high",
            "allowed_roots": [],
            "device_records": {},
            "paired_devices": {},
            "transcript": [],
            "logs": []
        }))
        .expect("json should serialize"),
    )
    .await
    .expect("legacy state file should write");

    let loaded = store
        .load()
        .await
        .expect("legacy state should load")
        .expect("state should exist");

    assert!(loaded.thread_settings.is_empty());

    let (change_tx, _) = watch::channel(0_u64);
    let mut relay = RelayState::new(
        "/tmp/other".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    relay.apply_persisted(&loaded);

    assert_eq!(relay.active_thread_id.as_deref(), Some("thread-legacy"));
    assert_eq!(
        relay
            .thread_settings("thread-legacy")
            .expect("legacy active thread should be backfilled"),
        ThreadSessionSettings::new("bypass", "danger-full-access", "high", DEFAULT_MODEL)
    );

    tokio::fs::remove_dir_all(&directory)
        .await
        .expect("temp persisted state directory should be removable");
}

#[tokio::test]
async fn persistence_store_rejects_old_schema_version() {
    let unique = format!(
        "agent-relay-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos()
    );
    let directory = std::env::temp_dir().join(unique);
    let path = directory.join("session.json");
    let store = PersistenceStore::from_path(path.clone());

    tokio::fs::create_dir_all(&directory)
        .await
        .expect("temp persisted state directory should exist");
    tokio::fs::write(
        &path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "active_thread_id": null,
            "active_controller_device_id": null,
            "active_controller_last_seen_at": null,
            "current_status": "idle",
            "active_flags": [],
            "current_cwd": "/tmp/project",
            "model": DEFAULT_MODEL,
            "approval_policy": DEFAULT_APPROVAL_POLICY,
            "sandbox": DEFAULT_SANDBOX,
            "reasoning_effort": DEFAULT_EFFORT,
            "allowed_roots": [],
            "device_records": {},
            "paired_devices": {},
            "transcript": [],
            "logs": []
        }))
        .expect("json should serialize"),
    )
    .await
    .expect("old state file should write");

    let error = store
        .load()
        .await
        .expect_err("old schema version should be rejected");

    assert!(error.contains("unsupported persisted state version: 1"));

    tokio::fs::remove_dir_all(&directory)
        .await
        .expect("temp persisted state directory should be removable");
}

#[test]
fn pairing_request_waits_for_local_approval_before_device_is_created() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let request = relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-approve".to_string()),
            Some("Approve Phone".to_string()),
            "surface-a",
            "verify-key-1".to_string(),
            100,
        )
        .expect("pairing request should register");

    assert_eq!(request.device_id, "phone-approve");
    assert_eq!(relay.paired_devices.len(), 0);
    assert_eq!(relay.pending_pairing_requests.len(), 1);

    let result = relay
        .decide_pairing_request(&ticket.pairing_id, true, None, 101)
        .expect("approval should complete pairing");

    assert_eq!(relay.pending_pairing_requests.len(), 0);
    assert_eq!(relay.pending_pairings.len(), 0);
    assert_eq!(relay.paired_devices.len(), 1);
    assert_eq!(result.target_peer_id, "surface-a");
    assert!(result.payload_secret.is_some());
    assert_eq!(
        result
            .device
            .as_ref()
            .map(|device| device.device_id.as_str()),
        Some("phone-approve")
    );
}

#[test]
fn rejecting_pairing_request_returns_error_without_creating_device() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-reject".to_string()),
            Some("Reject Phone".to_string()),
            "surface-b",
            "verify-key-2".to_string(),
            100,
        )
        .expect("pairing request should register");

    let result = relay
        .decide_pairing_request(&ticket.pairing_id, false, None, 101)
        .expect("rejection should succeed");

    assert_eq!(relay.pending_pairing_requests.len(), 0);
    assert_eq!(relay.pending_pairings.len(), 0);
    assert!(relay.paired_devices.is_empty());
    assert!(result.device.is_none());
    assert!(result.payload_secret.is_none());
    assert_eq!(
        result.error.as_deref(),
        Some("pairing request was rejected on the local relay")
    );
}

#[test]
fn devices_response_exposes_pending_device_record_metadata() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-pending".to_string()),
            Some("Pending Phone".to_string()),
            "surface-pending",
            "verify-key-pending".to_string(),
            100,
        )
        .expect("pairing request should register");

    let devices = relay.devices_response();
    let record = devices
        .device_records
        .iter()
        .find(|record| record.device_id == "phone-pending")
        .expect("pending device record should be present");

    assert_eq!(record.lifecycle_state, DeviceLifecycleState::Pending);
    assert_eq!(record.label, "Pending Phone");
    assert_eq!(record.last_seen_at, None);
    assert_eq!(record.last_peer_id.as_deref(), Some("surface-pending"));
    assert_eq!(record.broker_join_ticket_expires_at, None);
    assert!(record.fingerprint.is_some());

    let snapshot = relay.snapshot();
    assert!(snapshot.device_records.is_empty());
    assert!(snapshot.paired_devices.is_empty());
    assert!(snapshot.pending_pairing_requests.is_empty());
    assert_eq!(snapshot.devices_revision, devices.devices_revision);
}

#[test]
fn approving_pairing_request_updates_device_record_metadata() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-approved".to_string()),
            Some("Approved Phone".to_string()),
            "surface-approved",
            "verify-key-approved".to_string(),
            100,
        )
        .expect("pairing request should register");

    relay
        .decide_pairing_request(&ticket.pairing_id, true, Some(3600), 101)
        .expect("approval should succeed");

    let devices = relay.devices_response();
    let record = devices
        .device_records
        .iter()
        .find(|record| record.device_id == "phone-approved")
        .expect("approved device record should be present");

    assert_eq!(record.lifecycle_state, DeviceLifecycleState::Approved);
    assert_eq!(record.label, "Approved Phone");
    assert_eq!(record.last_seen_at, Some(101));
    assert_eq!(record.last_peer_id.as_deref(), Some("surface-approved"));
    assert_eq!(record.broker_join_ticket_expires_at, Some(3600));
    assert!(record.fingerprint.is_some());
}

#[test]
fn rejecting_pairing_request_records_rejected_device_state() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-rejected".to_string()),
            Some("Rejected Phone".to_string()),
            "surface-rejected",
            "verify-key-rejected".to_string(),
            100,
        )
        .expect("pairing request should register");

    relay
        .decide_pairing_request(&ticket.pairing_id, false, None, 101)
        .expect("rejection should succeed");

    let devices = relay.devices_response();
    let record = devices
        .device_records
        .iter()
        .find(|record| record.device_id == "phone-rejected")
        .expect("rejected device record should be present");

    assert_eq!(record.lifecycle_state, DeviceLifecycleState::Rejected);
    assert_eq!(record.label, "Rejected Phone");
    assert_eq!(record.last_seen_at, None);
    assert_eq!(record.last_peer_id.as_deref(), Some("surface-rejected"));
    assert_eq!(record.broker_join_ticket_expires_at, None);
    assert!(record.fingerprint.is_some());
}

#[test]
fn revoke_all_other_devices_keeps_selected_device_and_marks_others_revoked() {
    let mut relay = test_state();
    let keep_ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );
    let drop_ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let (keep_device, _) = relay
        .consume_pairing_ticket(
            &keep_ticket.pairing_id,
            &keep_ticket.pairing_secret,
            Some("phone-keep".to_string()),
            Some("Keep Phone".to_string()),
            "verify-key-keep".to_string(),
            Some(300),
            "surface-keep",
            100,
        )
        .expect("keep device should pair");
    let (drop_device, _) = relay
        .consume_pairing_ticket(
            &drop_ticket.pairing_id,
            &drop_ticket.pairing_secret,
            Some("phone-drop".to_string()),
            Some("Drop Phone".to_string()),
            "verify-key-drop".to_string(),
            Some(400),
            "surface-drop",
            101,
        )
        .expect("drop device should pair");

    let revoked = relay
        .revoke_all_other_paired_devices(&keep_device.device_id, 102)
        .expect("bulk revoke should succeed");

    assert_eq!(revoked, vec![drop_device.device_id.clone()]);
    assert_eq!(relay.paired_devices.len(), 1);
    assert!(relay.paired_devices.contains_key(&keep_device.device_id));

    let devices = relay.devices_response();
    let kept_record = devices
        .device_records
        .iter()
        .find(|record| record.device_id == keep_device.device_id)
        .expect("kept device record should be present");
    let revoked_record = devices
        .device_records
        .iter()
        .find(|record| record.device_id == drop_device.device_id)
        .expect("revoked device record should be present");

    assert_eq!(kept_record.lifecycle_state, DeviceLifecycleState::Approved);
    assert_eq!(kept_record.broker_join_ticket_expires_at, Some(300));
    assert_eq!(
        revoked_record.lifecycle_state,
        DeviceLifecycleState::Revoked
    );
    assert_eq!(revoked_record.broker_join_ticket_expires_at, Some(400));
    assert_eq!(revoked_record.last_peer_id.as_deref(), Some("surface-drop"));
}

#[test]
fn repeated_pairing_request_rebinds_to_latest_broker_peer() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-rebind".to_string()),
            Some("Rebind Phone".to_string()),
            "surface-old",
            "verify-key-3".to_string(),
            100,
        )
        .expect("initial pairing request should register");

    let rebound = relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-rebind".to_string()),
            Some("Rebind Phone".to_string()),
            "surface-new",
            "verify-key-3".to_string(),
            101,
        )
        .expect("retry should rebind to the latest broker peer");

    assert_eq!(rebound.broker_peer_id, "surface-new");

    let result = relay
        .decide_pairing_request(&ticket.pairing_id, true, None, 102)
        .expect("approval should use the rebound broker peer");
    assert_eq!(result.target_peer_id, "surface-new");
}

#[test]
fn a_second_device_cannot_steal_a_pending_pairing_request() {
    // SECURITY: the rebind in `repeated_pairing_request_rebinds_to_latest_broker
    // _peer` exists so ONE device can retry over a new broker peer. It must not
    // also let a DIFFERENT device (different Ed25519 verify key) overwrite the
    // request the operator is about to approve: whoever holds the QR payload can
    // then wait for the victim to register, register last, and receive the
    // approval — plus the payload_secret and refresh tokens that come with it.
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("victim-phone".to_string()),
            Some("Victim Phone".to_string()),
            "surface-victim",
            "victim-verify-key".to_string(),
            100,
        )
        .expect("the victim's pairing request should register");

    let stolen = relay.register_pairing_request(
        &ticket.pairing_id,
        Some("victim-phone".to_string()),
        Some("Victim Phone".to_string()),
        "surface-attacker",
        "attacker-verify-key".to_string(),
        101,
    );

    assert!(
        stolen.is_err(),
        "a request carrying a different verify key must not rebind an existing \
         pending pairing request, got {stolen:?}"
    );

    let result = relay
        .decide_pairing_request(&ticket.pairing_id, true, None, 102)
        .expect("approval should still resolve the victim's request");
    assert_eq!(
        result.target_peer_id, "surface-victim",
        "the approval must land on the device the operator actually saw"
    );
    assert_eq!(
        result
            .device
            .as_ref()
            .expect("approved device")
            .fingerprint
            .as_deref(),
        device_fingerprint_for("victim-verify-key").as_deref(),
        "the paired device must be keyed to the victim's verify key"
    );
}

fn device_fingerprint_for(verify_key: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(verify_key)
        .unwrap_or_else(|_| verify_key.as_bytes().to_vec());
    let digest = Sha256::digest(&bytes);
    let mut fingerprint = String::new();
    for (index, byte) in digest.iter().take(8).enumerate() {
        if index > 0 {
            fingerprint.push(':');
        }
        use std::fmt::Write as _;
        let _ = write!(fingerprint, "{byte:02x}");
    }
    Some(fingerprint)
}

#[test]
fn completed_pairing_can_replay_result_to_reconnected_peer() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-replay".to_string()),
            Some("Replay Phone".to_string()),
            "surface-a",
            "verify-key-4".to_string(),
            100,
        )
        .expect("pairing request should register");
    relay
        .decide_pairing_request(&ticket.pairing_id, true, None, 101)
        .expect("approval should complete pairing");

    let replay = relay
        .completed_pairing_result(&ticket.pairing_id, "verify-key-4", "surface-b", 102)
        .expect("completed pairing lookup should succeed")
        .expect("completed pairing should be replayable");

    assert_eq!(replay.target_peer_id, "surface-b");
    assert_eq!(
        replay
            .device
            .as_ref()
            .map(|device| device.device_id.as_str()),
        Some("phone-replay")
    );
    assert!(replay.payload_secret.is_some());
}

#[test]
fn completed_pairing_can_carry_client_directory_grant() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-directory".to_string()),
            Some("Directory Phone".to_string()),
            "surface-a",
            "verify-key-5".to_string(),
            100,
        )
        .expect("pairing request should register");
    relay
        .decide_pairing_request(&ticket.pairing_id, true, None, 101)
        .expect("approval should complete pairing");
    relay
        .attach_pairing_client_grant(
            &ticket.pairing_id,
            Some("relay-directory".to_string()),
            Some("Demo Relay".to_string()),
            Some("claim-directory".to_string()),
            Some("nonce-directory".to_string()),
            Some(900),
        )
        .expect("client directory grant should attach");

    let replay = relay
        .completed_pairing_result(&ticket.pairing_id, "verify-key-5", "surface-b", 102)
        .expect("completed pairing lookup should succeed")
        .expect("completed pairing should be replayable");

    assert_eq!(replay.relay_id.as_deref(), Some("relay-directory"));
    assert_eq!(replay.relay_label.as_deref(), Some("Demo Relay"));
    assert_eq!(replay.client_claim_id.as_deref(), Some("claim-directory"));
    assert_eq!(
        replay.client_claim_nonce.as_deref(),
        Some("nonce-directory")
    );
    assert_eq!(replay.client_claim_expires_at, Some(900));
}

#[test]
fn remote_action_replay_cache_replays_completed_results() {
    let mut relay = test_state();
    let cached = test_cached_remote_action_result("send_message", true);

    let first = relay
        .reserve_remote_action("device-a", "act-1", "send_message", 100)
        .expect("first remote action should reserve");
    assert!(matches!(first, RemoteActionReplayDecision::Execute));

    relay.store_remote_action_result("device-a", "act-1", cached.clone(), 101);

    let second = relay
        .reserve_remote_action("device-a", "act-1", "send_message", 102)
        .expect("completed action should replay");
    match second {
        RemoteActionReplayDecision::Replay(result) => {
            assert!(result.ok);
            assert_eq!(result.action_kind, "send_message");
            assert_eq!(result.session_claim.as_deref(), Some("claim-1"));
        }
        other => panic!("unexpected replay decision: {other:?}"),
    }
}

#[test]
fn remote_action_replay_cache_blocks_inflight_duplicates() {
    let mut relay = test_state();

    let first = relay
        .reserve_remote_action("device-a", "act-2", "send_message", 100)
        .expect("first remote action should reserve");
    assert!(matches!(first, RemoteActionReplayDecision::Execute));

    let second = relay
        .reserve_remote_action("device-a", "act-2", "send_message", 101)
        .expect("duplicate inflight action should not re-execute");
    assert!(matches!(second, RemoteActionReplayDecision::InFlight));
}

#[test]
fn remote_action_replay_cache_rejects_action_id_reuse_for_different_action_kind() {
    let mut relay = test_state();
    relay.store_remote_action_result(
        "device-a",
        "act-2",
        test_cached_remote_action_result("send_message", true),
        100,
    );

    let error = relay
        .reserve_remote_action("device-a", "act-2", "list_threads", 101)
        .expect_err("reusing an action_id for a different action should fail");
    assert!(error.contains("different remote action"));
}

#[test]
fn remote_action_replay_cache_expires_old_entries() {
    let mut relay = test_state();
    relay.store_remote_action_result(
        "device-a",
        "act-3",
        test_cached_remote_action_result("send_message", false),
        100,
    );

    let decision = relay
        .reserve_remote_action("device-a", "act-3", "send_message", 100 + 601)
        .expect("expired replay entry should allow a new execution");
    assert!(matches!(decision, RemoteActionReplayDecision::Execute));
}

#[test]
fn ensure_path_within_device_scope_blocks_outside_device_scope() {
    let unique = format!(
        "agent-relay-scope-block-{}-{}",
        std::process::id(),
        unix_now()
    );
    let root = std::env::temp_dir().join(unique);
    let allowed = root.join("project");
    let device_dir = allowed.join("only");
    let outside_device = allowed.join("other");
    std::fs::create_dir_all(&device_dir).expect("device dir should be creatable");
    std::fs::create_dir_all(&outside_device).expect("outside dir should be creatable");
    let allowed_roots = normalize_allowed_roots(vec![allowed.display().to_string()])
        .expect("allowed roots should normalize");
    let device_scope = normalize_allowed_roots(vec![device_dir.display().to_string()])
        .expect("device scope should normalize");

    assert!(ensure_path_within_device_scope(
        &device_dir.display().to_string(),
        &device_scope,
        &allowed_roots,
    )
    .is_ok());
    let error = ensure_path_within_device_scope(
        &outside_device.display().to_string(),
        &device_scope,
        &allowed_roots,
    )
    .expect_err("path outside device scope should be rejected");
    assert!(error.contains("device's allowed paths"));

    std::fs::remove_dir_all(&root).expect("temp scope dir should be removable");
}

#[test]
fn ensure_path_within_device_scope_blocks_outside_relay_roots_even_when_in_device_scope() {
    let unique = format!(
        "agent-relay-scope-relay-{}-{}",
        std::process::id(),
        unix_now()
    );
    let root = std::env::temp_dir().join(unique);
    let allowed = root.join("project");
    let outside_relay = root.join("other-project");
    std::fs::create_dir_all(&allowed).expect("allowed dir should be creatable");
    std::fs::create_dir_all(&outside_relay).expect("outside dir should be creatable");
    let allowed_roots = normalize_allowed_roots(vec![allowed.display().to_string()])
        .expect("allowed roots should normalize");
    // Device scope claims a path outside the relay's allowed roots — defense in depth
    // means the relay roots check still fires first.
    let device_scope = vec![outside_relay.display().to_string()];

    let error = ensure_path_within_device_scope(
        &outside_relay.display().to_string(),
        &device_scope,
        &allowed_roots,
    )
    .expect_err("path outside relay roots should be rejected even if device scope allows");
    assert!(error.contains("relay's allowed roots"));

    std::fs::remove_dir_all(&root).expect("temp scope dir should be removable");
}

#[test]
fn ensure_path_within_device_scope_passes_when_device_scope_empty() {
    let unique = format!(
        "agent-relay-scope-empty-{}-{}",
        std::process::id(),
        unix_now()
    );
    let root = std::env::temp_dir().join(unique);
    let allowed = root.join("project");
    let nested = allowed.join("anywhere");
    std::fs::create_dir_all(&nested).expect("nested dir should be creatable");
    let allowed_roots = normalize_allowed_roots(vec![allowed.display().to_string()])
        .expect("allowed roots should normalize");

    assert!(
        ensure_path_within_device_scope(&nested.display().to_string(), &[], &allowed_roots,)
            .is_ok()
    );

    std::fs::remove_dir_all(&root).expect("temp scope dir should be removable");
}

#[test]
fn prepare_pairing_ticket_defaults_to_a_three_minute_approval_window() {
    // The default TTL is the whole approval budget: it has to cover the human
    // walking from phone to laptop and hitting Approve. 30s was not enough.
    let mut relay = test_state();
    let before = unix_now();
    let prepared = relay
        .prepare_pairing_ticket(None, Vec::new())
        .expect("pairing ticket should prepare");
    let after = unix_now();

    assert!(
        prepared.expires_at >= before + 180 && prepared.expires_at <= after + 180,
        "default pairing TTL should be 180s (3 minutes); got expires_at={} with now in {before}..={after}",
        prepared.expires_at
    );
}

#[test]
fn prepare_pairing_ticket_carries_path_scope() {
    let mut relay = test_state();
    let scope = vec![
        "/tmp/project/foo".to_string(),
        "/tmp/project/bar".to_string(),
    ];
    let ticket = issue_test_pairing_ticket_with_scope(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
        scope.clone(),
    );

    assert_eq!(ticket.path_scope, scope);
    let pending = relay
        .pending_pairings
        .get(&ticket.pairing_id)
        .expect("pending pairing should be present");
    assert_eq!(pending.path_scope, scope);

    // QR payload contains the scope so paired clients see what they're accepting.
    let decoded = URL_SAFE_NO_PAD
        .decode(&ticket.pairing_payload)
        .expect("pairing payload should decode");
    let value: serde_json::Value =
        serde_json::from_slice(&decoded).expect("pairing payload should be valid JSON");
    assert_eq!(
        value["path_scope"],
        serde_json::to_value(&scope).expect("scope should serialize")
    );
}

#[test]
fn consume_pairing_ticket_overwrites_path_scope_on_repair() {
    let mut relay = test_state();
    let first_ticket = issue_test_pairing_ticket_with_scope(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
        vec!["/tmp/project/initial".to_string()],
    );

    let (device, _) = relay
        .consume_pairing_ticket(
            &first_ticket.pairing_id,
            &first_ticket.pairing_secret,
            Some("my-phone".to_string()),
            Some("Phone".to_string()),
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-a",
            100,
        )
        .expect("first pairing should succeed");
    assert_eq!(device.path_scope, vec!["/tmp/project/initial".to_string()]);
    assert_eq!(
        relay.device_path_scope(&device.device_id),
        vec!["/tmp/project/initial".to_string()]
    );

    // Re-pair the same device with a different scope — latest QR should win.
    let second_ticket = issue_test_pairing_ticket_with_scope(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
        vec!["/tmp/project/updated".to_string()],
    );
    let (device_after, _) = relay
        .consume_pairing_ticket(
            &second_ticket.pairing_id,
            &second_ticket.pairing_secret,
            Some("my-phone".to_string()),
            Some("Phone".to_string()),
            TEST_VERIFY_KEY_B64.to_string(),
            None,
            "surface-a",
            200,
        )
        .expect("re-pair should succeed");
    assert_eq!(
        device_after.path_scope,
        vec!["/tmp/project/updated".to_string()]
    );
    assert_eq!(
        relay.device_path_scope(&device_after.device_id),
        vec!["/tmp/project/updated".to_string()]
    );
    assert_eq!(
        relay.paired_devices.len(),
        1,
        "still one device after re-pair"
    );
}

#[test]
fn snapshot_includes_pending_ask_user_questions_sorted_by_requested_at() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );

    let mut earlier = test_pending_ask_user_question("thread-1");
    earlier.request_id = "ask:1".to_string();
    earlier.requested_at = 100;
    let mut later = test_pending_ask_user_question("thread-1");
    later.request_id = "ask:2".to_string();
    later.requested_at = 200;
    relay
        .pending_ask_user_questions
        .insert(later.request_id.clone(), later);
    relay
        .pending_ask_user_questions
        .insert(earlier.request_id.clone(), earlier);

    let snapshot = relay.snapshot();
    let ids: Vec<&str> = snapshot
        .pending_ask_user_questions
        .iter()
        .map(|q| q.request_id.as_str())
        .collect();
    // Earlier requested_at sorts first so the UI doesn't reshuffle the cards
    // when an unrelated revision bump triggers a re-render.
    assert_eq!(ids, vec!["ask:1", "ask:2"]);
}

#[test]
fn activate_thread_preserves_pending_requests_from_other_threads() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay
        .pending_approvals
        .insert("req-1".to_string(), test_pending_approval("thread-1"));
    relay.pending_ask_user_questions.insert(
        "ask:1".to_string(),
        test_pending_ask_user_question("thread-1"),
    );
    assert_eq!(relay.pending_approvals.len(), 1);
    assert_eq!(relay.pending_ask_user_questions.len(), 1);

    // Pending approvals/questions are owned by the worker turn, not by the
    // currently viewed thread. Dropping them on switch leaves non-selected
    // Claude turns blocked with no request the UI can answer.
    relay.activate_thread(
        test_thread("thread-2", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    assert!(relay.pending_approvals.contains_key("req-1"));
    assert!(relay.pending_ask_user_questions.contains_key("ask:1"));
}

#[test]
fn paired_device_path_scope_loads_default_empty_from_legacy_state() {
    // Legacy on-disk PairedDevice JSON has no `path_scope` field — serde should default to empty.
    let legacy = r#"{
        "device_id": "phone-1",
        "label": "Primary Phone",
        "payload_secret": "payload-secret",
        "device_verify_key": "dGVzdC12ZXJpZnkta2V5",
        "created_at": 7,
        "last_seen_at": 9,
        "last_peer_id": "surface-1"
    }"#;
    let device: PairedDevice =
        serde_json::from_str(legacy).expect("legacy paired device JSON should deserialize");
    assert_eq!(device.path_scope, Vec::<String>::new());
}

#[test]
fn full_pairing_flow_carries_path_scope_to_paired_device() {
    // Reproduces the operator-side flow end to end inside RelayState:
    //   start_pairing → prepare_pairing_ticket(scope)
    //   broker receives pairing_request → register_pairing_request
    //   operator approves → decide_pairing_request(true) → consume_pairing_ticket
    // Assert the scope made it onto the PairedDevice.
    let mut relay = test_state();
    let scope = vec!["/tmp/scoped".to_string()];
    let ticket = issue_test_pairing_ticket_with_scope(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
        scope.clone(),
    );

    let pending_request = relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("mobile-test-device".to_string()),
            Some("Test Device".to_string()),
            "broker-peer-1",
            TEST_VERIFY_KEY_B64.to_string(),
            50,
        )
        .expect("register should succeed");
    assert_eq!(
        pending_request.path_scope, scope,
        "PendingPairingRequest should carry the scope from PendingPairing"
    );

    let result = relay
        .decide_pairing_request(&ticket.pairing_id, true, None, 100)
        .expect("decide should succeed");
    let approved = result.device.expect("approval should yield a device");
    assert_eq!(
        approved.path_scope, scope,
        "PendingPairingResult device view should carry the scope"
    );

    let on_disk = relay
        .paired_devices
        .get("mobile-test-device")
        .expect("device should be persisted");
    assert_eq!(
        on_disk.path_scope, scope,
        "PairedDevice on disk should carry the scope"
    );
    assert_eq!(
        relay.device_path_scope("mobile-test-device"),
        scope,
        "device_path_scope accessor should agree"
    );
}

#[test]
fn pairing_start_input_deserializes_path_scope() {
    use crate::protocol::PairingStartInput;
    // Exactly what the frontend POSTs when the input is filled in.
    let raw = r#"{"path_scope":["/Users/luchi/git/agent-relay"]}"#;
    let input: PairingStartInput =
        serde_json::from_str(raw).expect("PairingStartInput should deserialize");
    assert_eq!(
        input.path_scope,
        Some(vec!["/Users/luchi/git/agent-relay".to_string()])
    );

    // What the frontend POSTs when the input is empty: body is `{}`.
    let empty: PairingStartInput =
        serde_json::from_str("{}").expect("empty body should deserialize");
    assert!(empty.path_scope.is_none());
}

#[cfg(test)]
mod paged_history_merge_tests {
    use crate::protocol::{
        FileChangeDiffView, ToolCallView, TranscriptContentState, TranscriptEntryKind,
        TranscriptEntryView,
    };
    use crate::state::relay::ThreadRuntime;

    fn view(item_id: &str, status: &str, tool: ToolCallView) -> TranscriptEntryView {
        TranscriptEntryView {
            item_id: Some(item_id.to_string()),
            kind: TranscriptEntryKind::ToolCall,
            text: None,
            status: status.to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: Some(tool),
            content_state: TranscriptContentState::Full,
        }
    }

    fn make_runtime() -> ThreadRuntime {
        ThreadRuntime::new(
            crate::protocol::ThreadSummaryView {
                workspace_trusted: false,
                id: "thread-1".to_string(),
                name: None,
                preview: String::new(),
                cwd: "/repo".to_string(),
                updated_at: 1,
                source: "local".to_string(),
                status: "idle".to_string(),
                model_provider: "anthropic".to_string(),
                provider: "claude_code".to_string(),
                forked_from: None,
                renamed: false,
            },
            "/repo",
            "sonnet",
            "default",
            "workspace-write",
            "medium",
            1,
            0,
        )
    }

    fn blank_tool(item_type: &str, name: &str) -> ToolCallView {
        ToolCallView {
            item_type: item_type.to_string(),
            name: name.to_string(),
            title: name.to_string(),
            kind: None,
            detail: None,
            query: None,
            path: None,
            url: None,
            command: None,
            input_preview: None,
            result_preview: None,
            diff: None,
            file_changes: Vec::new(),
            apply_state: None,
            file_changes_omitted: false,
            can_apply: None,
        }
    }

    // A page cannot know that a tool finished — its result may simply be on another page.
    // So an older page's non-terminal status must never overwrite a terminal one already
    // recorded from a newer page, or a successful edit shows as running forever.
    #[test]
    fn an_older_page_never_downgrades_a_settled_status() {
        let mut runtime = make_runtime();
        runtime.prepend_provider_history(
            vec![view("tool:t1", "completed", blank_tool("toolCall", "tool"))],
            None,
            None,
        );
        runtime.prepend_provider_history(
            vec![view("tool:t1", "running", blank_tool("fileChange", "Edit"))],
            None,
            None,
        );

        let record = runtime
            .transcript
            .iter()
            .find(|record| record.item_id == "tool:t1")
            .expect("entry");
        assert_eq!(
            record.status, "completed",
            "an older page must not un-settle an edit that already completed"
        );
    }

    // Paging can split a tool's request from its result. The newer page carries only the
    // RESULT, which replays as a generic entry with no path and no diff; the real
    // fileChange metadata lives on the older page's request. Dropping the older record as
    // a duplicate loses that edit entirely — no file change, no turn diff, and no
    // evidence for the worktree suggestion — even though it succeeded.
    #[test]
    fn an_older_page_enriches_a_result_only_entry_instead_of_being_dropped() {
        let mut runtime = make_runtime();
        let _unused = ThreadRuntime::new(
            crate::protocol::ThreadSummaryView {
                workspace_trusted: false,
                id: "thread-1".to_string(),
                name: None,
                preview: String::new(),
                cwd: "/repo".to_string(),
                updated_at: 1,
                source: "local".to_string(),
                status: "idle".to_string(),
                model_provider: "anthropic".to_string(),
                provider: "claude_code".to_string(),
                forked_from: None,
                renamed: false,
            },
            "/repo",
            "sonnet",
            "default",
            "workspace-write",
            "medium",
            1,
            0,
        );

        // Newest page first: only the tool_result was on it.
        runtime.prepend_provider_history(
            vec![view("tool:t1", "completed", blank_tool("toolCall", "tool"))],
            None,
            None,
        );

        // Older page carries the request, with the actual file change.
        let mut rich = blank_tool("fileChange", "Edit");
        rich.path = Some("/repo/src/x.rs".to_string());
        rich.file_changes = vec![FileChangeDiffView {
            path: "/repo/src/x.rs".to_string(),
            change_type: "update".to_string(),
            diff: "--- a/src/x.rs\n+++ b/src/x.rs\n@@ -1 +1 @@\n-a\n+b\n".to_string(),
        }];
        runtime.prepend_provider_history(vec![view("tool:t1", "running", rich)], None, None);

        let record = runtime
            .transcript
            .iter()
            .find(|record| record.item_id == "tool:t1")
            .expect("the tool entry must survive");
        let tool = record.tool.as_ref().expect("tool");
        assert_eq!(
            tool.item_type, "fileChange",
            "the older page's real tool metadata must win over the result-only stub"
        );
        assert_eq!(tool.file_changes.len(), 1, "the edit must not be lost");
        assert_eq!(
            record.status, "completed",
            "the newer page's settled status must be kept"
        );
        assert_eq!(
            runtime
                .transcript
                .iter()
                .filter(|r| r.item_id == "tool:t1")
                .count(),
            1,
            "still exactly one entry"
        );
    }
}

/// Per-device thread watch sets: the subscription that lets every thread stream live
/// without fanning every thread's deltas out to every paired surface.
mod watched_threads {
    use super::*;

    /// Bring a paired device online as a broker target.
    fn online_paired_device(relay: &mut RelayState, device_id: &str, peer_id: &str) {
        relay.paired_devices.insert(
            device_id.to_string(),
            PairedDevice {
                device_id: device_id.to_string(),
                label: device_id.to_string(),
                payload_secret: format!("secret-{device_id}"),
                device_verify_key: TEST_VERIFY_KEY_B64.to_string(),
                created_at: 0,
                last_seen_at: None,
                last_peer_id: Some(peer_id.to_string()),
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
            },
        );
        relay.mark_surface_peer_online(peer_id);
        relay.bind_surface_peer_to_device(device_id, peer_id);
        relay.register_broker_surface(peer_id);
    }

    fn activate(relay: &mut RelayState, thread_id: &str, device_id: &str) {
        relay.activate_thread(
            test_thread(thread_id, "/tmp/project"),
            "/tmp/project",
            DEFAULT_MODEL,
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            device_id,
        );
    }

    /// BACKWARD COMPAT: a client that never learned to declare a watch set must keep
    /// receiving exactly what it received before subscriptions existed — the active
    /// thread, and nothing else. If this breaks, an un-upgraded phone goes silent.
    #[test]
    fn a_device_with_no_declaration_falls_back_to_the_active_thread() {
        let mut relay = test_state();
        activate(&mut relay, "thread-active", "device-a");

        assert!(
            relay.device_watches_thread("device-a", "thread-active"),
            "no declaration must mean 'the active thread', preserving pre-subscription behavior"
        );
        assert!(
            !relay.device_watches_thread("device-a", "thread-background"),
            "no declaration must NOT mean 'everything' — that would fan out every thread"
        );
    }

    /// Once a device declares, the declaration is the whole truth: it stops implicitly
    /// receiving the active thread it did not ask for.
    #[test]
    fn a_declaration_replaces_the_active_thread_fallback() {
        let mut relay = test_state();
        activate(&mut relay, "thread-active", "device-a");

        assert!(relay.set_watched_threads(
            "device-a",
            "device-a",
            vec!["thread-background".to_string()]
        ));

        assert!(
            relay.device_watches_thread("device-a", "thread-background"),
            "a declared thread must be watched even though it is not active"
        );
        assert!(
            !relay.device_watches_thread("device-a", "thread-active"),
            "a device looking away from the active thread must not keep streaming it"
        );
    }

    /// Declaring the same set twice must not report a change — clients re-declare on
    /// every navigation, and a spurious `true` would wake a notify()/publish cycle.
    #[test]
    fn redeclaring_the_same_set_reports_no_change() {
        let mut relay = test_state();
        let set = vec!["thread-a".to_string(), "thread-b".to_string()];

        assert!(relay.set_watched_threads("device-a", "device-a", set.clone()));
        assert!(
            !relay.set_watched_threads("device-a", "device-a", set),
            "an identical re-declaration must be a no-op"
        );
        assert!(
            !relay.set_watched_threads(
                "device-a",
                "device-a",
                vec!["thread-b".into(), "thread-a".into()]
            ),
            "order must not matter — the watch set is a set"
        );
    }

    /// An explicit empty declaration means "showing nothing" and MUTES the surface.
    ///
    /// It must NOT restore the never-declared fallback (the active thread): a scoped
    /// device whose declaration is entirely filtered out lands here, and falling back
    /// would hand it exactly the content the filter just refused.
    #[test]
    fn an_empty_declaration_mutes_rather_than_falling_back() {
        let mut relay = test_state();
        activate(&mut relay, "thread-active", "device-a");
        relay.set_watched_threads(
            "device-a",
            "device-a",
            vec!["thread-background".to_string()],
        );

        assert!(relay.set_watched_threads("device-a", "device-a", Vec::new()));
        assert!(
            !relay.device_watches_thread("device-a", "thread-active"),
            "an explicit empty declaration must mute, not fall back to the active thread"
        );
        assert!(
            !relay.surface_watches_thread("device-a", "thread-active"),
            "the surface must be muted too"
        );
    }

    /// The point of the whole feature: one phone watching a background thread must not
    /// drag that thread's deltas onto every other paired surface.
    #[test]
    fn broker_targets_for_thread_excludes_devices_that_are_not_watching() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");
        online_paired_device(&mut relay, "tablet", "peer-tablet");
        activate(&mut relay, "thread-active", "phone");

        relay.set_watched_threads("peer-phone", "phone", vec!["thread-background".to_string()]);
        relay.set_watched_threads("peer-tablet", "tablet", vec!["thread-active".to_string()]);

        let background_targets = relay.broker_targets_for_thread("thread-background");
        assert_eq!(
            background_targets.len(),
            1,
            "only the watching device may be a publish target, got: {background_targets:?}"
        );
        assert_eq!(background_targets[0].0, "phone");

        let active_targets = relay.broker_targets_for_thread("thread-active");
        assert_eq!(active_targets.len(), 1, "got: {active_targets:?}");
        assert_eq!(active_targets[0].0, "tablet");
    }

    /// Providers skip queueing entirely for a thread nobody has on screen.
    #[test]
    fn any_device_watches_thread_gates_background_threads() {
        let mut relay = test_state();
        activate(&mut relay, "thread-active", "device-a");

        assert!(
            relay.any_device_watches_thread("thread-active"),
            "the active thread always streams — the local surface needs it"
        );
        assert!(
            !relay.any_device_watches_thread("thread-background"),
            "a thread nobody is looking at must not queue deltas"
        );

        relay.set_watched_threads(
            "device-a",
            "device-a",
            vec!["thread-background".to_string()],
        );
        assert!(
            relay.any_device_watches_thread("thread-background"),
            "one watcher is enough to start streaming a background thread"
        );
    }

    /// A watch set describes what an ONLINE surface has on screen. Surviving a broker
    /// drop would resume streaming to a device that may have navigated away or closed.
    #[test]
    fn a_broker_disconnect_clears_every_watch_set() {
        let mut relay = test_state();
        relay.register_broker_surface("peer-phone");
        relay.set_watched_threads("peer-phone", "phone", vec!["thread-background".to_string()]);

        relay.set_broker_connection(false);

        assert!(
            !relay.any_device_watches_thread("thread-background"),
            "watch sets must not survive a broker disconnect"
        );
    }

    /// A phone that closes must stop being a publish target, or its threads stay in
    /// the fan-out set forever.
    #[test]
    fn a_peer_going_offline_prunes_its_watch_set() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");
        relay.set_watched_threads("peer-phone", "phone", vec!["thread-background".to_string()]);

        relay.mark_surface_peer_offline("peer-phone");

        assert!(
            !relay.any_device_watches_thread("thread-background"),
            "an offline device's watch set must be pruned"
        );
    }

    /// Same for a presence resync that drops the peer.
    #[test]
    fn replacing_online_peers_prunes_departed_devices() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");
        online_paired_device(&mut relay, "tablet", "peer-tablet");
        relay.set_watched_threads("peer-phone", "phone", vec!["thread-x".to_string()]);
        relay.set_watched_threads("peer-tablet", "tablet", vec!["thread-x".to_string()]);

        relay.replace_online_surface_peers(vec!["peer-tablet".to_string()]);

        let targets = relay.broker_targets_for_thread("thread-x");
        assert_eq!(
            targets.len(),
            1,
            "the departed peer's device must be pruned, got: {targets:?}"
        );
        assert_eq!(targets[0].0, "tablet");
    }

    fn queued_delta_thread_ids(relay: &RelayState) -> Vec<String> {
        relay
            .pending_broker_messages
            .iter()
            .filter_map(|message| match message {
                BrokerPendingMessage::TranscriptDelta(delta) => Some(delta.thread_id.clone()),
                _ => None,
            })
            .collect()
    }

    /// THE POINT OF THE FEATURE: a background thread that someone is watching now
    /// streams. Before subscriptions, `bg_append_agent_delta` mutated the runtime
    /// transcript and stopped there, so a non-active thread could only be read by
    /// re-polling a snapshot — which is why looking at one felt frozen.
    #[test]
    fn a_watched_background_thread_streams_its_deltas() {
        let mut relay = test_state();
        relay.broker_configured = true;
        activate(&mut relay, "thread-active", "device-a");
        relay.set_watched_threads(
            "device-a",
            "device-a",
            vec!["thread-background".to_string()],
        );

        relay.bg_append_agent_delta("thread-background", "item-1", "hello", "turn-1", 100);

        assert_eq!(
            queued_delta_thread_ids(&relay),
            vec!["thread-background".to_string()],
            "a watched background thread must queue a broker delta"
        );
    }

    /// ...and a thread nobody has on screen still costs nothing. This is what keeps
    /// "every thread can stream" from meaning "every thread does stream".
    #[test]
    fn an_unwatched_background_thread_queues_nothing() {
        let mut relay = test_state();
        relay.broker_configured = true;
        activate(&mut relay, "thread-active", "device-a");

        relay.bg_append_agent_delta("thread-background", "item-1", "hello", "turn-1", 100);

        assert!(
            queued_delta_thread_ids(&relay).is_empty(),
            "an unwatched background thread must not queue deltas"
        );
    }

    /// The runtime transcript is updated either way — dropping the *publish* must never
    /// mean dropping the *data*, or switching to the thread later would show a hole.
    #[test]
    fn an_unwatched_background_thread_still_records_its_transcript() {
        let mut relay = test_state();
        relay.broker_configured = true;
        activate(&mut relay, "thread-active", "device-a");

        relay.bg_append_agent_delta("thread-background", "item-1", "hello", "turn-1", 100);

        let runtime = relay
            .runtime_for_thread("thread-background")
            .expect("the background runtime must still exist");
        assert!(
            runtime
                .transcript
                .iter()
                .any(|entry| entry.text.as_deref() == Some("hello")),
            "not publishing a delta must not stop the relay recording it"
        );
    }

    /// Command output streams on the same gate as agent text.
    #[test]
    fn a_watched_background_thread_streams_command_output() {
        let mut relay = test_state();
        relay.broker_configured = true;
        activate(&mut relay, "thread-active", "device-a");
        relay.set_watched_threads(
            "device-a",
            "device-a",
            vec!["thread-background".to_string()],
        );

        relay.bg_append_command_delta("thread-background", "cmd-1", "line of output", 100);

        assert_eq!(
            queued_delta_thread_ids(&relay),
            vec!["thread-background".to_string()],
            "command output must stream for a watched background thread too"
        );
    }

    /// The LOCAL surface gets deltas over its own broadcast channel, not the broker
    /// queue (the broker publisher drains that with `mem::take`, so sharing it would
    /// mean whichever consumer ran first stole the frame).
    /// Enqueue an active-thread delta the way every provider does: mutate the
    /// transcript, then hand the mutation metadata to `queue_broker_message`.
    fn provider_enqueues_active_delta(relay: &mut RelayState, item_id: &str, text: &str) {
        let mutation = relay.append_agent_delta(item_id, text, "turn-1");
        let thread_id = relay.active_thread_id.clone().unwrap_or_default();
        relay.queue_broker_message(BrokerPendingMessage::TranscriptDelta(
            PendingTranscriptDelta {
                thread_id,
                base_revision: mutation.base_revision,
                revision: mutation.revision,
                entry_seq: mutation.entry_seq,
                server_time: mutation.server_time,
                item_id: item_id.to_string(),
                turn_id: Some("turn-1".to_string()),
                delta: text.to_string(),
                kind: TranscriptDeltaKind::AgentText,
                text_offset: mutation.text_offset,
            },
        ));
    }

    #[test]
    fn a_local_subscriber_receives_active_thread_deltas() {
        let mut relay = test_state();
        activate(&mut relay, "thread-active", "device-a");
        let mut deltas = relay.subscribe_transcript_deltas();

        provider_enqueues_active_delta(&mut relay, "item-1", "hello");

        let event = deltas.try_recv().expect("a local delta must be broadcast");
        assert_eq!(event.thread_id, "thread-active");
        assert_eq!(event.delta, "hello");
        assert_eq!(event.delta_kind, "agent_text");
    }

    /// REGRESSION: a relay with no broker still has a local surface, and that surface
    /// still needs a live tail. Deltas are dropped at the door when no broker is
    /// configured, so the local tee must happen BEFORE that guard — otherwise the
    /// local live tail only works when a phone happens to be paired.
    #[test]
    fn a_local_subscriber_receives_deltas_with_no_broker_configured() {
        let mut relay = test_state();
        assert!(
            !relay.broker_configured,
            "this test is about the broker-less path"
        );
        activate(&mut relay, "thread-active", "device-a");
        let mut deltas = relay.subscribe_transcript_deltas();

        provider_enqueues_active_delta(&mut relay, "item-1", "hello");

        let event = deltas
            .try_recv()
            .expect("local deltas must not depend on a broker being configured");
        assert_eq!(event.delta, "hello");
        assert!(
            relay.pending_broker_messages.is_empty(),
            "the broker queue must still stay empty without a broker"
        );
    }

    /// A watched BACKGROUND thread reaches local subscribers too — that is what lets
    /// the local surface watch more than the single globally-active thread live.
    #[test]
    fn a_local_subscriber_receives_watched_background_deltas() {
        let mut relay = test_state();
        activate(&mut relay, "thread-active", "device-a");
        relay.set_watched_threads(
            "device-a",
            "device-a",
            vec!["thread-background".to_string()],
        );
        let mut deltas = relay.subscribe_transcript_deltas();

        relay.bg_append_agent_delta("thread-background", "item-1", "bg text", "turn-9", 100);

        let event = deltas
            .try_recv()
            .expect("a watched background thread must reach local subscribers");
        assert_eq!(event.thread_id, "thread-background");
        assert_eq!(event.delta, "bg text");
    }

    /// REVIEW P1 (security): a watch declaration is a CONTENT grant — the relay streams
    /// the thread's transcript to whoever declares it. Every other content path checks
    /// `ensure_path_within_device_scope`, so a subscription must not be the one way
    /// around a device's path scope. E2EE does not mitigate it: the declaring device
    /// holds the decryption key.
    #[test]
    fn a_scoped_device_cannot_watch_a_thread_outside_its_scope() {
        let unique = format!(
            "agent-relay-watch-scope-{}-{}",
            std::process::id(),
            unix_now()
        );
        let root = std::env::temp_dir().join(unique);
        let allowed = root.join("project");
        let in_scope = allowed.join("mine");
        let out_of_scope = allowed.join("theirs");
        std::fs::create_dir_all(&in_scope).expect("in-scope dir");
        std::fs::create_dir_all(&out_of_scope).expect("out-of-scope dir");

        let mut relay = test_state();
        relay.set_allowed_roots(
            normalize_allowed_roots(vec![allowed.display().to_string()]).expect("roots"),
        );
        online_paired_device(&mut relay, "phone", "peer-phone");
        relay
            .paired_devices
            .get_mut("phone")
            .expect("paired")
            .path_scope =
            normalize_allowed_roots(vec![in_scope.display().to_string()]).expect("scope");

        // Two loaded threads: one inside the device's grant, one outside it.
        relay.ensure_runtime_for_thread("thread-mine").current_cwd = in_scope.display().to_string();
        relay.ensure_runtime_for_thread("thread-theirs").current_cwd =
            out_of_scope.display().to_string();

        relay.set_watched_threads(
            "peer-phone",
            "phone",
            vec!["thread-mine".to_string(), "thread-theirs".to_string()],
        );

        assert!(
            relay.device_watches_thread("phone", "thread-mine"),
            "the in-scope thread must still be watchable"
        );
        assert!(
            !relay.device_watches_thread("phone", "thread-theirs"),
            "a scoped device must NOT be able to subscribe to an out-of-scope thread"
        );
        assert!(
            relay.broker_targets_for_thread("thread-theirs").is_empty(),
            "an out-of-scope thread must have no delta targets"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A thread whose runtime is not loaded has no known cwd, so it cannot be PROVEN in
    /// scope. Fail closed rather than streaming and hoping.
    #[test]
    fn a_scoped_device_cannot_watch_a_thread_with_an_unknown_cwd() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");
        relay
            .paired_devices
            .get_mut("phone")
            .expect("paired")
            .path_scope = vec!["/tmp/some-scope".to_string()];

        relay.set_watched_threads("peer-phone", "phone", vec!["never-loaded".to_string()]);

        assert!(
            !relay.device_watches_thread("phone", "never-loaded"),
            "an unprovable thread must not be watchable by a scoped device"
        );
    }

    /// An UNSCOPED device (no path grant) keeps full access — scoping is opt-in and this
    /// check must not quietly become a general restriction.
    #[test]
    fn an_unscoped_device_can_watch_any_thread() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");

        relay.set_watched_threads("peer-phone", "phone", vec!["thread-anything".to_string()]);

        assert!(relay.device_watches_thread("phone", "thread-anything"));
    }

    /// REVIEW P1: a local browser tab is a surface with NO broker peer. Pruning by peer
    /// presence used to delete its subscription whenever any phone joined or left,
    /// silently downgrading the local live tail to polling.
    #[test]
    fn remote_peer_churn_does_not_prune_a_local_surface() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");
        // The local tab declares under its own surface id and is not a broker surface.
        relay.set_watched_threads("local-tab-1", "local-device", vec!["thread-bg".to_string()]);
        relay.set_watched_threads("peer-phone", "phone", vec!["thread-bg".to_string()]);

        relay.mark_surface_peer_offline("peer-phone");

        assert!(
            relay.surface_watches_thread("local-tab-1", "thread-bg"),
            "a phone disconnecting must not cancel a local tab's subscription"
        );
        assert!(
            relay.any_device_watches_thread("thread-bg"),
            "the thread must keep streaming for the local surface"
        );
    }

    /// Same for a broker disconnect: the local surface is still connected over SSE.
    #[test]
    fn a_broker_disconnect_does_not_clear_local_surfaces() {
        let mut relay = test_state();
        relay.register_broker_surface("peer-phone");
        relay.set_watched_threads("peer-phone", "phone", vec!["thread-bg".to_string()]);
        relay.set_watched_threads("local-tab-1", "local-device", vec!["thread-bg".to_string()]);

        relay.set_broker_connection(false);

        assert!(
            relay.surface_watches_thread("local-tab-1", "thread-bg"),
            "a broker drop must not cancel a local tab's subscription"
        );
    }

    /// REVIEW P2: two tabs of one browser share a device id (it lives in localStorage).
    /// A per-device set let whichever tab declared last silence the other.
    #[test]
    fn two_surfaces_on_one_device_watch_independently() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");

        relay.set_watched_threads("tab-1", "local-device", vec!["thread-a".to_string()]);
        relay.set_watched_threads("tab-2", "local-device", vec!["thread-b".to_string()]);

        assert!(relay.surface_watches_thread("tab-1", "thread-a"));
        assert!(
            !relay.surface_watches_thread("tab-1", "thread-b"),
            "each tab sees only what it is showing"
        );
        assert!(relay.surface_watches_thread("tab-2", "thread-b"));
        assert!(
            !relay.surface_watches_thread("tab-2", "thread-a"),
            "the second tab must not have clobbered the first"
        );
        // Broker delivery is per device, so the device is a target for the union.
        assert!(relay.device_watches_thread("local-device", "thread-a"));
        assert!(relay.device_watches_thread("local-device", "thread-b"));
    }

    /// A closed tab must stop being a publish target, or a local-only relay keeps
    /// producing deltas nobody reads.
    #[test]
    fn dropping_a_surface_ends_its_subscription() {
        let mut relay = test_state();
        relay.set_watched_threads("tab-1", "local-device", vec!["thread-bg".to_string()]);

        assert!(relay.drop_watched_surface("tab-1"));

        assert!(
            !relay.any_device_watches_thread("thread-bg"),
            "a closed surface must not keep a background thread streaming"
        );
    }

    /// REVIEW P1: a scoped device whose entire declaration is filtered out must end up
    /// MUTED, not fall through to the active thread — otherwise the ACL leaks exactly
    /// the content it just refused.
    #[test]
    fn a_fully_filtered_declaration_does_not_fall_back_to_the_active_thread() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");
        relay
            .paired_devices
            .get_mut("phone")
            .expect("paired")
            .path_scope = vec!["/tmp/only-here".to_string()];
        activate(&mut relay, "thread-active", "phone");

        // Every declared thread is out of scope, so nothing survives the filter.
        relay.set_watched_threads("peer-phone", "phone", vec!["thread-elsewhere".to_string()]);

        assert!(
            !relay.device_watches_thread("phone", "thread-active"),
            "a filtered-to-empty declaration must not fall back to the active thread"
        );
    }

    /// REVIEW P1: an empty device scope means "no EXTRA device restriction" — the relay's
    /// own allowed_roots still apply. Skipping the check when the device scope was empty
    /// let any paired device watch a thread outside the relay's roots.
    #[test]
    fn an_unscoped_device_is_still_bound_by_relay_allowed_roots() {
        let unique = format!(
            "agent-relay-watch-roots-{}-{}",
            std::process::id(),
            unix_now()
        );
        let root = std::env::temp_dir().join(unique);
        let allowed = root.join("allowed");
        let outside = root.join("outside");
        std::fs::create_dir_all(&allowed).expect("allowed dir");
        std::fs::create_dir_all(&outside).expect("outside dir");

        let mut relay = test_state();
        relay.set_allowed_roots(
            normalize_allowed_roots(vec![allowed.display().to_string()]).expect("roots"),
        );
        online_paired_device(&mut relay, "phone", "peer-phone");
        assert!(
            relay.device_path_scope("phone").is_empty(),
            "this test is about a device with NO scope of its own"
        );

        relay.ensure_runtime_for_thread("thread-inside").current_cwd =
            allowed.display().to_string();
        relay
            .ensure_runtime_for_thread("thread-outside")
            .current_cwd = outside.display().to_string();

        relay.set_watched_threads(
            "peer-phone",
            "phone",
            vec!["thread-inside".to_string(), "thread-outside".to_string()],
        );

        assert!(relay.device_watches_thread("phone", "thread-inside"));
        assert!(
            !relay.device_watches_thread("phone", "thread-outside"),
            "an unscoped device must still be confined to the relay's allowed roots"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// REVIEW P1: watches are re-validated on delivery, so tightening a scope revokes a
    /// subscription that was legal when it was declared.
    #[test]
    fn tightening_a_device_scope_revokes_an_existing_watch() {
        let unique = format!(
            "agent-relay-watch-tighten-{}-{}",
            std::process::id(),
            unix_now()
        );
        let root = std::env::temp_dir().join(unique);
        let project = root.join("project");
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&project).expect("project dir");
        std::fs::create_dir_all(&elsewhere).expect("elsewhere dir");

        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");
        relay.ensure_runtime_for_thread("thread-x").current_cwd = project.display().to_string();

        // Declared while unscoped: legal.
        relay.set_watched_threads("peer-phone", "phone", vec!["thread-x".to_string()]);
        assert!(relay.device_watches_thread("phone", "thread-x"));

        // The operator narrows this device to a different directory.
        relay
            .paired_devices
            .get_mut("phone")
            .expect("paired")
            .path_scope =
            normalize_allowed_roots(vec![elsewhere.display().to_string()]).expect("scope");

        assert!(
            !relay.device_watches_thread("phone", "thread-x"),
            "an already-declared watch must stop delivering once the scope excludes it"
        );
        assert!(
            relay.broker_targets_for_thread("thread-x").is_empty(),
            "and it must no longer be a publish target"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// REVIEW P1: a surface id is stable across reconnects (it identifies the TAB), so a
    /// refreshed page reuses it. The OLD connection's teardown must not unsubscribe the
    /// NEW connection that already declared.
    #[test]
    fn a_stale_connection_teardown_cannot_unsubscribe_its_replacement() {
        let mut relay = test_state();
        let old_generation = relay.open_surface_generation("tab-1", None);
        relay.set_watched_threads("tab-1", "local-device", vec!["thread-a".to_string()]);

        // The tab reloads: same surface id, new connection, new declaration.
        let new_generation = relay.open_surface_generation("tab-1", None);
        relay.set_watched_threads("tab-1", "local-device", vec!["thread-b".to_string()]);
        assert_ne!(old_generation, new_generation);

        // The old stream's teardown finally runs.
        assert!(
            !relay.drop_watched_surface_generation("tab-1", old_generation),
            "a superseded connection must not remove the live subscription"
        );
        assert!(
            relay.surface_watches_thread("tab-1", "thread-b"),
            "the new connection's declaration must survive the old one's teardown"
        );

        // The current connection's own teardown still works.
        assert!(relay.drop_watched_surface_generation("tab-1", new_generation));
        assert!(!relay.surface_watches_thread("tab-1", "thread-b"));
    }

    /// REVIEW P2: two broker tabs on ONE phone are two peers. Targeting by the device's
    /// union sent both threads to both peers, which defeats declaring at all.
    #[test]
    fn two_broker_surfaces_on_one_device_get_only_their_own_thread() {
        let mut relay = test_state();
        relay.paired_devices.insert(
            "phone".to_string(),
            PairedDevice {
                device_id: "phone".to_string(),
                label: "phone".to_string(),
                payload_secret: "secret".to_string(),
                device_verify_key: TEST_VERIFY_KEY_B64.to_string(),
                created_at: 0,
                last_seen_at: None,
                last_peer_id: Some("peer-2".to_string()),
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
            },
        );
        for peer in ["peer-1", "peer-2"] {
            relay.mark_surface_peer_online(peer);
            relay.bind_surface_peer_to_device("phone", peer);
            relay.register_broker_surface(peer);
        }
        relay.set_watched_threads("peer-1", "phone", vec!["thread-a".to_string()]);
        relay.set_watched_threads("peer-2", "phone", vec!["thread-b".to_string()]);

        let a_targets = relay.broker_targets_for_thread("thread-a");
        assert_eq!(a_targets.len(), 1, "got: {a_targets:?}");
        assert_eq!(a_targets[0].1, "peer-1", "only the tab showing A gets A");

        let b_targets = relay.broker_targets_for_thread("thread-b");
        assert_eq!(b_targets.len(), 1, "got: {b_targets:?}");
        assert_eq!(b_targets[0].1, "peer-2", "only the tab showing B gets B");
    }

    /// REVIEW P2: a phone mints a new peer id on every reconnect, so departed ids must be
    /// dropped or the set grows for as long as the relay stays connected.
    #[test]
    fn departed_broker_surface_ids_are_not_retained() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-old");
        relay.set_watched_threads("peer-old", "phone", vec!["thread-a".to_string()]);

        relay.mark_surface_peer_offline("peer-old");

        assert!(
            !relay.broker_surface_id_is_tracked("peer-old"),
            "a departed peer id must not be retained"
        );
    }

    /// REVIEW P2: the relay inserts a separating newline between command chunks, but
    /// used to publish the RAW provider delta. A client that appends what it was sent
    /// then renders `npm testline 1` instead of `npm test\nline 1`.
    ///
    /// Uses the real Codex shape — an existing `npm test` entry, then a raw `line 1`
    /// chunk with no leading newline — rather than a fixture that pre-bakes the
    /// separator and so cannot fail.
    #[test]
    fn a_command_delta_publishes_the_separator_the_relay_inserted() {
        let mut relay = test_state();
        relay.broker_configured = true;
        activate(&mut relay, "thread-active", "device-a");
        relay.set_watched_threads(
            "device-a",
            "device-a",
            vec!["thread-background".to_string()],
        );

        // The command entry already holds the command line, with no trailing newline.
        relay.bg_append_command_delta("thread-background", "cmd-1", "npm test", 100);
        // The provider's next chunk does NOT start with a newline.
        relay.bg_append_command_delta("thread-background", "cmd-1", "line 1", 101);

        let published: Vec<String> = relay
            .pending_broker_messages
            .iter()
            .filter_map(|message| match message {
                BrokerPendingMessage::TranscriptDelta(delta) => Some(delta.delta.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            published,
            vec!["npm test".to_string(), "\nline 1".to_string()],
            "the published delta must carry the separator the relay appended"
        );

        // And a client that appends the published deltas ends up byte-identical to the
        // relay's own copy — the property that actually matters.
        let runtime = relay
            .runtime_for_thread("thread-background")
            .expect("runtime");
        let stored = runtime
            .transcript
            .iter()
            .find(|entry| entry.item_id == "cmd-1")
            .and_then(|entry| entry.text.clone())
            .expect("command text");
        assert_eq!(published.concat(), stored);
    }

    /// REVIEW P1: local navigation declares a watch BEFORE the transcript fetch loads the
    /// runtime. Filtering an unloaded thread at declaration time muted it permanently,
    /// because the client had already recorded the declaration as delivered and dedupes
    /// the retry. Delivery re-checks, so admitting it is safe.
    #[test]
    fn a_thread_declared_before_it_loads_starts_streaming_once_it_loads() {
        let unique = format!(
            "agent-relay-watch-late-{}-{}",
            std::process::id(),
            unix_now()
        );
        let root = std::env::temp_dir().join(unique);
        let allowed = root.join("allowed");
        std::fs::create_dir_all(&allowed).expect("allowed dir");

        let mut relay = test_state();
        relay.set_allowed_roots(
            normalize_allowed_roots(vec![allowed.display().to_string()]).expect("roots"),
        );
        online_paired_device(&mut relay, "phone", "peer-phone");

        // Declared before the runtime exists — exactly the local navigation ordering.
        relay.set_watched_threads("peer-phone", "phone", vec!["thread-late".to_string()]);
        assert!(
            !relay.device_watches_thread("phone", "thread-late"),
            "an unloaded thread cannot be proven readable yet, so it must not deliver"
        );

        // The transcript fetch loads the runtime, in scope.
        relay.ensure_runtime_for_thread("thread-late").current_cwd = allowed.display().to_string();

        assert!(
            relay.device_watches_thread("phone", "thread-late"),
            "once the runtime loads in scope, the standing declaration must start delivering"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// REVIEW P2: an older client that never declares must keep its own fallback — the
    /// active thread. Unioning in what a NEWER tab on the same device declared both
    /// pushed it a thread it does not render AND stopped its live tail.
    #[test]
    fn a_legacy_peer_keeps_the_active_thread_when_another_tab_declares() {
        let mut relay = test_state();
        relay.paired_devices.insert(
            "phone".to_string(),
            PairedDevice {
                device_id: "phone".to_string(),
                label: "phone".to_string(),
                payload_secret: "secret".to_string(),
                device_verify_key: TEST_VERIFY_KEY_B64.to_string(),
                created_at: 0,
                last_seen_at: None,
                last_peer_id: Some("peer-new".to_string()),
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
            },
        );
        for peer in ["peer-legacy", "peer-new"] {
            relay.mark_surface_peer_online(peer);
            relay.bind_surface_peer_to_device("phone", peer);
            relay.register_broker_surface(peer);
        }
        activate(&mut relay, "thread-active", "phone");

        // Only the new tab declares; the legacy peer never does.
        relay.set_watched_threads("peer-new", "phone", vec!["thread-background".to_string()]);

        let active_peers: Vec<String> = relay
            .broker_targets_for_thread("thread-active")
            .into_iter()
            .map(|(_, peer_id, _)| peer_id)
            .collect();
        assert_eq!(
            active_peers,
            vec!["peer-legacy".to_string()],
            "the legacy peer must keep receiving the active thread it renders"
        );

        let background_peers: Vec<String> = relay
            .broker_targets_for_thread("thread-background")
            .into_iter()
            .map(|(_, peer_id, _)| peer_id)
            .collect();
        assert_eq!(
            background_peers,
            vec!["peer-new".to_string()],
            "and must NOT be sent the background thread it does not render"
        );
    }

    /// REVIEW P2: generation guarded teardown but not declarations. A stale page's POST
    /// landing after its replacement declared would overwrite the live watch set, and the
    /// new page would not re-send because it already recorded its declaration.
    #[test]
    fn a_late_declaration_from_a_superseded_connection_is_refused() {
        let mut relay = test_state();
        let old_generation = relay.open_surface_generation("tab-1", None);
        relay.set_watched_threads_for_generation(
            "tab-1",
            "local-device",
            vec!["thread-old".to_string()],
            Some(old_generation),
        );

        // The page reloads and the new connection declares.
        let new_generation = relay.open_surface_generation("tab-1", None);
        relay.set_watched_threads_for_generation(
            "tab-1",
            "local-device",
            vec!["thread-new".to_string()],
            Some(new_generation),
        );

        // The OLD page's in-flight POST finally lands.
        assert!(
            !relay.set_watched_threads_for_generation(
                "tab-1",
                "local-device",
                vec!["thread-old".to_string()],
                Some(old_generation),
            ),
            "a superseded connection's declaration must be refused"
        );
        assert!(
            relay.surface_watches_thread("tab-1", "thread-new"),
            "the live declaration must survive"
        );
        assert!(!relay.surface_watches_thread("tab-1", "thread-old"));
    }

    /// A client that sends no generation (older build) is still accepted — the same
    /// backwards-compatible posture as a missing watch set.
    #[test]
    fn a_declaration_without_a_generation_is_still_accepted() {
        let mut relay = test_state();
        relay.open_surface_generation("tab-1", None);

        assert!(relay.set_watched_threads_for_generation(
            "tab-1",
            "local-device",
            vec!["thread-a".to_string()],
            None,
        ));
        assert!(relay.surface_watches_thread("tab-1", "thread-a"));
    }

    /// A revoked device must stop being a publish target immediately, not merely fail
    /// to decrypt what it still receives.
    #[test]
    fn revoking_a_paired_device_prunes_its_watch_set() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");
        relay.set_watched_threads("peer-phone", "phone", vec!["thread-background".to_string()]);

        assert!(relay.revoke_paired_device("phone", 100));

        assert!(
            !relay.any_device_watches_thread("thread-background"),
            "a revoked device must not remain a delta target"
        );
    }

    /// A revoked device must not keep acting as the Orchestrator across restarts.
    #[test]
    fn revoking_the_orchestrator_device_clears_the_pin() {
        let mut relay = test_state();
        online_paired_device(&mut relay, "phone", "peer-phone");
        relay.orchestrator_thread_id = Some("orch-thread".to_string());
        relay.orchestrator_device_id = Some("phone".to_string());
        relay.orchestrator_system_prompt = Some("You are the Orchestrator.".to_string());
        relay.orchestrator_system_prompt_version = Some(2);

        assert!(relay.revoke_paired_device("phone", 100));

        assert!(relay.orchestrator_thread_id.is_none());
        assert!(relay.orchestrator_device_id.is_none());
        assert!(relay.orchestrator_system_prompt.is_none());
        assert!(relay.orchestrator_system_prompt_version.is_none());
        assert!(
            relay.orchestrator_session_options("orch-thread").is_none(),
            "a revoked acting device must not keep Orchestrator MCP authority"
        );
    }

    #[test]
    fn orchestrator_session_options_allow_unpaired_local_device_id() {
        let mut relay = test_state();
        relay.orchestrator_thread_id = Some("orch-thread".to_string());
        relay.orchestrator_device_id = Some("local-browser-uuid".to_string());
        relay.orchestrator_system_prompt = Some("You are the Orchestrator.".to_string());

        assert_eq!(
            relay.orchestrator_session_options("orch-thread"),
            Some((
                "local-browser-uuid".to_string(),
                Some("You are the Orchestrator.".to_string())
            )),
            "local browser operators are not in paired_devices and must still get tools"
        );
    }

    #[test]
    fn orchestrator_session_options_reject_explicitly_revoked_device() {
        use crate::protocol::DeviceLifecycleState;
        use crate::state::DeviceRecord;

        let mut relay = test_state();
        relay.orchestrator_thread_id = Some("orch-thread".to_string());
        relay.orchestrator_device_id = Some("phone".to_string());
        relay.orchestrator_system_prompt = Some("You are the Orchestrator.".to_string());
        relay.device_records.insert(
            "phone".to_string(),
            DeviceRecord {
                device_id: "phone".to_string(),
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

        assert!(
            relay.orchestrator_session_options("orch-thread").is_none(),
            "explicitly revoked acting devices must not receive Orchestrator tools"
        );
    }
}

// ---------------------------------------------------------------------------
// Transcript revision: one shared monotonic clock.
//
// The transcript revision is the client's only proof that it has not missed a
// delta: it accepts a delta when `base_revision` matches the revision it holds,
// and drops one whose `revision` is below it (frontend/remote/session-ops.js
// `shouldAcceptTranscriptRevision`). That contract only holds if the revision a
// thread reports NEVER goes backwards. These tests pin that invariant at each
// place the relay hands out a revision.
// ---------------------------------------------------------------------------

/// Every revision the relay issues must be unique across threads, because they
/// all have to come from one clock. Two threads minting their own 1, 2, 3...
/// means a client that switches threads can hold a revision the other thread is
/// about to re-issue.
#[test]
fn transcript_revisions_are_unique_across_threads() {
    let mut relay = test_state();
    let mut seen = std::collections::HashSet::new();

    for _ in 0..3 {
        for thread_id in ["thread-a", "thread-b"] {
            let (_base, revision) = relay.bump_thread_transcript_revision(thread_id);
            assert!(
                seen.insert(revision),
                "revision {revision} was handed out twice (second time to {thread_id}); \
                 per-thread counters are not one shared clock"
            );
        }
    }
}

/// A thread's revision must survive a relay restart. A browser tab that held
/// revision N before the restart drops every delta below N, so a restored
/// runtime that restarts at 0 goes silently deaf until the counter climbs back.
#[test]
fn transcript_revision_survives_a_relay_restart() {
    let mut relay = test_state();
    for _ in 0..5 {
        relay.bump_thread_transcript_revision("thread-1");
    }
    let before_restart = relay
        .runtime_for_thread("thread-1")
        .expect("runtime")
        .transcript_revision;
    assert!(before_restart > 0, "precondition: revision advanced");

    let persisted = PersistedRelayState::from_relay(&relay);
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);

    let (_base, after_restart) = restored.bump_thread_transcript_revision("thread-1");
    assert!(
        after_restart > before_restart,
        "after a restart thread-1 issued revision {after_restart}, which is not above \
         the {before_restart} a live client still holds — every delta up to \
         {before_restart} will be dropped as stale"
    );
}

/// Re-reading history rebuilds the runtime. That must not rewind the revision:
/// the client needs to see the number move FORWARD so it repairs the gap, rather
/// than see it move backward and silently discard the deltas that follow.
#[test]
fn rehydrating_a_thread_does_not_rewind_its_transcript_revision() {
    let mut relay = test_state();
    for _ in 0..4 {
        relay.bump_thread_transcript_revision("thread-1");
    }
    let before = relay
        .runtime_for_thread("thread-1")
        .expect("runtime")
        .transcript_revision;
    assert!(before > 0, "precondition: revision advanced");

    // Drop the runtime the way an eviction / cold re-read does, then let the
    // relay rebuild it from a fresh provider history read.
    relay.runtimes.remove("thread-1");
    relay.load_thread_data(
        ThreadSyncData {
            thread: test_thread("thread-1", "/tmp/project"),
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript: vec![TranscriptEntryView {
                item_id: Some("item-1".to_string()),
                kind: TranscriptEntryKind::AgentText,
                text: Some("hello".to_string()),
                status: "completed".to_string(),
                turn_id: Some("turn-1".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            }],
        },
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        DEFAULT_MODEL,
        "device-a",
    );

    let after = relay
        .runtime_for_thread("thread-1")
        .expect("rehydrated runtime")
        .transcript_revision;
    assert!(
        after >= before,
        "rehydration rewound thread-1 from revision {before} to {after}; a client \
         holding {before} would drop every delta that follows"
    );
}

/// `merge_fresh_history` mutates the transcript, so it has to draw its new
/// revision from the same clock as every other mutation. If it bumps a private
/// per-thread counter it can mint a revision another thread already used.
#[test]
fn merging_fresh_history_draws_from_the_shared_revision_clock() {
    let mut relay = test_state();
    // Advance the shared clock well past thread-1's own counter using a
    // different thread.
    let mut highest = 0;
    for _ in 0..6 {
        let (_base, revision) = relay.bump_thread_transcript_revision("thread-other");
        highest = highest.max(revision);
    }
    let (_base, thread_one) = relay.bump_thread_transcript_revision("thread-1");
    highest = highest.max(thread_one);

    // A history re-read that genuinely adds an entry must move the revision
    // forward relative to everything issued so far.
    relay.load_thread_data(
        ThreadSyncData {
            thread: test_thread("thread-1", "/tmp/project"),
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript: vec![TranscriptEntryView {
                item_id: Some("fresh-item".to_string()),
                kind: TranscriptEntryKind::AgentText,
                text: Some("fresh".to_string()),
                status: "completed".to_string(),
                turn_id: Some("turn-2".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            }],
        },
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        DEFAULT_MODEL,
        "device-a",
    );

    let merged = relay
        .runtime_for_thread("thread-1")
        .expect("runtime")
        .transcript_revision;
    assert!(
        merged > highest,
        "merge_fresh_history issued revision {merged}, but the shared clock had \
         already handed out {highest} — it is bumping a private counter"
    );
}

/// Every delta must carry `base_revision < revision`. The pair is a *chain*: the
/// client matches `base_revision` against what it holds and then adopts
/// `revision`. A bump that hands back a revision at or below its own base tells
/// the client to move backwards, and it responds by discarding the delta.
#[test]
fn a_bump_always_reports_a_base_below_the_revision_it_issues() {
    let mut relay = test_state();

    // Includes the very first bump on a thread with no runtime yet — that path
    // has to create the runtime AND issue a revision, so it is the easiest one to
    // get out of order.
    for round in 0..3 {
        for thread_id in ["thread-a", "thread-b"] {
            let (base_revision, revision) = relay.bump_thread_transcript_revision(thread_id);
            assert!(
                base_revision < revision,
                "round {round}: {thread_id} issued base_revision {base_revision} with \
                 revision {revision}; a delta that does not move forward is dropped \
                 by the client"
            );
        }
    }
}

/// Restoring a relay whose ACTIVE thread has no runtime yet must not seed that
/// thread at 0. The active thread is rebuilt lazily by
/// `materialize_selected_runtime_from_fields`, which runs in the window between
/// `apply_persisted` and `restore_persisted_session` — a window any provider
/// event or client poll can land in.
#[test]
fn restoring_an_active_thread_does_not_seed_it_below_the_clock() {
    let mut relay = test_state();
    relay.active_thread_id = Some("thread-1".to_string());
    for _ in 0..5 {
        relay.bump_thread_transcript_revision("thread-1");
    }
    let before_restart = relay
        .runtime_for_thread("thread-1")
        .expect("runtime")
        .transcript_revision;

    let persisted = PersistedRelayState::from_relay(&relay);
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);
    assert_eq!(
        restored.active_thread_id.as_deref(),
        Some("thread-1"),
        "precondition: the active thread was restored"
    );

    // Lazily materialize it, the way a provider event arriving before
    // `restore_persisted_session` would.
    let seeded = restored
        .ensure_runtime_for_thread("thread-1")
        .transcript_revision;
    assert!(
        seeded >= before_restart,
        "the restored active thread was seeded at revision {seeded}, below the \
         {before_restart} a surviving client still holds — that client rejects both \
         the deltas AND the snapshot that would have repaired it"
    );
}

/// Persistence is debounced, and several paths advance the clock without
/// scheduling a save at all. So the persisted value must sit AHEAD of the
/// revisions already issued: a hard crash must make the clock skip forward, never
/// replay numbers it has already handed out.
#[test]
fn a_crash_after_the_last_save_does_not_replay_issued_revisions() {
    let mut relay = test_state();
    for _ in 0..3 {
        relay.bump_thread_transcript_revision("thread-1");
    }

    // The last successful save.
    let persisted = PersistedRelayState::from_relay(&relay);

    // The relay keeps running and keeps issuing revisions, then dies before the
    // next save lands.
    let mut highest_issued = 0;
    for _ in 0..100 {
        let (_base, revision) = relay.bump_thread_transcript_revision("thread-1");
        highest_issued = highest_issued.max(revision);
    }

    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);
    let (_base, first_after_restart) = restored.bump_thread_transcript_revision("thread-1");
    assert!(
        first_after_restart > highest_issued,
        "after a crash the relay re-issued revision {first_after_restart}, but \
         {highest_issued} had already gone out to clients — the persisted clock \
         needs headroom for revisions minted since the last save"
    );
}

/// Promoting a deferred thread onto its real id must not rewind the real id's
/// revision. `turn_revision` is already max-folded here; the transcript revision
/// has to be too.
#[test]
fn promoting_a_background_thread_does_not_rewind_the_real_threads_revision() {
    let mut relay = test_state();
    // The pending runtime was created first, so it sits BEHIND on the shared clock.
    relay.bump_thread_transcript_revision("claude-pending-1");
    // The event stream then built a real-id runtime and advanced it past pending.
    for _ in 0..4 {
        relay.bump_thread_transcript_revision("real-id");
    }
    let real_before = relay
        .runtime_for_thread("real-id")
        .expect("real runtime")
        .transcript_revision;
    // Pending carries the longer transcript, so promotion keeps pending's runtime.
    relay
        .runtimes
        .get_mut("claude-pending-1")
        .expect("pending runtime")
        .transcript = vec![
        TranscriptRecord {
            item_id: "a".to_string(),
            kind: TranscriptEntryKind::AgentText,
            text: Some("a".to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            seq: None,
        },
        TranscriptRecord {
            item_id: "b".to_string(),
            kind: TranscriptEntryKind::AgentText,
            text: Some("b".to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            seq: None,
        },
    ];

    relay.promote_background_thread("claude-pending-1", "real-id");

    let real_after = relay
        .runtime_for_thread("real-id")
        .expect("promoted runtime")
        .transcript_revision;
    assert!(
        real_after >= real_before,
        "promotion rewound real-id from revision {real_before} to {real_after}; a \
         client tracking real-id would discard everything until the clock caught up"
    );
}

/// `restore_thread_data` restores the clock itself, so it must do that BEFORE it
/// draws a revision — otherwise the restored thread is seeded from a clock that
/// has not yet resumed.
#[test]
fn restore_thread_data_resumes_the_clock_before_it_draws_from_it() {
    let mut relay = test_state();
    let mut persisted = test_persisted_state();
    persisted.transcript_clock = 900;

    relay.restore_thread_data(
        ThreadSyncData {
            thread: test_thread("thread-1", "/tmp/project"),
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript: Vec::new(),
        },
        &persisted,
    );

    let seeded = relay
        .runtime_for_thread("thread-1")
        .expect("restored runtime")
        .transcript_revision;
    assert!(
        seeded > 900,
        "the restored thread was seeded at revision {seeded}, at or below the \
         persisted clock high-water mark of 900"
    );
}

/// `snapshot()` falls back to the mirror when the active thread has no runtime,
/// and the mirror is 0 on a freshly restored relay. A snapshot is the client's
/// repair path, so one reporting a revision below what the client holds gets
/// rejected — taking the repair with it.
#[test]
fn a_snapshot_never_reports_a_revision_below_one_already_issued() {
    let mut relay = test_state();
    relay.active_thread_id = Some("thread-1".to_string());
    for _ in 0..5 {
        relay.bump_thread_transcript_revision("thread-1");
    }
    let reported_before = relay.snapshot().transcript_revision;
    assert!(reported_before > 0, "precondition: a revision was reported");

    let persisted = PersistedRelayState::from_relay(&relay);
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);

    let reported_after = restored.snapshot().transcript_revision;
    assert!(
        reported_after >= reported_before,
        "the same thread reported revision {reported_before}, then {reported_after} \
         after a restart; a client holding {reported_before} rejects that snapshot — \
         and the snapshot was its way out"
    );
}

/// End-to-end over the REAL mutation API, with two threads interleaved — the
/// shape a client actually sees on the wire.
///
/// The unit tests above drive `bump_thread_transcript_revision` directly, so they
/// would not catch a mutation path that emits a stale or out-of-order meta. This
/// replays the contract a surface applies: per thread, each delta's
/// `base_revision` must equal the previous delta's `revision` for THAT thread
/// (the chain), and no revision may ever be reused across threads.
#[test]
fn interleaved_threads_emit_an_unbroken_per_thread_chain() {
    let mut relay = test_state();
    let mut last_revision: std::collections::HashMap<&str, u64> = std::collections::HashMap::new();
    let mut all_revisions = std::collections::HashSet::new();

    for round in 0..6 {
        for thread_id in ["thread-a", "thread-b"] {
            // Alternate the two mutation kinds a real turn produces.
            let meta = if round % 2 == 0 {
                relay.upsert_transcript_item_for_thread(
                    thread_id,
                    format!("{thread_id}-item-{round}"),
                    TranscriptEntryKind::AgentText,
                    Some("hello".to_string()),
                    "in_progress".to_string(),
                    Some(format!("turn-{round}")),
                    None,
                )
            } else {
                relay.append_agent_delta_for_thread(
                    thread_id,
                    &format!("{thread_id}-item-{}", round - 1),
                    " more",
                    &format!("turn-{}", round - 1),
                )
            };

            assert!(
                meta.base_revision < meta.revision,
                "round {round} {thread_id}: base {} is not below revision {}",
                meta.base_revision,
                meta.revision
            );
            if let Some(previous) = last_revision.get(thread_id) {
                assert_eq!(
                    meta.base_revision, *previous,
                    "round {round} {thread_id}: chain broken — base_revision {} does \
                     not match this thread's previous revision {previous}; the client \
                     would treat every following delta as a gap",
                    meta.base_revision
                );
            }
            assert!(
                all_revisions.insert(meta.revision),
                "round {round} {thread_id}: revision {} was already issued to some \
                 thread",
                meta.revision
            );
            last_revision.insert(thread_id, meta.revision);
        }
    }
}

/// The snapshot's `transcript_revision` is a cache key: the surface re-fetches the
/// transcript whenever it advances past what it last fetched at
/// (`transcript-hydration-store.js`, "cap the omitted/preview re-fetch to once per
/// revision"). So it must only move when the transcript it describes moves.
/// Reading the live global clock would make it churn on every poll as unrelated
/// background threads stream, re-arming that fetch each time.
#[test]
fn the_snapshot_revision_does_not_churn_on_unrelated_thread_activity() {
    let mut relay = test_state();
    // No active thread — the branch that falls back off the selected runtime.
    assert!(relay.active_thread_id.is_none());
    let first = relay.snapshot().transcript_revision;

    // A background thread streams. Nothing about the snapshot's own transcript
    // changed.
    for _ in 0..3 {
        relay.bump_thread_transcript_revision("background-thread");
    }

    let second = relay.snapshot().transcript_revision;
    assert_eq!(
        first, second,
        "the snapshot revision moved from {first} to {second} because another \
         thread streamed; the surface reads that as 'my transcript changed' and \
         re-fetches on every poll"
    );
}

/// A SECOND crash must not replay revisions either.
///
/// The headroom is added when state is written, so it only protects the run that
/// did the writing. If a restored relay issues revisions and dies before its own
/// first debounced save, the next start reads the SAME stale value and hands the
/// same numbers out again. The startup reservation (a save taken right after
/// restore, before anything can issue) is what closes that.
#[test]
fn a_crash_before_the_first_save_after_a_restore_does_not_replay() {
    let mut first = test_state();
    for _ in 0..3 {
        first.bump_thread_transcript_revision("thread-1");
    }
    let after_first_run = PersistedRelayState::from_relay(&first);

    // Second run restores, then reserves on disk before serving.
    let (change_tx, _) = watch::channel(0_u64);
    let mut second = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    second.apply_persisted(&after_first_run);
    let startup_reservation = PersistedRelayState::from_relay(&second);
    // It then issues revisions and dies before any later save.
    let mut issued_by_second = Vec::new();
    for _ in 0..5 {
        let (_base, revision) = second.bump_thread_transcript_revision("thread-1");
        issued_by_second.push(revision);
    }

    // Third run reads what the second run reserved at startup.
    let (change_tx, _) = watch::channel(0_u64);
    let mut third = RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    third.apply_persisted(&startup_reservation);
    let (_base, first_after_second_crash) = third.bump_thread_transcript_revision("thread-1");

    assert!(
        !issued_by_second.contains(&first_after_second_crash),
        "the third run re-issued revision {first_after_second_crash}, which the \
         second run had already handed out ({issued_by_second:?})"
    );
}
