use super::*;
use crate::{protocol::SessionSnapshot, state::SecurityProfile};
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
    // The full diff lives on the authoritative view (what the entry-detail fetch
    // returns); the snapshot projection only carries the file-change summary, so
    // assert enrichment against the view, not the snapshot.
    let views = relay
        .selected_runtime()
        .expect("runtime")
        .transcript_views();
    let summary = views
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
    // The full diff lives on the authoritative view (what the entry-detail fetch
    // returns); the snapshot projection only carries the file-change summary, so
    // assert enrichment against the view, not the snapshot.
    let views = relay
        .selected_runtime()
        .expect("runtime")
        .transcript_views();
    let summary = views
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
    // The full diff lives on the authoritative view (what the entry-detail fetch
    // returns); the snapshot projection only carries the file-change summary, so
    // assert enrichment against the view, not the snapshot.
    let views = relay
        .selected_runtime()
        .expect("runtime")
        .transcript_views();
    let summary = views
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
async fn handle_notification_drops_unthreaded_codex_events_when_active_thread_is_other_provider() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.set_provider_name("claude_code".to_string());
        relay.active_thread_id = Some("claude-thread".to_string());
        relay.active_turn_id = Some("claude-turn".to_string());
        relay.upsert_thread(ThreadSummaryView {
            id: "claude-thread".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "claude_code".to_string(),
            status: "active".to_string(),
            model_provider: "anthropic".to_string(),
            provider: "claude_code".to_string(),
        });
    }

    handle_notification(
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "turnId": "codex-turn",
                "itemId": "codex-agent",
                "delta": "must not land on Claude"
            }
        }),
        &state,
    )
    .await;

    let snapshot = state.read().await.snapshot();
    assert_eq!(snapshot.active_thread_id.as_deref(), Some("claude-thread"));
    assert_eq!(snapshot.active_turn_id.as_deref(), Some("claude-turn"));
    assert!(
        snapshot.transcript.is_empty(),
        "unthreaded Codex event must not mutate a Claude active transcript: {:?}",
        snapshot.transcript
    );
}

#[tokio::test]
async fn handle_notification_tracks_background_thread_status_activity() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.set_provider_name("claude_code".to_string());
        relay.active_thread_id = Some("claude-thread".to_string());
        relay.upsert_thread(ThreadSummaryView {
            id: "codex-thread".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "codex".to_string(),
            status: "idle".to_string(),
            model_provider: "codex".to_string(),
            provider: "codex".to_string(),
        });
    }

    handle_notification(
        json!({
            "method": "thread/status/changed",
            "params": {
                "threadId": "codex-thread",
                "status": {"type": "active", "activeFlags": []}
            }
        }),
        &state,
    )
    .await;

    let snapshot = state.read().await.snapshot();
    assert!(
        snapshot
            .thread_activity
            .iter()
            .any(|activity| activity.thread_id == "codex-thread"),
        "background active Codex status should surface as thread activity: {:?}",
        snapshot.thread_activity
    );
}

#[tokio::test]
async fn handle_server_request_for_background_thread_does_not_touch_active_progress() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.set_provider_name("claude_code".to_string());
        relay.active_thread_id = Some("claude-thread".to_string());
        relay.upsert_thread(ThreadSummaryView {
            id: "codex-thread".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "codex".to_string(),
            status: "idle".to_string(),
            model_provider: "codex".to_string(),
            provider: "codex".to_string(),
        });
    }

    handle_server_request(
        json!({
            "id": 9,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "codex-thread",
                "command": "echo hi",
                "cwd": "/tmp/project"
            }
        }),
        &state,
    )
    .await;

    let snapshot = state.read().await.snapshot();
    assert_eq!(snapshot.current_phase, None);
    assert_eq!(snapshot.pending_approvals.len(), 1);
    assert!(
        snapshot
            .thread_activity
            .iter()
            .any(|activity| activity.thread_id == "codex-thread"),
        "background approval should surface the Codex thread as active"
    );
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

