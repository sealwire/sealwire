use super::*;
use crate::state::SecurityProfile;
use tokio::sync::{watch, RwLock};

#[test]
fn parse_transcript_preserves_tool_and_reasoning_items() {
    let thread = json!({
        "turns": [
            {
                "id": "turn-1",
                "items": [
                    {
                        "id": "item-user",
                        "type": "userMessage",
                        "content": [{ "text": "Investigate the relay transcript" }]
                    },
                    {
                        "id": "item-reasoning",
                        "type": "reasoning",
                        "text": "Exploring 4 files, 1 search"
                    },
                    {
                        "id": "item-tool",
                        "type": "mcpToolCall",
                        "title": "Read frontend/remote/main.js",
                        "status": "completed"
                    },
                    {
                        "id": "item-assistant",
                        "type": "agentMessage",
                        "text": "The relay drops tool events today."
                    }
                ]
            }
        ]
    });

    let transcript = parse_transcript(&thread);

    assert_eq!(transcript.len(), 4);
    assert_eq!(transcript[1].kind, TranscriptEntryKind::Reasoning);
    assert_eq!(
        transcript[1].text.as_deref(),
        Some("Exploring 4 files, 1 search")
    );
    assert_eq!(transcript[2].kind, TranscriptEntryKind::ToolCall);
    assert_eq!(
        transcript[2].tool.as_ref().map(|tool| tool.title.as_str()),
        Some("Read frontend/remote/main.js")
    );
}

#[test]
fn parse_transcript_truncates_large_tool_payloads() {
    let huge_result = "A".repeat(MAX_TOOL_JSON_CHARS * 4);
    let thread = json!({
        "turns": [
            {
                "id": "turn-1",
                "items": [
                    {
                        "id": "item-tool",
                        "type": "mcpToolCall",
                        "title": "Read frontend/remote/main.js",
                        "result": {
                            "text": huge_result
                        }
                    }
                ]
            }
        ]
    });

    let transcript = parse_transcript(&thread);
    let tool_entry = &transcript[0];
    let tool = tool_entry
        .tool
        .as_ref()
        .expect("tool metadata should be present");

    assert_eq!(tool_entry.kind, TranscriptEntryKind::ToolCall);
    assert_eq!(tool.title, "Read frontend/remote/main.js");
    assert!(tool
        .result_preview
        .as_deref()
        .unwrap_or_default()
        .contains("..."));
    assert!(tool_entry
        .text
        .as_deref()
        .unwrap_or_default()
        .contains("Read frontend/remote/main.js"));
    assert!(
        tool_entry
            .text
            .as_ref()
            .map(|text| text.chars().count())
            .unwrap_or(0)
            <= MAX_TOOL_ENTRY_CHARS
    );
    assert!(!tool
        .result_preview
        .as_deref()
        .unwrap_or_default()
        .contains(&"A".repeat(MAX_TOOL_JSON_CHARS * 2)));
}

#[test]
fn parse_transcript_enriches_file_change_tool_items_with_paths() {
    let thread = json!({
        "turns": [
            {
                "id": "turn-1",
                "items": [
                    {
                        "id": "item-file-change",
                        "type": "fileChange",
                        "changes": [
                            { "path": "crates/relay-server/src/protocol.rs", "kind": "modify" },
                            { "path": "frontend/shared/transcript-render.js", "kind": "modify" }
                        ]
                    }
                ]
            }
        ]
    });

    let transcript = parse_transcript(&thread);
    let tool = transcript[0]
        .tool
        .as_ref()
        .expect("file change should render as a tool call");

    assert_eq!(transcript[0].kind, TranscriptEntryKind::ToolCall);
    assert_eq!(tool.item_type, "fileChange");
    assert_eq!(tool.title, "Codex wants to edit 2 files.");
    assert_eq!(tool.detail.as_deref(), Some("Target files: crates/relay-server/src/protocol.rs, frontend/shared/transcript-render.js"));
    assert!(tool
        .input_preview
        .as_deref()
        .unwrap_or_default()
        .contains("crates/relay-server/src/protocol.rs"));
    assert!(tool
        .input_preview
        .as_deref()
        .unwrap_or_default()
        .contains("frontend/shared/transcript-render.js"));
}

