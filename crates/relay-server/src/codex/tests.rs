use super::*;
use crate::{protocol::SessionSnapshot, state::SecurityProfile};
use tokio::sync::{watch, RwLock};

#[test]
fn summarize_codex_mcp_servers_reports_enabled_and_disabled() {
    let json = r#"[
        {"name":"github","enabled":true,"disabled_reason":null},
        {"name":"computer-use","enabled":false,"disabled_reason":null},
        {"name":"node_repl","enabled":true},
        {"name":"broken","enabled":false,"disabled_reason":"startup failed"}
    ]"#;
    let lines = summarize_codex_mcp_servers(json).expect("valid json");
    assert_eq!(lines[0], "MCP: 4 configured (2 enabled, 2 disabled)");
    assert!(lines.iter().any(|l| l == "MCP enabled: github, node_repl"));
    // disabled servers keep their reason when present
    assert!(lines
        .iter()
        .any(|l| l.contains("computer-use") && l.contains("broken (startup failed)")));
}

#[test]
fn summarize_codex_mcp_servers_no_servers_is_silent() {
    assert_eq!(
        summarize_codex_mcp_servers("[]").unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn summarize_codex_mcp_servers_rejects_bad_json() {
    assert!(summarize_codex_mcp_servers("not json at all").is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn collect_codex_mcp_lines_times_out_without_hanging() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Instant;

    // A fake "codex" that ignores its args and never returns within the window.
    // `exec sleep` makes the sleeper the direct child, so kill_on_drop's SIGKILL
    // actually stops it rather than orphaning a grandchild.
    let script = std::env::temp_dir().join(format!("codex-mcp-sleeper-{}.sh", std::process::id()));
    {
        let mut file = std::fs::File::create(&script).unwrap();
        writeln!(file, "#!/bin/sh\nexec sleep 30").unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
    }

    let start = Instant::now();
    let lines = collect_codex_mcp_lines(script.to_str().unwrap(), Duration::from_millis(200)).await;
    let elapsed = start.elapsed();
    std::fs::remove_file(&script).ok();

    // Returned promptly at the timeout — did NOT block for the 30s sleeper. The
    // child is killed and reaped by kill_on_drop when the future is dropped.
    assert!(
        elapsed < Duration::from_secs(5),
        "probe hung for {elapsed:?}"
    );
    assert!(
        lines.iter().any(|line| line.contains("timed out")),
        "expected a timeout note, got {lines:?}"
    );
}

#[tokio::test]
async fn collect_codex_mcp_lines_reports_a_missing_binary() {
    let lines = collect_codex_mcp_lines(
        "definitely-not-a-real-codex-binary-xyz",
        Duration::from_secs(5),
    )
    .await;
    assert!(
        lines.iter().any(|line| line.contains("could not run")),
        "expected a spawn-failure note, got {lines:?}"
    );
}

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
fn parse_transcript_keeps_an_image_only_user_turn_visible() {
    let thread = json!({
        "turns": [{
            "id": "turn-image",
            "items": [{
                "id": "item-image",
                "type": "userMessage",
                "content": [{
                    "type": "image",
                    "url": "data:image/png;base64,iVBORw0KGgo="
                }]
            }]
        }]
    });

    let transcript = parse_transcript(&thread);
    assert_eq!(transcript.len(), 1);
    assert_eq!(transcript[0].kind, TranscriptEntryKind::UserText);
    assert_eq!(transcript[0].text.as_deref(), Some("[Attached image]"));
}

#[test]
fn parse_transcript_marks_images_attached_to_a_text_user_turn() {
    let thread = json!({
        "turns": [{
            "id": "turn-mixed",
            "items": [{
                "id": "item-mixed",
                "type": "userMessage",
                "content": [
                    {
                        "type": "image",
                        "url": "data:image/png;base64,iVBORw0KGgo="
                    },
                    {
                        "type": "text",
                        "text": "Inspect this screenshot"
                    }
                ]
            }]
        }]
    });

    let transcript = parse_transcript(&thread);
    assert_eq!(transcript.len(), 1);
    assert_eq!(
        transcript[0].text.as_deref(),
        Some("Inspect this screenshot\n\n[Attached image]")
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

// P0a regression: a codex turn/completed on the ACTIVE thread used to clear the
// turn but leave current_status = "active" (relying on a separate
// thread/status/changed). If that follow-up was missing, the thread stayed
// "working" forever. Completion alone must now settle the status to idle.
#[tokio::test]
async fn handle_notification_turn_completed_settles_active_thread_to_idle() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        relay.set_active_turn(Some("turn-1".to_string()));
        let snapshot = relay.snapshot();
        assert_eq!(snapshot.current_status, "active");
        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-1"));
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": { "threadId": "thread-1", "turn": { "id": "turn-1" } }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    assert_eq!(snapshot.active_turn_id, None, "turn must be cleared");
    assert_eq!(
        snapshot.current_status, "idle",
        "a completed turn must idle the thread, not leave it 'active'"
    );
}

// A codex turn that completes WITH an error must notify remote devices (push),
// not just log it.
#[tokio::test]
async fn turn_completed_with_error_enqueues_error_push() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    let (push_tx, mut push_rx) = tokio::sync::mpsc::unbounded_channel();
    {
        let mut relay = state.write().await;
        relay.set_push_runtime(push_tx, "test-key".to_string());
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        relay.set_active_turn(Some("turn-1".to_string()));
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": { "id": "turn-1", "error": { "message": "model overloaded" } }
            }
        }),
        &state,
    )
    .await;

    let job = push_rx
        .try_recv()
        .expect("a turn error must enqueue a push");
    assert_eq!(job.kind, crate::state::PushKind::Error);
    assert_eq!(job.thread_id, "thread-1");
}

// A codex turn that fails on a BACKGROUND thread must also push (symmetric with
// the active-thread path and with Claude's fg+bg handling).
#[tokio::test]
async fn background_turn_completed_with_error_enqueues_error_push() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    let (push_tx, mut push_rx) = tokio::sync::mpsc::unbounded_channel();
    {
        let mut relay = state.write().await;
        relay.set_push_runtime(push_tx, "test-key".to_string());
        relay.active_thread_id = Some("active-thread".to_string());
        relay.set_active_turn(Some("turn-active".to_string()));
        relay.bg_set_active_turn(
            "bg-thread",
            Some("turn-bg".to_string()),
            crate::state::unix_now(),
        );
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "bg-thread",
                "turn": { "id": "turn-bg", "error": { "message": "model overloaded" } }
            }
        }),
        &state,
    )
    .await;

    let job = push_rx
        .try_recv()
        .expect("a background turn error must enqueue a push");
    assert_eq!(job.kind, crate::state::PushKind::Error);
    assert_eq!(job.thread_id, "bg-thread");
}