#[test]
fn resolve_codex_policy_translates_bypass_to_yolo_pair() {
    // The relay-level "bypass" knob is the unified YOLO option. Codex's
    // app-server only understands its own (approvalPolicy, sandbox) pair,
    // so the shim must rewrite "bypass" into the danger-full-access combo
    // before talking to it — regardless of what sandbox the user set.
    assert_eq!(
        resolve_codex_policy("bypass", "workspace-write"),
        ("never", "danger-full-access")
    );
    assert_eq!(
        resolve_codex_policy("bypass", "read-only"),
        ("never", "danger-full-access")
    );
}

#[test]
fn resolve_codex_policy_passes_through_non_bypass_values() {
    assert_eq!(
        resolve_codex_policy("untrusted", "workspace-write"),
        ("untrusted", "workspace-write")
    );
    assert_eq!(
        resolve_codex_policy("on-request", "read-only"),
        ("on-request", "read-only")
    );
    assert_eq!(
        resolve_codex_policy("never", "danger-full-access"),
        ("never", "danger-full-access")
    );
}

async fn codex_test_state_with_thread(thread_id: &str) -> std::sync::Arc<RwLock<RelayState>> {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some(thread_id.to_string());
    }
    state
}

#[tokio::test]
async fn turn_started_sets_phase_thinking() {
    let state = codex_test_state_with_thread("thread-1").await;

    handle_notification(
        json!({
            "method": "turn/started",
            "params": {
                "threadId": "thread-1",
                "turn": { "id": "turn-1" }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    assert_eq!(relay.current_phase.as_deref(), Some("thinking"));
    assert!(relay.last_progress_at.is_some());
}

#[tokio::test]
async fn command_execution_marks_tool_phase() {
    let state = codex_test_state_with_thread("thread-1").await;

    handle_notification(
        json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-cmd",
                    "type": "commandExecution",
                    "command": "npm test",
                    "status": "running"
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    assert_eq!(relay.current_phase.as_deref(), Some("tool"));
    assert_eq!(relay.current_tool.as_deref(), Some("Bash"));
}

#[tokio::test]
async fn agent_delta_switches_to_streaming() {
    let state = codex_test_state_with_thread("thread-1").await;

    handle_notification(
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-1",
                "itemId": "item-msg",
                "turnId": "turn-1",
                "delta": "hi "
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    assert_eq!(relay.current_phase.as_deref(), Some("streaming"));
}

#[tokio::test]
async fn turn_completed_clears_progress_state() {
    let state = codex_test_state_with_thread("thread-1").await;

    handle_notification(
        json!({
            "method": "turn/started",
            "params": {
                "threadId": "thread-1",
                "turn": { "id": "turn-1" }
            }
        }),
        &state,
    )
    .await;
    assert!(state.read().await.last_progress_at.is_some());

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": { "id": "turn-1" }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    assert_eq!(relay.current_phase, None);
    assert_eq!(relay.current_tool, None);
    assert_eq!(relay.last_progress_at, None);
}

fn test_thread_summary(id: &str) -> ThreadSummaryView {
    ThreadSummaryView {
        id: id.to_string(),
        name: None,
        preview: String::new(),
        cwd: "/tmp/project".to_string(),
        updated_at: 1,
        source: "codex".to_string(),
        status: "idle".to_string(),
        model_provider: "openai".to_string(),
        provider: "codex".to_string(),
    }
}

struct CodexReplayHarness {
    state: std::sync::Arc<RwLock<RelayState>>,
}

impl CodexReplayHarness {
    async fn new(active_thread_id: &str) -> Self {
        let (change_tx, _) = watch::channel(0_u64);
        let state = std::sync::Arc::new(RwLock::new(RelayState::new(
            "/tmp/project".to_string(),
            change_tx,
            SecurityProfile::private(),
        )));

        {
            let mut relay = state.write().await;
            relay.active_thread_id = Some(active_thread_id.to_string());
        }

        Self { state }
    }

    async fn notify(&self, payload: serde_json::Value) {
        handle_notification(payload, &self.state).await;
    }

    async fn switch_to(&self, thread_id: &str, status: &str, transcript: Vec<TranscriptEntryView>) {
        let mut relay = self.state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary(thread_id),
                status: status.to_string(),
                active_flags: Vec::new(),
                transcript,
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    async fn snapshot(&self) -> SessionSnapshot {
        self.state.read().await.snapshot()
    }
}

fn agent_entry(item_id: &str, text: &str, status: &str, turn_id: &str) -> TranscriptEntryView {
    TranscriptEntryView {
        item_id: Some(item_id.to_string()),
        kind: TranscriptEntryKind::AgentText,
        text: Some(text.to_string()),
        status: status.to_string(),
        turn_id: Some(turn_id.to_string()),
        tool: None,
    }
}

fn assert_agent_entry(snapshot: &SessionSnapshot, item_id: &str, text: &str, status: &str) {
    let entry = snapshot
        .transcript
        .iter()
        .find(|entry| entry.item_id.as_deref() == Some(item_id))
        .unwrap_or_else(|| panic!("missing transcript item {item_id}"));
    assert_eq!(entry.kind, TranscriptEntryKind::AgentText);
    assert_eq!(entry.text.as_deref(), Some(text));
    assert_eq!(entry.status, status);
}

fn assert_no_streaming_agent_entries(snapshot: &SessionSnapshot) {
    let streaming = snapshot
        .transcript
        .iter()
        .find(|entry| entry.kind == TranscriptEntryKind::AgentText && entry.status == "streaming");
    assert!(
        streaming.is_none(),
        "snapshot must not leave assistant entries streaming after turn completion: {streaming:?}"
    );
}

fn turn_started(thread_id: &str, turn_id: &str) -> serde_json::Value {
    json!({
        "method": "turn/started",
        "params": {
            "threadId": thread_id,
            "turn": { "id": turn_id }
        }
    })
}

fn turn_completed(thread_id: &str, turn_id: &str) -> serde_json::Value {
    json!({
        "method": "turn/completed",
        "params": {
            "threadId": thread_id,
            "turn": { "id": turn_id }
        }
    })
}

fn agent_started(thread_id: &str, turn_id: &str, item_id: &str) -> serde_json::Value {
    json!({
        "method": "item/started",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "item": {
                "id": item_id,
                "type": "agentMessage"
            }
        }
    })
}

fn agent_delta(thread_id: &str, turn_id: &str, item_id: &str, delta: &str) -> serde_json::Value {
    json!({
        "method": "item/agentMessage/delta",
        "params": {
            "threadId": thread_id,
            "itemId": item_id,
            "turnId": turn_id,
            "delta": delta
        }
    })
}

fn agent_completed(thread_id: &str, turn_id: &str, item_id: &str, text: &str) -> serde_json::Value {
    json!({
        "method": "item/completed",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "item": {
                "id": item_id,
                "type": "agentMessage",
                "text": text
            }
        }
    })
}

#[tokio::test]
async fn replay_harness_prevents_stuck_state_after_background_completion() {
    let harness = CodexReplayHarness::new("thread-A").await;

    harness.notify(turn_started("thread-A", "turn-A1")).await;
    harness
        .notify(agent_started("thread-A", "turn-A1", "msg-A1"))
        .await;
    harness
        .notify(agent_delta("thread-A", "turn-A1", "msg-A1", "Hello"))
        .await;

    harness.switch_to("thread-B", "idle", Vec::new()).await;

    harness
        .notify(agent_delta("thread-A", "turn-A1", "msg-A1", " world"))
        .await;
    harness
        .notify(agent_completed(
            "thread-A",
            "turn-A1",
            "msg-A1",
            "Hello world",
        ))
        .await;
    harness.notify(turn_completed("thread-A", "turn-A1")).await;

    let thread_b = harness.snapshot().await;
    assert_eq!(thread_b.active_thread_id.as_deref(), Some("thread-B"));
    assert!(
        thread_b.transcript.is_empty(),
        "background events must not leak into the visible thread"
    );

    harness
        .switch_to(
            "thread-A",
            "idle",
            vec![agent_entry("msg-A1", "Hello world", "completed", "turn-A1")],
        )
        .await;

    let thread_a = harness.snapshot().await;
    assert_eq!(thread_a.active_thread_id.as_deref(), Some("thread-A"));
    assert_eq!(thread_a.active_turn_id, None);
    assert_eq!(thread_a.current_status, "idle");
    assert_agent_entry(&thread_a, "msg-A1", "Hello world", "completed");
    assert_no_streaming_agent_entries(&thread_a);
}

#[tokio::test]
async fn replay_harness_keeps_interleaved_thread_streams_isolated() {
    let harness = CodexReplayHarness::new("thread-A").await;

    harness.notify(turn_started("thread-A", "turn-A1")).await;
    harness
        .notify(agent_started("thread-A", "turn-A1", "msg-A1"))
        .await;
    harness
        .notify(agent_delta("thread-A", "turn-A1", "msg-A1", "A: one"))
        .await;

    harness.switch_to("thread-B", "idle", Vec::new()).await;
    harness.notify(turn_started("thread-B", "turn-B1")).await;
    harness
        .notify(agent_started("thread-B", "turn-B1", "msg-B1"))
        .await;
    harness
        .notify(agent_delta("thread-B", "turn-B1", "msg-B1", "B: one"))
        .await;
    harness
        .notify(agent_delta("thread-A", "turn-A1", "msg-A1", " two"))
        .await;
    harness
        .notify(agent_completed(
            "thread-A",
            "turn-A1",
            "msg-A1",
            "A: one two",
        ))
        .await;
    harness.notify(turn_completed("thread-A", "turn-A1")).await;
    harness
        .notify(agent_delta("thread-B", "turn-B1", "msg-B1", " two"))
        .await;
    harness
        .notify(agent_completed(
            "thread-B",
            "turn-B1",
            "msg-B1",
            "B: one two",
        ))
        .await;
    harness.notify(turn_completed("thread-B", "turn-B1")).await;

    let thread_b = harness.snapshot().await;
    assert_eq!(thread_b.active_thread_id.as_deref(), Some("thread-B"));
    assert_eq!(thread_b.active_turn_id, None);
    assert_agent_entry(&thread_b, "msg-B1", "B: one two", "completed");
    assert!(
        !thread_b
            .transcript
            .iter()
            .any(|entry| entry.item_id.as_deref() == Some("msg-A1")),
        "thread A entries must stay out of thread B while B is visible"
    );

    harness
        .switch_to(
            "thread-A",
            "idle",
            vec![agent_entry("msg-A1", "A: one two", "completed", "turn-A1")],
        )
        .await;

    let thread_a = harness.snapshot().await;
    assert_eq!(thread_a.active_thread_id.as_deref(), Some("thread-A"));
    assert_eq!(thread_a.active_turn_id, None);
    assert_agent_entry(&thread_a, "msg-A1", "A: one two", "completed");
    assert!(
        !thread_a
            .transcript
            .iter()
            .any(|entry| entry.item_id.as_deref() == Some("msg-B1")),
        "thread B entries must stay out of thread A after switching back"
    );
    assert_no_streaming_agent_entries(&thread_a);
}

#[tokio::test]
async fn handle_notification_keeps_late_delta_for_prior_thread() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-A".to_string());
    }

    handle_notification(
        json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-A",
                "turnId": "turn-A1",
                "item": { "id": "msg-1", "type": "agentMessage" }
            }
        }),
        &state,
    )
    .await;
    handle_notification(
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-A",
                "itemId": "msg-1",
                "turnId": "turn-A1",
                "delta": "Hello"
            }
        }),
        &state,
    )
    .await;

    {
        let relay = state.read().await;
        let entry = relay
            .snapshot()
            .transcript
            .into_iter()
            .find(|entry| entry.item_id.as_deref() == Some("msg-1"))
            .expect("msg-1 should exist on thread A");
        assert_eq!(entry.text.as_deref(), Some("Hello"));
    }

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-B"),
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    handle_notification(
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-A",
                "itemId": "msg-1",
                "turnId": "turn-A1",
                "delta": " world"
            }
        }),
        &state,
    )
    .await;

    {
        let relay = state.read().await;
        assert!(
            relay.snapshot().transcript.is_empty(),
            "thread B's transcript should not absorb thread A's delta"
        );
    }

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-A"),
                status: "running".to_string(),
                active_flags: Vec::new(),
                transcript: vec![TranscriptEntryView {
                    item_id: Some("msg-1".to_string()),
                    kind: TranscriptEntryKind::AgentText,
                    text: Some("Hello".to_string()),
                    status: "running".to_string(),
                    turn_id: Some("turn-A1".to_string()),
                    tool: None,
                }],
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    let relay = state.read().await;
    let entry = relay
        .snapshot()
        .transcript
        .into_iter()
        .find(|entry| entry.item_id.as_deref() == Some("msg-1"))
        .expect("thread A's msg-1 should be present after switching back");
    assert_eq!(
        entry.text.as_deref(),
        Some("Hello world"),
        "late delta from prior thread must be replayed on switch-back"
    );
}