#[test]
fn parse_transcript_enriches_new_file_changes_with_synthetic_diff() {
    let thread = json!({
        "turns": [
            {
                "id": "turn-1",
                "items": [
                    {
                        "id": "item-file-change",
                        "type": "fileChange",
                        "changes": [
                            {
                                "path": "crates/relay-server/src/file_changes.rs",
                                "type": "add",
                                "content": "pub(crate) fn merge_file_change_diff(existing: &str, incoming: &str) -> String {\n    format!(\"{existing}{incoming}\")\n}"
                            }
                        ]
                    }
                ]
            }
        ]
    });

    let transcript = parse_transcript(&thread);
    let tool = transcript[0]
        .tool
        .as_ref()
        .expect("file change should render as a tool call");

    assert_eq!(tool.file_changes.len(), 1);
    assert_eq!(tool.file_changes[0].change_type, "add");
    assert!(tool.file_changes[0].diff.contains("new file mode 100644"));
    assert!(tool.file_changes[0].diff.contains("--- /dev/null"));
    assert!(tool.file_changes[0]
        .diff
        .contains("+++ b/crates/relay-server/src/file_changes.rs"));
    assert!(tool.file_changes[0].diff.contains("@@ -0,0 +1,3 @@"));
    assert!(tool.file_changes[0].diff.contains(
        "+pub(crate) fn merge_file_change_diff(existing: &str, incoming: &str) -> String {"
    ));
    assert_eq!(
        tool.diff.as_deref(),
        Some(tool.file_changes[0].diff.as_str())
    );
}

#[test]
fn parse_transcript_builds_turn_summary_from_path_only_file_changes() {
    let thread = json!({
        "turns": [
            {
                "id": "turn-1",
                "items": [
                    {
                        "id": "item-file-change",
                        "type": "fileChange",
                        "changes": [
                            { "path": "frontend/app.js", "kind": "modify" },
                            { "path": "frontend/styles.css", "kind": "modify" }
                        ]
                    }
                ]
            }
        ]
    });

    let transcript = parse_transcript(&thread);
    let summary = transcript[1]
        .tool
        .as_ref()
        .expect("turn summary should render as a tool call");

    assert_eq!(transcript.len(), 2);
    assert_eq!(summary.item_type, "turnDiff");
    assert_eq!(summary.title, "Codex changed 2 files in this turn.");
    assert_eq!(
        summary.detail.as_deref(),
        Some("Target files: frontend/app.js, frontend/styles.css")
    );
    assert_eq!(summary.file_changes.len(), 2);
    assert_eq!(summary.file_changes[0].path, "frontend/app.js");
    assert_eq!(summary.file_changes[1].path, "frontend/styles.css");
    assert_eq!(summary.diff, None);
}

#[test]
fn parse_transcript_turn_summary_accumulates_multiple_hunks_for_same_file() {
    let thread = json!({
        "turns": [
            {
                "id": "turn-1",
                "items": [
                    {
                        "id": "item-file-change-1",
                        "type": "fileChange",
                        "changes": [
                            {
                                "path": "frontend/app.js",
                                "kind": "modify",
                                "diff": "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-old\n+mid"
                            }
                        ]
                    },
                    {
                        "id": "item-file-change-2",
                        "type": "fileChange",
                        "changes": [
                            {
                                "path": "frontend/app.js",
                                "kind": "modify",
                                "diff": "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-mid\n+final"
                            }
                        ]
                    }
                ]
            }
        ]
    });

    let transcript = parse_transcript(&thread);
    let summary = transcript[2]
        .tool
        .as_ref()
        .expect("turn summary should be present");

    assert_eq!(summary.item_type, "turnDiff");
    assert_eq!(summary.file_changes.len(), 1);
    assert!(summary.file_changes[0].diff.contains("+mid"));
    assert!(summary.file_changes[0].diff.contains("+final"));
    assert!(summary.file_changes[0].diff.contains("-old"));
    assert!(summary.file_changes[0].diff.contains("-mid"));
}

