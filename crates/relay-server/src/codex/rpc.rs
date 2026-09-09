use std::sync::{atomic::Ordering, Arc};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStderr, ChildStdout},
    sync::RwLock,
    time::{timeout, Duration},
};
use tracing::{debug, trace};

use crate::state::{BrokerPendingMessage, PendingTranscriptDelta, RelayState, TranscriptDeltaKind};

use super::*;

const CODEX_REQUEST_TIMEOUT_SECS: u64 = 30;

impl CodexBridge {
    #[cfg(test)]
    pub(crate) fn set_test_request_timeout_ms(&self, ms: u64) {
        self.test_request_timeout_ms
            .store(ms, std::sync::atomic::Ordering::Relaxed);
    }

    fn request_timeout(&self) -> Duration {
        #[cfg(test)]
        {
            let ms = self
                .test_request_timeout_ms
                .load(std::sync::atomic::Ordering::Relaxed);
            if ms > 0 {
                return Duration::from_millis(ms);
            }
        }
        Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS)
    }

    pub(super) async fn initialize(&self) -> Result<(), String> {
        self.send_request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "agent-relay",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true
                }
            }),
        )
        .await?;

        self.send_json(json!({ "method": "initialized" })).await
    }

    pub(super) async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.send_request_with_timeout(method, params, self.request_timeout())
            .await
    }

    pub(super) async fn send_request_with_timeout(
        &self,
        method: &str,
        params: Value,
        request_timeout: Duration,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request_id_key = request_id.to_string();
        let (sender, receiver) = oneshot::channel();

        self.pending_responses
            .lock()
            .await
            .insert(request_id_key.clone(), sender);

        if let Err(error) = self
            .send_json(json!({
                "id": request_id,
                "method": method,
                "params": params,
            }))
            .await
        {
            self.pending_responses.lock().await.remove(&request_id_key);
            return Err(error);
        }

        match timeout(request_timeout, receiver).await {
            Ok(result) => result.map_err(|_| {
                format!("Codex app-server dropped the response channel for `{method}`")
            })?,
            Err(_) => {
                self.pending_responses.lock().await.remove(&request_id_key);
                return Err(format!("Codex app-server timed out waiting for `{method}`"));
            }
        }
    }

    pub(super) async fn send_json(&self, value: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let serialized = serde_json::to_string(&value)
            .map_err(|error| format!("failed to encode JSON-RPC message: {error}"))?;
        stdin
            .write_all(serialized.as_bytes())
            .await
            .map_err(|error| format!("failed to write to codex app-server stdin: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("failed to finalize codex app-server message: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush codex app-server stdin: {error}"))
    }
}

pub(super) fn spawn_stdout_reader(
    stdout: ChildStdout,
    pending_responses: PendingResponses,
    state: Arc<RwLock<RelayState>>,
    provider_key: &'static str,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    handle_stdout_line(&line, &pending_responses, &state, provider_key).await;
                }
                Ok(None) => {
                    let mut relay = state.write().await;
                    relay.set_provider_connection(provider_key, false);
                    relay.fail_in_flight_turns_for_provider(provider_key);
                    relay.push_log("error", format!("{provider_key} app-server stdout closed."));
                    relay.notify();
                    break;
                }
                Err(error) => {
                    let mut relay = state.write().await;
                    relay.set_provider_connection(provider_key, false);
                    relay.fail_in_flight_turns_for_provider(provider_key);
                    relay.push_log(
                        "error",
                        format!("Failed to read {provider_key} stdout: {error}"),
                    );
                    relay.notify();
                    break;
                }
            }
        }
    });
}

pub(super) fn spawn_stderr_reader(stderr: ChildStderr, state: Arc<RwLock<RelayState>>) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let mut relay = state.write().await;
                    relay.push_log("codex", line);
                    relay.notify();
                }
                Ok(None) => break,
                Err(error) => {
                    let mut relay = state.write().await;
                    relay.push_log("error", format!("Failed to read Codex stderr: {error}"));
                    relay.notify();
                    break;
                }
            }
        }
    });
}