#[tokio::test]
async fn handle_notification_keeps_late_agent_completion_for_prior_thread() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-A".to_string());
    }

    handle_notification(
        json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-A",
                "turnId": "turn-A1",
                "item": { "id": "msg-1", "type": "agentMessage" }
            }
        }),
        &state,
    )
    .await;
    handle_notification(
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-A",
                "itemId": "msg-1",
                "turnId": "turn-A1",
                "delta": "Hello"
            }
        }),
        &state,
    )
    .await;

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-B"),
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    handle_notification(
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-A",
                "itemId": "msg-1",
                "turnId": "turn-A1",
                "delta": " world"
            }
        }),
        &state,
    )
    .await;
    handle_notification(
        json!({
            "method": "item/completed",
            "params": {
                "threadId": "thread-A",
                "turnId": "turn-A1",
                "item": {
                    "id": "msg-1",
                    "type": "agentMessage",
                    "text": "Hello world"
                }
            }
        }),
        &state,
    )
    .await;

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-A"),
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: vec![TranscriptEntryView {
                    item_id: Some("msg-1".to_string()),
                    kind: TranscriptEntryKind::AgentText,
                    text: Some("Hello world".to_string()),
                    status: "completed".to_string(),
                    turn_id: Some("turn-A1".to_string()),
                    tool: None,
                }],
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    let relay = state.read().await;
    let entry = relay
        .snapshot()
        .transcript
        .into_iter()
        .find(|entry| entry.item_id.as_deref() == Some("msg-1"))
        .expect("thread A's msg-1 should be present after switching back");
    assert_eq!(entry.text.as_deref(), Some("Hello world"));
    assert_eq!(
        entry.status, "completed",
        "background item/completed must prevent a restored streaming entry"
    );
}

