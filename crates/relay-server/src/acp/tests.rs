//! Translation tests driven by wire payloads captured verbatim from the
//! 2026-08-11 `cursor-agent 2026.08.04-aaa8809` spike.

use serde_json::json;

use super::rpc::{capture_op, plan_update, TranscriptOp};
use super::SessionRuntime;
use crate::protocol::TranscriptEntryView;

fn session() -> SessionRuntime {
    SessionRuntime::default()
}

/// Drive a whole `session/load` replay through the same path `read_thread` uses.
fn replay(updates: &[serde_json::Value]) -> Vec<TranscriptEntryView> {
    let mut runtime = session();
    let mut buffer = Vec::new();
    for update in updates {
        capture_op(&mut buffer, plan_update(update, &mut runtime));
    }
    buffer
}

fn user(text: &str) -> serde_json::Value {
    json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":text}})
}

fn agent(text: &str) -> serde_json::Value {
    json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}})
}

#[test]
fn agent_chunks_accumulate_into_one_item() {
    let mut runtime = session();
    let mut last = TranscriptOp::Ignore;
    for piece in ["`hello", ".txt", "` says"] {
        last = plan_update(
            &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":piece}}),
            &mut runtime,
        );
    }
    match last {
        TranscriptOp::AgentChunk {
            item_id,
            delta,
            text,
        } => {
            assert_eq!(item_id, "acp-msg-1", "all chunks share one minted item");
            assert_eq!(delta, "` says", "the delta is just the newest piece");
            assert_eq!(text, "`hello.txt` says", "text is the accumulation");
        }
        other => panic!("expected AgentChunk, got {other:?}"),
    }
}

#[test]
fn a_tool_call_closes_the_open_message_so_text_does_not_bleed_across_it() {
    let mut runtime = session();
    plan_update(
        &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"before"}}),
        &mut runtime,
    );
    plan_update(
        &json!({"sessionUpdate":"tool_call","toolCallId":"call-1","title":"`cat`","status":"pending"}),
        &mut runtime,
    );
    let after = plan_update(
        &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"after"}}),
        &mut runtime,
    );
    match after {
        TranscriptOp::AgentChunk { item_id, text, .. } => {
            assert_eq!(item_id, "acp-msg-2", "a new message entry opened");
            assert_eq!(text, "after", "accumulation restarted");
        }
        other => panic!("expected AgentChunk, got {other:?}"),
    }
}

#[test]
fn tool_call_and_its_update_share_one_item_despite_the_newline_in_acps_id() {
    // Measured: a live toolCallId embeds a raw newline, which is exactly why the
    // relay mints its own ids and keys off ACP's only as a lookup.
    let raw_id =
        "call-3309e706-88e5-472b-91ce-f92ed275425c-0\nfc_b5ce28f3-0445-9b76-a044-dfd055991a59_0";
    let mut runtime = session();

    let started = plan_update(
        &json!({
            "sessionUpdate":"tool_call","toolCallId":raw_id,
            "title":"`cat hello.txt`","kind":"execute","status":"pending",
            "rawInput":{"command":"cat hello.txt"}
        }),
        &mut runtime,
    );
    let completed = plan_update(
        &json!({
            "sessionUpdate":"tool_call_update","toolCallId":raw_id,"status":"completed",
            "rawOutput":{"exitCode":0,"stdout":"hello from the acp spike\n","stderr":""}
        }),
        &mut runtime,
    );

    let (
        TranscriptOp::Tool {
            item_id: a,
            command,
            status: started_status,
            ..
        },
        TranscriptOp::Tool {
            item_id: b,
            output,
            status: done_status,
            ..
        },
    ) = (started, completed)
    else {
        panic!("expected two Tool ops");
    };
    assert_eq!(
        a, b,
        "the update must land on the started call, not a new row"
    );
    assert!(
        !a.contains('\n'),
        "minted ids must not inherit ACP's newline"
    );
    assert_eq!(command.as_deref(), Some("cat hello.txt"));
    assert_eq!(output.as_deref(), Some("hello from the acp spike\n"));
    assert_eq!(started_status, "pending");
    assert_eq!(done_status, "completed");
}

#[test]
fn replay_ids_match_live_ids_because_ordinals_are_per_kind() {
    // ACP reassigns its own ids on `session/load` (a live `call-…` replays as
    // `replay-0-1`), so item identity has to come from per-kind ordering. Live
    // and replay differ only by the leading user_message_chunk, which is why the
    // counters are per kind rather than global.
    let mut live = session();
    plan_update(
        &json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Running `cat`"}}),
        &mut live,
    );
    let live_tool = plan_update(
        &json!({"sessionUpdate":"tool_call","toolCallId":"call-live","title":"`cat`","status":"pending"}),
        &mut live,
    );

    let mut replay = session();
    plan_update(
        &json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Run cat"}}),
        &mut replay,
    );
    plan_update(
        &json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Running `cat`"}}),
        &mut replay,
    );
    let replay_tool = plan_update(
        &json!({"sessionUpdate":"tool_call","toolCallId":"replay-0-1","title":"`cat`","status":"pending"}),
        &mut replay,
    );

    let (
        TranscriptOp::Tool {
            item_id: live_id, ..
        },
        TranscriptOp::Tool {
            item_id: replay_id, ..
        },
    ) = (live_tool, replay_tool)
    else {
        panic!("expected Tool ops");
    };
    assert_eq!(
        live_id, replay_id,
        "a reload must not renumber the item a fork anchor points at"
    );
}

#[test]
fn thought_chunks_are_reasoning_not_agent_text() {
    let mut runtime = session();
    let op = plan_update(
        &json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking"}}),
        &mut runtime,
    );
    assert!(
        matches!(op, TranscriptOp::ThoughtChunk { .. }),
        "got {op:?}"
    );
}

#[test]
fn session_info_update_carries_the_generated_title() {
    let mut runtime = session();
    let op = plan_update(
        &json!({"sessionUpdate":"session_info_update","title":"Cat File Content"}),
        &mut runtime,
    );
    assert_eq!(op, TranscriptOp::Title("Cat File Content".to_string()));
}

#[test]
fn unknown_and_empty_updates_are_ignored_rather_than_producing_blank_entries() {
    let mut runtime = session();
    for payload in [
        json!({"sessionUpdate":"available_commands_update","availableCommands":[]}),
        json!({"sessionUpdate":"usage_update","used":10}),
        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":""}}),
        json!({"sessionUpdate":"tool_call","title":"no id"}),
        json!({}),
    ] {
        assert_eq!(
            plan_update(&payload, &mut runtime),
            TranscriptOp::Ignore,
            "payload should be ignored: {payload}"
        );
    }
    // Nothing was minted, so a later real chunk still starts at ordinal 1.
    let op = plan_update(
        &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}),
        &mut runtime,
    );
    assert!(matches!(op, TranscriptOp::AgentChunk { ref item_id, .. } if item_id == "acp-msg-1"));
}

#[test]
fn acp_error_messages_surface_the_nested_detail() {
    // The useful text lives in `data.message`; `message` alone is the JSON-RPC
    // class and would tell the user nothing.
    let error = json!({
        "code": -32000,
        "message": "Authentication required",
        "data": {"message": "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'."}
    });
    let rendered = super::rpc::acp_error_message(&error);
    assert!(rendered.contains("agent login"), "got {rendered}");

    // A duplicated detail must not be printed twice.
    let dup = json!({"message":"boom","data":{"message":"boom"}});
    assert_eq!(super::rpc::acp_error_message(&dup), "boom");
    assert_eq!(
        super::rpc::acp_error_message(&json!({})),
        "unknown ACP error"
    );
}

// ---------------------------------------------------------------------------
// Regressions from the 2026-08-11 Codex review of the ACP skeleton.
// ---------------------------------------------------------------------------

#[test]
fn multi_turn_replay_keeps_each_assistant_reply_in_its_own_entry() {
    // A `user_message_chunk` is a turn boundary: the previous assistant message
    // is finished. Without closing the open stream, `agent2` appends onto
    // `acp-msg-1` and the reloaded history reads as one giant reply attached to
    // the first question.
    let entries = replay(&[user("q1"), agent("a1"), user("q2"), agent("a2")]);

    let texts: Vec<_> = entries
        .iter()
        .map(|entry| (entry.kind, entry.text.clone().unwrap_or_default()))
        .collect();
    assert_eq!(
        texts,
        vec![
            (
                crate::protocol::TranscriptEntryKind::UserText,
                "q1".to_string()
            ),
            (
                crate::protocol::TranscriptEntryKind::AgentText,
                "a1".to_string()
            ),
            (
                crate::protocol::TranscriptEntryKind::UserText,
                "q2".to_string()
            ),
            (
                crate::protocol::TranscriptEntryKind::AgentText,
                "a2".to_string()
            ),
        ],
        "each reply belongs to the question it answered"
    );

    let ids: Vec<_> = entries
        .iter()
        .filter_map(|entry| entry.item_id.clone())
        .collect();
    assert_eq!(ids.len(), 4);
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        4,
        "no two entries may share an item id: {ids:?}"
    );
}

#[test]
fn a_user_turn_boundary_makes_live_and_replay_ids_agree_without_tools() {
    // The no-tool multi-turn case is the common one, and it is where live and
    // replay diverge if only tool calls close the stream: live closes on every
    // `start_turn`, replay only saw `user_message_chunk`.
    let mut live = session();
    // Turn 1 — `start_turn` closes streams before the prompt goes out.
    live.close_streams();
    plan_update(&agent("a1"), &mut live);
    // Turn 2.
    live.close_streams();
    let live_second = plan_update(&agent("a2"), &mut live);

    let mut replayed = session();
    plan_update(&user("q1"), &mut replayed);
    plan_update(&agent("a1"), &mut replayed);
    plan_update(&user("q2"), &mut replayed);
    let replay_second = plan_update(&agent("a2"), &mut replayed);

    let (
        TranscriptOp::AgentChunk {
            item_id: live_id, ..
        },
        TranscriptOp::AgentChunk {
            item_id: replay_id, ..
        },
    ) = (live_second, replay_second)
    else {
        panic!("expected AgentChunk ops");
    };
    assert_eq!(
        live_id, replay_id,
        "a reload must not renumber the second reply"
    );
}

#[test]
fn a_tool_completion_keeps_the_title_and_command_from_its_start() {
    // ACP tool updates are partial: `tool_call_update` carries only
    // toolCallId/status/rawOutput. Treating the absent fields as empty and then
    // replacing the whole entry loses what the tool actually was.
    let raw_id = "call-abc\nfc_def";
    let entries = replay(&[
        json!({
            "sessionUpdate":"tool_call","toolCallId":raw_id,
            "title":"`cat hello.txt`","kind":"execute","status":"pending",
            "rawInput":{"command":"cat hello.txt"}
        }),
        json!({
            "sessionUpdate":"tool_call_update","toolCallId":raw_id,"status":"completed",
            "rawOutput":{"exitCode":0,"stdout":"hello from the acp spike\n","stderr":""}
        }),
    ]);

    assert_eq!(entries.len(), 1, "the update belongs to the started call");
    let entry = &entries[0];
    assert_eq!(entry.status, "completed");
    assert_eq!(
        entry.text.as_deref(),
        Some("`cat hello.txt`"),
        "the title from `tool_call` must survive the completion"
    );
    let tool = entry.tool.as_ref().expect("tool view");
    assert_eq!(tool.title, "`cat hello.txt`");
    assert_eq!(
        tool.command.as_deref(),
        Some("cat hello.txt"),
        "rawInput only rides on the start event"
    );
    assert_eq!(
        tool.result_preview.as_deref(),
        Some("hello from the acp spike\n")
    );
}

#[test]
fn standard_acp_tool_content_is_read_not_just_cursors_raw_output() {
    // `rawOutput` is a Cursor extension; the portable shape is a `content`
    // array. A generic ACP bridge has to understand the spec'd one.
    let entries = replay(&[
        json!({
            "sessionUpdate":"tool_call","toolCallId":"t1",
            "title":"Read file","kind":"read","status":"pending"
        }),
        json!({
            "sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed",
            "content":[{"type":"content","content":{"type":"text","text":"file body"}}]
        }),
    ]);
    let tool = entries[0].tool.as_ref().expect("tool view");
    assert_eq!(tool.result_preview.as_deref(), Some("file body"));
}