// A late, SUPERSEDED turn/completed carrying an error (turn A's completion
// arriving while turn B is in flight) must be ignored — pushing/suppressing for
// it would wrongly swallow turn B's real completion later.
#[tokio::test]
async fn superseded_turn_error_does_not_enqueue_push() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    let (push_tx, mut push_rx) = tokio::sync::mpsc::unbounded_channel();
    {
        let mut relay = state.write().await;
        relay.set_push_runtime(push_tx, "test-key".to_string());
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        // turn B is the current in-flight turn.
        relay.set_active_turn(Some("turn-B".to_string()));
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": { "id": "turn-A", "error": { "message": "stale boom" } }
            }
        }),
        &state,
    )
    .await;

    assert!(
        push_rx.try_recv().is_err(),
        "a superseded turn's error must not enqueue a push (it would suppress turn B's completion)"
    );
}

// A unique marker only ever present in the RAW provider `error.message`. It must
// NEVER appear in a transcript Error entry (which rides broker-bound snapshots to
// every paired device); the entry must carry only the bounded, closed-enum
// reason. See `TranscriptEntryKind::Error` and `codex_turn_failure_reason`.
const RAW_MSG_SENTINEL: &str = "RAW-9f3-/Users/secret/leak";

// A failed codex turn must leave a DURABLE, remote-visible failure entry in the
// transcript (kind Error, status "failed"), not settle as a clean success.
// Operator logs are stripped from broker-bound snapshots, so the pre-existing
// push/log alone let a failed turn look like a clean success on the transcript
// surface. Mirrors the Claude path. Uses the REAL wire shape: `codexErrorInfo`
// is a camelCase string (`CodexErrorInfo`'s serde repr). The bounded label must
// be surfaced and the raw provider message must NOT leak into the entry.
#[tokio::test]
async fn turn_completed_with_error_injects_transcript_error_entry() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        relay.set_active_turn(Some("turn-1".to_string()));
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": {
                        "message": format!("upstream said {RAW_MSG_SENTINEL}"),
                        "codexErrorInfo": "usageLimitExceeded"
                    }
                }
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
        .find(|entry| entry.kind == TranscriptEntryKind::Error)
        .expect("a failed codex turn must inject an Error transcript entry");
    assert_eq!(entry.status, "failed");
    assert_eq!(
        entry.item_id.as_deref(),
        Some("turn-error:turn-1"),
        "stable per-turn id so a re-delivered completion upserts, not duplicates"
    );
    assert_eq!(
        entry.text.as_deref(),
        Some("Usage limit reached"),
        "the reason must be the bounded camelCase-classified label"
    );
    assert!(
        !entry
            .text
            .as_deref()
            .unwrap_or("")
            .contains(RAW_MSG_SENTINEL),
        "the raw provider message must NEVER leak into the remote-visible entry"
    );
}

// Data-carrying `codexErrorInfo` variants arrive as an externally-tagged
// single-key object with an inner `httpStatusCode` — the real wire shape for
// e.g. `HttpConnectionFailed`. The bounded label must be produced (with the
// status code, itself bounded), never a raw string.
#[tokio::test]
async fn turn_completed_http_error_object_injects_bounded_entry() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        relay.set_active_turn(Some("turn-1".to_string()));
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": {
                        "message": RAW_MSG_SENTINEL,
                        "codexErrorInfo": { "httpConnectionFailed": { "httpStatusCode": 503 } }
                    }
                }
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
        .find(|entry| entry.kind == TranscriptEntryKind::Error)
        .expect("an externally-tagged codexErrorInfo object must be classified");
    assert_eq!(
        entry.text.as_deref(),
        Some("The connection to the model failed (HTTP 503)")
    );
    assert!(!entry
        .text
        .as_deref()
        .unwrap_or("")
        .contains(RAW_MSG_SENTINEL));
}

// `other`/unknown/future classifications must fall back to a GENERIC bounded
// reason — never the raw provider message — and that bounded reason must survive
// remote-surface snapshot compaction without ever exposing the raw text.
#[tokio::test]
async fn turn_completed_unknown_error_never_leaks_raw_message() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        relay.set_active_turn(Some("turn-1".to_string()));
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": { "message": RAW_MSG_SENTINEL, "codexErrorInfo": "other" }
                }
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
        .find(|entry| entry.kind == TranscriptEntryKind::Error)
        .expect("an unknown classification must still inject a generic Error entry");
    assert_eq!(entry.text.as_deref(), Some("The turn ended with an error."));

    // The raw message must not appear ANYWHERE in the remote-surface-compacted
    // snapshot (compaction truncates but never sanitizes — so the invariant must
    // hold at the source).
    let remote =
        snapshot.compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface);
    let leaked = remote.transcript.iter().any(|entry| {
        entry
            .text
            .as_deref()
            .unwrap_or("")
            .contains(RAW_MSG_SENTINEL)
    });
    assert!(
        !leaked,
        "raw provider text must never reach a broker-bound snapshot"
    );
    // ...and the bounded failure entry must SURVIVE remote compaction — that is
    // the whole point (operator logs get stripped; this entry must not).
    assert!(
        remote
            .transcript
            .iter()
            .any(|entry| entry.kind == TranscriptEntryKind::Error),
        "the bounded failure entry must remain visible in the remote snapshot"
    );
}

// Same DURABLE failure entry on a BACKGROUND thread (symmetric with the active
// path and with Claude's fg+bg handling). Here the error carries ONLY the
// closed-enum classification, no free-text message — the bounded reason must
// still be produced.
#[tokio::test]
async fn background_turn_completed_with_error_injects_transcript_error_entry() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("active-thread".to_string());
        relay.set_active_turn(Some("turn-active".to_string()));
        relay.bg_set_active_turn(
            "bg-thread",
            Some("turn-bg".to_string()),
            crate::state::unix_now(),
        );
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "bg-thread",
                "turn": {
                    "id": "turn-bg",
                    "status": "failed",
                    "error": { "codexErrorInfo": "usageLimitExceeded" }
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let runtime = relay.runtime_for_thread("bg-thread").expect("bg runtime");
    let entry = runtime
        .transcript
        .iter()
        .find(|entry| entry.kind == TranscriptEntryKind::Error)
        .expect("a failed background codex turn must inject an Error transcript entry");
    assert_eq!(entry.status, "failed");
    assert_eq!(entry.item_id, "turn-error:turn-bg");
    assert_eq!(entry.text.as_deref(), Some("Usage limit reached"));
}