#[tokio::test]
async fn runtime_merge_does_not_downgrade_fresh_completed_agent_message() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-A".to_string());
    }

    handle_notification(
        json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-A",
                "turnId": "turn-A1",
                "item": { "id": "msg-1", "type": "agentMessage" }
            }
        }),
        &state,
    )
    .await;
    handle_notification(
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-A",
                "itemId": "msg-1",
                "turnId": "turn-A1",
                "delta": "Hello"
            }
        }),
        &state,
    )
    .await;

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-B"),
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    handle_notification(
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-A",
                "itemId": "msg-1",
                "turnId": "turn-A1",
                "delta": " world"
            }
        }),
        &state,
    )
    .await;

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-A"),
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: vec![TranscriptEntryView {
                    item_id: Some("msg-1".to_string()),
                    kind: TranscriptEntryKind::AgentText,
                    text: Some("Hello world".to_string()),
                    status: "completed".to_string(),
                    turn_id: Some("turn-A1".to_string()),
                    tool: None,
                }],
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    let relay = state.read().await;
    let entry = relay
        .snapshot()
        .transcript
        .into_iter()
        .find(|entry| entry.item_id.as_deref() == Some("msg-1"))
        .expect("thread A's msg-1 should be present after switching back");
    assert_eq!(entry.text.as_deref(), Some("Hello world"));
    assert_eq!(
        entry.status, "completed",
        "fresh worker state must not be downgraded by a stale background stream"
    );
}

