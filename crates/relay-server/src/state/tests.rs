use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::json;
use std::{env, path::PathBuf};
use tokio::sync::watch;

use crate::{
    codex::ThreadSyncData,
    protocol::{
        ApprovalReceipt, DeviceLifecycleState, LogEntryView, ModelOptionView, SessionSnapshot,
        ThreadSummaryView, ThreadsResponse, TranscriptEntryKind, TranscriptEntryView,
    },
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
        },
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
        allowed_roots: vec!["/tmp/project".to_string()],
        device_records,
        paired_devices,
        transcript: vec![TranscriptRecord {
            item_id: "history-0".to_string(),
            kind: TranscriptEntryKind::AgentText,
            text: Some("hello".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: None,
        }],
        logs: vec![LogEntryView {
            kind: "info".to_string(),
            message: "persisted".to_string(),
            created_at: 1,
        }],
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
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime should build");
    let broker = runtime.block_on(test_broker_config(broker_url, channel_id, peer_id));
    let prepared = relay
        .prepare_pairing_ticket(expires_in_seconds)
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
        requested_permissions: None,
        available_decisions: vec!["approve".to_string(), "deny".to_string()],
        supports_session_scope: true,
    }
}

fn test_cached_remote_action_result(action_kind: &str, ok: bool) -> CachedRemoteActionResult {
    CachedRemoteActionResult {
        action_kind: action_kind.to_string(),
        ok,
        snapshot: SessionSnapshot {
            provider: "codex",
            service_ready: true,
            codex_connected: true,
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
            active_flags: Vec::new(),
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
            transcript_truncated: false,
            transcript: Vec::new(),
            logs: Vec::new(),
        },
        receipt: Some(ApprovalReceipt {
            request_id: "req-1".to_string(),
            decision: crate::protocol::ApprovalDecision::Approve,
            resulting_state: "approval_response_sent".to_string(),
            message: "approved".to_string(),
        }),
        threads: Some(ThreadsResponse {
            threads: vec![test_thread("thread-1", "/tmp/project")],
        }),
        thread_transcript: None,
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
            hidden: false,
            is_default: true,
        },
        ModelOptionView {
            model: "gpt-5.1-codex-mini".to_string(),
            display_name: "gpt-5.1-codex-mini".to_string(),
            supported_reasoning_efforts: vec!["medium".to_string(), "high".to_string()],
            default_reasoning_effort: "medium".to_string(),
            hidden: false,
            is_default: false,
        },
    ]);

    assert_eq!(relay.model, "gpt-5.4");
    assert_eq!(relay.reasoning_effort, "medium");
    assert_eq!(relay.available_models.len(), 2);
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
        "phone-device",
    );

    assert_eq!(relay.active_thread_id.as_deref(), Some("thread-9"));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("phone-device")
    );
    assert_eq!(relay.current_status, "running");
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
fn filter_threads_matches_tilde_scoped_workspace() {
    let home = env::var("HOME").expect("HOME should be set for tests");
    let project_root = PathBuf::from(home).join("git/agent-relay");
    let nested_root = project_root.join("crates/relay-server");

    let threads = vec![
        test_thread("thread-1", &project_root.display().to_string()),
        test_thread("thread-2", &nested_root.display().to_string()),
        test_thread("thread-3", "/tmp/other-project"),
    ];

    let filtered = filter_threads(threads, Some("~/git/agent-relay"), 20);

    assert_eq!(filtered.len(), 2);
    assert_eq!(filtered[0].id, "thread-1");
    assert_eq!(filtered[1].id, "thread-2");
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
    assert_eq!(restored.allowed_roots, vec!["/tmp/project".to_string()]);
    assert_eq!(restored.transcript.len(), 1);
    assert_eq!(restored.logs.len(), persisted.logs.len());
    assert_eq!(restored.logs[0].message, persisted.logs[0].message);
}

#[test]
fn restore_thread_data_keeps_persisted_controller_and_settings() {
    let mut relay = test_state();
    relay
        .pending_approvals
        .insert("req-1".to_string(), test_pending_approval("thread-1"));

    let persisted = test_persisted_state();
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
    assert_eq!(relay.approval_policy, DEFAULT_APPROVAL_POLICY);
    assert_eq!(relay.sandbox, DEFAULT_SANDBOX);
    assert_eq!(relay.reasoning_effort, DEFAULT_EFFORT);
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

    let removed = relay.remove_thread("thread-2");

    assert!(removed);
    assert_eq!(relay.threads.len(), 1);
    assert_eq!(relay.threads[0].id, "thread-1");
    assert_eq!(relay.active_thread_id.as_deref(), Some("thread-1"));
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
    assert_eq!(loaded.transcript.len(), 1);

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
