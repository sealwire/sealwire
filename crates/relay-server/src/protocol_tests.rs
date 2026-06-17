use crate::protocol::strip_file_change_diffs_for_snapshot;
use crate::protocol::{
    truncate_with_ellipsis, ApprovalRequestView, AskUserOptionView, AskUserQuestionRequestView,
    AskUserQuestionView, DeleteThreadInput, DeviceLifecycleState, DeviceRecordView,
    FileChangeDiffView, LogEntryView, ReviewActionInput, ReviewJobView, ReviewerThreadView,
    SecurityMode, SessionSnapshot, SessionSnapshotCompactProfile, ThreadEntriesResponse,
    ThreadEntryDetailResponse, ThreadSummaryView, ThreadTranscriptResponse, ThreadsResponse,
    ThreadsResponseCompactProfile, ToolCallView, TranscriptContentState, TranscriptEntryKind,
    TranscriptEntryView, EMERGENCY_TRANSCRIPT_SHELL_CHARS,
};

const MAX_BROKER_LOGS: usize = 8;
const MAX_BROKER_TRANSCRIPT_ENTRIES: usize = 6;
const MAX_BROKER_TRANSCRIPT_CHARS: usize = 1_200;
const MAX_BROKER_THREADS: usize = 80;
const MAX_BROKER_THREAD_PREVIEW_CHARS: usize = 160;
const SESSION_SNAPSHOT_TARGET_BYTES: usize = 8_000;
const LOCAL_SESSION_SNAPSHOT_TARGET_BYTES: usize = 16_000;
const THREADS_RESPONSE_TARGET_BYTES: usize = 20_000;

#[test]
fn review_action_input_supports_an_explicit_job_and_keeps_legacy_omission() {
    let targeted: ReviewActionInput = serde_json::from_value(serde_json::json!({
        "device_id": "device-a",
        "review_job_id": "review-a"
    }))
    .expect("review resolve requests can target a job");
    assert_eq!(targeted.review_job_id.as_deref(), Some("review-a"));

    let input: ReviewActionInput =
        serde_json::from_value(serde_json::json!({ "device_id": "device-a" }))
            .expect("legacy review actions may omit the job with one active review");

    assert_eq!(input.device_id.as_deref(), Some("device-a"));
    assert_eq!(input.review_job_id, None);
}

fn make_snapshot() -> SessionSnapshot {
    SessionSnapshot {
        provider_fork_capabilities: Vec::new(),
        revision: 7,
        transcript_revision: 3,
        server_time: 11,
        provider: "codex".to_string(),
        service_ready: true,
        provider_connected: true,
        broker_connected: true,
        broker_channel_id: Some("room".to_string()),
        broker_peer_id: Some("relay".to_string()),
        security_mode: SecurityMode::Private,
        e2ee_enabled: true,
        broker_can_read_content: false,
        audit_enabled: false,
        active_thread_id: Some("thread-1".to_string()),
        active_controller_device_id: Some("device-1".to_string()),
        active_controller_last_seen_at: Some(1),
        controller_lease_expires_at: Some(2),
        controller_lease_seconds: 15,
        active_turn_id: Some("turn-1".to_string()),
        current_status: "idle".to_string(),
        current_phase: None,
        current_tool: None,
        last_progress_at: None,
        active_flags: vec![],
        thread_activity: vec![],
        current_cwd: "/tmp/project".to_string(),
        model: "gpt-5.4".to_string(),
        available_models: vec![],
        approval_policy: "untrusted".to_string(),
        sandbox: "workspace-write".to_string(),
        reasoning_effort: "medium".to_string(),
        allowed_roots: vec![],
        device_records: vec![],
        paired_devices: vec![],
        pending_pairing_requests: vec![],
        pending_ask_user_questions: vec![],
        pending_approvals: vec![ApprovalRequestView {
            request_id: "approval-1".to_string(),
            thread_id: "thread-1".to_string(),
            kind: "file_change".to_string(),
            summary: "S".repeat(320),
            detail: Some("D".repeat(1_200)),
            command: Some("C".repeat(1_200)),
            cwd: Some("/tmp/project".to_string()),
            context_preview: Some("P".repeat(3_000)),
            requested_permissions: None,
            available_decisions: vec!["approve".to_string(), "deny".to_string()],
            supports_session_scope: true,
        }],
        transcript_truncated: false,
        transcript: (0..30)
            .map(|index| TranscriptEntryView {
                item_id: Some(format!("item-{index}")),
                kind: TranscriptEntryKind::AgentText,
                text: Some("x".repeat(4500 + index)),
                status: "completed".to_string(),
                turn_id: Some(format!("turn-{index}")),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            })
            .collect(),
        logs: (0..30)
            .map(|index| LogEntryView {
                kind: "info".to_string(),
                message: format!("log-{index}"),
                created_at: index,
                // Mark these helper logs remote_safe so the existing budget/size
                // assertions exercise the truncation path, not the operator-only
                // confidentiality strip (covered by a dedicated test below).
                remote_safe: true,
            })
            .collect(),
        active_review_jobs: vec![],
        reviewer_threads: vec![],
        reviews_revision: 0,
        push_vapid_public_key: None,
    }
}

#[test]
fn compaction_preserves_reviews_revision_so_the_panel_can_refetch() {
    // The reviewer panel reads its cards from a dedicated (uncompacted) reviews channel and
    // re-fetches only when `reviews_revision` changes. That scalar MUST survive snapshot
    // compaction even when the high-churn `active_review_jobs` cards are drained under
    // transcript pressure (a live turn) — otherwise the client can't tell when to refresh
    // and the panel goes stale/empty (the live bug: cards vanish during live turns).
    let mut snapshot = make_snapshot();
    snapshot.reviews_revision = 4242;
    // make_snapshot()'s oversized transcript forces the byte-budget drain on RemoteSurface.
    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);
    assert_eq!(
        compacted.reviews_revision, 4242,
        "the reviews cache-key revision must survive compaction (it's the panel's refetch signal)"
    );
}

#[test]
fn compact_for_broker_limits_logs_and_transcript() {
    let compacted = make_snapshot().compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert!(compacted.transcript_truncated);
    assert!(compacted.logs.len() <= MAX_BROKER_LOGS);
    assert!(compacted.transcript.len() <= MAX_BROKER_TRANSCRIPT_ENTRIES);
    assert!(compacted
        .transcript
        .first()
        .and_then(|entry| entry.turn_id.as_deref())
        .map(|turn_id| turn_id != "turn-0")
        .unwrap_or(false));
    assert!(compacted.transcript.iter().all(|entry| {
        entry
            .text
            .as_ref()
            .map(|text| text.chars().count() <= MAX_BROKER_TRANSCRIPT_CHARS)
            .unwrap_or(true)
    }));
    assert!(compacted.pending_approvals[0].summary.chars().count() <= 140);
    assert!(compacted.pending_approvals[0]
        .detail
        .as_ref()
        .map(|value| value.chars().count() <= 320)
        .unwrap_or(true));
    assert!(compacted.pending_approvals[0]
        .command
        .as_ref()
        .map(|value| value.chars().count() <= 320)
        .unwrap_or(true));
    assert!(compacted.pending_approvals[0]
        .context_preview
        .as_ref()
        .map(|value| value.chars().count() <= 800)
        .unwrap_or(true));
    assert!(serde_json::to_vec(&compacted).unwrap().len() <= SESSION_SNAPSHOT_TARGET_BYTES);
}

#[test]
fn compact_for_broker_keeps_only_active_parent_reviewers() {
    // Broker-bound (remote/iOS) snapshots keep ONLY the active parent's reviewers —
    // all the remote reuse picker needs — so the full cross-parent map (which could
    // grow unbounded) never blows the frame budget. make_snapshot's active thread is
    // "thread-1".
    let mut snapshot = make_snapshot();
    let reviewer = |id: &str, parent: &str| ReviewerThreadView {
        reviewer_thread_id: id.to_string(),
        parent_thread_id: parent.to_string(),
        reviewer_provider: Some("codex".to_string()),
        name: Some(id.to_string()),
        updated_at: Some(1),
    };
    snapshot.reviewer_threads = vec![
        reviewer("active-rev-1", "thread-1"),
        reviewer("active-rev-2", "thread-1"),
        reviewer("other-rev", "thread-99"),
    ];

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);
    let ids: Vec<&str> = compacted
        .reviewer_threads
        .iter()
        .map(|view| view.reviewer_thread_id.as_str())
        .collect();
    assert_eq!(
        ids,
        vec!["active-rev-1", "active-rev-2"],
        "remote keeps only the active parent's reviewers; other parents are dropped"
    );
}

#[test]
fn compact_for_broker_with_no_active_thread_keeps_reviewers() {
    // REPRO (remote bug #2): the active-parent scoping uses
    //     retain(|view| Some(&view.parent_thread_id) == active.as_ref())
    // which, when there is NO active thread (`active_thread_id == None`, a state the
    // broker DOES broadcast — broker.rs `active_thread_id.as_deref().unwrap_or("-")`),
    // compares `Some(parent) == None` and is ALWAYS false. So every reviewer thread is
    // stripped from the remote snapshot the moment the relay has no active thread, even
    // though there are real reviewer threads behind real review jobs. With no active
    // parent to scope by, the scoping should be a no-op (there's nothing to narrow to),
    // not a total wipe — otherwise the remote reuse picker / reviewer panel goes empty.
    let mut snapshot = make_snapshot();
    snapshot.active_thread_id = None;
    let reviewer = |id: &str, parent: &str| ReviewerThreadView {
        reviewer_thread_id: id.to_string(),
        parent_thread_id: parent.to_string(),
        reviewer_provider: Some("codex".to_string()),
        name: Some(id.to_string()),
        updated_at: Some(1),
    };
    snapshot.reviewer_threads = vec![reviewer("rev-1", "thread-1"), reviewer("rev-2", "thread-2")];

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);
    assert!(
        !compacted.reviewer_threads.is_empty(),
        "with no active thread to scope to, the remote snapshot must NOT strip every \
reviewer thread (got {} reviewers)",
        compacted.reviewer_threads.len()
    );
}