#[test]
fn listing_threads_caches_each_cwd_so_a_cold_session_can_be_loaded() {
    // `session/load` needs an absolute cwd. After a relay restart the session
    // map is empty, and the only place the cwd appears is the `session/list`
    // response — so listing has to seed the cache or every cold `read_thread` /
    // `resume_thread` sends `cwd: ""`.
    let mut sessions = std::collections::HashMap::new();
    let listed = vec![crate::acp::protocol::thread_summary(
        &json!({"sessionId":"s1","cwd":"/Users/luchi/git/agent-relay","title":"t1",
                    "updatedAt":"2026-08-11T16:39:48.293Z"}),
        "cursor",
        0,
    )
    .expect("thread")];

    crate::acp::absorb_thread_cwds(&mut sessions, &listed);

    assert_eq!(
        sessions.get("s1").map(|s| s.cwd.as_str()),
        Some("/Users/luchi/git/agent-relay")
    );
}

#[test]
fn caching_cwds_never_clobbers_a_live_session() {
    // A listing is a weaker source than the cwd the relay opened the session
    // with; it must fill gaps, not overwrite.
    let mut sessions = std::collections::HashMap::new();
    sessions.insert(
        "s1".to_string(),
        crate::acp::SessionRuntime {
            cwd: "/live/path".to_string(),
            approval_policy: "on-request".to_string(),
            ..Default::default()
        },
    );
    let listed = vec![crate::acp::protocol::thread_summary(
        &json!({"sessionId":"s1","cwd":"/stale/path"}),
        "cursor",
        0,
    )
    .expect("thread")];

    crate::acp::absorb_thread_cwds(&mut sessions, &listed);

    assert_eq!(sessions["s1"].cwd, "/live/path");
    assert_eq!(
        sessions["s1"].approval_policy, "on-request",
        "listing must not reset policy either"
    );
}

#[test]
fn a_blank_cwd_from_the_agent_is_not_cached_as_if_it_were_real() {
    let mut sessions = std::collections::HashMap::new();
    let listed =
        vec![
            crate::acp::protocol::thread_summary(&json!({"sessionId":"s1"}), "cursor", 0)
                .expect("thread"),
        ];
    crate::acp::absorb_thread_cwds(&mut sessions, &listed);
    assert!(
        sessions.get("s1").is_none_or(|s| s.cwd.is_empty()),
        "an empty cwd is absence, not a value"
    );
}

#[test]
fn auto_approve_grants_once_never_always() {
    // `allow_always` writes the grant into the AGENT's own allowlist, where the
    // relay can no longer see or revoke it — a `bypass` thread would silently
    // widen Cursor's standing permissions beyond that thread and beyond the
    // relay's lifetime. `allow_once` keeps every call round-tripping, so the
    // relay stays the policy authority.
    let options = vec![
        json!({"optionId":"allow-once","name":"Allow once","kind":"allow_once"}),
        json!({"optionId":"allow-always","name":"Allow always","kind":"allow_always"}),
        json!({"optionId":"reject-once","name":"Reject","kind":"reject_once"}),
    ];
    assert_eq!(
        crate::acp::rpc::auto_approve_option_id(&options).as_deref(),
        Some("allow-once")
    );

    // Superseded: this used to fall back to `allow_always` when no single-shot
    // option existed. See `auto_approve_cancels_rather_than_granting_a_permanent_allowlist_entry`
    // for why that was wrong — the turn is cancelled instead, not deadlocked.
    let only_always = vec![json!({"optionId":"allow-always","kind":"allow_always"})];
    assert_eq!(crate::acp::rpc::auto_approve_option_id(&only_always), None);

    // Nothing allowable at all: no option, so the caller cancels rather than
    // picking a reject and pretending it approved.
    let deny_only = vec![json!({"optionId":"reject-once","kind":"reject_once"})];
    assert_eq!(crate::acp::rpc::auto_approve_option_id(&deny_only), None);
}

#[test]
fn a_model_change_is_only_sent_when_it_actually_changes() {
    // `session/set_model` is session-level config, not a per-turn argument, so
    // the bridge has to track what the session is on. Re-sending it on every
    // turn would be a wasted round trip on the hot path; never sending it means
    // the relay reports a model the agent is not running.
    let mut runtime = SessionRuntime::default();
    let sonnet = "claude-sonnet-4-6[thinking=true,context=200k,effort=medium]";

    assert_eq!(
        runtime.model_change_needed(sonnet).as_deref(),
        Some(sonnet),
        "first selection must be pushed"
    );
    runtime.model = sonnet.to_string();
    assert_eq!(
        runtime.model_change_needed(sonnet),
        None,
        "same model must not re-send"
    );
    assert_eq!(
        runtime
            .model_change_needed("gpt-5.5[context=272k,reasoning=medium,fast=false]")
            .as_deref(),
        Some("gpt-5.5[context=272k,reasoning=medium,fast=false]")
    );
}

#[test]
fn an_empty_or_placeholder_model_never_overrides_the_sessions_own_default() {
    // The relay passes "" (and codex's literal "default") in paths that mean
    // "whatever the provider picks". Pushing those as a model id would be
    // rejected by the agent, or worse, silently accepted as a bogus model.
    let mut runtime = SessionRuntime::default();
    for placeholder in ["", "default"] {
        assert_eq!(
            runtime.model_change_needed(placeholder),
            None,
            "`{placeholder}` is not a model selection"
        );
    }
    runtime.model = "gpt-5.5[]".to_string();
    assert_eq!(runtime.model_change_needed(""), None);
    assert_eq!(
        runtime.model, "gpt-5.5[]",
        "a placeholder must not clear a real selection"
    );
}

#[test]
fn a_session_reset_is_refused_while_a_turn_is_in_flight() {
    // `read_thread`'s replay resets the shared per-session counters. Doing that
    // under a live turn makes the turn resume minting from `msg-1`, colliding
    // with the ids the replay just produced and overwriting settled entries —
    // which is worse than the lost deltas, because it corrupts history rather
    // than dropping the tail.
    let mut runtime = SessionRuntime {
        turn_id: Some("acp-turn-7".to_string()),
        ..Default::default()
    };
    runtime.next_item_id("msg");
    runtime.next_item_id("msg");

    assert!(
        !runtime.can_replay_into(),
        "a session with a live turn must not be reset for a replay"
    );

    runtime.turn_id = None;
    assert!(runtime.can_replay_into());

    runtime.reset_for_replay();
    assert_eq!(
        runtime.next_item_id("msg"),
        "acp-msg-1",
        "a replay renumbers from the start"
    );
}

#[test]
fn resetting_for_replay_keeps_the_session_identity_it_needs_afterwards() {
    // The reset is about transcript numbering only; losing cwd or policy would
    // break the next `session/load` and the approval gate.
    let mut runtime = SessionRuntime {
        cwd: "/repo".to_string(),
        approval_policy: "on-request".to_string(),
        model: "gpt-5.5[]".to_string(),
        ..Default::default()
    };
    runtime.next_item_id("tool");
    runtime
        .tool_items
        .insert("acp-id".to_string(), "acp-tool-1".to_string());

    runtime.reset_for_replay();

    assert_eq!(runtime.cwd, "/repo");
    assert_eq!(runtime.approval_policy, "on-request");
    assert_eq!(runtime.model, "gpt-5.5[]");
    assert!(runtime.tool_items.is_empty());
    assert!(runtime.tool_meta.is_empty());
}

#[test]
fn capabilities_are_read_from_the_handshake_not_assumed() {
    use crate::acp::protocol::AgentCapabilities;

    // Verbatim from the 2026-08-11 spike.
    let measured = json!({
        "protocolVersion": 1,
        "agentCapabilities": {
            "loadSession": true,
            "mcpCapabilities": {"http": true, "sse": true},
            "promptCapabilities": {"audio": false, "embeddedContext": false, "image": true},
            "sessionCapabilities": {"list": {}}
        }
    });
    let caps = AgentCapabilities::from_initialize(&measured);
    assert!(caps.load_session);
    // An empty object marks the capability present — treating it as falsy would
    // disable session listing against the one agent known to support it.
    assert!(caps.list_sessions);
    assert!(caps.prompt_images);

    // An agent that advertises nothing gets nothing enabled, rather than the
    // bridge assuming Cursor's answers.
    let bare = AgentCapabilities::from_initialize(&json!({"protocolVersion": 1}));
    assert_eq!(bare, AgentCapabilities::default());
    assert!(!bare.load_session && !bare.list_sessions && !bare.prompt_images);

    // Explicit false must win over presence.
    let denied = AgentCapabilities::from_initialize(&json!({
        "agentCapabilities": {"loadSession": false, "sessionCapabilities": {"list": false}}
    }));
    assert!(!denied.load_session);
    assert!(!denied.list_sessions);
}

#[test]
fn a_content_only_update_does_not_regress_a_completed_tool_to_pending() {
    // ACP allows every field except `toolCallId` to be omitted from a
    // `tool_call_update`. Recomputing status from each payload alone turns an
    // absent status into "pending", so a trailing content-only update marks a
    // finished tool as still running.
    let entries = replay(&[
        json!({"sessionUpdate":"tool_call","toolCallId":"t1","title":"`nl hello.txt`",
               "kind":"execute","status":"pending","rawInput":{"command":"nl hello.txt"}}),
        json!({"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed",
               "rawOutput":{"exitCode":0,"stdout":"1 hi\n","stderr":""}}),
        // Content-only: no status, no title, no input.
        json!({"sessionUpdate":"tool_call_update","toolCallId":"t1",
               "content":[{"type":"content","content":{"type":"text","text":"1 hi"}}]}),
    ]);

    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(
        entry.status, "completed",
        "status must not fall back to pending"
    );
    assert_eq!(entry.text.as_deref(), Some("`nl hello.txt`"));
    let tool = entry.tool.as_ref().expect("tool view");
    assert_eq!(tool.command.as_deref(), Some("nl hello.txt"));
    assert!(tool.result_preview.is_some());
}

#[test]
fn an_agent_mode_change_is_tracked_so_a_thread_cannot_silently_leave_plan() {
    // ACP lets the AGENT change mode and announce it with `current_mode_update`.
    // Ignoring it means a thread the relay believes is read-only may already be
    // back in `agent` mode.
    let mut runtime = session();
    let op = plan_update(
        &json!({"sessionUpdate":"current_mode_update","currentModeId":"agent"}),
        &mut runtime,
    );
    assert_eq!(op, TranscriptOp::ModeChanged("agent".to_string()));

    let ignored = plan_update(
        &json!({"sessionUpdate":"current_mode_update"}),
        &mut runtime,
    );
    assert_eq!(ignored, TranscriptOp::Ignore);
}

// ---------------------------------------------------------------------------
// Model catalog cache — ACP reports models only on `session/new`, so the first
// session of a fresh process would otherwise face an empty picker.
// ---------------------------------------------------------------------------

#[test]
fn a_cached_catalog_survives_a_restart_so_the_picker_is_not_empty() {
    use crate::acp::{read_cached_models, write_cached_models};

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("acp-models-cursor.json");

    // Nothing cached yet: the very first run of a fresh install.
    assert!(read_cached_models(&path).is_empty());

    let harvested = crate::acp::protocol::model_options(
        &[
            json!({"modelId":"default[]","name":"Auto"}),
            json!({"modelId":"claude-sonnet-4-6[thinking=true]","name":"claude-sonnet-4-6"}),
        ],
        Some("default[]"),
        "cursor",
    );
    write_cached_models(&path, &harvested);

    let restored = read_cached_models(&path);
    assert_eq!(restored.len(), 2);
    // The bracketed id is what `session/set_model` needs back, so it has to
    // survive the round trip byte for byte.
    assert_eq!(restored[1].model, "claude-sonnet-4-6[thinking=true]");
    assert_eq!(restored[1].provider, "cursor");
    assert_eq!(
        restored[1].supported_reasoning_efforts,
        Vec::<String>::new()
    );
    assert!(restored[0].is_default);
}

#[test]
fn a_corrupt_or_unreadable_cache_is_absence_not_an_error() {
    use crate::acp::read_cached_models;

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("acp-models-cursor.json");
    std::fs::write(&path, "{ this is not json").expect("write");
    // A stale cache must never block startup — it degrades to "not harvested
    // yet", which is exactly the pre-cache behaviour.
    assert!(read_cached_models(&path).is_empty());
}

// ---------------------------------------------------------------------------
// Transport lifecycle, driven over `tokio::io::duplex`. These are the paths a
// live agent cannot be asked to produce on cue: a failed write and a dead
// stream, both of which can strand a turn.
// ---------------------------------------------------------------------------

use tokio::sync::{watch, RwLock};

