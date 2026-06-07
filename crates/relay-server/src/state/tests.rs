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
        thread_settings,
        allowed_roots: vec!["/tmp/project".to_string()],
        device_records,
        paired_devices,
        reviewer_threads: std::collections::HashMap::new(),
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
        id: id.to_string(),
        name: Some("Test Thread".to_string()),
        preview: "Test preview".to_string(),
        cwd: cwd.to_string(),
        updated_at: 1,
        source: "codex".to_string(),
        status: "idle".to_string(),
        model_provider: "openai".to_string(),
        provider: "codex".to_string(),
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
            active_thread_id: Some("thread-1".to_string()),
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
            model: DEFAULT_MODEL.to_string(),
            available_models: Vec::new(),
            approval_policy: DEFAULT_APPROVAL_POLICY.to_string(),
            sandbox: DEFAULT_SANDBOX.to_string(),
            reasoning_effort: DEFAULT_EFFORT.to_string(),
            allowed_roots: vec!["/tmp/project".to_string()],
            device_records: Vec::new(),
            paired_devices: Vec::new(),
            pending_pairing_requests: Vec::new(),
            pending_approvals: Vec::new(),
            pending_ask_user_questions: Vec::new(),
            transcript_truncated: false,
            transcript: Vec::new(),
            logs: Vec::new(),
            active_review_jobs: Vec::new(),
            reviewer_threads: Vec::new(),
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
        }),
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
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
    assert_eq!(relay.current_status, "running");
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

    relay.clear_active_session();

    let snapshot = relay.snapshot();
    assert!(snapshot.active_thread_id.is_none());
    assert!(snapshot.transcript.is_empty());
    assert_eq!(snapshot.transcript_revision, 0);
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
    assert_eq!(
        restored.logs[0].message,
        "Relay booted. Waiting for Codex app-server."
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

    assert!(ticket
        .pairing_url
        .starts_with("https://relay.example.com/?pairing="));
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

    let snapshot = relay.snapshot();
    let record = snapshot
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
    assert!(relay.pending_approvals.is_empty());
    assert!(relay.pending_ask_user_questions.is_empty());
    let filtered = relay.filter_deleted_threads(vec![test_thread("thread-2", "/tmp/project")]);
    assert!(filtered.is_empty());
    assert_eq!(relay.threads.len(), 1);
    assert_eq!(relay.threads[0].id, "thread-1");
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

    assert!(error.contains("Codex is still running"));
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

    assert!(error.contains("Codex is still running"));
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
fn snapshot_exposes_pending_device_record_metadata() {
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

    let snapshot = relay.snapshot();
    let record = snapshot
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

    let snapshot = relay.snapshot();
    let record = snapshot
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

    let snapshot = relay.snapshot();
    let record = snapshot
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

    let snapshot = relay.snapshot();
    let kept_record = snapshot
        .device_records
        .iter()
        .find(|record| record.device_id == keep_device.device_id)
        .expect("kept device record should be present");
    let revoked_record = snapshot
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
            Some("client-directory".to_string()),
            Some("client-refresh-directory".to_string()),
        )
        .expect("client directory grant should attach");

    let replay = relay
        .completed_pairing_result(&ticket.pairing_id, "verify-key-5", "surface-b", 102)
        .expect("completed pairing lookup should succeed")
        .expect("completed pairing should be replayable");

    assert_eq!(replay.relay_id.as_deref(), Some("relay-directory"));
    assert_eq!(replay.relay_label.as_deref(), Some("Demo Relay"));
    assert_eq!(replay.client_id.as_deref(), Some("client-directory"));
    assert_eq!(
        replay.client_refresh_token.as_deref(),
        Some("client-refresh-directory")
    );
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