// A turn whose only failure signal is `status: "failed"` (no error object at
// all — e.g. codex's own silent early-returns) must STILL surface a generic
// failure entry, rather than settling as a clean success. This is the exact
// "the turn just ends with nothing shown" case.
#[tokio::test]
async fn turn_completed_failed_status_without_detail_still_injects_error_entry() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        relay.set_active_turn(Some("turn-1".to_string()));
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": { "id": "turn-1", "status": "failed" }
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
        .find(|entry| entry.kind == TranscriptEntryKind::Error)
        .expect("a status:failed turn must inject an Error entry even with no detail");
    assert_eq!(entry.status, "failed");
    assert!(
        !entry.text.as_deref().unwrap_or("").is_empty(),
        "the generic failure entry must carry some user-facing text"
    );
}

// A normal (successful) completion must NOT inject any Error entry — the failure
// path must be gated strictly on a failed status / present error.
#[tokio::test]
async fn turn_completed_success_injects_no_error_entry() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        relay.set_active_turn(Some("turn-1".to_string()));
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": { "id": "turn-1", "status": "completed" }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    assert!(
        !snapshot
            .transcript
            .iter()
            .any(|entry| entry.kind == TranscriptEntryKind::Error),
        "a successful completion must not inject an Error entry"
    );
}

// A re-delivered completion for the same turn must UPSERT the failure entry, not
// duplicate it (stable `turn-error:<turn_id>` id).
#[tokio::test]
async fn turn_completed_error_entry_is_idempotent() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    let notification = json!({
        "method": "turn/completed",
        "params": {
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "failed",
                "error": { "codexErrorInfo": "usageLimitExceeded" }
            }
        }
    });
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        relay.set_active_turn(Some("turn-1".to_string()));
    }

    handle_notification(notification.clone(), &state).await;
    handle_notification(notification, &state).await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    let error_entries = snapshot
        .transcript
        .iter()
        .filter(|entry| entry.kind == TranscriptEntryKind::Error)
        .count();
    assert_eq!(
        error_entries, 1,
        "a re-delivered completion must upsert, not duplicate, the failure entry"
    );
}

// F3 (restart durability): persisted thread history carries per-turn
// `status`/`error`, so rehydration must RE-SYNTHESIZE the bounded failure entry
// (with the same stable id) — otherwise a failure that predates a relay restart
// vanishes on reopen. Goes beyond Claude, which cannot rebuild its error card.
#[test]
fn parse_transcript_synthesizes_failed_turn_error_entry() {
    let thread = json!({
        "turns": [
            {
                "id": "turn-1",
                "status": "failed",
                "error": {
                    "message": RAW_MSG_SENTINEL,
                    "codexErrorInfo": "usageLimitExceeded"
                },
                "items": [
                    { "id": "item-user", "type": "userMessage", "content": [{ "text": "hi" }] }
                ]
            }
        ]
    });

    let transcript = parse_transcript(&thread);
    let entry = transcript
        .iter()
        .find(|entry| entry.kind == TranscriptEntryKind::Error)
        .expect("a failed history turn must rehydrate an Error entry");
    assert_eq!(entry.item_id.as_deref(), Some("turn-error:turn-1"));
    assert_eq!(entry.status, "failed");
    assert_eq!(entry.text.as_deref(), Some("Usage limit reached"));
    assert!(
        !entry
            .text
            .as_deref()
            .unwrap_or("")
            .contains(RAW_MSG_SENTINEL),
        "rehydration must also keep the raw provider message out of the entry"
    );

    // A successful history turn must NOT synthesize an error entry.
    let ok_thread = json!({
        "turns": [
            { "id": "turn-2", "status": "completed", "items": [] }
        ]
    });
    assert!(
        !parse_transcript(&ok_thread)
            .iter()
            .any(|entry| entry.kind == TranscriptEntryKind::Error),
        "a completed history turn must not synthesize an error entry"
    );
}

// Table-driven guard against a single-variant mapping typo: every known
// `CodexErrorInfo` variant (unit strings + externally-tagged HTTP objects + the
// `turnKind` object) must resolve to a bounded label, while `other`/unknown must
// NOT (so the caller uses the generic fallback).
#[test]
fn codex_error_info_label_maps_every_known_variant() {
    let unit_variants = [
        "usageLimitExceeded",
        "sessionBudgetExceeded",
        "contextWindowExceeded",
        "serverOverloaded",
        "cyberPolicy",
        "unauthorized",
        "badRequest",
        "internalServerError",
        "threadRollbackFailed",
        "sandboxError",
    ];
    for variant in unit_variants {
        assert!(
            codex_error_info_label(&json!(variant)).is_some(),
            "unit variant {variant:?} must map to a bounded label"
        );
    }

    let http_variants = [
        "httpConnectionFailed",
        "responseStreamConnectionFailed",
        "responseStreamDisconnected",
        "responseTooManyFailedAttempts",
    ];
    for variant in http_variants {
        let label = codex_error_info_label(&json!({ variant: { "httpStatusCode": 503 } }))
            .unwrap_or_else(|| panic!("http variant {variant:?} must map"));
        assert!(
            label.contains("(HTTP 503)"),
            "http variant {variant:?} must fold in the bounded status code, got {label:?}"
        );
        // A null/absent status code must still map, just without the suffix.
        assert!(codex_error_info_label(&json!({ variant: { "httpStatusCode": null } })).is_some());
    }

    assert!(
        codex_error_info_label(&json!({ "activeTurnNotSteerable": { "turnKind": "review" } }))
            .is_some(),
        "the turnKind-carrying variant must map"
    );

    // `other` and any unknown/future variant must NOT map (generic fallback).
    assert_eq!(codex_error_info_label(&json!("other")), None);
    assert_eq!(
        codex_error_info_label(&json!("someUnknownFutureVariant")),
        None
    );
    assert_eq!(
        codex_error_info_label(&json!({ "brandNewVariant": {} })),
        None
    );
}