use crate::acp::AcpBridge;
use crate::state::{RelayState, SecurityProfile};

fn relay_state() -> std::sync::Arc<RwLock<RelayState>> {
    let (change_tx, _) = watch::channel(0_u64);
    std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )))
}

#[tokio::test]
async fn a_failed_prompt_write_leaves_no_thread_stuck_working() {
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("t1".to_string());
    }

    // Outbound half whose peer is dropped: every write fails.
    let (outbound, peer) = tokio::io::duplex(64);
    drop(peer);
    let (_inbound_writer, inbound) = tokio::io::duplex(64);

    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge.seed_session_for_test("t1", "/tmp/project").await;

    let sent =
        crate::provider::ProviderBridge::start_turn(&bridge, "t1", "hello", "", "", &[]).await;
    assert!(sent.is_err(), "a dead pipe must surface as a failed send");

    assert_eq!(
        bridge.session_turn_for_test("t1").await,
        None,
        "the session must not still own a turn the agent never received"
    );

    let relay = state.read().await;
    assert_ne!(
        relay.current_status, "working",
        "a thread cannot be left working on a turn that was never sent — no \
         event is coming to settle it"
    );
}

#[tokio::test]
async fn a_dead_stream_fails_in_flight_requests_instead_of_hanging_them() {
    let state = relay_state();

    let (outbound, mut outbound_peer) = tokio::io::duplex(4096);
    let (inbound_writer, inbound) = tokio::io::duplex(4096);

    let bridge = std::sync::Arc::new(AcpBridge::for_test(
        state.clone(),
        outbound,
        inbound,
        "cursor",
    ));

    // Fire a request that nobody will ever answer.
    let pending = {
        let bridge = bridge.clone();
        tokio::spawn(async move { bridge.send_request("session/list", json!({})).await })
    };

    // Wait until it is actually on the wire, so the drop below races nothing.
    let mut buffer = vec![0_u8; 512];
    tokio::io::AsyncReadExt::read(&mut outbound_peer, &mut buffer)
        .await
        .expect("request should reach the peer");

    // The agent dies.
    drop(inbound_writer);

    // Without draining `pending_responses` on EOF this would sit for the full
    // 60s request timeout (and an hour for a prompt) on a process that is gone.
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), pending)
        .await
        .expect("the request must not outlive the stream")
        .expect("task panicked");
    let error = outcome.expect_err("a dead stream cannot produce a result");
    assert!(
        error.contains("closed") || error.contains("failed"),
        "unhelpful error for a dead stream: {error}"
    );
}

#[tokio::test]
async fn reading_a_thread_mid_turn_serves_the_relay_and_never_touches_the_wire() {
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("t1".to_string());
        let runtime = relay.ensure_runtime_for_thread("t1");
        runtime.current_cwd = "/tmp/project".to_string();
        runtime.active_turn_id = Some("acp-turn-1".to_string());
        runtime.current_status = "working".to_string();
    }
    {
        let mut relay = state.write().await;
        relay.upsert_user_message_for_thread(
            "t1",
            "acp-user-1".to_string(),
            "hi".to_string(),
            "acp-turn-1".to_string(),
        );
    }

    let (outbound, mut outbound_peer) = tokio::io::duplex(4096);
    let (_inbound_writer, inbound) = tokio::io::duplex(4096);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge.seed_session_for_test("t1", "/tmp/project").await;

    let data = crate::provider::ProviderBridge::read_thread(&bridge, "t1")
        .await
        .expect("a thread with a live turn is readable");

    assert_eq!(data.transcript.len(), 1);
    assert_eq!(data.transcript[0].item_id.as_deref(), Some("acp-user-1"));
    assert_eq!(data.thread.cwd, "/tmp/project");

    // Nothing was written: no `session/load`, so no replay to swallow the live
    // turn's updates and no reset to renumber its items.
    let mut buffer = vec![0_u8; 256];
    let quiet = tokio::time::timeout(
        std::time::Duration::from_millis(200),
        tokio::io::AsyncReadExt::read(&mut outbound_peer, &mut buffer),
    )
    .await;
    assert!(
        quiet.is_err(),
        "read_thread must not issue a session/load while a turn is streaming"
    );
}

#[test]
fn an_approval_recovers_the_command_from_the_tool_call_that_preceded_it() {
    // Measured: `session/request_permission`'s `toolCall` carries a title and a
    // status but NO `rawInput` — the command only ever arrives on the earlier
    // `tool_call` update. Reading it off the request alone leaves the approval
    // card with nothing to show but a title, which is the one thing a user needs
    // to see before allowing a shell command to run.
    let mut runtime = session();
    plan_update(
        &json!({
            "sessionUpdate":"tool_call","toolCallId":"call-7","title":"`nl -ba note.txt`",
            "kind":"execute","status":"pending","rawInput":{"command":"nl -ba note.txt"}
        }),
        &mut runtime,
    );

    assert_eq!(
        crate::acp::rpc::command_for_tool_call(&runtime, "call-7").as_deref(),
        Some("nl -ba note.txt")
    );
    // A tool the relay never saw start has nothing to recover, and must not
    // invent one.
    assert_eq!(
        crate::acp::rpc::command_for_tool_call(&runtime, "unknown"),
        None
    );
}

// ---------------------------------------------------------------------------
// Round-3 review: read-only mode drift, capture leaks, approval fallback,
// and catalog defaults.
// ---------------------------------------------------------------------------

#[test]
fn a_mode_update_is_read_under_either_spelling() {
    // The ACP spec names the field `modeId`; Cursor sends `currentModeId`.
    // A bridge that claims to be generic has to accept both, and reading only
    // the measured one means a spec-compliant agent's mode change is invisible.
    for field in ["modeId", "currentModeId"] {
        let mut runtime = session();
        let op = plan_update(
            &json!({"sessionUpdate":"current_mode_update", field: "agent"}),
            &mut runtime,
        );
        assert_eq!(
            op,
            TranscriptOp::ModeChanged("agent".to_string()),
            "`{field}` must be understood"
        );
    }
}

#[test]
fn leaving_the_required_mode_is_drift_that_must_be_repaired() {
    // ACP lets the agent change its own mode. A thread the relay put in `plan`
    // for a read-only review can therefore be moved back to full `agent` by the
    // agent itself — the relay has to notice, not just narrate.
    let mut runtime = SessionRuntime {
        required_mode: Some("plan"),
        mode: "plan".to_string(),
        ..Default::default()
    };
    assert_eq!(runtime.mode_drift(), None);

    runtime.mode = "agent".to_string();
    assert_eq!(
        runtime.mode_drift(),
        Some("plan"),
        "a read-only thread that left plan must report the mode to restore"
    );

    // A thread with no read-only requirement may sit in any mode.
    let free = SessionRuntime {
        required_mode: None,
        mode: "plan".to_string(),
        ..Default::default()
    };
    assert_eq!(free.mode_drift(), None);
}

#[test]
fn auto_approve_cancels_rather_than_granting_a_permanent_allowlist_entry() {
    // Supersedes the round-2 fallback. The premise there — that `allow_always`
    // beats deadlocking the turn — was wrong: returning nothing makes the caller
    // answer `cancelled`, which ends the turn cleanly. A no-prompt policy must
    // never be the thing that writes a user-global, on-disk grant.
    let only_always = vec![json!({"optionId":"allow-always","kind":"allow_always"})];
    assert_eq!(
        crate::acp::rpc::auto_approve_option_id(&only_always),
        None,
        "a broad grant is worse than a cancelled turn"
    );

    let with_once = vec![
        json!({"optionId":"allow-once","kind":"allow_once"}),
        json!({"optionId":"allow-always","kind":"allow_always"}),
    ];
    assert_eq!(
        crate::acp::rpc::auto_approve_option_id(&with_once).as_deref(),
        Some("allow-once")
    );
}

#[test]
fn only_a_new_session_defines_the_providers_default_model() {
    use crate::acp::protocol::model_options;

    let available = vec![
        json!({"modelId":"default[]","name":"Auto"}),
        json!({"modelId":"claude-sonnet-4-6[thinking=true]","name":"claude-sonnet-4-6"}),
    ];

    // `session/new` reports the model a FRESH session starts on — that is the
    // provider's default.
    let fresh = model_options(&available, Some("default[]"), "cursor");
    assert!(fresh[0].is_default);
    assert!(!fresh[1].is_default);

    // `session/load` reports the model THAT session happens to use. Treating it
    // as the provider default means opening an old Sonnet thread silently makes
    // every future new session start on Sonnet.
    let loaded = model_options(&available, None, "cursor");
    assert!(
        loaded.iter().all(|option| !option.is_default),
        "a loaded session's model must not be marketed as the provider default"
    );
}

#[tokio::test]
async fn an_aborted_read_does_not_leave_a_capture_swallowing_live_updates() {
    // `read_thread` installs a capture, awaits `session/load`, then removes it.
    // If the future is dropped mid-await — a client disconnect, an aborted task —
    // the manual cleanup never runs and the capture stays installed forever.
    // Every later `session/update` for that session is then diverted into a
    // buffer nobody reads: a permanent transcript blackhole.
    let state = relay_state();

    let (outbound, _outbound_peer) = tokio::io::duplex(4096);
    // Nothing ever answers the load, so the read parks until it is aborted.
    let (inbound_writer, inbound) = tokio::io::duplex(4096);

    let bridge = std::sync::Arc::new(AcpBridge::for_test(
        state.clone(),
        outbound,
        inbound,
        "cursor",
    ));
    bridge.seed_session_for_test("t1", "/tmp/project").await;
    bridge.allow_session_load_for_test().await;

    let reading = {
        let bridge = bridge.clone();
        tokio::spawn(async move {
            let _ = crate::provider::ProviderBridge::read_thread(&*bridge, "t1").await;
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    reading.abort();
    let _ = reading.await;

    assert!(
        !bridge.has_capture_for_test("t1").await,
        "an aborted read must not leave its capture installed"
    );

    // And the proof that it matters: a live update now reaches RelayState.
    let update = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "t1",
            "update": {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"alive"}}
        }
    }))
    .unwrap();
    {
        let mut writer = inbound_writer;
        tokio::io::AsyncWriteExt::write_all(&mut writer, format!("{update}\n").as_bytes())
            .await
            .expect("write update");
        tokio::io::AsyncWriteExt::flush(&mut writer)
            .await
            .expect("flush");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let relay = state.read().await;
        let entries = relay
            .runtime_for_thread("t1")
            .map(|runtime| runtime.transcript_views())
            .unwrap_or_default();
        assert!(
            entries
                .iter()
                .any(|entry| entry.text.as_deref() == Some("alive")),
            "a delta after an aborted read must reach the transcript, not a dead buffer"
        );
    }
}

#[tokio::test]
async fn a_thread_with_no_turn_yet_reads_as_empty_rather_than_erroring() {
    // Measured: Cursor cannot load a session that has no content — it answers
    // `Session "…" not found`. So "new session, switch away before sending,
    // switch back" would surface a provider error for a thread that is simply
    // empty. Claude short-circuits its pending threads the same way.
    let state = relay_state();
    let (outbound, mut outbound_peer) = tokio::io::duplex(4096);
    let (_inbound_writer, inbound) = tokio::io::duplex(4096);

    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge.seed_session_for_test("t1", "/tmp/project").await;
    bridge.allow_session_load_for_test().await;

    let data = crate::provider::ProviderBridge::read_thread(&bridge, "t1")
        .await
        .expect("an un-prompted thread is readable");
    assert!(data.transcript.is_empty());
    assert_eq!(data.thread.cwd, "/tmp/project");

    // And it must not have asked the agent to load something that cannot load.
    let mut buffer = vec![0_u8; 256];
    let quiet = tokio::time::timeout(
        std::time::Duration::from_millis(200),
        tokio::io::AsyncReadExt::read(&mut outbound_peer, &mut buffer),
    )
    .await;
    assert!(
        quiet.is_err(),
        "no session/load should be attempted for an empty session"
    );
}