#[tokio::test]
async fn handle_notification_does_not_leak_late_delta_into_new_thread() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-A".to_string());
    }

    handle_notification(
        json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-A",
                "turnId": "turn-A1",
                "item": { "id": "msg-1", "type": "agentMessage" }
            }
        }),
        &state,
    )
    .await;

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-B"),
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    handle_notification(
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-A",
                "itemId": "msg-1",
                "turnId": "turn-A1",
                "delta": "leaked"
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    assert!(
        relay.snapshot().transcript.is_empty(),
        "thread B's transcript must not absorb a delta belonging to thread A"
    );
    assert_eq!(
        relay.active_thread_id.as_deref(),
        Some("thread-B"),
        "active thread must remain B"
    );
}

#[tokio::test]
async fn handle_notification_keeps_late_command_output_for_prior_thread() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-A".to_string());
    }

    handle_notification(
        json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-A",
                "turnId": "turn-A1",
                "item": {
                    "id": "cmd-1",
                    "type": "commandExecution",
                    "command": "npm test",
                    "status": "running"
                }
            }
        }),
        &state,
    )
    .await;

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-B"),
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    handle_notification(
        json!({
            "method": "item/commandExecution/outputDelta",
            "params": {
                "threadId": "thread-A",
                "itemId": "cmd-1",
                "delta": "line 1"
            }
        }),
        &state,
    )
    .await;

    {
        let relay = state.read().await;
        assert!(
            relay.snapshot().transcript.is_empty(),
            "command output delta for thread A must not leak into thread B"
        );
    }

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-A"),
                status: "running".to_string(),
                active_flags: Vec::new(),
                transcript: vec![TranscriptEntryView {
                    item_id: Some("cmd-1".to_string()),
                    kind: TranscriptEntryKind::Command,
                    text: Some("npm test".to_string()),
                    status: "running".to_string(),
                    turn_id: Some("turn-A1".to_string()),
                    tool: None,
                }],
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    let relay = state.read().await;
    let entry = relay
        .snapshot()
        .transcript
        .into_iter()
        .find(|entry| entry.item_id.as_deref() == Some("cmd-1"))
        .expect("cmd-1 should be present after switch-back");
    assert_eq!(
        entry.text.as_deref(),
        Some("npm test\nline 1"),
        "runtime command output must merge onto the freshly-read item"
    );
}

