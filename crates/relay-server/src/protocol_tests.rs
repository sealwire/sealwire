use crate::protocol::strip_file_change_diffs_for_snapshot;
use crate::protocol::{
    truncate_with_ellipsis, ApprovalRequestView, AskUserOptionView, AskUserQuestionRequestView,
    AskUserQuestionView, DeleteThreadInput, FileChangeDiffView, LogEntryView, ReviewerThreadView,
    SecurityMode, SessionSnapshot, SessionSnapshotCompactProfile, ThreadEntriesResponse,
    ThreadEntryDetailResponse, ThreadSummaryView, ThreadTranscriptResponse, ThreadsResponse,
    ThreadsResponseCompactProfile, ToolCallView, TranscriptEntryKind, TranscriptEntryView,
    EMERGENCY_TRANSCRIPT_SHELL_CHARS,
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
        active_review_jobs: vec![],
        reviewer_threads: vec![],
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
fn compact_for_broker_strips_reviewer_threads() {
    // The reviewer→parent map only drives the LOCAL delete/archive prompt; remote
    // surfaces never delete threads. It must be dropped from broker-bound snapshots
    // so it can't grow unbounded across many reviews and blow the frame budget.
    let mut snapshot = make_snapshot();
    snapshot.reviewer_threads = (0..50)
        .map(|index| ReviewerThreadView {
            reviewer_thread_id: format!("reviewer-{index}"),
            parent_thread_id: format!("parent-{index}"),
        })
        .collect();

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::RemoteSurface);
    assert!(
        compacted.reviewer_threads.is_empty(),
        "reviewer_threads must be stripped from the broker-compacted snapshot"
    );
}

#[test]
fn compact_for_local_web_keeps_reviewer_threads() {
    // The LOCAL snapshot path (/api/session + SSE) is the ONLY surface whose
    // delete/archive prompt reads `reviewer_threads`. Stripping it here would make
    // the frontend think there are no reviewers and silently skip the confirmation,
    // so LocalWeb must preserve the map.
    let mut snapshot = make_snapshot();
    snapshot.reviewer_threads = vec![ReviewerThreadView {
        reviewer_thread_id: "reviewer-1".to_string(),
        parent_thread_id: "parent-1".to_string(),
    }];

    let compacted = snapshot.compact_for(SessionSnapshotCompactProfile::LocalWeb);
    assert_eq!(
        compacted.reviewer_threads.len(),
        1,
        "LocalWeb must keep reviewer_threads so the local prompt can see reviewers"
    );
    assert_eq!(
        compacted.reviewer_threads[0].parent_thread_id, "parent-1",
        "the parent linkage is preserved for the prompt's reviewer count"
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
            },
            TranscriptEntryView {
                item_id: Some("a1".to_string()),
                kind: TranscriptEntryKind::AgentText,
                text: Some("Z".repeat(max_chars * 4)),
                status: "completed".to_string(),
                turn_id: Some("turn-1".to_string()),
                tool: None,
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
        },
        // A plain agent-text entry with no diff body — must be left untouched.
        TranscriptEntryView {
            item_id: Some("a1".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some("hello".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: None,
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