async fn handle_stdout_line(
    line: &str,
    pending_responses: &PendingResponses,
    state: &Arc<RwLock<RelayState>>,
    provider_key: &'static str,
) {
    let payload: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            let mut relay = state.write().await;
            relay.push_log("codex", line.to_string());
            relay.notify();
            return;
        }
    };

    if payload.get("method").is_some() && payload.get("id").is_some() {
        handle_server_request_for_provider(payload, state, provider_key).await;
        return;
    }

    if payload.get("id").is_some()
        && (payload.get("result").is_some() || payload.get("error").is_some())
    {
        let request_id = normalize_id(payload.get("id").unwrap_or(&Value::Null));
        if let Some(sender) = pending_responses.lock().await.remove(&request_id) {
            let result = if let Some(error) = payload.get("error") {
                let message = value_at(error, &["message"])
                    .and_then(Value::as_str)
                    .unwrap_or("Codex app-server returned an unknown error")
                    .to_string();
                Err(message)
            } else {
                Ok(payload.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(result);
        }
        return;
    }

    if payload.get("method").is_some() {
        handle_notification_for_provider(payload, state, provider_key).await;
        return;
    }

    let mut relay = state.write().await;
    relay.push_log("codex", line.to_string());
    relay.notify();
}

#[cfg(test)]
pub(super) async fn handle_server_request(payload: Value, state: &Arc<RwLock<RelayState>>) {
    handle_server_request_for_provider(payload, state, "codex").await;
}

async fn handle_server_request_for_provider(
    payload: Value,
    state: &Arc<RwLock<RelayState>>,
    provider_key: &'static str,
) {
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = payload.get("params").cloned().unwrap_or(Value::Null);
    let raw_request_id = payload.get("id").cloned().unwrap_or(Value::Null);
    let request_id = normalize_id(&raw_request_id);

    let pending = match method {
        "item/commandExecution/requestApproval" => Some(parse_command_approval(
            request_id.clone(),
            raw_request_id,
            &params,
        )),
        "item/fileChange/requestApproval" => Some(parse_file_change_approval(
            request_id.clone(),
            raw_request_id,
            &params,
        )),
        "item/permissions/requestApproval" => Some(parse_permissions_approval(
            request_id.clone(),
            raw_request_id,
            &params,
        )),
        _ => None,
    };

    if let Some(pending) = pending {
        let mut relay = state.write().await;
        let route = if pending.thread_id.is_empty() {
            ThreadRoute::Drop
        } else {
            thread_route(&relay, Some(&pending.thread_id), provider_key)
        };
        if !pending.thread_id.is_empty() {
            relay.set_thread_status(
                &pending.thread_id,
                "active".to_string(),
                vec!["waitingOnApproval".to_string()],
            );
        }
        if let ThreadRoute::Background(thread_id) = route.clone() {
            relay.bg_set_thread_status(
                &thread_id,
                "active".to_string(),
                vec!["waitingOnApproval".to_string()],
                crate::state::unix_now(),
            );
        }
        relay.add_pending_approval(pending.clone());
        if let Some(cwd) = pending.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
            if !pending.thread_id.is_empty() {
                relay.observe_thread_cwd(&pending.thread_id, cwd);
            }
        }
        if matches!(route, ThreadRoute::Active) {
            relay.touch_progress(Some("waiting_approval"), None);
        }
        relay.push_log(
            "approval",
            format!("Approval requested for {}.", pending.kind.as_str()),
        );
        relay.notify();
    }
}

#[cfg(test)]
pub(super) async fn handle_notification(payload: Value, state: &Arc<RwLock<RelayState>>) {
    handle_notification_for_provider(payload, state, "codex").await;
}