#[test]
fn compact_for_local_web_keeps_reviewer_threads() {
    // The LOCAL snapshot path (/api/session + SSE) is the ONLY surface whose
    // delete/archive prompt reads `reviewer_threads`. Stripping it here would make
    // the frontend think there are no reviewers and silently skip the confirmation,
    // so LocalWeb must preserve the map.
    let mut snapshot = make_snapshot();
    snapshot.reviewer_threads = vec![
        ReviewerThreadView {
            reviewer_thread_id: "reviewer-1".to_string(),
            parent_thread_id: "parent-1".to_string(),
            reviewer_provider: Some("codex".to_string()),
            name: Some("Reviewer one".to_string()),
            updated_at: Some(42),
        },
        // A reviewer of a NON-active parent — local must still keep it (the
        // delete/archive prompt works on any thread, not just the active one).
        ReviewerThreadView {
            reviewer_thread_id: "reviewer-2".to_string(),
            parent_thread_id: "parent-2".to_string(),
            reviewer_provider: Some("codex".to_string()),
            name: Some("Reviewer two".to_string()),
            updated_at: Some(7),
        },
    ];

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::LocalWeb);
    assert_eq!(
        compacted.reviewer_threads.len(),
        2,
        "LocalWeb keeps every thread's reviewers (not just the active parent's)"
    );
    // Enrichment fields (provider/name/updated_at) ride along on the kept path so
    // the reuse picker can filter + label.
    assert_eq!(
        compacted.reviewer_threads[0].reviewer_provider.as_deref(),
        Some("codex"),
        "LocalWeb keeps the enriched reviewer_provider for the reuse picker"
    );
}

#[test]
fn local_web_control_plane_metadata_does_not_shell_normal_live_transcript() {
    // Regression capture for the live UI showing 24-character assistant-message
    // fragments while the authoritative transcript endpoint still held full text.
    // The trigger is not a large transcript entry: accumulated review/device
    // metadata consumes the LocalWeb snapshot budget and the final compaction
    // fallback shells otherwise-normal live messages.
    let mut snapshot = make_snapshot();
    snapshot.pending_approvals.clear();
    snapshot.logs.clear();
    snapshot.transcript = (0..4)
        .map(|index| TranscriptEntryView {
            item_id: Some(format!("assistant:live-message-{index}")),
            kind: TranscriptEntryKind::AgentText,
            text: Some(format!(
                "Live assistant message {index} must remain readable while transcript hydration is pending."
            )),
            status: "completed".to_string(),
            turn_id: Some("turn-live".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        })
        .collect();
    snapshot.active_review_jobs = (0..15)
        .map(|index| ReviewJobView {
            id: format!("review-job-{index:02}-{}", "a".repeat(28)),
            parent_thread_id: format!("parent-thread-{index:02}-{}", "b".repeat(24)),
            reviewer_provider: "claude_code".to_string(),
            reviewer_model: Some("claude-opus-4-6".to_string()),
            reviewer_effort: Some("high".to_string()),
            reviewer_thread_id: Some(format!("reviewer-thread-{index:02}-{}", "c".repeat(22))),
            status: "completed".to_string(),
            error: None,
            updated_at: 1_750_000_000 + index,
            round: 1,
            max_rounds: 3,
            verdict: Some("review completed with no blocking findings".to_string()),
        })
        .collect();
    snapshot.reviewer_threads = (0..17)
        .map(|index| ReviewerThreadView {
            reviewer_thread_id: format!("reviewer-thread-{index:02}-{}", "d".repeat(22)),
            parent_thread_id: format!("parent-thread-{index:02}-{}", "e".repeat(24)),
            reviewer_provider: Some("claude_code".to_string()),
            name: Some(format!("Independent Claude review {index:02}")),
            updated_at: Some(1_750_000_000 + index),
        })
        .collect();
    snapshot.device_records = (0..11)
        .map(|index| DeviceRecordView {
            device_id: format!("device-{index:02}-{}", "f".repeat(28)),
            label: format!("Browser device {index:02} {}", "workstation".repeat(3)),
            lifecycle_state: DeviceLifecycleState::Approved,
            created_at: 1_750_000_000 + index,
            state_changed_at: 1_750_000_100 + index,
            last_seen_at: Some(1_750_000_200 + index),
            last_peer_id: Some(format!("peer-{index:02}-{}", "9".repeat(30))),
            broker_join_ticket_expires_at: Some(1_750_003_600 + index),
            fingerprint: Some(format!("sha256:{}", "0".repeat(48))),
            path_scope: vec![format!(
                "/Users/example/workspaces/review-project-{index:02}/subdirectory"
            )],
        })
        .collect();

    let original_texts = snapshot
        .transcript
        .iter()
        .map(|entry| entry.text.clone())
        .collect::<Vec<_>>();
    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::LocalWeb);
    let compacted_texts = compacted
        .transcript
        .iter()
        .map(|entry| entry.text.clone())
        .collect::<Vec<_>>();

    assert_eq!(
        compacted_texts, original_texts,
        "unrelated review/device metadata must not turn normal live messages into \
         {EMERGENCY_TRANSCRIPT_SHELL_CHARS}-character emergency shells"
    );
    // The live messages stay authoritative `Full` (never downgraded to Preview
    // or Omitted) because the control-plane caps protect the transcript budget.
    assert!(
        compacted
            .transcript
            .iter()
            .all(|entry| entry.content_state == TranscriptContentState::Full),
        "normal live messages must keep content_state Full"
    );
    // ...and LocalWeb still respects its hard byte cap (no longer a soft target).
    assert!(serde_json::to_vec(&compacted).unwrap().len() <= LOCAL_SESSION_SNAPSHOT_TARGET_BYTES);
}