#[test]
fn a_loaded_session_reports_the_mode_and_model_it_kept() {
    // Measured: Cursor preserves both across a reload AND across a process
    // restart, so the load response is authoritative about what the session is
    // actually set to. Recording it means a resume does not blindly re-push a
    // model that is already in place, and drift detection has a baseline before
    // the first `current_mode_update` arrives.
    let mut runtime = SessionRuntime::default();
    crate::acp::absorb_session_settings(
        &mut runtime,
        &json!({
            "modes": {"currentModeId": "plan"},
            "models": {"currentModelId": "claude-sonnet-4-6[thinking=true]"}
        }),
    );
    assert_eq!(runtime.mode, "plan");
    assert_eq!(runtime.model, "claude-sonnet-4-6[thinking=true]");
    // Already in place: nothing to push.
    assert_eq!(
        runtime.model_change_needed("claude-sonnet-4-6[thinking=true]"),
        None
    );

    // A response carrying neither must not blank what we already knew.
    crate::acp::absorb_session_settings(&mut runtime, &json!({}));
    assert_eq!(runtime.mode, "plan");
    assert_eq!(runtime.model, "claude-sonnet-4-6[thinking=true]");
}

#[test]
fn a_listed_session_is_known_to_have_content() {
    // Caught by the live e2e: caching cwds creates a session entry, and a
    // default entry claims no content — so every cold thread short-circuited to
    // an empty transcript. Being listed is itself the proof of content, because
    // the agent does not list (or load) a session that has none.
    let mut sessions = std::collections::HashMap::new();
    let listed = vec![crate::acp::protocol::thread_summary(
        &json!({"sessionId":"s1","cwd":"/repo","title":"t"}),
        "cursor",
        0,
    )
    .expect("thread")];

    crate::acp::absorb_thread_cwds(&mut sessions, &listed);

    let session = sessions.get("s1").expect("entry");
    assert_eq!(session.cwd, "/repo");
    assert!(
        session.has_content,
        "a listed session must be loadable, not treated as an empty draft"
    );
}

// ---------------------------------------------------------------------------
// `cursor/create_plan` — the relay must not accept a plan on the user's behalf.
//
// Measured 2026-08-11 against `cursor-agent 2026.08.04-aaa8809`, and confirmed
// against the agent's own handler source
// (`src/acp/interaction-handlers/create-plan-handler.ts` in the shipped bundle).
//
//   request  cursor/create_plan {toolCallId, name, overview, plan, todos,
//                                isProject, phases}      -- NOTE: no sessionId
//   result   {outcome: {outcome: "accepted", planUri?}}
//          | {outcome: {outcome: "rejected", reason?}}
//          | {outcome: {outcome: "cancelled"}}
//
// The blanket `{}` the bridge used to answer with is NOT a no-op: the handler
// reads `result.outcome.outcome`, throws on the missing field, and its catch
// path degrades to *success*. So every plan was silently accepted for the user.
// Rejection is a real, honoured outcome — measured, the agent answers
// "The plan was rejected (<reason>), so I did not change notes.txt. What should
// I do instead?" — which is exactly the steering the user was being denied.
// ---------------------------------------------------------------------------

/// The `cursor/create_plan` request as Cursor actually sends it, trimmed to the
/// fields the bridge reads. `toolCallId` embeds a raw newline, verbatim.
fn create_plan_request(id: u64, tool_call_id: &str) -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "cursor/create_plan",
        "params": {
            "toolCallId": tool_call_id,
            "name": "Add delta line",
            "overview": "Append a new line containing `delta` to notes.txt.",
            "plan": "# Add `delta` to notes.txt\n\n## Steps\n\n1. Edit notes.txt",
            "todos": [{"id":"append-delta","content":"Append line 'delta'","status":"pending"}],
            "isProject": false,
            "phases": []
        }
    })
}

const PLAN_TOOL_CALL_ID: &str =
    "call-67e2c21d-3bbf-4cfe-be86-56924c9c39f0-3\nfc_46511571-5444-9b39-8dd1-96b7d7a07621_0";

/// Read one NDJSON line off the duplex peer, or fail if nothing arrives.
async fn next_wire_line(peer: &mut tokio::io::DuplexStream) -> serde_json::Value {
    let mut buffer = vec![0_u8; 8192];
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::io::AsyncReadExt::read(peer, &mut buffer),
    )
    .await
    .expect("the bridge must answer the agent, not leave it blocked")
    .expect("read failed");
    let text = String::from_utf8_lossy(&buffer[..read]);
    let line = text.lines().next().expect("a line").to_string();
    serde_json::from_str(&line).expect("valid JSON on the wire")
}

#[tokio::test]
async fn a_plan_is_parked_for_the_user_instead_of_being_accepted_for_them() {
    let state = relay_state();
    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge.seed_session_for_test("t1", "/tmp/project").await;
    // A plan only ever arrives mid-turn, and the routing now insists on it.
    bridge
        .set_session_turn_for_test("t1", Some("acp-turn-1"))
        .await;

    // The agent announces the plan tool call first — that update is the only
    // thing carrying BOTH the toolCallId and the session it belongs to, because
    // `cursor/create_plan` itself has no `sessionId`.
    let mut writer = inbound_writer;
    let announce = json!({
        "jsonrpc":"2.0","method":"session/update",
        "params":{"sessionId":"t1","update":{
            "sessionUpdate":"tool_call","toolCallId":PLAN_TOOL_CALL_ID,
            "title":"Create Plan","kind":"other","status":"pending"}}
    });
    tokio::io::AsyncWriteExt::write_all(&mut writer, format!("{announce}\n").as_bytes())
        .await
        .expect("write");
    tokio::io::AsyncWriteExt::write_all(
        &mut writer,
        format!("{}\n", create_plan_request(7, PLAN_TOOL_CALL_ID)).as_bytes(),
    )
    .await
    .expect("write");

    // The user gets asked.
    let parked = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            {
                let relay = state.read().await;
                if let Some(pending) = relay.pending_approvals.values().next() {
                    return pending.clone();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a plan must reach the user as an approval, not be answered for them");

    assert_eq!(
        parked.thread_id, "t1",
        "the plan must be routed to the thread whose tool call announced it"
    );
    assert!(
        parked.summary.contains("Add delta line"),
        "the approval must name the plan: {}",
        parked.summary
    );
    assert!(
        parked
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("Edit notes.txt")),
        "the plan body is the whole thing being approved, so it has to be shown"
    );
    assert!(
        !parked.supports_session_scope,
        "ACP has no session-scoped plan grant, and offering one would lie"
    );

    // And nothing was answered yet — the agent stays blocked on the user.
    let mut buffer = vec![0_u8; 256];
    let quiet = tokio::time::timeout(
        std::time::Duration::from_millis(300),
        tokio::io::AsyncReadExt::read(&mut outbound_peer, &mut buffer),
    )
    .await;
    assert!(
        quiet.is_err(),
        "the bridge answered the plan before the user decided"
    );
}

#[tokio::test]
async fn approving_and_rejecting_a_plan_speak_cursors_outcome_vocabulary() {
    use crate::protocol::{ApprovalDecision, ApprovalDecisionInput, ApprovalScope};
    use crate::state::{ApprovalKind, PendingApproval};

    let plan_pending = |raw_id: u64| PendingApproval {
        // The `acp-plan-` prefix is the discriminator: it, and not the absence
        // of an option list, is what marks this as a plan (see the guard test
        // below for why that distinction is load-bearing).
        request_id: format!("acp-plan-{raw_id}"),
        raw_request_id: json!(raw_id),
        kind: ApprovalKind::Plan,
        thread_id: "t1".to_string(),
        summary: "Add delta line".to_string(),
        detail: Some("# Add `delta`".to_string()),
        command: None,
        cwd: Some("/tmp/project".to_string()),
        context_preview: None,
        requested_permissions: None,
        available_decisions: vec!["approve".to_string(), "deny".to_string()],
        supports_session_scope: false,
    };

    for (decision, expected) in [
        (ApprovalDecision::Approve, json!({"outcome":"accepted"})),
        // The reason is not decoration: measured, the agent quotes it back and
        // changes course — "The plan was rejected (Rejected by the user), so I
        // did not change notes.txt. What should I do instead?"
        (
            ApprovalDecision::Deny,
            json!({"outcome":"rejected","reason":"Rejected by the user"}),
        ),
        (ApprovalDecision::Cancel, json!({"outcome":"cancelled"})),
    ] {
        let state = relay_state();
        let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
        let (_inbound_writer, inbound) = tokio::io::duplex(8192);
        let bridge = AcpBridge::for_test(state, outbound, inbound, "cursor");

        crate::provider::ProviderBridge::respond_to_approval(
            &bridge,
            &plan_pending(7),
            &ApprovalDecisionInput {
                decision,
                scope: Some(ApprovalScope::Once),
                device_id: None,
            },
        )
        .await
        .expect("the decision must reach the agent");

        let sent = next_wire_line(&mut outbound_peer).await;
        assert_eq!(sent["id"], json!(7), "the reply must match the request id");
        assert_eq!(
            sent["result"]["outcome"], expected,
            "wrong outcome for {decision:?}; Cursor reads result.outcome.outcome"
        );
    }
}

#[tokio::test]
async fn a_permission_request_still_answers_with_a_selected_option() {
    // Regression guard for the branch added above: plans and permissions share
    // `respond_to_approval` and the same `result.outcome` envelope, but a
    // permission is answered with `selected` + `optionId`, never `accepted`.
    use crate::protocol::{ApprovalDecision, ApprovalDecisionInput, ApprovalScope};
    use crate::state::{ApprovalKind, PendingApproval};

    let state = relay_state();
    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (_inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state, outbound, inbound, "cursor");

    let pending = PendingApproval {
        request_id: "acp-approval-3".to_string(),
        raw_request_id: json!(3),
        kind: ApprovalKind::Command,
        thread_id: "t1".to_string(),
        summary: "`ls`".to_string(),
        detail: None,
        command: Some("ls".to_string()),
        cwd: None,
        context_preview: None,
        requested_permissions: Some(json!([
            {"optionId":"allow-once","kind":"allow_once"},
            {"optionId":"reject-once","kind":"reject_once"}
        ])),
        available_decisions: vec!["approve".to_string(), "deny".to_string()],
        supports_session_scope: false,
    };

    crate::provider::ProviderBridge::respond_to_approval(
        &bridge,
        &pending,
        &ApprovalDecisionInput {
            decision: ApprovalDecision::Approve,
            scope: Some(ApprovalScope::Once),
            device_id: None,
        },
    )
    .await
    .expect("send");

    let sent = next_wire_line(&mut outbound_peer).await;
    assert_eq!(
        sent["result"]["outcome"],
        json!({"outcome":"selected","optionId":"allow-once"})
    );
}

#[tokio::test]
async fn an_option_less_permission_request_cancels_and_is_never_read_as_a_plan() {
    // The near-miss this guards: discriminating "plan vs permission" on
    // `requested_permissions.is_none()` reads as elegant and is a security bug.
    // A permission request that arrived with an empty option list would then be
    // answered `accepted` — granting a tool call nobody approved. The
    // discriminator has to be the relay-minted `acp-plan-` id prefix, so a
    // permission with nothing to select still cancels.
    use crate::protocol::{ApprovalDecision, ApprovalDecisionInput, ApprovalScope};
    use crate::state::{ApprovalKind, PendingApproval};

    let state = relay_state();
    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (_inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state, outbound, inbound, "cursor");

    crate::provider::ProviderBridge::respond_to_approval(
        &bridge,
        &PendingApproval {
            request_id: "acp-approval-5".to_string(),
            raw_request_id: json!(5),
            kind: ApprovalKind::Command,
            thread_id: "t1".to_string(),
            summary: "`rm -rf /`".to_string(),
            detail: None,
            command: Some("rm -rf /".to_string()),
            cwd: None,
            context_preview: None,
            requested_permissions: None,
            available_decisions: vec!["approve".to_string(), "deny".to_string()],
            supports_session_scope: false,
        },
        &ApprovalDecisionInput {
            decision: ApprovalDecision::Approve,
            scope: Some(ApprovalScope::Once),
            device_id: None,
        },
    )
    .await
    .expect("send");

    let sent = next_wire_line(&mut outbound_peer).await;
    assert_eq!(
        sent["result"]["outcome"],
        json!({"outcome":"cancelled"}),
        "a permission with no selectable option must cancel, never accept"
    );
}

/// A `session/request_permission` as Cursor sends it, trimmed to what the
/// bridge reads.
fn permission_request(id: u64, session_id: &str) -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/request_permission",
        "params": {
            "sessionId": session_id,
            "toolCall": {
                "toolCallId": "call-1",
                "title": "`rm -rf build`",
                "kind": "execute",
                "status": "pending"
            },
            "options": [
                {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                {"optionId": "reject", "name": "Reject", "kind": "reject_once"}
            ]
        }
    })
}