async fn handle_notification_for_provider(
    payload: Value,
    state: &Arc<RwLock<RelayState>>,
    provider_key: &'static str,
) {
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = payload.get("params").cloned().unwrap_or(Value::Null);
    let mut relay = state.write().await;
    let mut changed = false;
    let notification_thread_id = notification_thread_id(&params);
    if is_session_notification_method(method) {
        trace!(
            method,
            notification_thread_id = notification_thread_id.as_deref().unwrap_or("-"),
            active_thread_id = relay.active_thread_id.as_deref().unwrap_or("-"),
            active_turn_id = relay.active_turn_id.as_deref().unwrap_or("-"),
            "received codex session notification"
        );
    }

    match method {
        "thread/started" => {
            if let Some(thread) =
                value_at(&params, &["thread"]).and_then(|value| parse_thread_summary(value).ok())
            {
                relay.upsert_thread(thread);
                changed = true;
            }
        }
        "thread/settings/updated" => {
            observe_notification_cwd(&mut relay, notification_thread_id.as_deref(), &params);
        }
        "thread/status/changed" => {
            let thread_id = string_at(&params, &["threadId"]).unwrap_or_default();
            if thread_id.is_empty() {
                return;
            }
            let (status, active_flags) = parse_status(value_at(&params, &["status"]));
            let route = thread_route(&relay, Some(&thread_id), provider_key);
            relay.set_thread_status(&thread_id, status.clone(), active_flags.clone());
            if let ThreadRoute::Background(bg_thread_id) = route {
                relay.bg_set_thread_status(
                    &bg_thread_id,
                    status,
                    active_flags,
                    crate::state::unix_now(),
                );
            }
            changed = true;
        }
        // Codex reports usage on every model request. This arm did not exist,
        // so the notification fell through the match and the relay's entire
        // token history was discarded as it arrived.
        //
        // Routed like any other thread notification: every team seat is
        // background-started, so a version that only handled the active thread
        // would silently drop exactly the spend a task run is made of.
        "thread/tokenUsage/updated" => {
            let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
            let thread_id = match &route {
                ThreadRoute::Drop => {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                ThreadRoute::Background(bg_thread_id) => bg_thread_id.clone(),
                ThreadRoute::Active => relay.active_thread_id.clone().unwrap_or_default(),
            };
            if let Some(observation) = relay.codex_usage.observe(&params) {
                // The tracker keys its baselines off the id Codex sent, which is
                // the same id the route resolved except when the active thread
                // is implied. Bill against the resolved one.
                relay.record_token_usage(
                    &thread_id,
                    observation.turn_id,
                    provider_key,
                    observation.usage,
                    // Codex reports no cost. Leaving this `None` is what keeps
                    // an unpriced group from rendering as a confident $0.00.
                    None,
                    observation.context_window,
                    None,
                    // Not knowable here: Codex reports usage per model request
                    // and the turn's outcome later, on `turn/completed`. That
                    // arm stamps failure retroactively via `mark_turn_failed`.
                    false,
                );
            }
            // Deliberately no `changed = true`: usage is not part of the
            // snapshot, so notifying every connected surface for it would wake
            // a snapshot build per model request for a number they cannot see.
        }
        "turn/started" => {
            let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
            if matches!(route, ThreadRoute::Drop) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let Some(turn_id) = string_at(&params, &["turn", "id"]) {
                // Bind only the in-flight pending reservation for this start —
                // never the oldest unbound leftover on the thread.
                let bind_thread_id = match &route {
                    ThreadRoute::Background(bg_thread_id) => Some(bg_thread_id.clone()),
                    ThreadRoute::Active => notification_thread_id
                        .clone()
                        .or_else(|| relay.active_thread_id.clone()),
                    ThreadRoute::Drop => None,
                };
                if let Some(bind_thread_id) = bind_thread_id {
                    relay.bind_pending_codex_user_reservation(&bind_thread_id, &turn_id);
                }
                if let ThreadRoute::Background(bg_thread_id) = route {
                    relay.bg_set_active_turn(
                        &bg_thread_id,
                        Some(turn_id),
                        crate::state::unix_now(),
                    );
                    changed = true;
                } else {
                    relay.set_active_turn(Some(turn_id));
                    relay.touch_progress(Some("thinking"), None);
                    changed = true;
                }
            }
        }
        "turn/completed" => {
            let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
            if matches!(route, ThreadRoute::Drop) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            let completed_turn = string_at(&params, &["turn", "id"]);
            if let ThreadRoute::Background(bg_thread_id) = route {
                let now = crate::state::unix_now();
                // Only settle if this completion is for the background thread's
                // CURRENT turn. A delayed completion for an already-superseded turn
                // must not clear a newer turn (see the active branch below).
                let current_turn = relay
                    .runtime_for_thread(&bg_thread_id)
                    .and_then(|runtime| runtime.active_turn_id.clone());
                let superseded = matches!(
                    (completed_turn.as_deref(), current_turn.as_deref()),
                    (Some(completed), Some(active)) if completed != active
                );
                if !superseded {
                    // Bind only while this completion still matches the thread's
                    // live turn. After active is cleared, a duplicate/stale
                    // completion must not stamp the next send's unbound pending.
                    if let Some(turn_id) = completed_turn.as_deref() {
                        if current_turn.as_deref() == Some(turn_id) {
                            relay.bind_pending_codex_user_reservation(&bg_thread_id, turn_id);
                        }
                    }
                    relay.bg_set_active_turn(&bg_thread_id, None, now);
                    // Settle the background thread to idle on completion, mirroring
                    // the active/Claude paths. Otherwise a background thread whose
                    // status was "active" stays is_working() == true forever if the
                    // follow-up thread/status/changed is missing — a ghost "working"
                    // badge that also blocks reviews on that thread.
                    relay.bg_set_thread_status(&bg_thread_id, "idle".to_string(), Vec::new(), now);
                    // A failed turn notifies AND leaves a durable, remote-visible
                    // failure entry — but only for the CURRENT turn. A superseded
                    // (stale) completion must not push/suppress, or it would
                    // swallow the newer turn's real "completed".
                    if let Some(reason) =
                        value_at(&params, &["turn"]).and_then(codex_turn_failure_reason)
                    {
                        // The usage rows for this turn were written before the
                        // outcome was known — Codex reports spend per request
                        // and failure only here. Stamp them now, so retry waste
                        // is not silently a Claude-only figure.
                        if let Some(turn) = completed_turn.as_deref() {
                            relay.usage_store.mark_turn_failed(turn);
                            relay.mark_turn_spend_failed(&bg_thread_id, turn);
                        }
                        // Operator log keeps the RAW provider message when present
                        // (never rides remote snapshots).
                        if let Some(raw) =
                            value_at(&params, &["turn", "error", "message"]).and_then(Value::as_str)
                        {
                            relay.push_log("error", raw.to_string());
                        }
                        // Truthful classification for team_turn (state/app/team.rs): a
                        // failed terminal must stop reading as Silent. Matched there by
                        // turn id, so only worth recording when we have one.
                        if let Some(turn_id) = completed_turn.clone() {
                            relay.set_last_turn_failure(
                                &bg_thread_id,
                                turn_id,
                                value_at(&params, &["turn"]).and_then(codex_turn_failure_kind),
                                reason.clone(),
                            );
                        }
                        relay.enqueue_error_push(&bg_thread_id, reason.clone());
                        // DURABLE failure entry on the background thread's runtime,
                        // present when the user switches back (and in its
                        // broker-bound snapshot). Mirrors the Claude bg path.
                        relay.bg_upsert_transcript_item(
                            &bg_thread_id,
                            codex_turn_error_item_id(completed_turn.as_deref()),
                            crate::protocol::TranscriptEntryKind::Error,
                            Some(reason),
                            "failed".to_string(),
                            completed_turn.clone(),
                            None,
                            now,
                        );
                    }
                }
                if let Some(turn_id) = completed_turn.as_deref() {
                    relay.bg_set_transcript_item_status(
                        &bg_thread_id,
                        &format!("turn-diff:{turn_id}"),
                        "completed",
                        now,
                    );
                    // Retire reservation metadata; keep any user placeholder in
                    // the transcript (terminal-without-echo must not linger).
                    relay.settle_codex_user_reservation_for_turn(&bg_thread_id, turn_id);
                }
                changed = true;
            } else {
                // Only settle the thread's active state if this completion is for
                // the currently-active turn. A delayed/stale completion for an old
                // turn (e.g. a stop fallback idled turn A, turn B then started, and
                // A's completion arrives late) must NOT clear the newer turn or idle
                // a working thread — that would also let the server permit an
                // overlapping turn.
                let superseded = matches!(
                    (completed_turn.as_deref(), relay.active_turn_id.as_deref()),
                    (Some(completed), Some(active)) if completed != active
                );
                if !superseded {
                    // Bind only while this completion still matches the live active
                    // turn. `superseded` is false when active_turn_id is None, so a
                    // late duplicate completion must not bind the next send's pending.
                    if let (Some(turn_id), Some(active)) =
                        (completed_turn.as_deref(), relay.active_turn_id.as_deref())
                    {
                        if active == turn_id {
                            if let Some(thread_id) = notification_thread_id
                                .clone()
                                .or_else(|| relay.active_thread_id.clone())
                            {
                                relay.bind_pending_codex_user_reservation(&thread_id, turn_id);
                            }
                        }
                    }
                    relay.set_active_turn(None);
                    // Match the Claude completion path: a completed turn idles the
                    // active thread. Codex otherwise relies on a follow-up
                    // thread/status/changed to set idle; if that is missing/delayed,
                    // the stale "active" status keeps is_working() true (a ghost
                    // "working" badge / wrongly-frozen composer after the turn ends).
                    if let Some(thread_id) = relay.active_thread_id.clone() {
                        relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
                    }
                    relay.clear_progress();
                    // A failed turn notifies AND leaves a durable, remote-visible
                    // failure entry — but only for the CURRENT turn. A superseded
                    // (stale) completion must not push/suppress, or it would
                    // swallow the newer turn's real "completed".
                    if let Some(reason) =
                        value_at(&params, &["turn"]).and_then(codex_turn_failure_reason)
                    {
                        // The usage rows for this turn were written before the
                        // outcome was known — Codex reports spend per request
                        // and failure only here. Stamp them now, so retry waste
                        // is not silently a Claude-only figure.
                        if let Some(turn) = completed_turn.as_deref() {
                            relay.usage_store.mark_turn_failed(turn);
                            if let Some(thread_id) = relay.active_thread_id.clone() {
                                relay.mark_turn_spend_failed(&thread_id, turn);
                            }
                        }
                        // Operator log keeps the RAW provider message when present
                        // (never rides remote snapshots).
                        if let Some(raw) =
                            value_at(&params, &["turn", "error", "message"]).and_then(Value::as_str)
                        {
                            relay.push_log("error", raw.to_string());
                        }
                        if let Some(thread_id) = relay.active_thread_id.clone() {
                            // Truthful classification for team_turn (state/app/team.rs):
                            // a failed terminal must stop reading as Silent. Matched
                            // there by turn id, so only worth recording when we have one.
                            if let Some(turn_id) = completed_turn.clone() {
                                relay.set_last_turn_failure(
                                    &thread_id,
                                    turn_id,
                                    value_at(&params, &["turn"]).and_then(codex_turn_failure_kind),
                                    reason.clone(),
                                );
                            }
                            relay.enqueue_error_push(&thread_id, reason.clone());
                            // DURABLE failure entry: operator logs are stripped
                            // from broker-bound snapshots, so a log line alone
                            // would let a remote/mobile client see the failed turn
                            // settle as a clean success. Mirrors the Claude path.
                            relay.upsert_transcript_item_for_thread(
                                &thread_id,
                                codex_turn_error_item_id(completed_turn.as_deref()),
                                crate::protocol::TranscriptEntryKind::Error,
                                Some(reason),
                                "failed".to_string(),
                                completed_turn.clone(),
                                None,
                            );
                        }
                    }
                    changed = true;
                }
                if let Some(turn_id) = completed_turn.as_deref() {
                    changed |= relay
                        .set_transcript_item_status(&format!("turn-diff:{turn_id}"), "completed");
                    let settle_thread = notification_thread_id
                        .clone()
                        .or_else(|| relay.active_thread_id.clone());
                    if let Some(settle_thread) = settle_thread {
                        relay.settle_codex_user_reservation_for_turn(&settle_thread, turn_id);
                        changed = true;
                    }
                }
            }
        }
        "turn/diff/updated" => {
            let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
            if matches!(route, ThreadRoute::Drop) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let (Some(turn_id), Some(diff)) = (
                string_at(&params, &["turnId"]),
                string_at(&params, &["diff"]),
            ) {
                let entry = build_turn_diff_entry(turn_id, diff, "running");
                if let Some(item_id) = entry.item_id.clone() {
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_upsert_turn_diff_item(
                            &bg_thread_id,
                            item_id,
                            entry.text,
                            entry.status,
                            entry.turn_id,
                            entry.tool,
                            crate::state::unix_now(),
                        );
                        changed = true;
                    } else {
                        relay.upsert_transcript_item(
                            item_id,
                            entry.kind,
                            entry.text,
                            entry.status,
                            entry.turn_id,
                            entry.tool,
                        );
                        changed = true;
                    }
                }
            }
        }
        "item/started" => match string_at(&params, &["item", "type"]).as_deref() {
            Some("agentMessage") => {
                let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
                if matches!(route, ThreadRoute::Drop) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let (Some(item_id), Some(turn_id)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                ) {
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_start_agent_message(
                            &bg_thread_id,
                            item_id,
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.start_agent_message(item_id, turn_id);
                        relay.touch_progress(Some("streaming"), None);
                    }
                    changed = true;
                }
            }
            Some("commandExecution") => {
                let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
                if matches!(route, ThreadRoute::Drop) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let (Some(item_id), Some(turn_id), Some(command)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                    string_at(&params, &["item", "command"]),
                ) {
                    let status = string_at(&params, &["item", "status"])
                        .unwrap_or_else(|| "running".to_string());
                    observe_notification_cwd(
                        &mut relay,
                        notification_thread_id.as_deref(),
                        &params,
                    );
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_start_command_execution(
                            &bg_thread_id,
                            item_id,
                            command,
                            status,
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.start_command_execution(item_id, command.clone(), status, turn_id);
                        relay.touch_progress(Some("tool"), Some("Bash"));
                        relay.push_log("command", format!("Command started: {command}"));
                    }
                    changed = true;
                }
            }
            _ => {
                let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
                if matches!(route, ThreadRoute::Drop) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let ThreadRoute::Background(bg_thread_id) = route {
                    if let Some(entry) = value_at(&params, &["item"]).and_then(|item| {
                        parse_transcript_item(item, string_at(&params, &["turnId"]), "running")
                    }) {
                        if let Some(item_id) = entry.item_id {
                            relay.bg_upsert_transcript_item(
                                &bg_thread_id,
                                item_id,
                                entry.kind,
                                entry.text,
                                entry.status,
                                entry.turn_id,
                                entry.tool,
                                crate::state::unix_now(),
                            );
                            changed = true;
                        }
                    }
                } else {
                    let tool_name = string_at(&params, &["item", "name"])
                        .or_else(|| string_at(&params, &["item", "tool"]));
                    relay.touch_progress(Some("tool"), tool_name.as_deref());
                    changed |= upsert_transcript_item_from_value(
                        &mut relay,
                        value_at(&params, &["item"]),
                        string_at(&params, &["turnId"]),
                        "running",
                    );
                }
            }
        },
        "item/agentMessage/delta" => {
            let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
            if matches!(route, ThreadRoute::Drop) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let (Some(item_id), Some(turn_id), Some(delta)) = (
                string_at(&params, &["itemId"]),
                string_at(&params, &["turnId"]),
                string_at(&params, &["delta"]),
            ) {
                if let ThreadRoute::Background(bg_thread_id) = route {
                    let delta_len = delta.len();
                    relay.bg_append_agent_delta(
                        &bg_thread_id,
                        &item_id,
                        &delta,
                        &turn_id,
                        crate::state::unix_now(),
                    );
                    trace!(
                        method,
                        thread_id = %bg_thread_id,
                        item_id = %item_id,
                        turn_id = %turn_id,
                        delta_len,
                        "updated runtime transcript delta for non-active thread"
                    );
                    changed = true;
                } else {
                    relay.touch_progress(Some("streaming"), None);
                    let delta_len = delta.len();
                    let mutation = relay.append_agent_delta(&item_id, &delta, &turn_id);
                    let thread_id = notification_thread_id
                        .clone()
                        .or_else(|| relay.active_thread_id.clone())
                        .unwrap_or_default();
                    trace!(
                        method,
                        thread_id = %thread_id,
                        item_id = %item_id,
                        turn_id = %turn_id,
                        delta_len,
                        pending_broker_messages = relay.pending_broker_messages.len() + 1,
                        "queued broker transcript delta"
                    );
                    relay.queue_broker_message(BrokerPendingMessage::TranscriptDelta(
                        PendingTranscriptDelta {
                            thread_id,
                            base_revision: mutation.base_revision,
                            revision: mutation.revision,
                            entry_seq: mutation.entry_seq,
                            server_time: mutation.server_time,
                            item_id,
                            turn_id: Some(turn_id),
                            delta,
                            kind: TranscriptDeltaKind::AgentText,
                            text_offset: mutation.text_offset,
                        },
                    ));
                    changed = true;
                }
            }
        }
        "item/completed" => match string_at(&params, &["item", "type"]).as_deref() {
            Some("userMessage") => {
                let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
                if matches!(route, ThreadRoute::Drop) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let (Some(item_id), Some(turn_id), Some(text)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                    parse_user_text(value_at(&params, &["item"])),
                ) {
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_upsert_user_message(
                            &bg_thread_id,
                            item_id,
                            text,
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.upsert_user_message(item_id, text, turn_id);
                        relay.touch_progress(Some("thinking"), None);
                    }
                    changed = true;
                }
            }
            Some("agentMessage") => {
                let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
                if matches!(route, ThreadRoute::Drop) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let (Some(item_id), Some(turn_id), Some(text)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                    string_at(&params, &["item", "text"]),
                ) {
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_complete_agent_message(
                            &bg_thread_id,
                            item_id,
                            text,
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.complete_agent_message(item_id, text, turn_id);
                        relay.touch_progress(Some("thinking"), None);
                    }
                    changed = true;
                }
            }
            Some("commandExecution") => {
                let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
                if matches!(route, ThreadRoute::Drop) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let (Some(item_id), Some(turn_id), Some(command)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                    string_at(&params, &["item", "command"]),
                ) {
                    let output = string_at(&params, &["item", "aggregatedOutput"]);
                    let status = string_at(&params, &["item", "status"])
                        .unwrap_or_else(|| "completed".to_string());
                    observe_notification_cwd(
                        &mut relay,
                        notification_thread_id.as_deref(),
                        &params,
                    );
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_add_command_result(
                            &bg_thread_id,
                            item_id,
                            command,
                            output,
                            status,
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.add_command_result(item_id, command, output, status, turn_id);
                        // Defer phase changes — the next event (or the next turn)
                        // will refine. Just keep the heartbeat fresh.
                        relay.touch_progress(None, None);
                    }
                    changed = true;
                }
            }
            _ => {
                let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
                if matches!(route, ThreadRoute::Drop) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let ThreadRoute::Background(bg_thread_id) = route {
                    if let Some(entry) = value_at(&params, &["item"]).and_then(|item| {
                        parse_transcript_item(item, string_at(&params, &["turnId"]), "completed")
                    }) {
                        if let Some(item_id) = entry.item_id {
                            relay.bg_upsert_transcript_item(
                                &bg_thread_id,
                                item_id,
                                entry.kind,
                                entry.text,
                                entry.status,
                                entry.turn_id,
                                entry.tool,
                                crate::state::unix_now(),
                            );
                            changed = true;
                        }
                    }
                } else {
                    relay.touch_progress(None, None);
                    changed |= upsert_transcript_item_from_value(
                        &mut relay,
                        value_at(&params, &["item"]),
                        string_at(&params, &["turnId"]),
                        "completed",
                    );
                }
            }
        },
        "serverRequest/resolved" => {
            if let Some(request_id) = params.get("requestId") {
                relay.remove_pending_approval(&normalize_id(request_id));
                changed = true;
            }
        }
        "error" => {
            if let Some(message) = value_at(&params, &["error", "message"]).and_then(Value::as_str)
            {
                relay.push_log("error", message.to_string());
                changed = true;
            }
        }
        "item/commandExecution/outputDelta" => {
            let route = thread_route(&relay, notification_thread_id.as_deref(), provider_key);
            if matches!(route, ThreadRoute::Drop) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let Some(delta) = string_at(&params, &["delta"]) {
                if let Some(item_id) =
                    string_at(&params, &["itemId"]).or_else(|| string_at(&params, &["item", "id"]))
                {
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_append_command_delta(
                            &bg_thread_id,
                            &item_id,
                            &delta,
                            crate::state::unix_now(),
                        );
                        changed = true;
                    } else {
                        relay.touch_progress(None, None);
                        let delta_len = delta.len();
                        let mutation = relay.append_command_delta(&item_id, &delta);
                        // The relay may have inserted a separating newline; clients must
                        // receive the text as appended, not the raw provider delta.
                        let wire_delta = mutation.wire_delta(&delta);
                        let thread_id = notification_thread_id
                            .clone()
                            .or_else(|| relay.active_thread_id.clone())
                            .unwrap_or_default();
                        trace!(
                            method,
                            thread_id = %thread_id,
                            item_id = %item_id,
                            delta_len,
                            pending_broker_messages = relay.pending_broker_messages.len() + 1,
                            "queued broker transcript delta"
                        );
                        relay.queue_broker_message(BrokerPendingMessage::TranscriptDelta(
                            PendingTranscriptDelta {
                                thread_id,
                                base_revision: mutation.base_revision,
                                revision: mutation.revision,
                                entry_seq: mutation.entry_seq,
                                server_time: mutation.server_time,
                                item_id,
                                turn_id: None,
                                delta: wire_delta,
                                kind: TranscriptDeltaKind::CommandOutput,
                                text_offset: mutation.text_offset,
                            },
                        ));
                        relay.push_log("command", delta);
                        changed = true;
                    }
                }
            }
        }
        "item/fileChange/outputDelta" => {
            if let Some(delta) = string_at(&params, &["delta"]) {
                relay.push_log("file_change", delta);
                changed = true;
            }
        }
        "item/commandExecution/terminalInteraction" => {
            if let Some(stdin) = string_at(&params, &["stdin"]) {
                relay.push_log(
                    "terminal",
                    format!("Command is requesting terminal input: {stdin}"),
                );
                changed = true;
            }
        }
        _ => {}
    }

    if changed {
        relay.notify();
    }
}