#[test]
fn parse_transcript_detail_item_preserves_full_tool_payloads() {
    let item = json!({
        "id": "item-tool",
        "type": "mcpToolCall",
        "toolName": "Read",
        "title": "Read frontend/remote/main.js",
        "detail": "Loaded the requested file contents.",
        "input": {
            "path": "frontend/remote/main.js",
            "range": {
                "start": 1,
                "end": 4000
            }
        },
        "result": {
            "text": "A".repeat(MAX_TOOL_JSON_CHARS * 4)
        }
    });

    let entry = parse_transcript_detail_item(&item, Some("turn-1".to_string()), "completed")
        .expect("detail entry should parse");
    let tool = entry.tool.as_ref().expect("tool detail should exist");

    assert_eq!(entry.kind, TranscriptEntryKind::ToolCall);
    assert_eq!(tool.title, "Read frontend/remote/main.js");
    assert_eq!(
        tool.detail.as_deref(),
        Some("Loaded the requested file contents.")
    );
    assert!(tool
        .input_preview
        .as_deref()
        .unwrap_or_default()
        .contains("\"path\": \"frontend/remote/main.js\""));
    assert!(tool
        .result_preview
        .as_deref()
        .unwrap_or_default()
        .contains(&"A".repeat(MAX_TOOL_JSON_CHARS * 2)));
}

#[test]
fn parse_transcript_preserves_full_agent_messages() {
    let huge_text = "A".repeat(MAX_COMMAND_ENTRY_CHARS * 3);
    let thread = json!({
        "turns": [
            {
                "id": "turn-1",
                "items": [
                    {
                        "id": "item-assistant",
                        "type": "agentMessage",
                        "text": huge_text
                    }
                ]
            }
        ]
    });

    let transcript = parse_transcript(&thread);

    assert_eq!(transcript.len(), 1);
    assert_eq!(transcript[0].kind, TranscriptEntryKind::AgentText);
    assert_eq!(
        transcript[0].text.as_deref().map(str::len),
        Some(MAX_COMMAND_ENTRY_CHARS * 3)
    );
    assert!(!transcript[0]
        .text
        .as_deref()
        .unwrap_or_default()
        .contains("..."));
}

#[test]
fn command_execution_text_truncates_large_output() {
    let item = json!({
        "type": "commandExecution",
        "command": "rg --files",
        "aggregatedOutput": "B".repeat(MAX_COMMAND_OUTPUT_CHARS * 3)
    });

    let text = command_execution_text(&item);

    assert!(text.starts_with("rg --files"));
    assert!(text.chars().count() <= MAX_COMMAND_ENTRY_CHARS);
    assert!(text.contains("..."));
    assert!(!text.contains(&"B".repeat(MAX_COMMAND_OUTPUT_CHARS * 2)));
}