/// Start a turn and drain its `session/prompt`, so the caller's next
/// `next_wire_line` reads the agent's answer.
async fn start_turn_and_drain_prompt(
    bridge: &AcpBridge,
    peer: &mut tokio::io::DuplexStream,
    thread_id: &str,
) {
    crate::provider::ProviderBridge::start_turn(bridge, thread_id, "hello", "", "", &[])
        .await
        .expect("the prompt must reach the agent");
    let prompt = next_wire_line(peer).await;
    assert_eq!(
        prompt["method"],
        json!("session/prompt"),
        "expected the turn's prompt first, got {prompt}"
    );
}

#[tokio::test]
async fn a_turn_refreshes_a_stale_approval_policy_before_prompting() {
    // "YOLO still asks for permission on Cursor": pressing YOLO on a thread the
    // relay already saved as `bypass` skips the resume, so the bridge copy that
    // actually decides permissions never hears.
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.remember_thread_settings("t1", "bypass", "workspace-write", "high", "");
    }

    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    // The copy the bridge is carrying predates the user's change.
    bridge
        .seed_session_with_policy_for_test("t1", "/tmp/project", "on-request")
        .await;

    start_turn_and_drain_prompt(&bridge, &mut outbound_peer, "t1").await;

    let mut writer = inbound_writer;
    tokio::io::AsyncWriteExt::write_all(
        &mut writer,
        format!("{}\n", permission_request(21, "t1")).as_bytes(),
    )
    .await
    .expect("write");

    let answered = next_wire_line(&mut outbound_peer).await;
    assert_eq!(answered["id"], json!(21));
    assert_eq!(
        answered["result"]["outcome"],
        json!({"outcome": "selected", "optionId": "allow"}),
        "a thread the relay has on `bypass` must be answered by the bridge, not the user"
    );
    assert!(
        state.read().await.pending_approvals.is_empty(),
        "a YOLO thread must not park an approval card at all"
    );
}

#[tokio::test]
async fn a_turn_on_a_session_the_bridge_has_no_copy_of_still_honours_bypass() {
    // The same defect with the copy missing rather than stale — the state after
    // every relay restart, since the session map is process memory.
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.remember_thread_settings("t1", "bypass", "workspace-write", "high", "");
    }

    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    // Deliberately no `seed_session_*`: the bridge has never heard of `t1`.

    start_turn_and_drain_prompt(&bridge, &mut outbound_peer, "t1").await;

    let mut writer = inbound_writer;
    tokio::io::AsyncWriteExt::write_all(
        &mut writer,
        format!("{}\n", permission_request(22, "t1")).as_bytes(),
    )
    .await
    .expect("write");

    let answered = next_wire_line(&mut outbound_peer).await;
    assert_eq!(answered["id"], json!(22));
    assert_eq!(
        answered["result"]["outcome"],
        json!({"outcome": "selected", "optionId": "allow"}),
        "a cold session must pick the relay's policy up on its first turn"
    );
}

#[tokio::test]
async fn a_turn_refreshes_a_stale_approval_policy_in_the_restricting_direction_too() {
    // A genuine re-read, not a one-way widening: a thread just taken OUT of YOLO
    // must ask again on its next turn, whatever the stale copy says.
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.remember_thread_settings("t1", "on-request", "workspace-write", "high", "");
    }

    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge
        .seed_session_with_policy_for_test("t1", "/tmp/project", "bypass")
        .await;

    start_turn_and_drain_prompt(&bridge, &mut outbound_peer, "t1").await;

    let mut writer = inbound_writer;
    tokio::io::AsyncWriteExt::write_all(
        &mut writer,
        format!("{}\n", permission_request(23, "t1")).as_bytes(),
    )
    .await
    .expect("write");

    let parked = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            {
                let relay = state.read().await;
                if let Some(pending) = relay.pending_approvals.values().next() {
                    return pending.clone();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a thread the relay has on `on-request` must ask the user");
    assert_eq!(parked.thread_id, "t1");
}

#[tokio::test]
async fn a_cold_read_only_thread_is_put_back_in_plan_mode_before_its_turn() {
    // The refresh writes `required_mode` too, so it has to restrict as well as
    // relax: a reviewer whose copy was lost to a restart would otherwise run as
    // a full `agent`, free to edit the artifact it was asked to judge.
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.remember_thread_settings("t1", "review_read_only", "read-only", "high", "");
    }

    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");

    // `session/set_mode` is a request: answer it, and hold the peer open past
    // the reply so the prompt that follows still has somewhere to go.
    let responder = tokio::spawn(async move {
        let request = next_wire_line(&mut outbound_peer).await;
        let mut writer = inbound_writer;
        let reply = json!({"jsonrpc": "2.0", "id": request["id"], "result": {}});
        tokio::io::AsyncWriteExt::write_all(&mut writer, format!("{reply}\n").as_bytes())
            .await
            .expect("write");
        let next = next_wire_line(&mut outbound_peer).await;
        (request, next)
    });

    crate::provider::ProviderBridge::start_turn(&bridge, "t1", "hello", "", "", &[])
        .await
        .expect("the prompt must reach the agent");

    let (request, next) = responder.await.expect("responder panicked");
    assert_eq!(
        request["method"],
        json!("session/set_mode"),
        "a read-only thread must be restricted before its prompt goes out"
    );
    assert_eq!(request["params"]["modeId"], json!("plan"));
    assert_eq!(
        next["method"],
        json!("session/prompt"),
        "and the prompt must follow it, not replace it"
    );
}

#[tokio::test]
async fn a_no_prompt_thread_accepts_the_plan_without_parking_it() {
    // Same contract as `session/request_permission` under a no-prompt policy:
    // there is nobody to ask, so the bridge answers immediately. Accepting is
    // the right default here — unlike `allow_always` it grants nothing that
    // outlives the turn, and rejecting would break plan mode for a thread whose
    // whole point is to run unattended.
    let state = relay_state();
    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge
        .seed_session_with_policy_for_test("t1", "/tmp/project", "never")
        .await;
    bridge
        .set_session_turn_for_test("t1", Some("acp-turn-1"))
        .await;

    let mut writer = inbound_writer;
    let announce = json!({
        "jsonrpc":"2.0","method":"session/update",
        "params":{"sessionId":"t1","update":{
            "sessionUpdate":"tool_call","toolCallId":PLAN_TOOL_CALL_ID,
            "title":"Create Plan","kind":"other","status":"pending"}}
    });
    tokio::io::AsyncWriteExt::write_all(&mut writer, format!("{announce}\n").as_bytes())
        .await
        .expect("write");
    tokio::io::AsyncWriteExt::write_all(
        &mut writer,
        format!("{}\n", create_plan_request(9, PLAN_TOOL_CALL_ID)).as_bytes(),
    )
    .await
    .expect("write");

    let sent = next_wire_line(&mut outbound_peer).await;
    assert_eq!(sent["id"], json!(9));
    assert_eq!(sent["result"]["outcome"], json!({"outcome":"accepted"}));
    assert!(
        state.read().await.pending_approvals.is_empty(),
        "a no-prompt thread must not park a card nobody will answer"
    );
}

#[tokio::test]
async fn a_plan_on_a_semantic_reviewer_thread_is_rejected_with_the_verdict_protocol() {
    // A Cursor reviewer runs in `plan` mode for read-only containment, but
    // `cursor/create_plan` is not a review verdict. Accepting it lets the turn end
    // without the final marker the private driver needs; parking it creates an
    // approval nobody can answer. The bridge rejects only semantic reviewer
    // threads and tells Cursor to finish in final assistant text instead.
    let state = relay_state();
    {
        let job = crate::state::ReviewJob {
            id: "review-1".to_string(),
            parent_thread_id: "parent-1".to_string(),
            reviewer_thread_id: Some("t1".to_string()),
            status: crate::state::ReviewJobStatus::WaitingForReviewer,
            ..Default::default()
        };
        state.write().await.insert_review_job(job);
    }

    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge
        .seed_session_with_policy_for_test("t1", "/tmp/project", "review_read_only")
        .await;
    bridge
        .set_session_turn_for_test("t1", Some("acp-turn-1"))
        .await;

    let mut writer = inbound_writer;
    let announce = json!({
        "jsonrpc":"2.0","method":"session/update",
        "params":{"sessionId":"t1","update":{
            "sessionUpdate":"tool_call","toolCallId":PLAN_TOOL_CALL_ID,
            "title":"Create Plan","kind":"other","status":"pending"}}
    });
    tokio::io::AsyncWriteExt::write_all(&mut writer, format!("{announce}\n").as_bytes())
        .await
        .expect("write");
    tokio::io::AsyncWriteExt::write_all(
        &mut writer,
        format!("{}\n", create_plan_request(13, PLAN_TOOL_CALL_ID)).as_bytes(),
    )
    .await
    .expect("write");

    let sent = next_wire_line(&mut outbound_peer).await;
    assert_eq!(sent["id"], json!(13));
    assert_eq!(sent["result"]["outcome"]["outcome"], json!("rejected"));
    assert!(
        sent["result"]["outcome"]["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("VERDICT: APPROVED")
                && reason.contains("VERDICT: NEEDS_CHANGES")
                && reason.contains("final agent_text")
                && reason.contains("do not create or wait on a plan")),
        "the provider-facing rejection must steer Cursor to the final-text verdict protocol: {sent}"
    );
    assert!(
        state.read().await.pending_approvals.is_empty(),
        "a plan must not park on a thread whose approvals fail the run that owns it"
    );
}

#[tokio::test]
async fn a_plan_on_a_locked_non_reviewer_thread_keeps_the_unattended_accept_behavior() {
    let state = relay_state();
    {
        state
            .write()
            .await
            .insert_review_job(crate::state::ReviewJob {
                id: "review-1".to_string(),
                parent_thread_id: "t1".to_string(),
                status: crate::state::ReviewJobStatus::WaitingForReviewer,
                ..Default::default()
            });
    }

    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge
        .seed_session_with_policy_for_test("t1", "/tmp/project", "review_read_only")
        .await;
    bridge
        .set_session_turn_for_test("t1", Some("acp-turn-1"))
        .await;

    let mut writer = inbound_writer;
    let announce = json!({
        "jsonrpc":"2.0","method":"session/update",
        "params":{"sessionId":"t1","update":{
            "sessionUpdate":"tool_call","toolCallId":PLAN_TOOL_CALL_ID,
            "title":"Create Plan","kind":"other","status":"pending"}}
    });
    tokio::io::AsyncWriteExt::write_all(&mut writer, format!("{announce}\n").as_bytes())
        .await
        .expect("write");
    tokio::io::AsyncWriteExt::write_all(
        &mut writer,
        format!("{}\n", create_plan_request(14, PLAN_TOOL_CALL_ID)).as_bytes(),
    )
    .await
    .expect("write");

    let sent = next_wire_line(&mut outbound_peer).await;
    assert_eq!(sent["id"], json!(14));
    assert_eq!(sent["result"]["outcome"], json!({"outcome":"accepted"}));
    assert!(
        state.read().await.pending_approvals.is_empty(),
        "a locked but non-reviewer thread still has nobody who can answer a plan card"
    );
}

#[tokio::test]
async fn an_unroutable_plan_is_accepted_loudly_rather_than_silently() {
    // `cursor/create_plan` carries no sessionId, so a plan whose announcing
    // `tool_call` the relay never saw cannot be attributed to a thread — and an
    // approval with no thread has no surface to appear on. Accepting keeps plan
    // mode working (rejecting would break a plan the user never saw), but it is
    // exactly the silent-accept this whole change exists to remove, so it must
    // leave a trace on a relay-owned channel: a line filed under the provider's
    // own channel is treated as subprocess chatter and filtered out of the audit
    // view.
    let state = relay_state();
    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge.seed_session_for_test("t1", "/tmp/project").await;

    let mut writer = inbound_writer;
    tokio::io::AsyncWriteExt::write_all(
        &mut writer,
        format!(
            "{}\n",
            create_plan_request(11, "a-tool-call-never-announced")
        )
        .as_bytes(),
    )
    .await
    .expect("write");

    let sent = next_wire_line(&mut outbound_peer).await;
    assert_eq!(sent["id"], json!(11));
    assert_eq!(sent["result"]["outcome"], json!({"outcome":"accepted"}));

    let relay = state.read().await;
    assert!(
        relay
            .logs_for_test()
            .iter()
            .any(|entry| entry.kind == "warn" && entry.message.contains("plan")),
        "an unattributable plan must be on a channel the audit view shows"
    );
}