fn notification_thread_id(params: &Value) -> Option<String> {
    string_at(params, &["threadId"])
        .or_else(|| string_at(params, &["turn", "threadId"]))
        .or_else(|| string_at(params, &["item", "threadId"]))
}

fn observe_notification_cwd(relay: &mut RelayState, thread_id: Option<&str>, params: &Value) {
    let Some(thread_id) = thread_id.filter(|id| !id.is_empty()) else {
        return;
    };
    let settings_cwd = string_at(params, &["threadSettings", "cwd"]);
    let cwd = string_at(params, &["item", "cwd"])
        .or_else(|| string_at(params, &["cwd"]))
        .or_else(|| settings_cwd.clone());
    let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) else {
        return;
    };
    // Configured session cwd is restated on every settings update (model, sandbox).
    // Restating birth is not "went home" and must not wipe a command-proven worktree.
    if settings_cwd.as_deref() == Some(cwd.as_str()) {
        if relay.thread_cwd(thread_id).as_deref() == Some(cwd.as_str()) {
            return;
        }
    }
    relay.observe_thread_cwd(thread_id, &cwd);
}

fn is_session_notification_method(method: &str) -> bool {
    matches!(
        method,
        "turn/started"
            | "turn/completed"
            | "turn/diff/updated"
            | "item/started"
            | "item/agentMessage/delta"
            | "item/completed"
            | "item/commandExecution/outputDelta"
            | "item/fileChange/outputDelta"
            | "item/commandExecution/terminalInteraction"
    )
}