// The Web Push reason (a remote-bound channel) must carry the BOUNDED reason,
// never the raw provider message — closing the loop the transcript tests cover.
#[tokio::test]
async fn turn_error_push_reason_is_bounded_not_raw() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    let (push_tx, mut push_rx) = tokio::sync::mpsc::unbounded_channel();
    {
        let mut relay = state.write().await;
        relay.set_push_runtime(push_tx, "test-key".to_string());
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        relay.set_active_turn(Some("turn-1".to_string()));
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": {
                        "message": format!("upstream said {RAW_MSG_SENTINEL}"),
                        "codexErrorInfo": "usageLimitExceeded"
                    }
                }
            }
        }),
        &state,
    )
    .await;

    let job = push_rx
        .try_recv()
        .expect("a turn error must enqueue a push");
    assert_eq!(job.kind, crate::state::PushKind::Error);
    let reason = job.reason.as_deref().unwrap_or("");
    assert_eq!(reason, "Usage limit reached");
    assert!(
        !reason.contains(RAW_MSG_SENTINEL),
        "the push reason must never carry the raw provider message"
    );
}

// Exercise the restore path exactly as `read_thread` does after its RPC returns:
// unwrap the `thread` from the `thread/read` result envelope, then hydrate. This
// covers the `result -> thread -> parse_transcript` chain, not just the pure
// parser, without needing a live app-server child.
#[test]
fn read_thread_result_envelope_rehydrates_failed_turn_entry() {
    let result = json!({
        "thread": {
            "id": "thread-1",
            "turns": [
                {
                    "id": "turn-1",
                    "status": "failed",
                    "error": { "codexErrorInfo": "usageLimitExceeded" },
                    "items": []
                }
            ]
        }
    });

    let thread = value_at(&result, &["thread"]).expect("thread/read envelope carries a thread");
    let transcript = parse_transcript(thread);
    let entry = transcript
        .iter()
        .find(|entry| entry.kind == TranscriptEntryKind::Error)
        .expect("restore path must rehydrate the failed-turn Error entry");
    assert_eq!(entry.item_id.as_deref(), Some("turn-error:turn-1"));
    assert_eq!(entry.text.as_deref(), Some("Usage limit reached"));
}