// ---------------------------------------------------------------------------
// MCP visibility.
//
// Codex probes `codex mcp list --json` at startup; Claude reports live per-server
// status off the SDK's `init` event. The ACP bridge had neither, so a Cursor MCP
// server that fails to load produced nothing anywhere in the relay.
//
// ACP itself cannot help. Measured 2026-08-12 with two broken servers and one
// healthy one configured in `~/.cursor/mcp.json`: `initialize` advertises
// `agentCapabilities.mcpCapabilities {http, sse}` — a statement about what the
// CLIENT may pass in — and `session/new` answers with exactly
// `sessionId`/`modes`/`models`/`configOptions`. No MCP field, and no
// notification, even with servers actively failing. So the CLI is the only
// signal, exactly as it is for codex.
//
// `cursor-agent mcp list` has no `--json`; its grammar, measured in full:
//
//     healthy-mini: ready
//     broken-stdio: Error: Connection failed
//     unreachable-http: disabled
//     No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)
// ---------------------------------------------------------------------------

#[test]
fn mcp_list_output_is_summarised_by_measured_status() {
    let summary = crate::acp::protocol::summarize_mcp_servers(
        "cursor",
        "healthy-mini: ready\nbroken-stdio: Error: Connection failed\nunreachable-http: disabled\n",
    );

    assert_eq!(
        summary.headline.as_deref(),
        Some("cursor MCP: 3 configured (1 ready, 1 disabled, 1 failed)")
    );
    // The failure names the server AND carries the agent's own reason: "one of
    // them is broken" is not actionable, "broken-stdio: Connection failed" is.
    assert_eq!(
        summary.problems,
        vec!["cursor MCP server `broken-stdio` failed to load: Connection failed"]
    );
}

#[test]
fn nothing_configured_is_silent_rather_than_a_line_of_noise_every_boot() {
    for text in [
        // The measured sentence. Note it happens to contain NO colon, so it
        // would fall out of the parser anyway — this case alone does not
        // exercise the sentinel guard, which is why the variant below exists.
        "No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)\n",
        // The same sentence worded with a colon, which is what the guard is
        // actually for: without it this parses as a server named
        // "No MCP servers configured (expected in" with an unrecognized status,
        // and the relay reports a phantom broken server on an empty install.
        "No MCP servers configured (expected in: .cursor/mcp.json)\n",
        "",
        "   \n",
    ] {
        let summary = crate::acp::protocol::summarize_mcp_servers("cursor", text);
        assert_eq!(summary.headline, None, "should stay quiet for: {text:?}");
        assert!(summary.problems.is_empty(), "for {text:?}");
    }
}

#[test]
fn an_unrecognised_status_is_surfaced_rather_than_counted_as_healthy() {
    // The grammar was measured against one version of one agent. If a later
    // build reports something else, bucketing it as `ready` would quietly claim
    // a server is fine when nobody knows that. Say so instead.
    let summary = crate::acp::protocol::summarize_mcp_servers(
        "cursor",
        "weird-one: needs-auth\nhealthy-mini: ready\n",
    );

    assert_eq!(
        summary.headline.as_deref(),
        Some("cursor MCP: 2 configured (1 ready, 0 disabled, 0 failed, 1 unrecognized)")
    );
    assert_eq!(
        summary.problems,
        vec!["cursor MCP server `weird-one` reported an unrecognized status: needs-auth"]
    );
}

#[tokio::test]
async fn mcp_problems_go_on_a_channel_the_audit_view_actually_shows() {
    // The trap this bridge has already been bitten by once: `push_log` filed
    // under the provider's own key is classified as subprocess chatter and
    // filtered out of the audit view. Codex files its MCP summary under
    // `push_log("codex", …)`, which is why codex's own MCP lines are mostly
    // invisible too — deliberately NOT copied here.
    let state = relay_state();
    crate::acp::log_mcp_summary_for_test(
        &state,
        crate::acp::protocol::summarize_mcp_servers(
            "cursor",
            "broken-stdio: Error: Connection failed\nhealthy: ready\n",
        ),
    )
    .await;

    let relay = state.read().await;
    let logs = relay.logs_for_test();
    let problem = logs
        .iter()
        .find(|entry| entry.message.contains("broken-stdio"))
        .expect("the failure must be logged");
    assert_eq!(
        problem.kind, "warn",
        "an MCP failure filed under `{}` would be filtered out of the audit view",
        problem.kind
    );
    let headline = logs
        .iter()
        .find(|entry| entry.message.starts_with("cursor MCP:"))
        .expect("the summary must be logged");
    assert_eq!(headline.kind, "info");
}

#[tokio::test]
async fn a_login_instruction_is_visible_and_names_the_binary_the_user_must_run() {
    // Two defects in one line, both of which make it useless to the person it
    // was written for:
    //
    // 1. It was filed under `push_log(provider_key, …)`, which the audit view
    //    classifies as subprocess chatter and filters out — neither
    //    "authenticated" nor "reconnect" matches the lifecycle regex that lets a
    //    provider line through. The one instruction that unblocks the provider
    //    was invisible.
    // 2. It told the user to run `cursor login`. The binary is `cursor-agent`;
    //    `cursor` is the relay's provider KEY. The command does not exist.
    let state = relay_state();
    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");

    let handshake = tokio::spawn({
        let mut writer = inbound_writer;
        async move {
            // Answer `initialize` (advertising an auth method), then fail
            // `authenticate` the way a logged-out agent does.
            let mut buffer = vec![0_u8; 4096];
            let read = tokio::io::AsyncReadExt::read(&mut outbound_peer, &mut buffer)
                .await
                .expect("initialize should reach the peer");
            let sent: serde_json::Value =
                serde_json::from_str(String::from_utf8_lossy(&buffer[..read]).trim())
                    .expect("valid JSON");
            let init_reply = json!({
                "jsonrpc":"2.0","id":sent["id"],
                "result":{"protocolVersion":1,"authMethods":[{"id":"cursor_login","name":"Cursor Login"}]}
            });
            tokio::io::AsyncWriteExt::write_all(&mut writer, format!("{init_reply}\n").as_bytes())
                .await
                .expect("write");

            let read = tokio::io::AsyncReadExt::read(&mut outbound_peer, &mut buffer)
                .await
                .expect("authenticate should reach the peer");
            let sent: serde_json::Value =
                serde_json::from_str(String::from_utf8_lossy(&buffer[..read]).trim())
                    .expect("valid JSON");
            let auth_reply = json!({
                "jsonrpc":"2.0","id":sent["id"],
                "error":{"code":-32000,"message":"Authentication required"}
            });
            tokio::io::AsyncWriteExt::write_all(&mut writer, format!("{auth_reply}\n").as_bytes())
                .await
                .expect("write");
            writer
        }
    });

    bridge
        .initialize_for_test()
        .await
        .expect("a logged-out agent still connects");
    let _writer = handshake.await.expect("handshake task");

    let relay = state.read().await;
    let line = relay
        .logs_for_test()
        .iter()
        .find(|entry| entry.message.contains("not authenticated"))
        .expect("the login instruction must be logged at all");

    assert_eq!(
        line.kind, "warn",
        "only a relay-owned channel survives the audit view's chatter filter; \
         `{}` does not",
        line.kind
    );
    assert!(
        line.message.contains("cursor-agent login"),
        "the user must be told the command that exists: {}",
        line.message
    );
}

// ---------------------------------------------------------------------------
// A failed turn has to reach the user the way codex's and Claude's do.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_failed_turn_pushes_the_failure_instead_of_a_success_shaped_ping() {
    // `enqueue_error_push` does two jobs, and skipping it loses both: the phone
    // never gets the failure, AND — because the call is what sets
    // `suppress_completed` — the ordinary work→idle transition still fires as a
    // "finished" push. A user away from the desk was told a turn that died had
    // completed. Codex (`codex/rpc.rs`) and Claude (`claude.rs`) both call it.
    let state = relay_state();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    {
        let mut relay = state.write().await;
        relay.set_push_runtime(tx, "test-vapid".to_string());
        relay.active_thread_id = Some("t1".to_string());
        // The app layer registers the turn once `start_turn` returns; a turn
        // that was never running cannot be the one this call is settling.
        relay.set_active_turn(Some("acp-turn-1".to_string()));
    }

    {
        let mut relay = state.write().await;
        crate::acp::rpc::apply_turn_finished(
            &mut relay,
            "t1",
            "acp-turn-1",
            Err("Model provider rejected the request".to_string()),
            "cursor",
        );
    }

    let job = rx.try_recv().expect("a failed turn must enqueue a push");
    assert!(
        matches!(job.kind, crate::state::PushKind::Error),
        "the push must be a failure, not a completion: {:?}",
        job.kind
    );
    assert_eq!(job.thread_id, "t1");
    assert_eq!(
        job.reason.as_deref(),
        Some("Model provider rejected the request"),
        "the push must carry the reason verbatim"
    );

    // And the failure is in the audit log, not only the transcript — operator
    // logs are what a maintainer greps when a user says "it just stopped".
    let relay = state.read().await;
    assert!(
        relay
            .logs_for_test()
            .iter()
            .any(|entry| entry.kind == "error"
                && entry.message.contains("Model provider rejected")),
        "a failed turn must leave an error line in the log"
    );
}

#[tokio::test]
async fn a_clean_turn_pushes_nothing() {
    // The guard on the above: `end_turn` and a user cancel are not failures, and
    // must not start firing error pushes.
    for outcome in [
        Ok(json!({"stopReason": "end_turn"})),
        Ok(json!({"stopReason": "cancelled"})),
    ] {
        let state = relay_state();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        {
            let mut relay = state.write().await;
            relay.set_push_runtime(tx, "test-vapid".to_string());
            relay.active_thread_id = Some("t1".to_string());
        }
        {
            let mut relay = state.write().await;
            crate::acp::rpc::apply_turn_finished(
                &mut relay,
                "t1",
                "acp-turn-1",
                outcome.clone(),
                "cursor",
            );
        }
        assert!(
            rx.try_recv().is_err(),
            "a clean turn must not enqueue an error push: {outcome:?}"
        );
    }
}

#[tokio::test]
async fn a_failed_background_turn_does_not_resurrect_a_deleted_thread() {
    // The background route is not just "the same write plus a progress touch":
    // `bg_upsert_transcript_item` first drops events for a thread the user has
    // permanently deleted. Writing the failure entry through the active-thread
    // path instead re-creates a runtime for a session nothing will ever clean up
    // again — the exact resurrection `mark_thread_deleted`'s tombstone exists to
    // prevent.
    let state = relay_state();
    {
        let mut relay = state.write().await;
        // Some OTHER thread is in front of the user, so `t-gone` is background.
        relay.active_thread_id = Some("t-visible".to_string());
        relay.mark_thread_deleted("t-gone");
    }

    {
        let mut relay = state.write().await;
        crate::acp::rpc::apply_turn_finished(
            &mut relay,
            "t-gone",
            "acp-turn-9",
            Err("boom".to_string()),
            "cursor",
        );
    }

    let relay = state.read().await;
    assert!(
        relay.runtime_for_thread("t-gone").is_none(),
        "a deleted thread must not be resurrected by its own turn failing"
    );
}

#[tokio::test]
async fn a_turn_already_settled_elsewhere_is_not_pushed_about_twice() {
    // The double-notify this bridge is uniquely exposed to. When the agent dies,
    // TWO paths run: the reader calls `fail_in_flight_turns_for_provider` (which
    // settles the turn and pushes "stopped unexpectedly"), and the drained
    // `session/prompt` waiter then resolves Err and reaches `apply_turn_finished`
    // with the same turn. Codex never collides this way — its turn failures
    // arrive as their own event — so copying its shape blindly buys a second
    // notification for one dead agent.
    //
    // The rule: only the call that is ACTUALLY settling this turn may push.
    let state = relay_state();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    {
        let mut relay = state.write().await;
        relay.set_push_runtime(tx, "test-vapid".to_string());
        relay.active_thread_id = Some("t1".to_string());
        relay.set_active_turn(Some("acp-turn-1".to_string()));
        // Something else got there first and cleared the turn.
        relay.enqueue_error_push("t1", "stopped unexpectedly — the agent exited.");
        relay.set_active_turn(None);
    }
    let first = rx.try_recv().expect("the first path pushed");
    assert!(format!("{first:?}").contains("stopped unexpectedly"));

    {
        let mut relay = state.write().await;
        crate::acp::rpc::apply_turn_finished(
            &mut relay,
            "t1",
            "acp-turn-1",
            Err("cursor dropped the turn before it finished".to_string()),
            "cursor",
        );
    }

    assert!(
        rx.try_recv().is_err(),
        "a turn someone else already settled must not push a second notification"
    );
    // The transcript entry is still wanted: the other path writes none, so this
    // is the only durable record a remote client will ever see.
    let relay = state.read().await;
    let runtime = relay.runtime_for_thread("t1").expect("runtime");
    assert!(
        runtime
            .transcript
            .iter()
            .any(|entry| entry.item_id == "turn-error:acp-turn-1"),
        "the failure must still be in the transcript"
    );
}