#[tokio::test]
async fn handle_notification_tracks_live_command_output_in_transcript() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
    }

    handle_notification(
        json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-command",
                    "type": "commandExecution",
                    "command": "npm test",
                    "status": "running"
                }
            }
        }),
        &state,
    )
    .await;

    handle_notification(
        json!({
            "method": "item/commandExecution/outputDelta",
            "params": {
                "threadId": "thread-1",
                "itemId": "item-command",
                "delta": "line 1"
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    let entry = snapshot
        .transcript
        .iter()
        .find(|entry| entry.item_id.as_deref() == Some("item-command"))
        .expect("command entry should exist");

    assert_eq!(entry.kind, TranscriptEntryKind::Command);
    assert_eq!(entry.status, "running");
    assert_eq!(entry.text.as_deref(), Some("npm test\nline 1"));
}

#[tokio::test]
async fn handle_notification_updates_generic_tool_items() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    handle_notification(
        json!({
            "method": "item/started",
            "params": {
                "turnId": "turn-1",
                "item": {
                    "id": "item-tool",
                    "type": "mcpToolCall",
                    "title": "Exploring 4 files, 1 search"
                }
            }
        }),
        &state,
    )
    .await;

    handle_notification(
        json!({
            "method": "item/completed",
            "params": {
                "turnId": "turn-1",
                "item": {
                    "id": "item-tool",
                    "type": "mcpToolCall",
                    "title": "Read frontend/remote/main.js",
                    "status": "completed"
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    assert_eq!(snapshot.transcript.len(), 1);
    assert_eq!(snapshot.transcript[0].kind, TranscriptEntryKind::ToolCall);
    assert_eq!(snapshot.transcript[0].status, "completed");
    assert_eq!(
        snapshot.transcript[0]
            .tool
            .as_ref()
            .map(|tool| tool.title.as_str()),
        Some("Read frontend/remote/main.js")
    );
}

#[tokio::test]
async fn handle_notification_enriches_turn_diff_from_same_turn_file_changes() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
    }

    handle_notification(
        json!({
            "method": "turn/diff/updated",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "diff": "@@ -1 +1 @@\n-old\n+new"
            }
        }),
        &state,
    )
    .await;

    handle_notification(
        json!({
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-file-change",
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [
                        { "path": "frontend/app.js", "kind": "modify" }
                    ]
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    let summary = snapshot
        .transcript
        .iter()
        .find(|entry| entry.item_id.as_deref() == Some("turn-diff:turn-1"))
        .and_then(|entry| entry.tool.as_ref())
        .expect("turn diff entry should exist");

    assert_eq!(
        summary.title,
        "Codex changed `frontend/app.js` in this turn."
    );
    assert_eq!(
        summary.detail.as_deref(),
        Some("Target file: frontend/app.js")
    );
    assert_eq!(summary.file_changes.len(), 1);
    assert_eq!(summary.file_changes[0].path, "frontend/app.js");
    assert_eq!(summary.diff.as_deref(), Some("@@ -1 +1 @@\n-old\n+new"));
}

#[tokio::test]
async fn handle_notification_enriches_turn_diff_from_added_file_content() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
    }

    handle_notification(
        json!({
            "method": "turn/diff/updated",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "diff": "@@ -1 +1 @@\n-old\n+new"
            }
        }),
        &state,
    )
    .await;

    handle_notification(
        json!({
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-file-change",
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "crates/relay-server/src/file_changes.rs",
                            "type": "add",
                            "content": "one\ntwo\nthree"
                        }
                    ]
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    let summary = snapshot
        .transcript
        .iter()
        .find(|entry| entry.item_id.as_deref() == Some("turn-diff:turn-1"))
        .and_then(|entry| entry.tool.as_ref())
        .expect("turn diff entry should exist");

    assert_eq!(summary.file_changes.len(), 1);
    assert_eq!(summary.file_changes[0].change_type, "add");
    assert!(summary.file_changes[0]
        .diff
        .contains("new file mode 100644"));
    assert!(summary.file_changes[0].diff.contains("@@ -0,0 +1,3 @@"));
    assert_eq!(summary.diff.as_deref(), Some("@@ -1 +1 @@\n-old\n+new"));
}

#[tokio::test]
async fn handle_notification_turn_diff_accumulates_multiple_hunks_for_same_file() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
    }

    handle_notification(
        json!({
            "method": "turn/diff/updated",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "diff": "@@ -1 +1 @@\n-old\n+new"
            }
        }),
        &state,
    )
    .await;

    handle_notification(
        json!({
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-file-change-1",
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "frontend/app.js",
                            "kind": "modify",
                            "diff": "diff --git a/frontend/app.js b/frontend/app.js\n@@ -10 +10 @@\n-a\n+b"
                        }
                    ]
                }
            }
        }),
        &state,
    )
    .await;

    handle_notification(
        json!({
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-file-change-2",
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "frontend/app.js",
                            "kind": "modify",
                            "diff": "diff --git a/frontend/app.js b/frontend/app.js\n@@ -20 +20 @@\n-c\n+d"
                        }
                    ]
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    let summary = snapshot
        .transcript
        .iter()
        .find(|entry| entry.item_id.as_deref() == Some("turn-diff:turn-1"))
        .and_then(|entry| entry.tool.as_ref())
        .expect("turn diff entry should exist");

    assert_eq!(summary.file_changes.len(), 1);
    assert!(summary.file_changes[0].diff.contains("@@ -10 +10 @@"));
    assert!(summary.file_changes[0].diff.contains("@@ -20 +20 @@"));
}