// P0a / review #3 regression: a delayed turn/completed for an OLD turn must not
// clear the newer active turn or idle a working thread (which would also let the
// server permit an overlapping turn).
#[tokio::test]
async fn handle_notification_stale_turn_completed_does_not_clear_newer_turn() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
        // turn B is the current, in-flight turn.
        relay.set_active_turn(Some("turn-B".to_string()));
    }

    // turn A's completion arrives late (A was superseded by B).
    handle_notification(
        json!({
            "method": "turn/completed",
            "params": { "threadId": "thread-1", "turn": { "id": "turn-A" } }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let snapshot = relay.snapshot();
    assert_eq!(
        snapshot.active_turn_id.as_deref(),
        Some("turn-B"),
        "a stale completion of turn A must not clear the newer active turn B"
    );
    assert_eq!(
        snapshot.current_status, "active",
        "the thread must stay working while turn B is in flight"
    );
}

// Review #1: a BACKGROUND codex turn/completed must also settle that thread to
// idle (not just the active thread). Otherwise a backgrounded thread whose status
// was "active" stays is_working() forever and can block reviews / show a ghost
// badge. The earlier switch-back tests masked this by feeding a fresh "idle" read.
#[tokio::test]
async fn handle_notification_background_turn_completed_settles_to_idle() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-active".to_string());
        let now = crate::state::unix_now();
        relay.bg_set_thread_status("thread-bg", "active".to_string(), Vec::new(), now);
        relay.bg_set_active_turn("thread-bg", Some("turn-1".to_string()), now);
        assert!(relay
            .runtime_for_thread("thread-bg")
            .expect("bg runtime")
            .is_working());
    }

    handle_notification(
        json!({
            "method": "turn/completed",
            "params": { "threadId": "thread-bg", "turn": { "id": "turn-1" } }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let runtime = relay.runtime_for_thread("thread-bg").expect("bg runtime");
    assert_eq!(runtime.active_turn_id, None);
    assert_eq!(runtime.current_status, "idle");
    assert!(
        !runtime.is_working(),
        "a completed background turn must idle the background thread"
    );
}

#[tokio::test]
async fn handle_notification_background_stale_turn_completed_does_not_clear_newer_turn() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));

    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-active".to_string());
        let now = crate::state::unix_now();
        relay.bg_set_thread_status("thread-bg", "active".to_string(), Vec::new(), now);
        relay.bg_set_active_turn("thread-bg", Some("turn-B".to_string()), now);
    }

    // Stale completion of the OLD background turn A.
    handle_notification(
        json!({
            "method": "turn/completed",
            "params": { "threadId": "thread-bg", "turn": { "id": "turn-A" } }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let runtime = relay.runtime_for_thread("thread-bg").expect("bg runtime");
    assert_eq!(
        runtime.active_turn_id.as_deref(),
        Some("turn-B"),
        "a stale background completion must not clear the newer background turn"
    );
    assert_eq!(runtime.current_status, "active");
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
            workspace_trusted: false,
            id: "claude-thread".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "claude_code".to_string(),
            status: "active".to_string(),
            model_provider: "anthropic".to_string(),
            provider: "claude_code".to_string(),
            forked_from: None,
            renamed: false,
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
            workspace_trusted: false,
            id: "codex-thread".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "codex".to_string(),
            status: "idle".to_string(),
            model_provider: "codex".to_string(),
            provider: "codex".to_string(),
            forked_from: None,
            renamed: false,
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
            workspace_trusted: false,
            id: "codex-thread".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "codex".to_string(),
            status: "idle".to_string(),
            model_provider: "codex".to_string(),
            provider: "codex".to_string(),
            forked_from: None,
            renamed: false,
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
async fn command_execution_cwd_records_proven_without_clobbering_birth_cwd() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.upsert_thread(ThreadSummaryView {
            workspace_trusted: false,
            id: "thread-1".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "codex".to_string(),
            status: "active".to_string(),
            model_provider: "codex".to_string(),
            provider: "codex".to_string(),
            forked_from: None,
            renamed: false,
        });
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
                    "command": "ls",
                    "cwd": "/tmp/project/.worktrees/feature",
                    "status": "running"
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    assert_eq!(
        relay.thread_workspace("thread-1").proven.as_deref(),
        Some("/tmp/project/.worktrees/feature"),
        "a command's cwd is where this session is, even with no file writes"
    );
    assert_eq!(
        relay.thread_cwd("thread-1").as_deref(),
        Some("/tmp/project"),
        "birth cwd stays the directory the thread was created in"
    );
}

#[tokio::test]
async fn thread_settings_updated_records_proven_from_thread_settings_cwd() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.upsert_thread(ThreadSummaryView {
            workspace_trusted: false,
            id: "thread-1".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "codex".to_string(),
            status: "active".to_string(),
            model_provider: "codex".to_string(),
            provider: "codex".to_string(),
            forked_from: None,
            renamed: false,
        });
        relay.active_thread_id = Some("thread-1".to_string());
    }

    handle_notification(
        json!({
            "method": "thread/settings/updated",
            "params": {
                "threadId": "thread-1",
                "threadSettings": {
                    "cwd": "/tmp/project/.worktrees/feature"
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    assert_eq!(
        relay.thread_workspace("thread-1").proven.as_deref(),
        Some("/tmp/project/.worktrees/feature"),
        "Codex threadSettings.cwd is the session cwd this notification carries"
    );
    assert_eq!(
        relay.thread_cwd("thread-1").as_deref(),
        Some("/tmp/project"),
        "birth cwd stays the directory the thread was created in"
    );
}

#[tokio::test]
async fn thread_settings_updated_restating_birth_must_not_clobber_proven() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.upsert_thread(ThreadSummaryView {
            workspace_trusted: false,
            id: "thread-1".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "codex".to_string(),
            status: "active".to_string(),
            model_provider: "codex".to_string(),
            provider: "codex".to_string(),
            forked_from: None,
            renamed: false,
        });
        relay.active_thread_id = Some("thread-1".to_string());
        relay.observe_thread_cwd("thread-1", "/tmp/project/.worktrees/feature");
    }

    handle_notification(
        json!({
            "method": "thread/settings/updated",
            "params": {
                "threadId": "thread-1",
                "threadSettings": {
                    "cwd": "/tmp/project",
                    "model": "gpt-5.5"
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    assert_eq!(
        relay.thread_workspace("thread-1").proven.as_deref(),
        Some("/tmp/project/.worktrees/feature"),
        "a settings update that restates birth cwd is not 'went home'"
    );
}

#[tokio::test]
async fn command_approval_cwd_records_proven_without_clobbering_birth_cwd() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.upsert_thread(ThreadSummaryView {
            workspace_trusted: false,
            id: "thread-1".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "codex".to_string(),
            status: "active".to_string(),
            model_provider: "codex".to_string(),
            provider: "codex".to_string(),
            forked_from: None,
            renamed: false,
        });
        relay.active_thread_id = Some("thread-1".to_string());
    }

    handle_server_request(
        json!({
            "id": 1,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-1",
                "command": "ls",
                "cwd": "/tmp/project/.worktrees/feature",
                "availableDecisions": ["approve", "deny"]
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    assert_eq!(
        relay.thread_workspace("thread-1").proven.as_deref(),
        Some("/tmp/project/.worktrees/feature")
    );
    assert_eq!(
        relay.thread_cwd("thread-1").as_deref(),
        Some("/tmp/project")
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
fn codex_turn_start_carries_resolved_yolo_policy_per_turn() {
    // Regression for "Codex YOLO still asks for permission": codex binds the
    // approval policy only at thread/start & thread/resume, so a turn that
    // reaches an app-server which never resumed this thread (relay restart,
    // background thread, or a plain send that skips resume) would fall back to
    // codex's config default and prompt. Every turn/start must re-assert the
    // thread's current resolved policy. Mirrors Claude's
    // `start_turn_sends_the_threads_current_permission_mode`.
    let params = codex_turn_start_params(
        "thread-1",
        "hello",
        "gpt-5-codex",
        "medium",
        Some(("bypass", "workspace-write")),
    );

    assert_eq!(params["threadId"], json!("thread-1"));
    assert_eq!(params["input"][0]["text"], json!("hello"));
    assert_eq!(
        params["approvalPolicy"],
        json!("never"),
        "YOLO turn must carry approvalPolicy=never so codex never prompts"
    );
    assert_eq!(
        params["sandboxPolicy"],
        json!({ "type": "dangerFullAccess" }),
        "YOLO turn must re-assert danger-full-access so a fresh/unloaded thread is not sandboxed"
    );
}

#[test]
fn codex_turn_start_reasserts_read_only_sandbox_per_turn() {
    // read-only is a deliberate safety lockdown. The same unloaded-thread cases
    // that drop the approval policy also drop the sandbox binding, so a saved
    // read-only thread could otherwise run under codex's default (writable)
    // sandbox after a restart/background send. The structured read-only policy
    // has no config-derived writableRoots to preserve, so we can safely
    // re-assert it every turn (network stays off, the restrictive direction).
    let params = codex_turn_start_params(
        "thread-1",
        "hello",
        "gpt-5-codex",
        "medium",
        Some(("on-request", "read-only")),
    );

    assert_eq!(params["approvalPolicy"], json!("on-request"));
    assert_eq!(
        params["sandboxPolicy"],
        json!({ "type": "readOnly", "networkAccess": false }),
        "read-only turn must re-assert the read-only sandbox so an unloaded thread cannot run writable"
    );
}

#[test]
fn codex_turn_start_leaves_workspace_write_sandbox_to_thread_binding() {
    // Non-YOLO turns still re-assert the approval policy every turn (so prompting
    // stays correct), but a workspace-write turn must NOT send a turn-level
    // sandbox override: codex's structured SandboxPolicy would clobber the
    // config-derived writableRoots that thread/start & thread/resume already
    // bound. workspace-write's default fallback is equivalently permissive, so
    // leaving it to the thread-level mode is safe.
    let params = codex_turn_start_params(
        "thread-1",
        "hello",
        "gpt-5-codex",
        "medium",
        Some(("on-request", "workspace-write")),
    );

    assert_eq!(params["approvalPolicy"], json!("on-request"));
    assert!(
        params.get("sandboxPolicy").is_none(),
        "workspace-write turn must not override the sandbox: {params}"
    );
}

#[test]
fn codex_turn_start_omits_overrides_when_settings_are_unknown() {
    // With no relay record for the thread, keep codex on whatever policy
    // thread/start or thread/resume last bound (legacy behavior) rather than
    // guessing.
    let params = codex_turn_start_params("thread-1", "hello", "gpt-5-codex", "medium", None);

    assert!(params.get("approvalPolicy").is_none(), "{params}");
    assert!(params.get("sandboxPolicy").is_none(), "{params}");
}

#[test]
fn codex_turn_start_sends_inline_images_before_optional_text() {
    let images = vec![ProviderImage {
        media_type: "image/png".to_string(),
        data: "iVBORw0KGgo=".to_string(),
    }];
    let params = codex_turn_start_params_with_images(
        "thread-1",
        "Inspect this screenshot",
        "gpt-5-codex",
        "medium",
        &images,
        None,
    );

    assert_eq!(
        params["input"],
        json!([
            {
                "type": "image",
                "url": "data:image/png;base64,iVBORw0KGgo="
            },
            {
                "type": "text",
                "text": "Inspect this screenshot"
            }
        ])
    );

    let image_only =
        codex_turn_start_params_with_images("thread-1", "", "gpt-5-codex", "medium", &images, None);
    assert_eq!(image_only["input"].as_array().map(Vec::len), Some(1));
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
        workspace_trusted: false,
        id: id.to_string(),
        name: None,
        preview: String::new(),
        cwd: "/tmp/project".to_string(),
        updated_at: 1,
        source: "codex".to_string(),
        status: "idle".to_string(),
        model_provider: "openai".to_string(),
        provider: "codex".to_string(),
        forked_from: None,
        renamed: false,
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
        content_state: crate::protocol::TranscriptContentState::Full,
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
                    content_state: crate::protocol::TranscriptContentState::Full,
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
                    content_state: crate::protocol::TranscriptContentState::Full,
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
                    content_state: crate::protocol::TranscriptContentState::Full,
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
                    content_state: crate::protocol::TranscriptContentState::Full,
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

// ---------------------------------------------------------------------------
// Bridge <-> fake-app-server integration (B-layer).
//
// These spawn the real CodexBridge against scripts/fake-codex-app-server.mjs,
// which models the one app-server rule the relay kept violating: `turn/start`
// only accepts threads that thread/start or thread/resume has materialized in
// THIS process, even though thread/read serves any rollout off disk.
// ---------------------------------------------------------------------------

fn fake_codex_path() -> &'static str {
    let crate_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = crate_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| ".".to_string());
    let path = format!("{workspace_root}/scripts/fake-codex-app-server.mjs");
    assert!(
        std::path::Path::new(&path).is_file(),
        "missing fake Codex app-server script at {path}; this regression coverage must not be skipped"
    );
    // CodexBridge::spawn takes a &'static binary name; leak the resolved fake
    // path so the test can point it at a script instead of the real binary.
    Box::leak(path.into_boxed_str())
}

async fn spawn_fake_codex_bridge() -> (CodexBridge, std::sync::Arc<RwLock<RelayState>>) {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    let bridge = CodexBridge::spawn(state.clone(), fake_codex_path(), "Fake Codex", "codex")
        .await
        .unwrap_or_else(|error| panic!("spawn fake Codex app-server for regression test: {error}"));
    (bridge, state)
}

/// The JSON-RPC methods the fake app-server actually received, oldest first.
///
/// The fake echoes every received message to stderr, which the bridge's stderr
/// reader funnels into the relay log buffer — but `push_log` inserts at the
/// front, so the buffer is newest-first. Reverse it here: an ordering assertion
/// that reads backwards is worse than none, since a symmetric sequence (say
/// turn/start → thread/resume → turn/start) passes either way and proves
/// nothing about order.
async fn codex_recv_methods(state: &std::sync::Arc<RwLock<RelayState>>) -> Vec<String> {
    state
        .read()
        .await
        .snapshot()
        .logs
        .iter()
        .rev()
        .filter_map(|log| log.message.strip_prefix("CODEX RECV ").map(str::to_string))
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(|payload| {
            payload
                .get("method")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

#[tokio::test]
async fn list_threads_follows_the_cursor_past_codexs_100_row_page_cap() {
    // The real app-server silently caps one thread/list response at 100 rows even when
    // the caller asks for more. A session just five rows into page two therefore used to
    // vanish from Sealwire's sidebar (and lose its tab title) because the bridge treated
    // `limit` as the scan size and ignored nextCursor.
    let (bridge, state) = spawn_fake_codex_bridge().await;

    let threads = bridge
        .list_threads(105)
        .await
        .expect("the bridge must collect enough pages to satisfy the requested scan");

    assert_eq!(threads.len(), 105);
    assert_eq!(threads[0].id, "listed-thread-000");
    assert_eq!(
        threads[104].id, "listed-thread-104",
        "the fifth session on page two must remain discoverable"
    );

    let requests = codex_recv_payloads(&state)
        .await
        .into_iter()
        .filter(|payload| payload.get("method").and_then(Value::as_str) == Some("thread/list"))
        .collect::<Vec<_>>();
    assert_eq!(
        requests.len(),
        2,
        "105 rows should require exactly two pages"
    );
    assert_eq!(requests[0]["params"]["cursor"], Value::Null);
    assert_eq!(requests[0]["params"]["limit"], 105);
    assert_eq!(requests[1]["params"]["cursor"], "100");
    assert_eq!(
        requests[1]["params"]["limit"], 5,
        "the second request should fetch only the missing rows"
    );
}

#[tokio::test]
async fn start_turn_resumes_a_thread_the_app_server_has_not_loaded() {
    // Regression for "codex 没法发消息" — POST /api/session/message -> 400
    // `thread not found: <id>` on a thread whose transcript renders fine.
    //
    // A thread created by the Codex VSCode extension / CLI (or any thread left
    // over from a previous relay process) exists on disk but was never
    // materialized in the app-server the relay spawned. thread/read serves it
    // off disk, so the relay hydrates a runtime and shows the transcript — but
    // turn/start rejects it, and the send path has no resume left to save it.
    //
    // 1084b0a ("Decouple thread viewing from targeted control") removed the
    // take-over resume that used to cover this:
    //     if needs_takeover { self.resume_session_inner(...).await?; }
    // and replaced it with ensure_thread_runtime_loaded, which is relay-local
    // (read_thread + hydrate_background_runtime) and never touches the provider.
    // The old take-over must NOT come back — it displaced the active thread's
    // control, which is exactly what that commit set out to fix — so the bridge
    // materializes the provider session itself, with no take-over semantics.
    let (bridge, state) = spawn_fake_codex_bridge().await;
    {
        let mut relay = state.write().await;
        relay.remember_thread_settings(
            "thread-cold",
            "on-request",
            "workspace-write",
            "low",
            "gpt-5.6-sol",
        );
    }

    let turn_id = bridge
        .start_turn("thread-cold", "hello", "gpt-5.6-sol", "low")
        .await
        .expect("sending to a thread the app-server has not loaded must still start a turn");

    assert!(
        turn_id.is_some(),
        "a healed turn/start must still return the turn id"
    );

    let methods = codex_recv_methods(&state).await;
    assert_eq!(
        methods
            .iter()
            .filter(|method| *method == "turn/start" || *method == "thread/resume")
            .collect::<Vec<_>>(),
        vec!["turn/start", "thread/resume", "turn/start"],
        "the bridge must retry turn/start once, after resuming the thread it \
         learned was not loaded"
    );
}

#[tokio::test]
async fn start_turn_does_not_resume_a_thread_the_app_server_already_has() {
    // The heal is a recovery path, not a preamble. Resuming on every send would
    // cost an extra round-trip per message and re-bind the thread's policy
    // underneath a live session — so it must fire only on codex's own
    // "not loaded" error, never speculatively.
    let (bridge, state) = spawn_fake_codex_bridge().await;
    {
        let mut relay = state.write().await;
        relay.remember_thread_settings(
            "thread-warm",
            "on-request",
            "workspace-write",
            "low",
            "gpt-5.6-sol",
        );
    }
    bridge
        .resume_thread("thread-warm", "on-request", "workspace-write")
        .await
        .expect("fake app-server resumes a thread on disk");

    bridge
        .start_turn("thread-warm", "hello", "gpt-5.6-sol", "low")
        .await
        .expect("a loaded thread starts a turn on the first try");

    let methods = codex_recv_methods(&state).await;
    assert_eq!(
        methods
            .iter()
            .filter(|method| *method == "turn/start" || *method == "thread/resume")
            .collect::<Vec<_>>(),
        vec!["thread/resume", "turn/start"],
        "a thread the app-server already holds must not be resumed again on send"
    );
}

#[tokio::test]
async fn start_turn_heals_a_thread_with_no_remembered_settings_under_the_strictest_policy() {
    // A Codex thread the relay never drove — created by the VSCode extension or
    // the CLI, or left over from a previous relay process — has no remembered
    // settings. Refusing to resume it left it PERMANENTLY unsendable:
    // `turn/start` -> `thread not found` -> HTTP 400, on a thread whose
    // transcript renders fine and whose session nobody is using. Claude has no
    // such dead end (its worker resumes the SDK session from disk on every
    // send), so this was a Codex-only "why can't I just talk to it".
    //
    // Heal it — but never by guessing a policy that could WIDEN what the turn
    // may do (the hazard that made this fail closed in the first place). Resume
    // under the strictest policy the protocol has: a read-only sandbox, and
    // escalation for anything outside codex's trusted-command set. Recovery can
    // then only narrow, never grant.
    let (bridge, state) = spawn_fake_codex_bridge().await;

    let turn_id = bridge
        .start_turn("thread-unknown", "hello", "gpt-5.6-sol", "low")
        .await
        .expect("a thread with no remembered settings must still be sendable");
    assert!(
        turn_id.is_some(),
        "a healed turn/start must still return the turn id"
    );

    let methods = codex_recv_methods(&state).await;
    assert_eq!(
        methods
            .iter()
            .filter(|method| *method == "turn/start" || *method == "thread/resume")
            .collect::<Vec<_>>(),
        vec!["turn/start", "thread/resume", "turn/start"],
        "the bridge must resume once, after codex reports the thread is not loaded"
    );

    let resume = codex_recv_payloads(&state)
        .await
        .into_iter()
        .find(|payload| payload.get("method").and_then(Value::as_str) == Some("thread/resume"))
        .expect("the heal must send thread/resume");
    assert_eq!(
        (
            &resume["params"]["approvalPolicy"],
            &resume["params"]["sandbox"]
        ),
        (&json!("untrusted"), &json!("read-only")),
        "an invented policy must be the strictest one, so healing cannot grant \
         write access nobody asked for: {resume}"
    );

    // The retried turn must re-assert the same policy. `turn/start` params are
    // built before the fallback is chosen, so a retry that reused them would
    // send no override and let codex fall back to its own config default —
    // silently widening the very turn this path locked down.
    let retry = codex_recv_payloads(&state)
        .await
        .into_iter()
        .filter(|payload| payload.get("method").and_then(Value::as_str) == Some("turn/start"))
        .next_back()
        .expect("the heal must retry turn/start");
    assert_eq!(
        (
            &retry["params"]["approvalPolicy"],
            &retry["params"]["sandboxPolicy"]
        ),
        (
            &json!("untrusted"),
            &json!({ "type": "readOnly", "networkAccess": false })
        ),
        "the healed turn must carry the policy the resume bound: {retry}"
    );

    // The relay must also RECORD what it bound. Otherwise the UI keeps showing
    // the permissive defaults the runtime was hydrated with while codex is
    // actually running the thread read-only — and the user gets approval
    // prompts with no way to see why.
    let settings = state
        .read()
        .await
        .remembered_thread_settings("thread-unknown")
        .expect("the healed policy must be remembered");
    assert_eq!(
        (settings.approval_policy.as_str(), settings.sandbox.as_str()),
        ("untrusted", "read-only"),
        "the healed thread's settings must describe what codex was actually told"
    );
}

#[tokio::test]
async fn a_healed_turn_with_images_still_carries_the_invented_policy() {
    // The retry rebuilds its params, and the images path is a separate branch
    // from the text one. A miss there sends an image turn with no override at
    // all, which drifts back to codex's config default — the silent widening
    // the strict fallback exists to prevent, on the one path nobody looks at.
    let (bridge, state) = spawn_fake_codex_bridge().await;

    let images = vec![ProviderImage {
        media_type: "image/png".to_string(),
        data: "aGk=".to_string(),
    }];
    let turn_id = bridge
        .start_turn_with_images("thread-cold-image", "look", "gpt-5.6-sol", "low", &images)
        .await
        .expect("an image send to a thread with unknown settings must still heal");
    assert!(turn_id.is_some());

    let retry = codex_recv_payloads(&state)
        .await
        .into_iter()
        .filter(|payload| payload.get("method").and_then(Value::as_str) == Some("turn/start"))
        .next_back()
        .expect("the heal must retry turn/start");
    assert_eq!(
        (
            &retry["params"]["approvalPolicy"],
            &retry["params"]["sandboxPolicy"]
        ),
        (
            &json!("untrusted"),
            &json!({ "type": "readOnly", "networkAccess": false })
        ),
        "the healed image turn must carry the policy the resume bound: {retry}"
    );
    assert_eq!(
        retry["params"]["input"][0]["type"],
        json!("image"),
        "and must still carry the attachment it was sent with: {retry}"
    );
}

#[test]
fn is_thread_not_loaded_error_matches_only_the_not_loaded_failure() {
    // Too broad a matcher would retry real turn failures (double-sending the
    // user's message); too narrow and the bug comes straight back.
    assert!(is_thread_not_loaded_error(
        "thread not found: 019f6c95-c5e1-7633-a9cd-44c4587261ef"
    ));
    assert!(is_thread_not_loaded_error("Thread not found"));
    assert!(!is_thread_not_loaded_error("turn failed: model overloaded"));
    assert!(!is_thread_not_loaded_error(
        "thread '019f6c95' was not found on any provider"
    ));
}

// Calls the SHIPPED bridge rather than comparing constants to literals:
// removing the override must fail here. Codex `thread/fork` is tip-only, and
// fork_thread returns Ok(None) for a mid-thread branch — the capability has to
// say so or the UI labels that replay as a native fork.
#[tokio::test]
async fn the_codex_bridge_declares_the_capability_it_implements() {
    let (bridge, _state) = spawn_fake_codex_bridge().await;
    let capability = crate::provider::ProviderBridge::fork_capability(&bridge);
    assert!(capability.native_fork, "codex implements thread/fork");
    assert!(
        !capability.native_fork_at_message,
        "thread/fork always branches at the tip"
    );
}

/// Full received payloads (oldest first), for assertions about request params
/// rather than just which method was called.
async fn codex_recv_payloads(state: &std::sync::Arc<RwLock<RelayState>>) -> Vec<Value> {
    state
        .read()
        .await
        .snapshot()
        .logs
        .iter()
        .rev()
        .filter_map(|log| log.message.strip_prefix("CODEX RECV ").map(str::to_string))
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .collect()
}

// End-to-end for the inheritance rule: the model fork_session resolved must
// reach the provider. Asserting only the returned snapshot would not prove the
// value left the relay — `thread/fork` is what actually creates the branch.
#[tokio::test]
async fn a_native_fork_sends_the_resolved_model_to_the_provider() {
    let (bridge, state) = spawn_fake_codex_bridge().await;

    crate::provider::ProviderBridge::fork_thread(
        &bridge,
        crate::provider::ProviderForkRequest {
            source_thread_id: "thread-src".to_string(),
            up_to_item_id: None,
            cwd: "/tmp/project".to_string(),
            model: "inherited-model".to_string(),
            approval_policy: "never".to_string(),
            sandbox: "workspace-write".to_string(),
        },
    )
    .await
    .expect("fork_thread should reach the app-server");

    let fork = codex_recv_payloads(&state)
        .await
        .into_iter()
        .find(|payload| payload.get("method").and_then(Value::as_str) == Some("thread/fork"))
        .expect("the bridge must send thread/fork");

    assert_eq!(
        fork["params"]["model"], "inherited-model",
        "the resolved model must reach the provider: {fork}"
    );
    assert_eq!(fork["params"]["threadId"], "thread-src");
}

// Which Codex failures are LIMITS — the ones that pause a task run instead of
// ending it. A pause is resumable, so the branch, worktree and sub-task
// progress survive until the limit lifts; an ordinary failure throws them away.
#[test]
fn codex_classifies_both_session_limits_and_nothing_else() {
    for limit in ["usageLimitExceeded", "sessionBudgetExceeded"] {
        assert_eq!(
            codex_error_info_kind(&json!(limit)),
            Some(TurnFailureKind::UsageLimit),
            "{limit:?} is a session limit and must pause the run, not end it"
        );
        // The same variant arrives object-wrapped too, and this mapper reads
        // both — a classification that depended on the shape would be a
        // coin-flip on whichever form the provider happened to send.
        assert_eq!(
            codex_error_info_kind(&json!({ limit: {} })),
            Some(TurnFailureKind::UsageLimit),
            "{limit:?} must classify the same object-wrapped as bare"
        );
    }

    // A transient, not a limit. Pausing would park the run as "waiting for
    // quota" when the answer is simply to try again.
    for ordinary in [
        "serverOverloaded",
        "contextWindowExceeded",
        "unauthorized",
        "badRequest",
        "internalServerError",
        "other",
        "someUnknownFutureVariant",
    ] {
        assert_eq!(
            codex_error_info_kind(&json!(ordinary)),
            None,
            "{ordinary:?} must stay an ordinary failure"
        );
        assert_eq!(codex_error_info_kind(&json!({ ordinary: {} })), None);
    }
}

/// The PRODUCTION path for a zero-token Codex turn, parser included.
///
/// The reviewer gate keys on `last_turn_spend`, and a test that called
/// `record_token_usage` directly would have proved nothing here: the tracker
/// used to swallow an all-zero delta before the funnel ever saw it, so a real
/// zero reply reached the gate as "no figure" and opened it.
#[tokio::test]
async fn a_zero_token_codex_turn_records_a_zero_spend_not_an_absence() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
        // The runtime the spend is recorded on; a bare id has none.
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
    }

    handle_notification(
        json!({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "tokenUsage": {
                    "last": { "totalTokens": 0 },
                    "total": { "totalTokens": 0 },
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let spend = relay
        .last_turn_spend("thread-1")
        .expect("a reported zero must leave a record, or it reads as no report");
    assert_eq!(spend.turn_id, "turn-1");
    assert_eq!(spend.billed, 0);
}

/// The other side of the same seam: real tokens are recorded against the turn
/// that spent them.
#[tokio::test]
async fn a_billed_codex_turn_records_what_it_spent() {
    let (change_tx, _) = watch::channel(0_u64);
    let state = std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )));
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("thread-1".to_string());
        // The runtime the spend is recorded on; a bare id has none.
        relay.set_thread_status("thread-1", "active".to_string(), Vec::new());
    }

    handle_notification(
        json!({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "tokenUsage": {
                    "last": { "inputTokens": 10, "outputTokens": 5, "totalTokens": 15 },
                    "total": { "inputTokens": 10, "outputTokens": 5, "totalTokens": 15 },
                }
            }
        }),
        &state,
    )
    .await;

    let relay = state.read().await;
    let spend = relay.last_turn_spend("thread-1").expect("a billed turn");
    assert_eq!(spend.turn_id, "turn-1");
    assert!(spend.billed > 0, "got {}", spend.billed);
}
