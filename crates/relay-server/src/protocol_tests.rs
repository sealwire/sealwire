use crate::protocol::{
    truncate_with_ellipsis, ApprovalRequestView, LogEntryView, SecurityMode, SessionSnapshot,
    SessionSnapshotCompactProfile, ThreadEntriesResponse, ThreadEntryDetailResponse,
    ThreadSummaryView, ThreadTranscriptResponse, ThreadsResponse, ThreadsResponseCompactProfile,
    TranscriptEntryKind, TranscriptEntryView,
};

const MAX_BROKER_LOGS: usize = 8;
const MAX_BROKER_TRANSCRIPT_ENTRIES: usize = 6;
const MAX_BROKER_TRANSCRIPT_CHARS: usize = 1_200;
const MAX_BROKER_THREADS: usize = 80;
const MAX_BROKER_THREAD_PREVIEW_CHARS: usize = 160;
const SESSION_SNAPSHOT_TARGET_BYTES: usize = 8_000;
const LOCAL_SESSION_SNAPSHOT_TARGET_BYTES: usize = 16_000;
const THREADS_RESPONSE_TARGET_BYTES: usize = 20_000;

fn make_snapshot() -> SessionSnapshot {
    SessionSnapshot {
        revision: 7,
        transcript_revision: 3,
        server_time: 11,
        provider: "codex",
        service_ready: true,
        codex_connected: true,
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
        active_flags: vec![],
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
        pending_approvals: vec![ApprovalRequestView {
            request_id: "approval-1".to_string(),
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
            })
            .collect(),
        logs: (0..30)
            .map(|index| LogEntryView {
                kind: "info".to_string(),
                message: format!("log-{index}"),
                created_at: index,
            })
            .collect(),
    }
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
fn compact_for_local_web_limits_snapshot_size() {
    let compacted = make_snapshot().compact_for(SessionSnapshotCompactProfile::LocalWeb);

    assert!(compacted.transcript_truncated);
    assert!(compacted.transcript.len() <= 8);
    assert!(serde_json::to_vec(&compacted).unwrap().len() <= LOCAL_SESSION_SNAPSHOT_TARGET_BYTES);
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
fn compact_for_broker_drops_logs_and_transcript_as_last_resort() {
    let mut snapshot = make_snapshot();
    snapshot.current_cwd = "/tmp/".to_string() + &"超长路径".repeat(3_000);
    snapshot.logs = (0..4)
        .map(|index| LogEntryView {
            kind: "info".to_string(),
            message: format!("{}-{index}", "日志".repeat(600)),
            created_at: index as u64,
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
        })
        .collect();

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);

    assert!(compacted.logs.is_empty());
    assert!(compacted.transcript.is_empty());
    assert!(compacted.transcript_truncated);
    assert!(compacted.current_cwd.starts_with("/tmp/"));
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
        },
        TranscriptEntryView {
            item_id: Some("item-2".to_string()),
            kind: TranscriptEntryKind::UserText,
            text: Some("next".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-2".to_string()),
            tool: None,
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
fn thread_transcript_response_tail_returns_latest_page_first() {
    let transcript = (0..12)
        .map(|index| TranscriptEntryView {
            item_id: Some(format!("item-{index}")),
            kind: TranscriptEntryKind::AgentText,
            text: Some(format!("entry-{index}-{}", "z".repeat(4500))),
            status: "completed".to_string(),
            turn_id: Some(format!("turn-{index}")),
            tool: None,
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
fn thread_entries_response_returns_complete_entries_for_requested_item_ids() {
    let transcript = vec![
        TranscriptEntryView {
            item_id: Some("item-1".to_string()),
            kind: TranscriptEntryKind::UserText,
            text: Some("hello".repeat(2_000)),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: None,
        },
        TranscriptEntryView {
            item_id: Some("item-2".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some("world".repeat(2_000)),
            status: "completed".to_string(),
            turn_id: Some("turn-2".to_string()),
            tool: None,
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