#[test]
fn emit_cross_layer_compacted_snapshot_fixture() {
    // P1.8 cross-layer harness: the frontend hydration/renderer regressions must
    // run against a REAL relay-compacted snapshot, not a separately hand-authored
    // JS fixture that can silently drift from the Rust contract. This test is the
    // single source of truth: it builds two realistic compacted snapshots
    // (RemoteSurface with omitted shells, LocalWeb with a preview + full mix) plus
    // the authoritative full entries a page fetch would return, and writes them to
    // a committed fixture the JS cross-layer test consumes verbatim.
    //
    // Without UPDATE_FIXTURES it asserts the committed bytes still match freshly
    // compacted output, so any change to the Rust compaction contract fails here
    // until the fixture (and the JS expectations) are regenerated.
    let authoritative_entries: Vec<TranscriptEntryView> = vec![
        TranscriptEntryView {
            item_id: Some("u-omitted".to_string()),
            kind: TranscriptEntryKind::UserText,
            text: Some("please summarize the whole project in detail".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-omitted".to_string()),
            tool: None,
            content_state: TranscriptContentState::Full,
        },
        TranscriptEntryView {
            item_id: Some("a-omitted".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some(format!(
                "The relay boots with the complete provider and transcript state. {}",
                "It then streams deltas as the turn progresses. ".repeat(40)
            )),
            status: "completed".to_string(),
            turn_id: Some("turn-omitted".to_string()),
            tool: None,
            content_state: TranscriptContentState::Full,
        },
    ];

    // RemoteSurface snapshot whose only over-budget bulk is an unfixable
    // non-transcript field (a giant cwd): the tail survives as omitted identity
    // shells, never an empty transcript.
    let mut remote = make_snapshot();
    remote.logs.clear();
    remote.pending_approvals.clear();
    remote.reviewer_threads.clear();
    remote.active_review_jobs.clear();
    remote.device_records.clear();
    remote.active_thread_id = Some("thread-omitted".to_string());
    remote.current_cwd = "/tmp/".to_string() + &"超长路径".repeat(3_000);
    remote.transcript = authoritative_entries.clone();
    remote.transcript_truncated = false;
    let remote_compacted = remote.compact_for(SessionSnapshotCompactProfile::RemoteSurface);
    assert!(
        remote_compacted
            .transcript
            .iter()
            .all(|entry| entry.content_state == TranscriptContentState::Omitted),
        "fixture scenario must actually omit the tail"
    );

    // LocalWeb snapshot with a long (preview) message, a short message whose
    // genuine text ends in "..." (must stay full), and a short full message.
    let mut local = make_snapshot();
    local.logs.clear();
    local.pending_approvals.clear();
    local.reviewer_threads.clear();
    local.active_review_jobs.clear();
    local.device_records.clear();
    local.active_thread_id = Some("thread-preview".to_string());
    local.current_cwd = "/tmp/project".to_string();
    local.transcript = vec![
        TranscriptEntryView {
            item_id: Some("u-preview".to_string()),
            kind: TranscriptEntryKind::UserText,
            text: Some("walk me through it...".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-preview".to_string()),
            tool: None,
            content_state: TranscriptContentState::Full,
        },
        TranscriptEntryView {
            item_id: Some("a-preview-long".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some(format!("Detailed answer. {}", "More detail. ".repeat(400))),
            status: "completed".to_string(),
            turn_id: Some("turn-preview".to_string()),
            tool: None,
            content_state: TranscriptContentState::Full,
        },
        TranscriptEntryView {
            item_id: Some("a-preview-short".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some("done, hope that helps...".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-preview".to_string()),
            tool: None,
            content_state: TranscriptContentState::Full,
        },
    ];
    local.transcript_truncated = false;
    let local_compacted = local.compact_for(SessionSnapshotCompactProfile::LocalWeb);

    let payload = serde_json::json!({
        "_comment": "Generated by relay-server protocol_tests::emit_cross_layer_compacted_snapshot_fixture. \
                     Regenerate with UPDATE_FIXTURES=1 cargo test -p relay-server emit_cross_layer_compacted_snapshot_fixture.",
        "remote_omitted_snapshot": remote_compacted,
        "remote_omitted_authoritative_entries": authoritative_entries,
        "local_preview_snapshot": local_compacted,
    });
    let pretty = serde_json::to_string_pretty(&payload).unwrap() + "\n";

    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-fixtures/protocol/cross_layer_compacted_snapshots.json"
    );
    if std::env::var("UPDATE_FIXTURES").is_ok() {
        std::fs::write(path, &pretty).expect("write cross-layer fixture");
    } else {
        let existing = std::fs::read_to_string(path).unwrap_or_default();
        assert_eq!(
            existing, pretty,
            "cross-layer compacted-snapshot fixture is stale; regenerate with \
             UPDATE_FIXTURES=1 cargo test -p relay-server emit_cross_layer_compacted_snapshot_fixture"
        );
    }
}

#[test]
fn long_session_snapshot_stays_bounded_in_bytes_and_entry_count() {
    // Perf regression: a long-lived session (1000 transcript entries) plus a
    // control-plane flood must still compact to a snapshot that is bounded in
    // BOTH serialized bytes (transport budget) and transcript entry count (what
    // the client parses and mounts). The omitted-content contract keeps the
    // snapshot a bounded identity/tail projection; the full bodies ride the
    // page/detail channel instead.
    let make_long = || {
        let mut snapshot = make_snapshot();
        snapshot.logs.clear();
        snapshot.pending_approvals.clear();
        snapshot.transcript = (0..1_000)
            .map(|index| TranscriptEntryView {
                item_id: Some(format!("item-{index:04}")),
                kind: if index % 2 == 0 {
                    TranscriptEntryKind::UserText
                } else {
                    TranscriptEntryKind::AgentText
                },
                text: Some(format!("turn {index}: {}", "lorem ipsum dolor ".repeat(60))),
                status: "completed".to_string(),
                turn_id: Some(format!("turn-{index}")),
                tool: None,
                content_state: TranscriptContentState::Full,
            })
            .collect();
        snapshot.reviewer_threads = (0..200)
            .map(|index| ReviewerThreadView {
                reviewer_thread_id: format!("reviewer-{index:03}"),
                parent_thread_id: "thread-1".to_string(),
                reviewer_provider: Some("claude_code".to_string()),
                name: Some(format!("review {index}")),
                updated_at: Some(1_750_000_000 + index),
            })
            .collect();
        snapshot
    };

    for (profile, byte_cap, max_entries) in [
        (
            SessionSnapshotCompactProfile::RemoteSurface,
            SESSION_SNAPSHOT_TARGET_BYTES,
            MAX_BROKER_TRANSCRIPT_ENTRIES,
        ),
        (
            SessionSnapshotCompactProfile::LocalWeb,
            LOCAL_SESSION_SNAPSHOT_TARGET_BYTES,
            8usize,
        ),
    ] {
        let compacted = make_long().compact_for(profile);
        let bytes = serde_json::to_vec(&compacted).unwrap().len();
        assert!(
            bytes <= byte_cap,
            "long-session snapshot blew the byte cap: {bytes} > {byte_cap}"
        );
        assert!(
            compacted.transcript.len() <= max_entries,
            "long-session snapshot mounted too many rows: {} > {max_entries}",
            compacted.transcript.len()
        );
        assert!(
            compacted.transcript_truncated,
            "a 1000-entry session must report truncation"
        );
        // The tail is preserved (newest entries), so the client hydrates older
        // pages rather than losing the live conversation.
        assert_eq!(
            compacted
                .transcript
                .last()
                .and_then(|e| e.item_id.as_deref()),
            Some("item-0999")
        );
    }
}

#[test]
fn compact_shelled_entries_are_marked_omitted_not_inferred_from_ellipsis() {
    // P1.1/P1.2: when an unfixable oversized non-transcript field (a giant cwd)
    // forces the surviving tail into the emergency shell, each entry must carry
    // an EXPLICIT `content_state: omitted` — the client must never have to infer
    // omission from a trailing "...". Identity (item_id/kind/status/turn_id) is
    // preserved so the client can render a loading placeholder in place.
    let mut snapshot = make_snapshot();
    snapshot.current_cwd = "/tmp/".to_string() + &"超长路径".repeat(3_000);
    snapshot.logs.clear();
    snapshot.pending_approvals.clear();
    snapshot.transcript = (0..3)
        .map(|index| TranscriptEntryView {
            item_id: Some(format!("item-{index}")),
            kind: TranscriptEntryKind::AgentText,
            // Note: this content does NOT end in "..." — yet it is omitted. The
            // omission signal is the explicit state, not a string suffix.
            text: Some(format!(
                "normal assistant message {index} without any ellipsis"
            )),
            status: "completed".to_string(),
            turn_id: Some(format!("turn-{index}")),
            tool: None,
            content_state: TranscriptContentState::Full,
        })
        .collect();

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert_eq!(compacted.transcript.len(), 3);
    assert!(compacted.transcript_truncated);
    for (index, entry) in compacted.transcript.iter().enumerate() {
        assert_eq!(
            entry.content_state,
            TranscriptContentState::Omitted,
            "shelled entry {index} must be explicitly omitted"
        );
        assert_eq!(
            entry.item_id.as_deref(),
            Some(format!("item-{index}").as_str()),
            "identity must survive omission"
        );
        assert_eq!(entry.status, "completed");
    }
}

#[test]
fn compact_marks_ellipsis_truncated_entry_preview_and_leaves_short_full() {
    // P1.1/P1.2: a long entry clipped to the per-entry budget is `Preview`
    // (readable, hydrate for the rest). A short entry is untouched and stays
    // `Full` — INCLUDING one whose genuine text legitimately ends in "...", which
    // must never be misclassified as truncated.
    let mut snapshot = make_snapshot();
    snapshot.logs.clear();
    snapshot.pending_approvals.clear();
    snapshot.transcript_truncated = false;
    snapshot.transcript = vec![
        TranscriptEntryView {
            item_id: Some("short-ellipsis".to_string()),
            kind: TranscriptEntryKind::AgentText,
            // A real, complete answer that happens to trail off in an ellipsis.
            text: Some("Sure — let me think about that...".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: None,
            content_state: TranscriptContentState::Full,
        },
        TranscriptEntryView {
            item_id: Some("long".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some("L".repeat(MAX_BROKER_TRANSCRIPT_CHARS * 4)),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: None,
            content_state: TranscriptContentState::Full,
        },
    ];

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    let short = &compacted.transcript[0];
    assert_eq!(
        short.content_state,
        TranscriptContentState::Full,
        "a genuine short body ending in '...' must stay Full"
    );
    assert_eq!(
        short.text.as_deref(),
        Some("Sure — let me think about that...")
    );

    let long = &compacted.transcript[1];
    assert_eq!(
        long.content_state,
        TranscriptContentState::Preview,
        "an ellipsis-truncated long body must be Preview"
    );
    assert!(long.text.as_ref().unwrap().chars().count() <= MAX_BROKER_TRANSCRIPT_CHARS);
}

#[test]
fn control_plane_flood_keeps_both_surfaces_bounded_without_shelling_live_text() {
    // P1.5/P1.6: a flood of low-frequency control-plane records (review jobs,
    // reviewer threads, device records) must NOT push normal live transcript
    // into the shell, and BOTH surfaces must stay under their hard byte cap.
    // Three short messages == the broker text-shrink floor (min 3) and below
    // LocalWeb's (min 4), so no transcript entry is dropped; the control-plane is
    // bounded/drained instead.
    let make_flooded = || {
        let mut snapshot = make_snapshot();
        snapshot.logs.clear();
        snapshot.pending_approvals.clear();
        snapshot.transcript_truncated = false;
        snapshot.transcript = (0..3)
            .map(|index| TranscriptEntryView {
                item_id: Some(format!("live-{index}")),
                kind: TranscriptEntryKind::AgentText,
                text: Some(format!("live assistant message {index}")),
                status: "completed".to_string(),
                turn_id: Some("turn-live".to_string()),
                tool: None,
                content_state: TranscriptContentState::Full,
            })
            .collect();
        snapshot.active_review_jobs = (0..120)
            .map(|index| ReviewJobView {
                id: format!("review-job-{index:03}-{}", "a".repeat(40)),
                parent_thread_id: "thread-1".to_string(),
                reviewer_provider: "claude_code".to_string(),
                reviewer_model: Some("claude-opus-4-6".to_string()),
                reviewer_effort: Some("high".to_string()),
                reviewer_thread_id: Some(format!("reviewer-thread-{index:03}")),
                // Terminal (aged-out) jobs — droppable by the cap. Matches the
                // frontend's terminal-status set ("complete", not "completed").
                status: "complete".to_string(),
                error: None,
                updated_at: 1_750_000_000 + index,
                round: 1,
                max_rounds: 3,
                verdict: Some("no blocking findings in this review round".to_string()),
            })
            .collect();
        snapshot.reviewer_threads = (0..120)
            .map(|index| ReviewerThreadView {
                reviewer_thread_id: format!("reviewer-thread-{index:03}-{}", "d".repeat(30)),
                parent_thread_id: "thread-1".to_string(),
                reviewer_provider: Some("claude_code".to_string()),
                name: Some(format!("Independent review {index:03}")),
                updated_at: Some(1_750_000_000 + index),
            })
            .collect();
        snapshot.device_records = (0..120)
            .map(|index| DeviceRecordView {
                device_id: format!("device-{index:03}-{}", "f".repeat(40)),
                label: format!("Browser device {index:03} {}", "workstation".repeat(3)),
                lifecycle_state: DeviceLifecycleState::Approved,
                created_at: 1_750_000_000 + index,
                state_changed_at: 1_750_000_100 + index,
                last_seen_at: Some(1_750_000_200 + index),
                last_peer_id: Some(format!("peer-{index:03}-{}", "9".repeat(36))),
                broker_join_ticket_expires_at: Some(1_750_003_600 + index),
                fingerprint: Some(format!("sha256:{}", "0".repeat(48))),
                path_scope: vec![format!("/Users/example/workspaces/project-{index:03}")],
            })
            .collect();
        snapshot
    };

    for (profile, cap) in [
        (
            SessionSnapshotCompactProfile::RemoteSurface,
            SESSION_SNAPSHOT_TARGET_BYTES,
        ),
        (
            SessionSnapshotCompactProfile::LocalWeb,
            LOCAL_SESSION_SNAPSHOT_TARGET_BYTES,
        ),
    ] {
        let compacted = make_flooded().compact_for(profile);
        let bytes = serde_json::to_vec(&compacted).unwrap().len();
        assert!(
            bytes <= cap,
            "control-plane flood blew the hard byte cap: {bytes} > {cap}"
        );
        // Every live message survives in full — the control-plane was bounded,
        // not the conversation.
        assert_eq!(compacted.transcript.len(), 3, "no live message was dropped");
        for (index, entry) in compacted.transcript.iter().enumerate() {
            assert_eq!(
                entry.content_state,
                TranscriptContentState::Full,
                "live message {index} must stay Full under a control-plane flood"
            );
            assert_eq!(
                entry.text.as_deref(),
                Some(format!("live assistant message {index}").as_str())
            );
        }
        // The control-plane collections are themselves bounded.
        assert!(compacted.active_review_jobs.len() <= 24);
        assert!(compacted.reviewer_threads.len() <= 48);
        assert!(compacted.device_records.len() <= 48);
    }
}

#[test]
fn control_plane_cap_keeps_actionable_device_records_not_terminal_junk() {
    // The device_records view arrives sorted Pending(0) → Approved(1) →
    // Rejected(2) → Revoked(3). When the count exceeds the cap, the cap must keep
    // the actionable HEAD (pending/approved) rather than the terminal junk tail,
    // so a pending device card never silently vanishes from the management list.
    let mut snapshot = make_snapshot();
    snapshot.logs.clear();
    snapshot.pending_approvals.clear();
    snapshot.transcript.clear();
    snapshot.transcript_truncated = false;
    let mut device_records = Vec::new();
    // One actionable pending device at the head (sort key 0)...
    device_records.push(DeviceRecordView {
        device_id: "device-pending".to_string(),
        label: "Pending phone".to_string(),
        lifecycle_state: DeviceLifecycleState::Pending,
        created_at: 1,
        state_changed_at: 1,
        last_seen_at: Some(1),
        last_peer_id: None,
        broker_join_ticket_expires_at: None,
        fingerprint: None,
        path_scope: vec![],
    });
    // ...followed by 50 approved devices, exceeding the LocalWeb cap of 48.
    for index in 0..50 {
        device_records.push(DeviceRecordView {
            device_id: format!("device-approved-{index:02}"),
            label: format!("Approved {index:02}"),
            lifecycle_state: DeviceLifecycleState::Approved,
            created_at: 10 + index,
            state_changed_at: 10 + index,
            last_seen_at: Some(10 + index),
            last_peer_id: None,
            broker_join_ticket_expires_at: None,
            fingerprint: None,
            path_scope: vec![],
        });
    }
    snapshot.device_records = device_records;

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::LocalWeb);

    assert!(compacted.device_records.len() <= 48);
    assert!(
        compacted
            .device_records
            .iter()
            .any(|record| record.device_id == "device-pending"),
        "the cap dropped the actionable pending device while keeping approved junk"
    );
}

#[test]
fn control_plane_cap_keeps_active_parent_reviewer_threads() {
    // reviewer_threads arrive sorted by reviewer_thread_id (arbitrary relative to
    // the active thread). When over the cap, the active parent's reviewers — the
    // ones the active view needs to hide/cascade — must survive even if their ids
    // sort to the dropped end. make_snapshot's active thread is "thread-1".
    let mut snapshot = make_snapshot();
    snapshot.logs.clear();
    snapshot.pending_approvals.clear();
    snapshot.transcript.clear();
    snapshot.transcript_truncated = false;
    let mut reviewer_threads = Vec::new();
    // Active-parent reviewers sit at the lexicographic HEAD (ids "00*").
    for index in 0..2 {
        reviewer_threads.push(ReviewerThreadView {
            reviewer_thread_id: format!("reviewer-00{index}"),
            parent_thread_id: "thread-1".to_string(),
            reviewer_provider: Some("claude_code".to_string()),
            name: Some(format!("active review {index}")),
            updated_at: Some(1),
        });
    }
    // 60 other-parent reviewers push the total over the LocalWeb cap of 48.
    for index in 0..60 {
        reviewer_threads.push(ReviewerThreadView {
            reviewer_thread_id: format!("reviewer-{index:03}-other"),
            parent_thread_id: format!("other-parent-{index:02}"),
            reviewer_provider: Some("claude_code".to_string()),
            name: Some(format!("other review {index}")),
            updated_at: Some(1),
        });
    }
    snapshot.reviewer_threads = reviewer_threads;

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::LocalWeb);

    assert!(compacted.reviewer_threads.len() <= 48);
    let active_kept = compacted
        .reviewer_threads
        .iter()
        .filter(|view| view.parent_thread_id == "thread-1")
        .count();
    assert_eq!(
        active_kept, 2,
        "the cap dropped the active parent's reviewer threads"
    );
}

#[test]
fn compact_for_broker_stays_under_budget_even_with_oversized_cwd() {
    // Review finding F3: the reduction loop shells the transcript and then exits,
    // so a single oversized non-transcript string field (here current_cwd) could
    // leave the frame over budget. The hard-cap profiles must clamp it so the
    // returned snapshot honors the byte target.
    let mut snapshot = make_snapshot();
    snapshot.logs.clear();
    snapshot.pending_approvals.clear();
    snapshot.reviewer_threads.clear();
    snapshot.active_review_jobs.clear();
    snapshot.device_records.clear();
    snapshot.transcript = vec![TranscriptEntryView {
        item_id: Some("a1".to_string()),
        kind: TranscriptEntryKind::AgentText,
        text: Some("short answer".to_string()),
        status: "completed".to_string(),
        turn_id: Some("turn-1".to_string()),
        tool: None,
        content_state: TranscriptContentState::Full,
    }];
    snapshot.current_cwd = "/tmp/".to_string() + &"超长路径".repeat(4_000);

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    let bytes = serde_json::to_vec(&compacted).unwrap().len();
    assert!(
        bytes <= SESSION_SNAPSHOT_TARGET_BYTES,
        "an oversized cwd left the broker snapshot over budget: {bytes} bytes"
    );
    assert!(compacted.current_cwd.starts_with("/tmp/"));
}

#[test]
fn control_plane_cap_keeps_non_terminal_review_jobs() {
    // Review finding F2: the active_review_jobs cap keeps the newest by
    // updated_at, but a non-terminal (running/blocked) job has an OLD updated_at
    // and would be dropped while newer terminal jobs survive. The UI derives the
    // blocked-review alert and send/lock gating from this global list
    // (review-state.js), so a non-terminal job must never be dropped by the cap.
    let mut snapshot = make_snapshot();
    snapshot.logs.clear();
    snapshot.pending_approvals.clear();
    snapshot.transcript.clear();
    snapshot.transcript_truncated = false;
    let mut jobs = Vec::new();
    // One old BLOCKED (non-terminal) job at the head (oldest updated_at)...
    jobs.push(ReviewJobView {
        id: "review-blocked".to_string(),
        parent_thread_id: "background-thread".to_string(),
        reviewer_provider: "claude_code".to_string(),
        reviewer_model: Some("claude-opus-4-6".to_string()),
        reviewer_effort: Some("high".to_string()),
        reviewer_thread_id: Some("reviewer-blocked".to_string()),
        status: "blocked".to_string(),
        error: None,
        updated_at: 1,
        round: 1,
        max_rounds: 3,
        verdict: None,
    });
    // ...followed by 30 newer terminal (complete) jobs, exceeding the broker cap.
    for index in 0..30 {
        jobs.push(ReviewJobView {
            id: format!("review-complete-{index:02}"),
            parent_thread_id: format!("thread-{index:02}"),
            reviewer_provider: "claude_code".to_string(),
            reviewer_model: Some("claude-opus-4-6".to_string()),
            reviewer_effort: Some("high".to_string()),
            reviewer_thread_id: Some(format!("reviewer-{index:02}")),
            status: "complete".to_string(),
            error: None,
            updated_at: 1_000 + index,
            round: 1,
            max_rounds: 3,
            verdict: Some("no blocking findings".to_string()),
        });
    }
    snapshot.active_review_jobs = jobs;

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert!(
        compacted
            .active_review_jobs
            .iter()
            .any(|job| job.status == "blocked"),
        "the cap dropped a non-terminal (blocked) review job while keeping terminal ones"
    );
}

#[test]
fn delete_thread_input_body_resolves_reviewer_choice() {
    // The delete/archive HTTP handlers resolve their optional body with
    // `body.and_then(|Json(input)| input.delete_reviewers)`. Pin every case so a
    // bodyless or empty request can never be misread as an explicit choice — that's
    // what makes archive's "no body → keep" default non-destructive.

    // A bodyless request: Axum's `Option<Json<_>>` extractor yields `None`, so the
    // resolved choice is `None` ("no explicit choice").
    let bodyless: Option<DeleteThreadInput> = None;
    assert_eq!(bodyless.and_then(|input| input.delete_reviewers), None);

    // An empty JSON object: `#[serde(default)]` leaves the field absent → `None`, so
    // a client that posts `{}` is also treated as "no explicit choice".
    let empty: DeleteThreadInput = serde_json::from_str("{}").expect("empty object decodes");
    assert_eq!(empty.delete_reviewers, None);

    // Explicit choices round-trip unchanged.
    let yes: DeleteThreadInput =
        serde_json::from_str(r#"{"delete_reviewers": true}"#).expect("true decodes");
    assert_eq!(yes.delete_reviewers, Some(true));
    let no: DeleteThreadInput =
        serde_json::from_str(r#"{"delete_reviewers": false}"#).expect("false decodes");
    assert_eq!(no.delete_reviewers, Some(false));
}

#[test]
fn compact_for_local_web_limits_snapshot_size() {
    let compacted = make_snapshot().compact_for(SessionSnapshotCompactProfile::LocalWeb);

    assert!(compacted.transcript_truncated);
    assert!(compacted.transcript.len() <= 8);
    assert!(serde_json::to_vec(&compacted).unwrap().len() <= LOCAL_SESSION_SNAPSHOT_TARGET_BYTES);
}

#[test]
fn compact_for_surfaces_truncates_a_single_oversized_agent_message() {
    // Where the streaming-tail bug begins: a single long final assistant message
    // is ellipsis-truncated and flips transcript_truncated, so the surface can
    // only recover the full text by re-hydrating. Short entries are left intact
    // and nothing is dropped. Documents the exact per-entry threshold the
    // frontend re-hydration gate must react to.
    for (profile, max_chars) in [
        (
            SessionSnapshotCompactProfile::RemoteSurface,
            MAX_BROKER_TRANSCRIPT_CHARS,
        ),
        (SessionSnapshotCompactProfile::LocalWeb, 1_600usize),
    ] {
        let mut snapshot = make_snapshot();
        snapshot.logs = vec![];
        snapshot.pending_approvals = vec![];
        snapshot.transcript_truncated = false;
        snapshot.transcript = vec![
            TranscriptEntryView {
                item_id: Some("u1".to_string()),
                kind: TranscriptEntryKind::UserText,
                text: Some("summarize the repo".to_string()),
                status: "completed".to_string(),
                turn_id: Some("turn-1".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            },
            TranscriptEntryView {
                item_id: Some("a1".to_string()),
                kind: TranscriptEntryKind::AgentText,
                text: Some("Z".repeat(max_chars * 4)),
                status: "completed".to_string(),
                turn_id: Some("turn-1".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            },
        ];

        let compacted = snapshot.compact_for(profile);

        // Both entries survive — nothing is dropped at this size.
        assert_eq!(compacted.transcript.len(), 2);
        // The short user message is untouched.
        assert_eq!(
            compacted.transcript[0].text.as_deref(),
            Some("summarize the repo")
        );
        // The long final message is ellipsis-truncated and the snapshot flagged.
        assert!(compacted.transcript_truncated);
        let agent_text = compacted.transcript[1].text.as_deref().unwrap();
        assert!(agent_text.chars().count() <= max_chars);
        assert!(agent_text.ends_with("..."));
    }
}

#[test]
fn compact_for_ios_surface_currently_reuses_remote_budget() {
    let ios = make_snapshot().compact_for(SessionSnapshotCompactProfile::IosSurface);
    let remote = make_snapshot().compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert_eq!(ios.transcript.len(), remote.transcript.len());
    assert_eq!(ios.logs.len(), remote.logs.len());
    assert_eq!(ios.transcript_truncated, remote.transcript_truncated);
    assert_eq!(
        serde_json::to_vec(&ios).unwrap().len(),
        serde_json::to_vec(&remote).unwrap().len()
    );
}

#[test]
fn compact_for_broker_drops_operator_only_logs_but_keeps_remote_safe() {
    // P1 confidentiality: the global `logs` buffer aggregates lines across ALL
    // threads/cwds and a broker-bound snapshot is broadcast to EVERY paired
    // device regardless of its `path_scope`. An out-of-scope thread's
    // identifying log line must not ride to a device scoped elsewhere, while a
    // line explicitly cleared for remote (`remote_safe`) still rides.
    let mut snapshot = make_snapshot();
    // Trim heavy fields so the snapshot is comfortably under the broker byte
    // budget: the ONLY reason a log can disappear here is the operator-only
    // strip, never size pressure.
    snapshot.transcript = vec![];
    snapshot.transcript_truncated = false;
    snapshot.pending_approvals = vec![];
    snapshot.current_cwd = "/tmp/p".to_string();
    snapshot.logs = vec![
        // Operator-only line that identifies an out-of-scope thread + its cwd
        // (mirrors the real `Claude session: {sid}` operator log).
        LogEntryView {
            kind: "info".to_string(),
            message: "Claude session: sess-out-of-scope (/srv/other-project)".to_string(),
            created_at: 2,
            remote_safe: false,
        },
        // A generic operational line explicitly cleared for remote surfaces.
        LogEntryView {
            kind: "info".to_string(),
            message: "remote-safe-operational-line".to_string(),
            created_at: 1,
            remote_safe: true,
        },
    ];

    for profile in [
        SessionSnapshotCompactProfile::RemoteSurface,
        SessionSnapshotCompactProfile::IosSurface,
    ] {
        let compacted = snapshot.clone().compact_for(profile);
        let messages: Vec<&str> = compacted.logs.iter().map(|l| l.message.as_str()).collect();
        assert!(
            !messages.iter().any(|m| m.contains("out-of-scope")),
            "operator-only log leaked to a broker-bound surface: {messages:?}"
        );
        assert!(
            messages.contains(&"remote-safe-operational-line"),
            "remote_safe log was dropped from a broker-bound surface: {messages:?}"
        );
        // The serialized envelope carries no trace of the out-of-scope thread
        // identifier or its cwd either.
        let json = String::from_utf8(serde_json::to_vec(&compacted).unwrap()).unwrap();
        assert!(!json.contains("out-of-scope"), "leaked via serialized json");
        assert!(
            !json.contains("/srv/other-project"),
            "leaked cwd via serialized json"
        );
    }

    // The local operator surface is the operator's own view and keeps the full
    // buffer, including the operator-only line.
    let local = snapshot.compact_for(SessionSnapshotCompactProfile::LocalWeb);
    let local_messages: Vec<&str> = local.logs.iter().map(|l| l.message.as_str()).collect();
    assert!(
        local_messages.iter().any(|m| m.contains("out-of-scope")),
        "local operator surface unexpectedly dropped an operator-only log"
    );
    assert!(local_messages.contains(&"remote-safe-operational-line"));
}

#[test]
fn threads_response_compact_for_broker_limits_serialized_size() {
    let response = ThreadsResponse {
        threads: (0..120)
            .map(|index| ThreadSummaryView {
                id: format!("thread-{index}"),
                name: Some(format!("{}{}", "名".repeat(80), index)),
                preview: format!("{}{}", "预览".repeat(300), index),
                cwd: format!("/tmp/project-{index}"),
                updated_at: index as u64,
                source: "cli".to_string(),
                status: "idle".to_string(),
                model_provider: "openai".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            })
            .collect(),
    };

    let compacted = response.compact_for(ThreadsResponseCompactProfile::RemoteSurface);

    assert!(compacted.threads.len() <= MAX_BROKER_THREADS);
    assert!(compacted
        .threads
        .iter()
        .all(|thread| thread.preview.chars().count() <= MAX_BROKER_THREAD_PREVIEW_CHARS));
    assert!(serde_json::to_vec(&compacted).unwrap().len() <= THREADS_RESPONSE_TARGET_BYTES);
}

#[test]
fn threads_response_compact_for_local_web_is_less_aggressive() {
    let response = ThreadsResponse {
        threads: (0..120)
            .map(|index| ThreadSummaryView {
                id: format!("thread-{index}"),
                name: Some(format!("{}{}", "名".repeat(80), index)),
                preview: format!("{}{}", "预览".repeat(300), index),
                cwd: format!("/tmp/project-{index}"),
                updated_at: index as u64,
                source: "cli".to_string(),
                status: "idle".to_string(),
                model_provider: "openai".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            })
            .collect(),
    };

    let local = response
        .clone()
        .compact_for(ThreadsResponseCompactProfile::LocalWeb);
    let remote = response.compact_for(ThreadsResponseCompactProfile::RemoteSurface);

    assert!(local.threads.len() >= remote.threads.len());
    assert!(local
        .threads
        .iter()
        .all(|thread| thread.preview.chars().count() <= 220));
}

#[test]
fn threads_response_compact_for_ios_surface_currently_reuses_remote_budget() {
    let response = ThreadsResponse {
        threads: (0..120)
            .map(|index| ThreadSummaryView {
                id: format!("thread-{index}"),
                name: Some(format!("{}{}", "名".repeat(80), index)),
                preview: format!("{}{}", "预览".repeat(300), index),
                cwd: format!("/tmp/project-{index}"),
                updated_at: index as u64,
                source: "cli".to_string(),
                status: "idle".to_string(),
                model_provider: "openai".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            })
            .collect(),
    };

    let ios = response
        .clone()
        .compact_for(ThreadsResponseCompactProfile::IosSurface);
    let remote = response.compact_for(ThreadsResponseCompactProfile::RemoteSurface);

    assert_eq!(ios.threads.len(), remote.threads.len());
    assert_eq!(
        serde_json::to_vec(&ios).unwrap().len(),
        serde_json::to_vec(&remote).unwrap().len()
    );
}

#[test]
fn truncate_with_ellipsis_preserves_utf8_boundaries() {
    let mut value = "你好世界alpha".to_string();

    assert!(truncate_with_ellipsis(&mut value, 5));

    assert_eq!(value, "你好...");
    assert_eq!(value.chars().count(), 5);
}

#[test]
fn compact_for_broker_shells_transcript_tail_as_last_resort_without_clearing() {
    // Even when an oversized non-transcript field (here, a giant cwd that
    // compaction never truncates) keeps the snapshot over budget after every
    // other reduction, the transcript must NOT be cleared: a non-empty thread
    // serialized as `[]` is indistinguishable from a genuinely empty thread.
    let mut snapshot = make_snapshot();
    snapshot.current_cwd = "/tmp/".to_string() + &"超长路径".repeat(3_000);
    snapshot.logs = (0..4)
        .map(|index| LogEntryView {
            kind: "info".to_string(),
            message: format!("{}-{index}", "日志".repeat(600)),
            created_at: index as u64,
            // remote_safe so they reach the byte-budget reduction this test
            // asserts drops them (the operator-only strip would drop them first).
            remote_safe: true,
        })
        .collect();
    snapshot.transcript = (0..3)
        .map(|index| TranscriptEntryView {
            item_id: Some(format!("item-{index}")),
            kind: TranscriptEntryKind::AgentText,
            text: Some(format!("{}-{index}", "内容".repeat(1_500))),
            status: "completed".to_string(),
            turn_id: Some(format!("turn-{index}")),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        })
        .collect();

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert!(compacted.logs.is_empty());
    // The tail survives as identity shells, not an empty transcript.
    assert_eq!(compacted.transcript.len(), 3);
    assert!(compacted.transcript_truncated);
    for (index, entry) in compacted.transcript.iter().enumerate() {
        assert_eq!(
            entry.item_id.as_deref(),
            Some(format!("item-{index}").as_str())
        );
        assert_eq!(
            entry.turn_id.as_deref(),
            Some(format!("turn-{index}").as_str())
        );
        assert_eq!(entry.status, "completed");
        // Heavy text is clipped down to a small stub, not preserved in full.
        let text_len = entry
            .text
            .as_ref()
            .map(|text| text.chars().count())
            .unwrap_or(0);
        assert!(
            text_len <= EMERGENCY_TRANSCRIPT_SHELL_CHARS,
            "shell text should be clipped, got {text_len} chars"
        );
    }
    assert!(compacted.current_cwd.starts_with("/tmp/"));
}

#[test]
fn compact_for_broker_shells_tool_entries_dropping_heavy_content() {
    // The terminal shell path must also strip heavy tool fields (diff /
    // file_changes / previews) while keeping the entry identity.
    let mut snapshot = make_snapshot();
    snapshot.current_cwd = "/tmp/".to_string() + &"超长路径".repeat(3_000);
    snapshot.logs.clear();
    snapshot.pending_approvals.clear();
    snapshot.transcript = vec![TranscriptEntryView {
        item_id: Some("turn-diff:turn-1".to_string()),
        kind: TranscriptEntryKind::ToolCall,
        text: Some("内容".repeat(1_500)),
        status: "running".to_string(),
        turn_id: Some("turn-1".to_string()),
        tool: Some(ToolCallView {
            item_type: "turnDiff".to_string(),
            name: "turn_diff".to_string(),
            title: "Changed files".to_string(),
            detail: Some("详情".repeat(1_000)),
            query: None,
            path: None,
            url: None,
            command: None,
            input_preview: Some("输入".repeat(1_000)),
            result_preview: Some("结果".repeat(1_000)),
            diff: Some("差异".repeat(1_000)),
            file_changes: (0..40)
                .map(|index| FileChangeDiffView {
                    path: format!("src/file-{index}.rs"),
                    change_type: "modify".to_string(),
                    diff: format!("-{}\n+{}", "old".repeat(600), "new".repeat(600)),
                })
                .collect(),
            apply_state: None,
            file_changes_omitted: false,
        }),
        content_state: crate::protocol::TranscriptContentState::Full,
    }];

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert_eq!(compacted.transcript.len(), 1);
    assert!(compacted.transcript_truncated);
    let entry = &compacted.transcript[0];
    assert_eq!(entry.item_id.as_deref(), Some("turn-diff:turn-1"));
    let tool = entry.tool.as_ref().expect("tool shell should survive");
    assert_eq!(tool.name, "turn_diff");
    assert!(tool.file_changes.is_empty());
    assert!(tool.diff.is_none());
    assert!(tool.detail.is_none());
    assert!(tool.input_preview.is_none());
    assert!(tool.result_preview.is_none());
}

#[test]
fn strip_file_change_diffs_keeps_summary_and_flags_entry() {
    let mut transcript = vec![
        // A turn-diff entry with full diffs — must be reduced to a summary.
        TranscriptEntryView {
            item_id: Some("turn-diff:turn-1".to_string()),
            kind: TranscriptEntryKind::ToolCall,
            text: Some("Edited files".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: Some(ToolCallView {
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
                diff: Some("@@ joined @@".to_string()),
                file_changes: vec![
                    FileChangeDiffView {
                        path: "src/a.rs".to_string(),
                        change_type: "modify".to_string(),
                        diff: "-old\n+new".to_string(),
                    },
                    FileChangeDiffView {
                        path: "src/b.rs".to_string(),
                        change_type: "add".to_string(),
                        diff: "+added".to_string(),
                    },
                ],
                apply_state: None,
                file_changes_omitted: false,
            }),
            content_state: crate::protocol::TranscriptContentState::Full,
        },
        // A plain agent-text entry with no diff body — must be left untouched.
        TranscriptEntryView {
            item_id: Some("a1".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some("hello".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        },
    ];

    strip_file_change_diffs_for_snapshot(&mut transcript);

    let tool = transcript[0].tool.as_ref().expect("tool survives");
    assert!(tool.file_changes_omitted);
    assert!(tool.diff.is_none());
    assert_eq!(tool.file_changes.len(), 2);
    assert_eq!(tool.file_changes[0].path, "src/a.rs");
    assert_eq!(tool.file_changes[0].change_type, "modify");
    assert!(tool.file_changes[0].diff.is_empty());
    assert_eq!(tool.file_changes[1].path, "src/b.rs");
    assert!(tool.file_changes[1].diff.is_empty());

    // The non-tool entry is unchanged.
    assert_eq!(transcript[1].text.as_deref(), Some("hello"));
}

#[test]
fn compact_for_broker_shells_bring_oversized_transcript_under_budget() {
    // When the over-budget bulk is transcript content (not an unfixable giant
    // non-transcript field), reducing the tail to shells must actually get the
    // snapshot under the target — proving shelling is an effective last resort,
    // not just non-destructive.
    let mut snapshot = make_snapshot();
    snapshot.current_cwd = "/tmp/project".to_string();
    snapshot.logs.clear();
    snapshot.pending_approvals.clear();
    snapshot.transcript = (0..3)
        .map(|index| TranscriptEntryView {
            item_id: Some(format!("item-{index}")),
            kind: TranscriptEntryKind::ToolCall,
            text: Some("内容".repeat(2_000)),
            status: "running".to_string(),
            turn_id: Some(format!("turn-{index}")),
            tool: Some(ToolCallView {
                item_type: "turnDiff".to_string(),
                name: "turn_diff".to_string(),
                title: "Changed files".to_string(),
                detail: Some("详情".repeat(2_000)),
                query: None,
                path: None,
                url: None,
                command: Some("c".repeat(4_000)),
                input_preview: Some("输入".repeat(2_000)),
                result_preview: Some("结果".repeat(2_000)),
                diff: Some("差异".repeat(2_000)),
                file_changes: (0..40)
                    .map(|i| FileChangeDiffView {
                        path: format!("src/file-{i}.rs"),
                        change_type: "modify".to_string(),
                        diff: format!("-{}\n+{}", "old".repeat(600), "new".repeat(600)),
                    })
                    .collect(),
                apply_state: None,
                file_changes_omitted: false,
            }),
            content_state: crate::protocol::TranscriptContentState::Full,
        })
        .collect();

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert!(compacted.transcript_truncated);
    assert_eq!(compacted.transcript.len(), 3);
    let serialized = serde_json::to_vec(&compacted).unwrap().len();
    assert!(
        serialized <= SESSION_SNAPSHOT_TARGET_BYTES,
        "shelled snapshot should fit budget, got {serialized} bytes"
    );
    // The fat command is clipped to the shell budget rather than kept whole.
    let tool = compacted.transcript[0]
        .tool
        .as_ref()
        .expect("tool shell should survive");
    let command_len = tool
        .command
        .as_ref()
        .map(|command| command.chars().count())
        .unwrap_or(0);
    assert!(
        command_len <= EMERGENCY_TRANSCRIPT_SHELL_CHARS,
        "command shell should be clipped, got {command_len} chars"
    );
}

#[test]
fn compact_for_broker_trims_many_file_changes_without_clearing_transcript() {
    let mut snapshot = make_snapshot();
    snapshot.pending_approvals.clear();
    snapshot.logs.clear();
    snapshot.transcript = vec![TranscriptEntryView {
        item_id: Some("turn-diff:turn-1".to_string()),
        kind: TranscriptEntryKind::ToolCall,
        text: Some("Edited many files".to_string()),
        status: "running".to_string(),
        turn_id: Some("turn-1".to_string()),
        tool: Some(ToolCallView {
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
            diff: None,
            file_changes: (0..40)
                .map(|index| FileChangeDiffView {
                    path: format!("src/file-{index}.rs"),
                    change_type: "modify".to_string(),
                    diff: format!(
                        "@@ -1 +1 @@\n-{}\n+{}",
                        "old".repeat(600),
                        "new".repeat(600)
                    ),
                })
                .collect(),
            apply_state: None,
            file_changes_omitted: false,
        }),
        content_state: crate::protocol::TranscriptContentState::Full,
    }];

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert!(compacted.transcript_truncated);
    assert_eq!(compacted.transcript.len(), 1);
    assert!(compacted.transcript[0]
        .tool
        .as_ref()
        .map(|tool| tool.file_changes.len() <= 4)
        .unwrap_or(false));
    assert!(serde_json::to_vec(&compacted).unwrap().len() <= SESSION_SNAPSHOT_TARGET_BYTES);
}

#[test]
fn compact_for_local_web_preserves_large_pending_ask_user_question_losslessly() {
    let long_question = format!(
        "用户可见的标题要改成什么品牌名? {}",
        "请保留这段问题正文不要截断。".repeat(450)
    );
    let long_description = format!(
        "首字母大写, 标签页显示 Sealwire / Sealwire Remote, PWA 名同步。{}",
        "描述也必须完整保留。".repeat(220)
    );
    let mut snapshot = make_snapshot();
    snapshot.pending_approvals.clear();
    snapshot.pending_ask_user_questions = vec![AskUserQuestionRequestView::with_inline_questions(
        "ask:large".to_string(),
        "toolu_large".to_string(),
        "thread-1".to_string(),
        123,
        vec![
            AskUserQuestionView {
                question: long_question.clone(),
                header: "品牌名".to_string(),
                multi_select: false,
                options: vec![
                    AskUserOptionView {
                        label: "Sealwire".to_string(),
                        description: long_description.clone(),
                    },
                    AskUserOptionView {
                        label: "sealwire".to_string(),
                        description: "全小写, 与 AGENTS.md 里描述保持一致的写法。".to_string(),
                    },
                ],
            },
            AskUserQuestionView {
                question: "只改可见文案,还是也处理内部标识符?".to_string(),
                header: "改动范围".to_string(),
                multi_select: false,
                options: vec![AskUserOptionView {
                    label: "只改可见文案(推荐)".to_string(),
                    description: "只动 <title> 和 manifest, 内部 agent-relay 标识不动。"
                        .to_string(),
                }],
            },
        ],
    )];

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::LocalWeb);

    assert_eq!(compacted.pending_ask_user_questions.len(), 1);
    let pending = &compacted.pending_ask_user_questions[0];
    assert_eq!(pending.request_id, "ask:large");
    assert_eq!(pending.tool_use_id, "toolu_large");
    assert_eq!(pending.questions.len(), 2);
    assert_eq!(pending.questions[0].question, long_question);
    assert_eq!(pending.questions[0].header, "品牌名");
    assert!(!pending.questions[0].multi_select);
    assert_eq!(pending.questions[0].options.len(), 2);
    assert_eq!(pending.questions[0].options[0].label, "Sealwire");
    assert_eq!(
        pending.questions[0].options[0].description,
        long_description
    );
    assert_eq!(
        pending.questions[1].question,
        "只改可见文案,还是也处理内部标识符?"
    );
    assert!(serde_json::to_vec(&compacted).unwrap().len() > LOCAL_SESSION_SNAPSHOT_TARGET_BYTES);
}

#[test]
fn compact_for_broker_externalizes_large_pending_ask_user_question_detail() {
    let long_question = format!(
        "用户可见的标题要改成什么品牌名? {}",
        "问题正文通过详情接口加载。".repeat(450)
    );
    let long_description = format!(
        "首字母大写, 标签页显示 Sealwire / Sealwire Remote, PWA 名同步。{}",
        "描述也通过详情接口加载。".repeat(220)
    );
    let mut snapshot = make_snapshot();
    snapshot.pending_approvals.clear();
    snapshot.pending_ask_user_questions = vec![AskUserQuestionRequestView::with_inline_questions(
        "ask:large".to_string(),
        "toolu_large".to_string(),
        "thread-1".to_string(),
        123,
        vec![AskUserQuestionView {
            question: long_question,
            header: "品牌名".to_string(),
            multi_select: false,
            options: vec![AskUserOptionView {
                label: "Sealwire".to_string(),
                description: long_description,
            }],
        }],
    )];

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert_eq!(compacted.pending_ask_user_questions.len(), 1);
    let pending = &compacted.pending_ask_user_questions[0];
    assert_eq!(pending.request_id, "ask:large");
    assert_eq!(pending.tool_use_id, "toolu_large");
    assert_eq!(pending.question_count, 1);
    assert!(!pending.questions_inline_complete);
    assert!(pending.detail_available);
    assert!(pending.content_hash.is_some());
    assert!(pending.questions.is_empty());
    assert!(serde_json::to_vec(&compacted).unwrap().len() < SESSION_SNAPSHOT_TARGET_BYTES);
}

#[test]
fn compact_for_broker_externalizes_pending_ask_user_questions_until_snapshot_fits() {
    let mut snapshot = make_snapshot();
    snapshot.pending_approvals.clear();
    snapshot.transcript.clear();
    snapshot.logs.clear();
    snapshot.pending_ask_user_questions = (0..4)
        .map(|index| {
            AskUserQuestionRequestView::with_inline_questions(
                format!("ask:{index}"),
                format!("toolu_{index}"),
                "thread-1".to_string(),
                index,
                vec![AskUserQuestionView {
                    question: format!("Question {index}: {}", "q".repeat(2_200)),
                    header: "Pick".to_string(),
                    multi_select: false,
                    options: vec![AskUserOptionView {
                        label: "A".to_string(),
                        description: "d".repeat(200),
                    }],
                }],
            )
        })
        .collect();

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert!(serde_json::to_vec(&compacted).unwrap().len() < SESSION_SNAPSHOT_TARGET_BYTES);
    assert!(compacted
        .pending_ask_user_questions
        .iter()
        .any(|request| !request.questions_inline_complete));
    assert!(compacted.pending_ask_user_questions.iter().all(|request| {
        request.questions_inline_complete
            || (request.detail_available && request.questions.is_empty())
    }));
}

#[test]
fn compact_for_broker_preserves_existing_transcript_truncated_flag() {
    let mut snapshot = make_snapshot();
    snapshot.transcript_truncated = true;
    snapshot.logs.clear();
    snapshot.transcript = (0..4)
        .map(|index| TranscriptEntryView {
            item_id: Some(format!("item-{index}")),
            kind: TranscriptEntryKind::AgentText,
            text: Some(format!("entry-{index}")),
            status: "completed".to_string(),
            turn_id: Some(format!("turn-{index}")),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        })
        .collect();

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert!(compacted.transcript_truncated);
    assert_eq!(compacted.transcript.len(), 4);
}

#[test]
fn thread_transcript_response_preserves_oversized_single_entries() {
    let transcript = vec![
        TranscriptEntryView {
            item_id: Some("item-1".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some("长".repeat(9_500)),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        },
        TranscriptEntryView {
            item_id: Some("item-2".to_string()),
            kind: TranscriptEntryKind::UserText,
            text: Some("next".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-2".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        },
    ];

    let mut cursor = 0;
    let mut pages = Vec::new();
    loop {
        let page = ThreadTranscriptResponse::from_transcript(
            "thread-1".to_string(),
            transcript.clone(),
            cursor,
        );
        let page_bytes = serde_json::to_vec(&page).unwrap().len();
        let single_entry_page = page.entries.len() == 1;
        if !single_entry_page {
            assert!(page_bytes <= THREADS_RESPONSE_TARGET_BYTES);
        }
        assert!(!page.entries.is_empty());
        cursor = match page.next_cursor {
            Some(next_cursor) => {
                pages.push(page);
                next_cursor
            }
            None => {
                pages.push(page);
                break;
            }
        };
    }

    assert!(pages.len() >= 2);
    assert_eq!(pages[0].entries.len(), 1);
    assert_eq!(pages[0].entries[0].item_id.as_deref(), Some("item-1"));
    assert!(serde_json::to_vec(&pages[0]).unwrap().len() > THREADS_RESPONSE_TARGET_BYTES);

    let rebuilt = pages
        .into_iter()
        .flat_map(|page| page.entries.into_iter())
        .enumerate()
        .fold(
            std::collections::BTreeMap::new(),
            |mut acc, (entry_index, entry)| {
                acc.insert(entry_index, entry.text.unwrap_or_default());
                acc
            },
        );

    assert_eq!(rebuilt.get(&0).unwrap(), &"长".repeat(9_500));
    assert_eq!(rebuilt.get(&1).unwrap(), "next");
}

#[test]
fn thread_transcript_response_keeps_complete_entries_together() {
    let transcript = vec![TranscriptEntryView {
        item_id: Some("item-1".to_string()),
        kind: TranscriptEntryKind::AgentText,
        text: Some("a".repeat(4_500)),
        status: "completed".to_string(),
        turn_id: Some("turn-1".to_string()),
        tool: None,
        content_state: crate::protocol::TranscriptContentState::Full,
    }];

    let page = ThreadTranscriptResponse::from_transcript("thread-1".to_string(), transcript, 0);

    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].item_id.as_deref(), Some("item-1"));
    assert_eq!(
        page.entries[0].text.as_deref(),
        Some("a".repeat(4_500).as_str())
    );
}

#[test]
fn thread_transcript_response_can_page_backwards_from_tail() {
    let transcript = (0..12)
        .map(|index| TranscriptEntryView {
            item_id: Some(format!("item-{index}")),
            kind: TranscriptEntryKind::AgentText,
            text: Some(format!("entry-{index}-{}", "z".repeat(4500))),
            status: "completed".to_string(),
            turn_id: Some(format!("turn-{index}")),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        })
        .collect::<Vec<_>>();

    let mut before = None;
    let mut pages = Vec::new();

    loop {
        let page = ThreadTranscriptResponse::from_transcript_before(
            "thread-1".to_string(),
            transcript.clone(),
            before,
            42,
        );
        assert!(!page.entries.is_empty());
        assert_eq!(page.revision, 42);
        assert!(page.server_time > 0);
        assert!(page.entry_seq_start.is_some());
        assert!(page.entry_seq_end.is_some());
        assert!(serde_json::to_vec(&page).unwrap().len() <= THREADS_RESPONSE_TARGET_BYTES);
        before = page.prev_cursor;
        pages.push(page);
        if before.is_none() {
            break;
        }
    }

    let rebuilt = pages
        .into_iter()
        .rev()
        .flat_map(|page| page.entries.into_iter())
        .enumerate()
        .fold(
            std::collections::BTreeMap::new(),
            |mut acc, (entry_index, entry)| {
                acc.insert(entry_index, entry.text.unwrap_or_default());
                acc
            },
        );

    assert_eq!(rebuilt.len(), transcript.len());
    assert!(rebuilt.get(&0).unwrap().starts_with("entry-0-"));
    assert!(rebuilt.get(&11).unwrap().starts_with("entry-11-"));
}

#[test]
fn thread_transcript_response_packs_many_small_entries_within_budget() {
    // Many small entries is the case the incremental page sizer most affects:
    // the old code re-serialized the whole growing candidate per entry. Verify
    // pages stay within budget, pack more than one entry, and lose nothing.
    let transcript = (0..400)
        .map(|index| TranscriptEntryView {
            item_id: Some(format!("item-{index}")),
            kind: TranscriptEntryKind::AgentText,
            text: Some(format!("small entry {index}")),
            status: "completed".to_string(),
            turn_id: Some(format!("turn-{index}")),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        })
        .collect::<Vec<_>>();

    let mut before = None;
    let mut pages = Vec::new();
    let mut max_page_entries = 0usize;
    loop {
        let page = ThreadTranscriptResponse::from_transcript_before(
            "thread-1".to_string(),
            transcript.clone(),
            before,
            7,
        );
        assert!(!page.entries.is_empty());
        let page_bytes = serde_json::to_vec(&page).unwrap().len();
        assert!(
            page_bytes <= THREADS_RESPONSE_TARGET_BYTES,
            "page exceeded budget: {page_bytes} bytes"
        );
        max_page_entries = max_page_entries.max(page.entries.len());
        before = page.prev_cursor;
        pages.push(page);
        if before.is_none() {
            break;
        }
    }

    // Packing works (not one-entry-per-page).
    assert!(
        max_page_entries > 1,
        "expected multi-entry pages, got {max_page_entries}"
    );

    // Nothing lost, order preserved across the reverse walk.
    let rebuilt = pages
        .into_iter()
        .rev()
        .flat_map(|page| page.entries.into_iter())
        .map(|entry| entry.item_id.unwrap_or_default())
        .collect::<Vec<_>>();
    assert_eq!(rebuilt.len(), transcript.len());
    assert_eq!(rebuilt.first().map(String::as_str), Some("item-0"));
    assert_eq!(rebuilt.last().map(String::as_str), Some("item-399"));
}

#[test]
fn thread_transcript_page_materializes_only_entries_near_the_requested_cursor() {
    use std::cell::Cell;

    let materialized = Cell::new(0usize);
    let transcript_len = 50_000usize;
    let page = ThreadTranscriptResponse::from_transcript_source(
        "thread-large".to_string(),
        transcript_len,
        None,
        9,
        |index| {
            materialized.set(materialized.get() + 1);
            TranscriptEntryView {
                item_id: Some(format!("item-{index}")),
                kind: TranscriptEntryKind::AgentText,
                text: Some(format!("entry-{index}-{}", "x".repeat(900))),
                status: "completed".to_string(),
                turn_id: Some(format!("turn-{index}")),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            }
        },
    );

    assert!(!page.entries.is_empty());
    assert!(page.prev_cursor.is_some());
    assert_eq!(page.entry_seq_end, Some(transcript_len as u64));
    assert!(
        materialized.get() <= page.entries.len() + 1,
        "page construction touched {} entries to return {}",
        materialized.get(),
        page.entries.len()
    );
    assert!(
        materialized.get() < 64,
        "page construction scaled with transcript length: {} entries materialized",
        materialized.get()
    );
    assert!(serde_json::to_vec(&page).unwrap().len() <= THREADS_RESPONSE_TARGET_BYTES);
}

#[test]
fn thread_transcript_response_tail_returns_latest_page_first() {
    let transcript = (0..12)
        .map(|index| TranscriptEntryView {
            item_id: Some(format!("item-{index}")),
            kind: TranscriptEntryKind::AgentText,
            text: Some(format!("entry-{index}-{}", "z".repeat(4500))),
            status: "completed".to_string(),
            turn_id: Some(format!("turn-{index}")),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        })
        .collect::<Vec<_>>();

    let page = ThreadTranscriptResponse::from_transcript_tail(
        "thread-1".to_string(),
        transcript.clone(),
        42,
    );

    assert!(!page.entries.is_empty());
    assert_eq!(page.revision, 42);
    assert_eq!(page.entry_seq_end, Some(12));
    assert!(serde_json::to_vec(&page).unwrap().len() <= THREADS_RESPONSE_TARGET_BYTES);
    assert_eq!(page.next_cursor, None);
    assert!(page.prev_cursor.is_some());
    assert!(page
        .entries
        .first()
        .and_then(|entry| entry.item_id.as_deref())
        .map(|item_id| item_id != "item-0")
        .unwrap_or(false));
    assert_eq!(
        page.entries
            .last()
            .and_then(|entry| entry.item_id.as_deref()),
        Some("item-11")
    );
}

#[test]
fn thread_transcript_history_externalizes_large_file_change_diffs() {
    let large_diff = format!(
        "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-{}\n+{}",
        "old".repeat(12_000),
        "new".repeat(12_000)
    );
    let transcript = vec![TranscriptEntryView {
        item_id: Some("turn-diff:turn-1".to_string()),
        kind: TranscriptEntryKind::ToolCall,
        text: Some("Changed files".to_string()),
        status: "completed".to_string(),
        turn_id: Some("turn-1".to_string()),
        tool: Some(ToolCallView {
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
            diff: None,
            file_changes: vec![FileChangeDiffView {
                path: "src/a.rs".to_string(),
                change_type: "modify".to_string(),
                diff: large_diff,
            }],
            apply_state: None,
            file_changes_omitted: false,
        }),
        content_state: crate::protocol::TranscriptContentState::Full,
    }];

    let page = ThreadTranscriptResponse::from_transcript_before(
        "thread-1".to_string(),
        transcript,
        None,
        9,
    );
    let tool = page.entries[0].tool.as_ref().expect("tool summary");
    assert!(tool.file_changes_omitted);
    assert!(tool.diff.is_none());
    assert!(tool.file_changes[0].diff.is_empty());
    assert!(serde_json::to_vec(&page).unwrap().len() <= THREADS_RESPONSE_TARGET_BYTES);
}

#[test]
fn thread_entries_response_returns_complete_entries_for_requested_item_ids() {
    let transcript = vec![
        TranscriptEntryView {
            item_id: Some("item-1".to_string()),
            kind: TranscriptEntryKind::UserText,
            text: Some("hello".repeat(2_000)),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        },
        TranscriptEntryView {
            item_id: Some("item-2".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some("world".repeat(2_000)),
            status: "completed".to_string(),
            turn_id: Some("turn-2".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        },
    ];

    let response = ThreadEntriesResponse::from_item_ids(
        "thread-1".to_string(),
        transcript.clone(),
        vec!["item-2".to_string()],
    );

    assert_eq!(response.thread_id, "thread-1");
    assert_eq!(response.entries.len(), 1);
    assert_eq!(response.entries[0].item_id.as_deref(), Some("item-2"));
    assert_eq!(
        response.entries[0].text.as_deref(),
        transcript[1].text.as_deref()
    );
}

#[test]
fn thread_entry_detail_response_chunks_large_command_text() {
    let entry = TranscriptEntryView {
        item_id: Some("item-1".to_string()),
        kind: TranscriptEntryKind::Command,
        text: Some("x".repeat(20_000)),
        status: "completed".to_string(),
        turn_id: Some("turn-1".to_string()),
        tool: None,
        content_state: crate::protocol::TranscriptContentState::Full,
    };

    let response =
        ThreadEntryDetailResponse::from_entry("thread-1".to_string(), entry.clone()).unwrap();

    assert_eq!(response.item_id, "item-1");
    assert!(response.entry.is_some());
    assert_eq!(response.pending_fields.len(), 1);
    assert_eq!(response.pending_fields[0].field, "text");
    assert!(response
        .entry
        .as_ref()
        .and_then(|entry| entry.text.as_ref())
        .map(|text| text.len() < entry.text.as_ref().unwrap().len())
        .unwrap_or(false));

    let chunk = ThreadEntryDetailResponse::from_entry_chunk(
        "thread-1".to_string(),
        &entry,
        "text",
        response.pending_fields[0].next_cursor,
    )
    .unwrap();

    assert!(chunk.entry.is_none());
    assert_eq!(
        chunk.chunk.as_ref().map(|chunk| chunk.field.as_str()),
        Some("text")
    );
    assert!(!chunk
        .chunk
        .as_ref()
        .map(|chunk| chunk.text.is_empty())
        .unwrap_or(true));
}

#[test]
fn thread_entry_detail_response_chunks_large_nested_file_change_diff() {
    let large_diff = format!(
        "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-{}\n+{}",
        "old".repeat(12_000),
        "new".repeat(12_000)
    );
    let entry = TranscriptEntryView {
        item_id: Some("turn-diff:turn-1".to_string()),
        kind: TranscriptEntryKind::ToolCall,
        text: Some("Changed files".to_string()),
        status: "completed".to_string(),
        turn_id: Some("turn-1".to_string()),
        tool: Some(ToolCallView {
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
            diff: None,
            file_changes: vec![FileChangeDiffView {
                path: "src/a.rs".to_string(),
                change_type: "modify".to_string(),
                diff: large_diff,
            }],
            apply_state: None,
            file_changes_omitted: false,
        }),
        content_state: crate::protocol::TranscriptContentState::Full,
    };

    let response =
        ThreadEntryDetailResponse::from_entry("thread-1".to_string(), entry.clone()).unwrap();
    let response_entry = response.entry.as_ref().expect("initial detail entry");
    let tool = response_entry.tool.as_ref().expect("tool detail");
    assert!(tool.file_changes[0].diff.is_empty());
    assert!(response
        .pending_fields
        .iter()
        .any(|pending| pending.field == "tool.diff"));
    assert!(serde_json::to_vec(&response).unwrap().len() <= THREADS_RESPONSE_TARGET_BYTES);

    let next_cursor = response
        .pending_fields
        .iter()
        .find(|pending| pending.field == "tool.diff")
        .map(|pending| pending.next_cursor)
        .expect("tool.diff cursor");
    let chunk = ThreadEntryDetailResponse::from_entry_chunk(
        "thread-1".to_string(),
        &entry,
        "tool.diff",
        next_cursor,
    )
    .expect("synthetic nested diff chunk");
    assert!(!chunk.chunk.expect("chunk").text.is_empty());
}