#[tokio::test]
async fn handle_notification_keeps_late_turn_started_for_prior_thread() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-A".to_string());
    }

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-B"),
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    handle_notification(
        json!({
            "method": "turn/started",
            "params": {
                "threadId": "thread-A",
                "turn": { "id": "turn-A2" }
            }
        }),
        &state,
    )
    .await;

    {
        let relay = state.read().await;
        assert_eq!(
            relay.active_turn_id, None,
            "thread B (active) must NOT inherit a turn id intended for thread A"
        );
    }

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-A"),
                status: "thinking".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    let relay = state.read().await;
    assert_eq!(
        relay.active_turn_id.as_deref(),
        Some("turn-A2"),
        "active_turn_id must remain in the thread runtime on switch-back"
    );
}

#[tokio::test]
async fn handle_notification_keeps_full_turn_lifecycle_for_prior_thread() {
    // Exercises turn/diff/updated + turn/completed routed to a non-selected
    // thread runtime. On switch-back, the synthetic turn-diff entry must exist AND
    // be marked completed. The worker's fresh `read_thread` alone cannot recover
    // that because it has no concept of synthetic turn-diff items and
    // ThreadSyncData carries no active_turn_id.
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-A".to_string());
    }

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-B"),
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    handle_notification(
        json!({
            "method": "turn/diff/updated",
            "params": {
                "threadId": "thread-A",
                "turnId": "turn-A1",
                "diff": "diff --git a/src/x.rs b/src/x.rs\n@@ -1 +1 @@\n-a\n+b"
            }
        }),
        &state,
    )
    .await;

    {
        let relay = state.read().await;
        let any_diff_entry = relay
            .snapshot()
            .transcript
            .iter()
            .any(|entry| entry.item_id.as_deref() == Some("turn-diff:turn-A1"));
        assert!(
            !any_diff_entry,
            "turn diff for thread A must not appear in thread B's transcript"
        );
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-A",
                "turn": { "id": "turn-A1" }
            }
        }),
        &state,
    )
    .await;

    {
        let mut relay = state.write().await;
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread_summary("thread-A"),
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            },
            "untrusted",
            "workspace-write",
            "medium",
            "fake-echo",
            "device-a",
        );
    }

    let relay = state.read().await;
    let diff_entry = relay
        .snapshot()
        .transcript
        .into_iter()
        .find(|entry| entry.item_id.as_deref() == Some("turn-diff:turn-A1"))
        .expect("turn-diff entry must remain in the thread runtime on switch-back");
    assert_eq!(
        diff_entry.status, "completed",
        "runtime turn/completed must flip the runtime turn-diff status"
    );
    assert_eq!(
        relay.active_turn_id, None,
        "active_turn_id must reflect the runtime turn/completed"
    );
}