#[derive(Debug, Clone)]
enum ThreadRoute {
    /// Apply to the currently-active thread (current behavior).
    Active,
    /// Buffer for a background thread; the user is viewing something else.
    Background(String),
    /// No active thread at all — drop.
    Drop,
}

fn thread_route(relay: &RelayState, thread_id: Option<&str>, provider_key: &str) -> ThreadRoute {
    match (relay.active_thread_id.as_deref(), thread_id) {
        (None, None) => ThreadRoute::Active,
        (Some(active), None) if thread_belongs_to_provider(relay, active, provider_key) => {
            ThreadRoute::Active
        }
        (_, None) => ThreadRoute::Drop,
        (None, Some(_)) => ThreadRoute::Drop,
        (Some(active), Some(t)) if active == t => ThreadRoute::Active,
        (Some(_), Some(t)) => ThreadRoute::Background(t.to_string()),
    }
}

fn thread_belongs_to_provider(relay: &RelayState, thread_id: &str, provider_key: &str) -> bool {
    if let Some(thread) = relay.threads.iter().find(|thread| thread.id == thread_id) {
        return thread.provider == provider_key
            || thread.source == provider_key
            || thread.model_provider == provider_key;
    }

    relay.provider_name.is_empty() || relay.provider_name == provider_key
}

