//! The Phase-2b boundary checklist for provider event ingress, and a tripwire
//! that notices when a new ingress point skips it.
//!
//! `markdown/STABLE_SESSION_ID_DESIGN.md` invariant 4: every provider event
//! resolves `(provider, provider handle)` to a session id before mutating
//! `RelayState`. Nothing in the type system enforces that — a provider handle and
//! a session id are both `String` — so this file is the standing reminder.
//!
//! # Manual checklist: adding or changing a provider event
//!
//! 1. **Translate at ingress, once.** Call
//!    `RelayState::session_for_provider_event(provider_key, handle)` while holding
//!    the write lock you are about to mutate under, before any `active_thread_id`
//!    comparison, runtime lookup or record write. Never translate twice: a session
//!    id fed back through the resolver is a handle nobody owns.
//! 2. **`Refused` drops the whole event.** Do not fall through to "unaddressed" —
//!    every router reads that as the active thread, which is how a refused event
//!    lands on someone else's session.
//! 3. **Use the CONFIGURED provider key**, not the protocol's name. The ACP bridge
//!    runs as `cursor`; the literal `"acp"` matches no binding and would silently
//!    adopt every handle under a provider that does not exist.
//! 4. **Rewrite payload ids, do not pass them through.** A `ThreadSummaryView`,
//!    `PendingApproval`, `PendingAskUserQuestion` or `PendingTranscriptDelta` built
//!    from a provider payload carries the handle until you overwrite it.
//! 5. **Bridge-owned maps keep the handle.** The ACP `Sessions`/`Captures` maps,
//!    Claude's `pending_threads` and the outgoing JSON are the provider's address
//!    space; only `RelayState` is translated.
//! 6. **Turn ids, request ids and transcript item ids are not session ids.** They
//!    are never translated.
//!
//! # What the scan below can and cannot do
//!
//! It is a **textual heuristic**, not a proof. It reads the router sources with
//! `include_str!` and attributes each match to the nearest preceding `fn`. It will
//! not notice a handle that reaches `RelayState` through a helper, a struct field,
//! or a payload key spelled differently — and a determined refactor can move code
//! out from under it without tripping it. What it does do is fail loudly when a new
//! function starts reading a provider event's thread field, which is where every
//! omission in this class has started so far. Treat a green run as "the known
//! ingress points still translate", never as "the boundary is complete".

/// Attribute every occurrence of `needle` in `source` to the nearest preceding
/// `fn` declaration.
fn functions_containing(source: &str, needle: &str) -> Vec<String> {
    let mut current = String::new();
    let mut found: Vec<String> = Vec::new();
    for line in source.lines() {
        if let Some(name) = function_name(line) {
            current = name;
        }
        if line.contains(needle) && !found.contains(&current) {
            found.push(current.clone());
        }
    }
    found.sort();
    found
}

fn function_name(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let rest = trimmed
        .strip_prefix("pub(crate) ")
        .or_else(|| trimmed.strip_prefix("pub(super) "))
        .or_else(|| trimmed.strip_prefix("pub "))
        .unwrap_or(trimmed);
    let rest = rest.strip_prefix("async ").unwrap_or(rest);
    let rest = rest.strip_prefix("fn ")?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

const CODEX_RPC: &str = include_str!("../codex/rpc.rs");
const ACP_RPC: &str = include_str!("../acp/rpc.rs");
const CLAUDE: &str = include_str!("../claude.rs");

/// Every function that reads a provider event's thread/session field, by name.
///
/// A new name here is the signal: that function is a NEW ingress point, and it has
/// to translate before it touches `RelayState`. Extend the list only after adding
/// the translation — and a test that proves it, the way each provider's
/// `session_binding_boundary_tests` module does.
#[test]
fn only_the_reviewed_functions_read_a_raw_provider_thread_field() {
    assert_eq!(
        functions_containing(CODEX_RPC, r#"threadId"]"#),
        vec!["notification_thread_id"],
        "codex/rpc.rs: a new reader of the notification's threadId",
    );
    assert_eq!(
        functions_containing(ACP_RPC, r#"get("sessionId")"#),
        vec!["handle_notification", "handle_server_request"],
        "acp/rpc.rs: a new reader of an ACP payload's sessionId",
    );
    assert_eq!(
        functions_containing(CLAUDE, r#"["provider_session_id"]"#),
        vec!["fork_thread", "handle_worker_event"],
        "claude.rs: a new reader of a worker event's provider_session_id",
    );
    assert_eq!(
        functions_containing(CLAUDE, r#"["pending_thread_id"]"#),
        vec!["handle_worker_event", "pending_session_id"],
        "claude.rs: a new reader of a deferred-start placeholder id",
    );
}

/// The other half: each ingress point still runs its handle through the seam.
#[test]
fn every_known_ingress_point_translates_before_it_mutates() {
    for (label, body) in [
        (
            "codex handle_notification_for_provider",
            function_body(CODEX_RPC, "handle_notification_for_provider"),
        ),
        (
            "codex handle_server_request_for_provider",
            function_body(CODEX_RPC, "handle_server_request_for_provider"),
        ),
        (
            "claude handle_worker_event",
            function_body(CLAUDE, "handle_worker_event"),
        ),
    ] {
        assert!(
            body.contains("session_for_provider_event"),
            "{label} must resolve its provider handle before mutating RelayState",
        );
    }

    // ACP resolves inside each `apply_*` rather than at one reader, because its
    // ingress points are split across `acp.rs` (start_turn, the prompt task) and
    // this file.
    for entry in [
        "apply_op",
        "apply_user_message",
        "apply_turn_started",
        "apply_turn_finished",
        "handle_server_request",
    ] {
        assert!(
            function_body(ACP_RPC, entry).contains("session_for_acp_id"),
            "acp/rpc.rs::{entry} must resolve its ACP session id before mutating RelayState",
        );
    }
}

/// Everything from `fn <name>` up to the next `fn` at the same or lower indent.
/// Crude on purpose — see the module note on what this scan is worth.
fn function_body(source: &str, name: &str) -> String {
    let mut body = String::new();
    let mut inside = false;
    for line in source.lines() {
        match function_name(line) {
            Some(found) if found == name => {
                inside = true;
            }
            Some(_) if inside => break,
            _ => {}
        }
        if inside {
            body.push_str(line);
            body.push('\n');
        }
    }
    assert!(!body.is_empty(), "no function named `{name}` was found");
    body
}