#[tokio::test]
async fn handle_notification_preserves_existing_tool_metadata_on_sparse_completion() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    handle_notification(
        json!({
            "method": "item/started",
            "params": {
                "turnId": "turn-1",
                "item": {
                    "id": "item-tool",
                    "type": "mcpToolCall",
                    "name": "Read",
                    "title": "Read frontend/remote/main.js",
                    "path": "frontend/remote/main.js",
                    "query": "closeBrokerSocket"
                }
            }
        }),
        &state,
    )
    .await;

    handle_notification(
        json!({
            "method": "item/completed",
            "params": {
                "turnId": "turn-1",
                "item": {
                    "id": "item-tool",
                    "type": "mcpToolCall",
                    "name": "Read",
                    "status": "completed"
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    let tool = snapshot
        .transcript
        .first()
        .and_then(|entry| entry.tool.as_ref())
        .expect("tool metadata should be present");

    assert_eq!(tool.title, "Read frontend/remote/main.js");
    assert_eq!(tool.path.as_deref(), Some("frontend/remote/main.js"));
    assert_eq!(tool.query.as_deref(), Some("closeBrokerSocket"));
}

#[tokio::test]
async fn handle_notification_ignores_session_updates_for_other_threads() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-active".to_string());
        relay.active_turn_id = Some("turn-active".to_string());
        relay.upsert_user_message(
            "item-existing".to_string(),
            "keep me".to_string(),
            "turn-active".to_string(),
        );
    }

    handle_notification(
        json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-other",
                "turnId": "turn-other",
                "item": {
                    "id": "item-other",
                    "type": "agentMessage"
                }
            }
        }),
        &state,
    )
    .await;

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "id": "turn-other",
                    "threadId": "thread-other"
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    assert_eq!(snapshot.active_thread_id.as_deref(), Some("thread-active"));
    assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-active"));
    assert_eq!(snapshot.transcript.len(), 1);
    assert_eq!(snapshot.transcript[0].text.as_deref(), Some("keep me"));
}

#[tokio::test]
async fn handle_server_request_enriches_command_approval_preview() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    handle_server_request(
        json!({
            "id": 1,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-1",
                "reason": "Need to verify the migration before continuing",
                "command": "cargo test -p relay-server approval_roundtrip -- --nocapture",
                "cwd": "/tmp/project",
                "environment": {
                    "RUST_LOG": "debug"
                },
                "availableDecisions": ["approve", "deny"]
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let approval = relay
        .snapshot()
        .pending_approvals
        .into_iter()
        .next()
        .expect("approval should be present");

    assert!(approval.summary.contains("cargo test -p relay-server"));
    assert_eq!(
        approval.detail.as_deref(),
        Some("Need to verify the migration before continuing")
    );
    assert_eq!(
        approval.command.as_deref(),
        Some("cargo test -p relay-server approval_roundtrip -- --nocapture")
    );
    assert_eq!(approval.cwd.as_deref(), Some("/tmp/project"));
    assert!(approval
        .context_preview
        .as_deref()
        .unwrap_or_default()
        .contains("RUST_LOG"));
}

#[tokio::test]
async fn handle_server_request_enriches_file_change_approval_preview() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    handle_server_request(
        json!({
            "id": 2,
            "method": "item/fileChange/requestApproval",
            "params": {
                "threadId": "thread-2",
                "reason": "Need to patch the approval transport",
                "cwd": "/tmp/project",
                "changes": [
                    { "path": "crates/relay-server/src/protocol.rs", "kind": "modify" },
                    { "path": "frontend/shared/transcript-render.js", "kind": "modify" }
                ],
                "availableDecisions": ["approve", "deny"]
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let approval = relay
        .snapshot()
        .pending_approvals
        .into_iter()
        .next()
        .expect("approval should be present");

    assert_eq!(approval.summary, "Codex wants to edit 2 files.");
    assert_eq!(
        approval.detail.as_deref(),
        Some("Need to patch the approval transport")
    );
    let context_preview = approval.context_preview.as_deref().unwrap_or_default();
    assert!(context_preview.contains("crates/relay-server/src/protocol.rs"));
    assert!(context_preview.contains("frontend/shared/transcript-render.js"));
}