// ---------------------------------------------------------------------------
// Plan routing, hardened after an adversarial pass.
//
// `cursor/create_plan` carries no sessionId, so the thread is reverse-looked-up
// from an AGENT-SUPPLIED `toolCallId`. That makes the routing key attacker- (or
// bug-) controlled, and every miss used to fall into a branch that answers
// `accepted` — turning one wrong string into a silent approval.
// ---------------------------------------------------------------------------

async fn drive_plan_request(
    state: &std::sync::Arc<RwLock<crate::state::RelayState>>,
    bridge: &AcpBridge,
    inbound_writer: &mut tokio::io::DuplexStream,
    announce_to: Option<(&str, &str)>,
    request_id: u64,
    plan_tool_call_id: &str,
) {
    if let Some((session_id, tool_call_id)) = announce_to {
        let announce = json!({
            "jsonrpc":"2.0","method":"session/update",
            "params":{"sessionId":session_id,"update":{
                "sessionUpdate":"tool_call","toolCallId":tool_call_id,
                "title":"Create Plan","kind":"other","status":"pending"}}
        });
        tokio::io::AsyncWriteExt::write_all(inbound_writer, format!("{announce}\n").as_bytes())
            .await
            .expect("write");
    }
    tokio::io::AsyncWriteExt::write_all(
        inbound_writer,
        format!("{}\n", create_plan_request(request_id, plan_tool_call_id)).as_bytes(),
    )
    .await
    .expect("write");
    let _ = (state, bridge);
}

#[tokio::test]
async fn a_plan_never_parks_on_a_thread_that_has_no_turn_in_flight() {
    // A plan only ever arrives DURING a turn. If the reverse lookup lands on a
    // session with nothing running, the lookup was wrong — and parking there
    // breaks the documented contract in `state/relay.rs` that a pending request
    // is only ever added to a thread already marked working. The card would pin
    // an idle thread to `waitingOnApproval` with no turn to consume the answer.
    let state = relay_state();
    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge
        .seed_session_for_test("idle-thread", "/tmp/project")
        .await;

    let mut writer = inbound_writer;
    drive_plan_request(
        &state,
        &bridge,
        &mut writer,
        Some(("idle-thread", PLAN_TOOL_CALL_ID)),
        21,
        PLAN_TOOL_CALL_ID,
    )
    .await;

    let sent = next_wire_line(&mut outbound_peer).await;
    assert_eq!(sent["id"], json!(21));
    assert_eq!(sent["result"]["outcome"], json!({"outcome":"accepted"}));
    assert!(
        state.read().await.pending_approvals.is_empty(),
        "a plan must not pin a card on a thread with no turn to answer it"
    );
}

#[tokio::test]
async fn an_empty_tool_call_id_matches_nothing() {
    // `tool_call` accepts `"toolCallId": ""` (serde's `as_str` on an empty
    // string is `Some`), so an empty key is insertable — and `create_plan` with
    // the field missing resolves to the empty string too. Left alone, those two
    // meet and a plan routes to an arbitrary session.
    let state = relay_state();
    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge.seed_session_for_test("t1", "/tmp/project").await;
    bridge
        .set_session_turn_for_test("t1", Some("acp-turn-1"))
        .await;

    let mut writer = inbound_writer;
    drive_plan_request(&state, &bridge, &mut writer, Some(("t1", "")), 23, "").await;

    let sent = next_wire_line(&mut outbound_peer).await;
    assert_eq!(sent["id"], json!(23));
    assert!(
        state.read().await.pending_approvals.is_empty(),
        "an empty tool call id must never resolve to a session"
    );
}

#[tokio::test]
async fn a_plan_answered_on_behalf_of_a_run_leaves_a_trace() {
    // The unroutable branch logs because "the relay decided for you" has to be
    // auditable. This branch makes the same decision — and the opposite one from
    // what the owning run makes for every other approval on that thread, which
    // it DENIES — so silence here is worse, not better.
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.insert_review_job(crate::state::ReviewJob {
            id: "review-2".to_string(),
            parent_thread_id: "t1".to_string(),
            status: crate::state::ReviewJobStatus::WaitingForReviewer,
            ..Default::default()
        });
    }
    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge
        .seed_session_with_policy_for_test("t1", "/tmp/project", "review_read_only")
        .await;
    bridge
        .set_session_turn_for_test("t1", Some("acp-turn-1"))
        .await;

    let mut writer = inbound_writer;
    drive_plan_request(
        &state,
        &bridge,
        &mut writer,
        Some(("t1", PLAN_TOOL_CALL_ID)),
        25,
        PLAN_TOOL_CALL_ID,
    )
    .await;

    let sent = next_wire_line(&mut outbound_peer).await;
    assert_eq!(sent["result"]["outcome"], json!({"outcome":"accepted"}));

    let relay = state.read().await;
    assert!(
        relay
            .logs_for_test()
            .iter()
            .any(|entry| entry.kind == "warn" && entry.message.contains("plan")),
        "accepting a plan for a run nobody can answer must be recorded visibly"
    );
}

#[test]
fn the_two_approval_id_prefixes_can_never_overlap() {
    // The discriminator is load-bearing in the dangerous direction: if a
    // permission id ever started with the plan prefix it would be answered
    // `accepted`, granting a tool call nobody approved. The permission prefix is
    // a bare literal at its mint site, so pin the invariant itself.
    assert!(!crate::acp::protocol::is_plan_approval(
        crate::acp::rpc::PERMISSION_APPROVAL_PREFIX
    ));
    assert!(crate::acp::protocol::is_plan_approval(
        crate::acp::protocol::PLAN_APPROVAL_PREFIX
    ));
    assert!(!crate::acp::rpc::PERMISSION_APPROVAL_PREFIX
        .starts_with(crate::acp::protocol::PLAN_APPROVAL_PREFIX));
    assert!(!crate::acp::protocol::PLAN_APPROVAL_PREFIX
        .starts_with(crate::acp::rpc::PERMISSION_APPROVAL_PREFIX));
}

#[tokio::test]
async fn a_stale_turn_finishing_late_must_not_settle_the_turn_that_replaced_it() {
    // The half-applied guard. `settling_this_turn` gated only the push; the
    // settle tail ran unconditionally, so a late finisher for turn A cleared
    // whatever turn was running by then. Both siblings guard the whole block —
    // codex computes `superseded` (`codex/rpc.rs`), Claude returns early on a
    // "stale completion".
    //
    // Reachable: user stops turn A, the agent does not answer inside the stop
    // fallback so the relay idles the thread, the user sends turn B, and only
    // then does A's `session/prompt` resolve. B is live and must survive.
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("t1".to_string());
        relay.set_active_turn(Some("turn-A".to_string()));
        // A was abandoned and B took over.
        relay.set_active_turn(Some("turn-B".to_string()));
        relay.set_thread_status("t1", "working".to_string(), Vec::new());
    }

    {
        let mut relay = state.write().await;
        crate::acp::rpc::apply_turn_finished(
            &mut relay,
            "t1",
            "turn-A",
            Err("the abandoned turn finally failed".to_string()),
            "cursor",
        );
    }

    let relay = state.read().await;
    let runtime = relay.runtime_for_thread("t1").expect("runtime");
    assert_eq!(
        runtime.active_turn_id.as_deref(),
        Some("turn-B"),
        "a late finisher for an abandoned turn cleared the turn that replaced it"
    );
    assert_ne!(
        runtime.current_status, "idle",
        "the thread was forced idle while a newer turn was still running"
    );
}

#[test]
fn multi_line_mcp_errors_do_not_become_phantom_servers() {
    // `mcp list` output is human text, and a failing stdio server can print a
    // stack trace. Counting every line with a colon as a server turns one broken
    // server into a dozen phantoms — and each phantom emits its own `warn`, so a
    // chatty failure evicts the whole 200-line audit log at boot.
    let summary = crate::acp::protocol::summarize_mcp_servers(
        "cursor",
        "healthy-mini: ready\n\
         broken-stdio: Error: spawn cursor-mcp ENOENT\n\
         \x20   at ChildProcess.handle (node:internal/child_process:289:12)\n\
         \x20   at onErrorNT (node:internal/child_process:476:16)\n",
    );

    assert_eq!(
        summary.headline.as_deref(),
        Some("cursor MCP: 2 configured (1 ready, 0 disabled, 1 failed)"),
        "indented continuation lines are not servers"
    );
    assert_eq!(summary.problems.len(), 1);
}

#[test]
fn a_server_name_containing_a_colon_is_not_split_in_half() {
    // Splitting on the FIRST colon truncates any name that contains one, and
    // then reports a perfectly healthy server as having an unrecognized status.
    let summary = crate::acp::protocol::summarize_mcp_servers("cursor", "aws:prod: ready\n");
    assert_eq!(
        summary.headline.as_deref(),
        Some("cursor MCP: 1 configured (1 ready, 0 disabled, 0 failed)")
    );
    assert!(summary.problems.is_empty(), "{:?}", summary.problems);
}

#[test]
fn mcp_lines_name_the_agent_they_describe() {
    // Two CLIs on one relay produce two `MCP: N configured` lines. Moving off
    // the provider channel (which is what the audit view filters on) removed the
    // only attribution these lines had, so they have to carry it themselves.
    let summary = crate::acp::protocol::summarize_mcp_servers("cursor", "broken: Error: nope\n");
    assert!(summary
        .headline
        .as_deref()
        .unwrap()
        .starts_with("cursor MCP:"));
    assert!(
        summary.problems[0].contains("cursor"),
        "{:?}",
        summary.problems
    );
}

#[tokio::test]
async fn a_turn_finishing_on_a_dropped_thread_touches_nothing() {
    // `apply_turn_started` has an explicit `ThreadRoute::Drop => {}` arm.
    // `apply_turn_finished` used `_ =>`, which swallowed Drop into the ACTIVE
    // behaviour — and both `upsert_transcript_item_for_thread` and
    // `set_thread_status` call `ensure_runtime_for_thread`, so a route that
    // means "this event belongs to nobody" created a runtime instead.
    //
    // Reachable exactly when it hurts most: deleting a thread clears
    // `active_thread_id` and tombstones the id, and on any relay that also runs
    // Claude the provider fallback in `thread_belongs_to_provider` is false for
    // a cursor thread — so the late failure of the deleted thread's turn lands
    // here and resurrects the runtime the tombstone exists to bury.
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.active_thread_id = None;
        // The boot default on a relay with Claude installed, which is what makes
        // the cursor thread fail the provider fallback.
        relay.set_provider_name("claude_code".to_string());
        relay.mark_thread_deleted("t-gone");
    }

    {
        let mut relay = state.write().await;
        crate::acp::rpc::apply_turn_finished(
            &mut relay,
            "t-gone",
            "acp-turn-1",
            Err("late failure for a thread nobody owns".to_string()),
            "cursor",
        );
    }

    let relay = state.read().await;
    assert!(
        relay.runtime_for_thread("t-gone").is_none(),
        "a dropped event must not create the runtime it claims not to own"
    );
}

#[tokio::test]
async fn a_background_thread_failure_lands_its_transcript_entry_and_its_push() {
    // The gap the other failure tests left: they cover the ACTIVE thread and a
    // DELETED one. The case that actually matters to a user away from the desk —
    // a thread running behind the one they are looking at — was covered only by
    // the negative assertion that a deleted thread stays buried.
    let state = relay_state();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    {
        let mut relay = state.write().await;
        relay.set_push_runtime(tx, "test-vapid".to_string());
        // The user is looking at a different thread.
        relay.active_thread_id = Some("front".to_string());
        relay.bg_set_active_turn("back", Some("acp-turn-7".to_string()), 0);
        relay.bg_set_thread_status("back", "working".to_string(), Vec::new(), 0);
    }

    {
        let mut relay = state.write().await;
        crate::acp::rpc::apply_turn_finished(
            &mut relay,
            "back",
            "acp-turn-7",
            Err("the background turn died".to_string()),
            "cursor",
        );
    }

    let job = rx
        .try_recv()
        .expect("a background failure must still reach the phone");
    assert!(matches!(job.kind, crate::state::PushKind::Error));
    assert_eq!(job.thread_id, "back");

    let relay = state.read().await;
    let runtime = relay.runtime_for_thread("back").expect("runtime");
    let entry = runtime
        .transcript
        .iter()
        .find(|entry| entry.item_id == "turn-error:acp-turn-7")
        .expect("the durable failure entry is the only thing a remote client sees");
    assert_eq!(entry.text.as_deref(), Some("the background turn died"));
    assert_eq!(runtime.active_turn_id, None, "the turn must be settled");
    // And the thread the user IS looking at was not disturbed.
    assert_eq!(relay.active_thread_id.as_deref(), Some("front"));
}