fn log_ignored_session_notification(method: &str, thread_id: Option<&str>, relay: &RelayState) {
    let transcript_entries = relay.snapshot().transcript.len();
    debug!(
        method,
        notification_thread_id = thread_id.unwrap_or("-"),
        active_thread_id = relay.active_thread_id.as_deref().unwrap_or("-"),
        active_turn_id = relay.active_turn_id.as_deref().unwrap_or("-"),
        transcript_entries,
        "ignored codex notification for non-active thread"
    );
}

#[cfg(test)]
mod disconnect_tests {
    use super::*;
    use crate::{protocol::ThreadSummaryView, state::SecurityProfile};
    use std::{collections::HashMap, process::Stdio};
    use tokio::{
        process::Command,
        sync::{watch, Mutex},
        time::{sleep, timeout},
    };

    #[tokio::test]
    async fn stdout_close_settles_codex_in_flight_turns() {
        let (change_tx, _) = watch::channel(0_u64);
        let mut relay = RelayState::new(
            "/tmp/project".to_string(),
            change_tx,
            SecurityProfile::private(),
        );
        let summary = ThreadSummaryView {
            workspace_trusted: false,
            id: "codex-thread".to_string(),
            name: None,
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "codex".to_string(),
            status: "active".to_string(),
            model_provider: "openai".to_string(),
            provider: "codex".to_string(),
            forked_from: None,
            renamed: false,
            flagged: false,
        };
        relay.upsert_thread(summary.clone());
        relay.bg_set_active_turn("codex-thread", Some("turn-1".to_string()), 1);
        relay.ensure_runtime_for_thread("codex-thread").summary = Some(summary);
        let state = Arc::new(RwLock::new(relay));

        let mut child = Command::new("sh")
            .args(["-c", "true"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn short-lived stdout");
        let stdout = child.stdout.take().expect("child stdout");
        let pending_responses = Arc::new(Mutex::new(HashMap::new()));
        spawn_stdout_reader(stdout, pending_responses, state.clone(), "codex");
        child.wait().await.expect("child exits");

        timeout(Duration::from_secs(2), async {
            loop {
                if state
                    .read()
                    .await
                    .runtime_for_thread("codex-thread")
                    .and_then(|runtime| runtime.active_turn_id.as_deref())
                    .is_none()
                {
                    break;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("stdout close should settle the turn");
    }
}