#[tokio::test]
async fn every_kind_of_run_that_answers_its_own_approvals_closes_the_gate() {
    // The bridge auto-accepts a plan when `approval_can_reach_a_user` is false,
    // so that predicate is load-bearing: a branch that wrongly returns true
    // parks a card no one can answer and fails the run; one that wrongly returns
    // false accepts a plan a user should have seen. Only the review branch was
    // covered — a workflow or team run would have gone unnoticed.
    let unlocked = relay_state();
    assert!(
        unlocked.read().await.approval_can_reach_a_user("t1"),
        "an ordinary thread's approvals belong to the user"
    );

    let review = relay_state();
    review
        .write()
        .await
        .insert_review_job(crate::state::ReviewJob {
            id: "r".to_string(),
            parent_thread_id: "t1".to_string(),
            status: crate::state::ReviewJobStatus::WaitingForReviewer,
            ..Default::default()
        });
    assert!(!review.read().await.approval_can_reach_a_user("t1"));

    let workflow = relay_state();
    workflow
        .write()
        .await
        .insert_workflow_run(crate::state::WorkflowRun {
            id: "w".to_string(),
            parent_thread_id: "t1".to_string(),
            status: crate::state::RunStatus::Running,
            ..Default::default()
        });
    assert!(
        !workflow.read().await.approval_can_reach_a_user("t1"),
        "a workflow run answers its own approvals"
    );

    let team = relay_state();
    team.write().await.insert_team_run(crate::state::TeamRun {
        id: "team".to_string(),
        // A run owns a set of threads (TL, its successions, sub-task seats);
        // any of them is enough to close the gate.
        tl_thread_id: "t1".to_string(),
        status: crate::state::TeamRunStatus::Running,
        ..Default::default()
    });
    assert!(
        !team.read().await.approval_can_reach_a_user("t1"),
        "a team run answers its own approvals"
    );
}

#[test]
fn a_tool_call_keeps_the_kind_and_file_acp_reported() {
    let entries = replay(&[json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-read-1",
        "title": "Reading src/main.rs",
        "kind": "read",
        "status": "completed",
        "locations": [{"path": "/repo/src/main.rs", "line": 42}]
    })]);

    let tool = entries
        .iter()
        .find_map(|entry| entry.tool.as_ref())
        .expect("the replayed tool_call should carry a ToolCallView");

    assert_eq!(
        tool.kind.as_deref(),
        Some("read"),
        "the ACP ToolCallKind must survive into the view"
    );
    assert_eq!(
        tool.path.as_deref(),
        Some("/repo/src/main.rs"),
        "the first ACP location is the file this call acted on"
    );
}

#[test]
fn a_shell_tool_call_keeps_its_execute_kind_alongside_the_command() {
    let entries = replay(&[json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-run-1",
        "title": "`cargo test`",
        "kind": "execute",
        "status": "completed",
        "rawInput": {"command": "cargo test"}
    })]);

    let tool = entries
        .iter()
        .find_map(|entry| entry.tool.as_ref())
        .expect("the replayed tool_call should carry a ToolCallView");

    assert_eq!(tool.kind.as_deref(), Some("execute"));
    assert_eq!(tool.command.as_deref(), Some("cargo test"));
    assert_eq!(
        tool.item_type, "command_execution",
        "a call carrying a command still routes to the command view"
    );
}

#[tokio::test]
async fn a_completed_tool_update_keeps_the_kind_the_pending_call_reported() {
    // The live path is two upserts, so the second always merges. Replay never
    // does, which is why the replay tests cannot catch a field dropped there.
    let state = relay_state();
    let mut runtime = session();

    let pending = plan_update(
        &json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-read-live",
            "title": "Reading src/main.rs",
            "kind": "read",
            "status": "pending",
            "locations": [{"path": "/repo/src/main.rs"}]
        }),
        &mut runtime,
    );
    let completed = plan_update(
        &json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-read-live",
            "status": "completed"
        }),
        &mut runtime,
    );

    {
        let mut relay = state.write().await;
        crate::acp::rpc::apply_op(
            &mut relay,
            "t-live",
            Some("acp-turn-1".to_string()),
            pending,
            "cursor",
        );
        crate::acp::rpc::apply_op(
            &mut relay,
            "t-live",
            Some("acp-turn-1".to_string()),
            completed,
            "cursor",
        );
    }

    let relay = state.read().await;
    let runtime = relay.runtime_for_thread("t-live").expect("runtime");
    let tool = runtime
        .transcript
        .iter()
        .find_map(|entry| entry.tool.as_ref())
        .expect("the tool entry must exist after the update");
    assert_eq!(
        tool.kind.as_deref(),
        Some("read"),
        "the completed update must not erase the kind the pending call reported"
    );
    assert_eq!(tool.path.as_deref(), Some("/repo/src/main.rs"));
}

#[tokio::test]
async fn forget_session_drops_runtime_state_for_a_deleted_thread() {
    // Nothing else removes from `sessions`, so a deleted thread leaked its
    // `tool_meta` (full tool output strings) for the relay's life.
    let sessions: super::Sessions = Default::default();
    sessions
        .lock()
        .await
        .insert("thread-gone".to_string(), SessionRuntime::default());
    sessions
        .lock()
        .await
        .insert("thread-kept".to_string(), SessionRuntime::default());

    super::forget_session(&sessions, "thread-gone").await;

    let guard = sessions.lock().await;
    assert!(!guard.contains_key("thread-gone"));
    assert!(guard.contains_key("thread-kept"));
}

#[tokio::test]
async fn a_failed_delete_keeps_the_runtime_intact() {
    // A failed delete leaves the thread usable; a reset `ordinals` would restart
    // at 1 and re-mint item ids the surviving transcript already uses.
    let sessions: super::Sessions = Default::default();
    let mut runtime = SessionRuntime::default();
    runtime.ordinals.insert("user", 7);
    sessions.lock().await.insert("t".to_string(), runtime);

    super::settle_delete(
        &sessions,
        "t",
        &Err::<(), _>("permission denied".to_string()),
    )
    .await;
    assert_eq!(
        sessions.lock().await.get("t").map(|r| r.ordinals["user"]),
        Some(7),
        "a failed delete must not drop the runtime"
    );

    super::settle_delete(&sessions, "t", &Ok(())).await;
    assert!(!sessions.lock().await.contains_key("t"));
}

/// An agent without `loadSession` refuses to replay a session it can still be
/// prompted with; reading that refusal as "dead" throws away a live seat.
#[tokio::test]
async fn a_live_session_can_take_a_turn_even_when_its_history_cannot_be_read() {
    let state = relay_state();
    let (outbound, _outbound_peer) = tokio::io::duplex(8192);
    let (_inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state, outbound, inbound, "cursor");
    bridge.seed_session_for_test("t1", "/tmp/project").await;
    bridge.mark_session_content_for_test("t1").await;

    assert!(
        crate::provider::ProviderBridge::read_thread(&bridge, "t1")
            .await
            .is_err(),
        "without loadSession the history genuinely cannot be replayed"
    );
    assert!(
        crate::provider::ProviderBridge::session_can_take_a_turn(&bridge, "t1").await,
        "but the session is in this process, and start_turn needs no such capability"
    );
    assert!(
        !crate::provider::ProviderBridge::session_can_take_a_turn(&bridge, "gone").await,
        "a session the bridge has no copy of really is beyond reuse"
    );
}

/// A listing caches a cwd for a later load, not an open session — and after a
/// restart it is how a team seat is found, so "in the map" would fail the turn.
#[tokio::test]
async fn a_session_known_only_from_a_listing_is_not_treated_as_loaded() {
    let state = relay_state();
    let (outbound, _outbound_peer) = tokio::io::duplex(8192);
    let (_inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = AcpBridge::for_test(state, outbound, inbound, "cursor");

    bridge
        .absorb_listing_for_test("t-cold", "/tmp/project")
        .await;

    assert!(
        !crate::provider::ProviderBridge::session_can_take_a_turn(&bridge, "t-cold").await,
        "a cold session has to be loaded before it can be prompted, and this \
agent cannot load one at all"
    );
}

/// The load IS what makes a cold session promptable, so it is not refused —
/// and it is recorded, or the next MR round replays the whole thing again.
#[tokio::test]
async fn a_cold_session_is_loaded_once_and_then_known_to_be_attached() {
    let state = relay_state();
    let (outbound, mut outbound_peer) = tokio::io::duplex(8192);
    let (inbound_writer, inbound) = tokio::io::duplex(8192);
    let bridge = std::sync::Arc::new(AcpBridge::for_test(state, outbound, inbound, "cursor"));
    bridge.allow_session_load_for_test().await;
    bridge
        .absorb_listing_for_test("t-cold", "/tmp/project")
        .await;

    let probing = {
        let bridge = bridge.clone();
        tokio::spawn(async move {
            crate::provider::ProviderBridge::session_can_take_a_turn(&*bridge, "t-cold").await
        })
    };

    let request = next_wire_line(&mut outbound_peer).await;
    assert_eq!(
        request["method"],
        json!("session/load"),
        "a cold session an agent can load is loaded, not written off"
    );
    let mut writer = inbound_writer;
    let reply = json!({"jsonrpc": "2.0", "id": request["id"], "result": {}});
    tokio::io::AsyncWriteExt::write_all(&mut writer, format!("{reply}\n").as_bytes())
        .await
        .expect("write");
    tokio::io::AsyncWriteExt::flush(&mut writer)
        .await
        .expect("flush");

    assert!(
        probing.await.expect("the probe finishes"),
        "a session that loaded can take a turn"
    );

    assert!(
        crate::provider::ProviderBridge::session_can_take_a_turn(&*bridge, "t-cold").await,
        "and it stays usable"
    );
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(200),
            tokio::io::AsyncReadExt::read(&mut outbound_peer, &mut vec![0_u8; 1024]),
        )
        .await
        .is_err(),
        "the second probe must not put another session/load on the wire"
    );
}

// `TranscriptOp::AgentChunk` must stream local deltas with a correct text_offset.

#[tokio::test]
async fn a_foreground_agent_chunk_queues_a_transcript_delta() {
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("t1".to_string());
    }
    let mut deltas = state.read().await.subscribe_transcript_deltas();

    let mut runtime = session();
    let op = plan_update(&agent("hello"), &mut runtime);
    {
        let mut relay = state.write().await;
        crate::acp::rpc::apply_op(&mut relay, "t1", Some("turn-1".to_string()), op, "cursor");
    }

    let event = deltas
        .try_recv()
        .expect("a foreground AgentChunk must queue a local transcript delta");
    assert_eq!(event.thread_id, "t1");
    assert_eq!(event.delta, "hello");
}

#[tokio::test]
async fn a_foreground_agent_chunks_second_delta_offset_follows_the_first() {
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("t1".to_string());
    }
    let mut deltas = state.read().await.subscribe_transcript_deltas();
    let mut runtime = session();

    {
        let mut relay = state.write().await;
        let op = plan_update(&agent("hello "), &mut runtime);
        crate::acp::rpc::apply_op(&mut relay, "t1", Some("turn-1".to_string()), op, "cursor");
    }
    let first = deltas.try_recv().expect("first chunk must queue a delta");
    assert_eq!(first.text_offset, Some(0));

    {
        let mut relay = state.write().await;
        let op = plan_update(&agent("world"), &mut runtime);
        crate::acp::rpc::apply_op(&mut relay, "t1", Some("turn-1".to_string()), op, "cursor");
    }
    let second = deltas.try_recv().expect("second chunk must queue a delta");
    assert_eq!(
        second.text_offset,
        Some("hello ".encode_utf16().count() as u64),
        "a per-chunk `start` wipes the accumulated text before this append, so a \
         naive fix ships text_offset: 0 and the client refuses the delta as a gap"
    );
}
