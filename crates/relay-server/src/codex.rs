use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::{atomic::AtomicU64, Arc},
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex, RwLock},
};

use async_trait::async_trait;

use crate::{
    codex_local::{
        delete_thread_permanently as delete_thread_permanently_local, LocalThreadDeleteSummary,
    },
    protocol::{
        truncate_with_ellipsis, ApprovalDecisionInput, FileChangeDiffView, ModelOptionView,
        ThreadSummaryView, ToolCallView, TranscriptEntryKind, TranscriptEntryView,
    },
    provider::{
        user_message_transcript_text, ProviderBridge, ProviderForkCapability, ProviderForkRequest,
        ProviderImage, StartThreadRequest, StartThreadResult, ThreadSyncData,
    },
    state::{ApprovalKind, PendingApproval, RelayState, TurnFailureKind},
};

mod rpc;

use rpc::{spawn_stderr_reader, spawn_stdout_reader};

#[cfg(test)]
use rpc::{handle_notification, handle_server_request};

#[cfg(test)]
mod tests;

type PendingResponses = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

const MAX_COMMAND_TEXT_CHARS: usize = 240;
const MAX_COMMAND_OUTPUT_CHARS: usize = 1_024;
const MAX_COMMAND_ENTRY_CHARS: usize = 1_400;
const MAX_TOOL_SUMMARY_CHARS: usize = 240;
const MAX_TOOL_FIELD_CHARS: usize = 240;
const MAX_TOOL_JSON_CHARS: usize = 512;
const MAX_TOOL_ENTRY_CHARS: usize = 1_400;
const MAX_APPROVAL_SUMMARY_CHARS: usize = 120;
const MAX_APPROVAL_CONTEXT_CHARS: usize = 1_200;
// Preserve the 30 seconds one thread/list request had before pagination while
// bounding the whole scan to that same budget instead of multiplying it by pages.
const CODEX_THREAD_LIST_TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
// A second backstop for a server that keeps advancing the cursor without ever
// producing new rows. Matches the equivalent ACP session-list guard.
const MAX_CODEX_THREAD_LIST_PAGES: usize = 50;

fn thread_list_timeout_error(timeout: Duration) -> String {
    format!(
        "Codex thread/list pagination exceeded its {} ms total timeout",
        timeout.as_millis()
    )
}

pub struct CodexBridge {
    _child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending_responses: PendingResponses,
    next_request_id: AtomicU64,
    state: Arc<RwLock<RelayState>>,
    provider_name: &'static str,
}

#[async_trait]
impl ProviderBridge for CodexBridge {
    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        self.list_threads(limit).await
    }

    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        self.list_models().await
    }

    /// `system_prompt` is IGNORED. The app-server's `thread/start` takes only
    /// cwd / model / approvalPolicy / sandbox / personality — there is no
    /// instruction surface, and `~/.codex/config.toml` is process-global while
    /// one app-server serves every thread, so it could not be scoped to this one
    /// anyway. Smuggling the persona in as a user turn is deliberately not done:
    /// see `StartThreadRequest::system_prompt`.
    async fn start_thread(&self, request: StartThreadRequest) -> Result<StartThreadResult, String> {
        let thread = self
            .start_thread(
                &request.cwd,
                &request.model,
                &request.approval_policy,
                &request.sandbox,
            )
            .await?;
        Ok(StartThreadResult {
            thread,
            consumed_initial_prompt: false,
            initial_user_message: None,
            started_turn_id: None,
        })
    }

    async fn fork_thread(
        &self,
        request: ProviderForkRequest,
    ) -> Result<Option<StartThreadResult>, String> {
        // `thread/fork` always branches at the thread tip. Forking from an
        // earlier message has to go through transcript replay, which can
        // truncate at the requested item.
        if request.up_to_item_id.is_some() {
            return Ok(None);
        }
        let thread = CodexBridge::fork_thread(self, request).await?;
        Ok(Some(StartThreadResult {
            thread,
            consumed_initial_prompt: false,
            initial_user_message: None,
            started_turn_id: None,
        }))
    }

    // `thread/fork` always branches at the tip; a mid-thread branch falls back
    // to replay in `fork_thread` above.
    fn fork_capability(&self) -> ProviderForkCapability {
        ProviderForkCapability::NATIVE_TIP_ONLY
    }

    // `thread/archive` is a real app-server method: Codex moves the rollout into
    // `archived_sessions`, so the thread stops coming back from `list_threads`.
    fn supports_archive(&self) -> bool {
        true
    }

    async fn resume_thread(
        &self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String> {
        self.resume_thread(thread_id, approval_policy, sandbox)
            .await
    }

    async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String> {
        self.read_thread(thread_id).await
    }

    async fn read_thread_entry_detail(
        &self,
        thread_id: &str,
        item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        self.read_thread_entry_detail(thread_id, item_id).await
    }

    async fn archive_thread(&self, thread_id: &str) -> Result<(), String> {
        self.archive_thread(thread_id).await
    }

    async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        self.delete_thread_permanently(thread_id).await
    }

    async fn start_turn(
        &self,
        thread_id: &str,
        text: &str,
        model: &str,
        effort: &str,
        images: &[ProviderImage],
    ) -> Result<Option<String>, String> {
        if images.is_empty() {
            CodexBridge::start_turn(self, thread_id, text, model, effort).await
        } else {
            self.start_turn_with_images(thread_id, text, model, effort, images)
                .await
        }
    }

    async fn request_turn_stop(
        &self,
        thread_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), String> {
        let turn_id =
            turn_id.ok_or_else(|| "Codex requires a turn id to stop a turn".to_string())?;
        self.interrupt_turn(thread_id, turn_id).await
    }

    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        self.respond_to_approval(pending, input).await
    }

    async fn respond_to_ask_user_question(
        &self,
        _request_id: &str,
        _answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        // Codex does not surface AskUserQuestion through its bridge — the
        // tool is Claude-specific. Returning an error keeps callers honest
        // rather than swallowing a misrouted request.
        Err("Codex does not support AskUserQuestion".to_string())
    }

    fn provider_name(&self) -> &'static str {
        self.provider_name
    }
}

// Turn `codex mcp list --json` output into operator log lines. Codex's
// app-server does NOT expose runtime MCP connection status (verified by probing
// the real app-server: the initialize response and startup notifications carry
// no MCP data), so this config-level view — which servers are configured and
// whether each is enabled — is the only structured MCP signal the relay can
// surface. Runtime failures, if codex prints them, arrive via its forwarded
// stderr. Returns Err on unparseable JSON; Ok(vec![]) when nothing is configured.
fn summarize_codex_mcp_servers(json: &str) -> Result<Vec<String>, String> {
    let servers: Vec<Value> = serde_json::from_str(json).map_err(|error| error.to_string())?;
    if servers.is_empty() {
        return Ok(vec![]);
    }
    let mut enabled: Vec<String> = Vec::new();
    let mut disabled: Vec<String> = Vec::new();
    for server in &servers {
        let name = server.get("name").and_then(Value::as_str).unwrap_or("?");
        if server
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            enabled.push(name.to_string());
        } else {
            match server.get("disabled_reason").and_then(Value::as_str) {
                Some(reason) => disabled.push(format!("{name} ({reason})")),
                None => disabled.push(name.to_string()),
            }
        }
    }
    let mut lines = vec![format!(
        "MCP: {} configured ({} enabled, {} disabled)",
        servers.len(),
        enabled.len(),
        disabled.len()
    )];
    if !enabled.is_empty() {
        lines.push(format!("MCP enabled: {}", enabled.join(", ")));
    }
    if !disabled.is_empty() {
        lines.push(format!("MCP disabled: {}", disabled.join(", ")));
    }
    Ok(lines)
}

// Run `codex mcp list --json` (bounded by `timeout`) and turn it into operator
// log lines. Best-effort: a spawn failure, timeout, non-zero exit, or
// unparseable output produces a note (or nothing) rather than an error.
// `kill_on_drop(true)` matters: on Tokio, cancelling `output()` at the timeout
// only stops awaiting — without it a genuinely hung CLI keeps running as an
// orphan. With it, the child is killed and reaped when the future is dropped.
async fn collect_codex_mcp_lines(binary_name: &str, timeout: Duration) -> Vec<String> {
    let mut command = Command::new(crate::provider::resolve_binary(binary_name));
    command
        .arg("mcp")
        .arg("list")
        .arg("--json")
        .kill_on_drop(true);

    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            match summarize_codex_mcp_servers(&String::from_utf8_lossy(&output.stdout)) {
                Ok(lines) => lines,
                Err(error) => vec![format!("MCP: could not parse `mcp list` output: {error}")],
            }
        }
        // Non-zero exit: `mcp list` unsupported or errored — stay quiet rather than noisy.
        Ok(Ok(_)) => vec![],
        Ok(Err(error)) => vec![format!(
            "MCP: could not run `{binary_name} mcp list`: {error}"
        )],
        // Timed out: `command.output()` is dropped here → kill_on_drop kills+reaps the child.
        Err(_) => vec![format!("MCP: `{binary_name} mcp list` timed out")],
    }
}

// Push the configured-MCP summary into the relay log panel. Spawned off the
// provider-startup critical path (see the `tokio::spawn` call site), so a slow
// or hung `codex mcp list` never delays bridge creation or later providers.
async fn log_codex_mcp_config(binary_name: &'static str, state: Arc<RwLock<RelayState>>) {
    let lines = collect_codex_mcp_lines(binary_name, Duration::from_secs(5)).await;
    if lines.is_empty() {
        return;
    }
    let mut relay = state.write().await;
    for line in lines {
        relay.push_log("codex", line);
    }
    relay.notify();
}

impl CodexBridge {
    pub async fn spawn(
        state: Arc<RwLock<RelayState>>,
        binary_name: &'static str,
        display_name: &'static str,
        provider_key: &'static str,
    ) -> Result<Self, String> {
        // Resolved, not bare — see `provider::resolve_binary`. The error text
        // below stays bare: it names a command for a human to run.
        let mut command = Command::new(crate::provider::resolve_binary(binary_name));
        command
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start `{binary_name} app-server`: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("failed to capture {binary_name} stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("failed to capture {binary_name} stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("failed to capture {binary_name} stderr"))?;

        let child = Arc::new(Mutex::new(child));
        let pending_responses = Arc::new(Mutex::new(HashMap::new()));

        spawn_stdout_reader(
            stdout,
            pending_responses.clone(),
            state.clone(),
            provider_key,
        );
        spawn_stderr_reader(stderr, state.clone());

        let bridge = Self {
            _child: child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending_responses,
            next_request_id: AtomicU64::new(1),
            state,
            provider_name: provider_key,
        };

        bridge.initialize().await?;
        {
            let mut relay = bridge.state.write().await;
            relay.set_provider_connection(provider_key, true);
            relay.push_log("info", format!("Connected to {display_name} app-server."));
            relay.notify();
        }

        // Surface the configured MCP servers (enabled/disabled) once at startup.
        // Codex's app-server reports no runtime MCP status, so this is the only
        // structured MCP visibility available on the codex side. Run it in the
        // background: it's a diagnostic, and awaiting it here would delay this
        // bridge (and, since providers start sequentially, later ones + the HTTP
        // listener) by up to the probe timeout if the CLI hangs.
        tokio::spawn(log_codex_mcp_config(binary_name, bridge.state.clone()));

        Ok(bridge)
    }

    pub async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        self.list_threads_with_limits(
            limit,
            CODEX_THREAD_LIST_TOTAL_TIMEOUT,
            MAX_CODEX_THREAD_LIST_PAGES,
        )
        .await
    }

    #[cfg(test)]
    async fn list_threads_with_timeout(
        &self,
        limit: usize,
        total_timeout: Duration,
    ) -> Result<Vec<ThreadSummaryView>, String> {
        self.list_threads_with_limits(limit, total_timeout, MAX_CODEX_THREAD_LIST_PAGES)
            .await
    }

    async fn list_threads_with_limits(
        &self,
        limit: usize,
        total_timeout: Duration,
        max_pages: usize,
    ) -> Result<Vec<ThreadSummaryView>, String> {
        // `limit` is the number the relay wants to SCAN, not Codex's page size. The
        // app-server caps one response at 100 rows and returns `nextCursor` even when a
        // larger limit was requested, so a single request silently loses older sessions.
        let mut threads = Vec::new();
        let mut seen_thread_ids = HashSet::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        let deadline = tokio::time::Instant::now() + total_timeout;

        while threads.len() < limit {
            if pages >= max_pages {
                return Err(format!(
                    "Codex thread/list pagination exceeded its {max_pages}-page limit"
                ));
            }
            pages += 1;
            let remaining = limit - threads.len();
            let request_timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
            if request_timeout.is_zero() {
                return Err(thread_list_timeout_error(total_timeout));
            }
            let result = self
                .send_request_with_timeout(
                    "thread/list",
                    json!({
                        "cursor": cursor,
                        "limit": remaining,
                        "archived": false
                    }),
                    request_timeout,
                )
                .await
                .map_err(|error| {
                    if error == "Codex app-server timed out waiting for `thread/list`"
                        && tokio::time::Instant::now() >= deadline
                    {
                        thread_list_timeout_error(total_timeout)
                    } else {
                        error
                    }
                })?;
            let page = value_at(&result, &["data"])
                .and_then(Value::as_array)
                .ok_or_else(|| "thread/list did not return a thread array".to_string())?;

            for thread in page {
                let thread = parse_thread_summary(thread)?;
                if !seen_thread_ids.insert(thread.id.clone()) {
                    continue;
                }
                threads.push(thread);
                if threads.len() == limit {
                    break;
                }
            }

            let next_cursor = value_at(&result, &["nextCursor"])
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            // An empty page may still be an intermediate filtered page. Keep going
            // whenever the opaque cursor advances; the page/deadline guards above
            // bound a broken server that produces empty pages forever.
            if next_cursor.is_none() || next_cursor == cursor {
                break;
            }
            cursor = next_cursor;
        }

        Ok(threads)
    }

    pub async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let result = self
                .send_request(
                    "model/list",
                    json!({
                        "cursor": cursor,
                        "includeHidden": true,
                        "limit": 100
                    }),
                )
                .await?;

            let data = value_at(&result, &["data"])
                .and_then(Value::as_array)
                .ok_or_else(|| "model/list did not return a model array".to_string())?;

            for model in data {
                let parsed = parse_model_option(model)?;
                if parsed.provider.is_empty() || parsed.provider == self.provider_name {
                    models.push(parsed);
                }
            }

            cursor = value_at(&result, &["nextCursor"])
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);

            if cursor.is_none() {
                break;
            }
        }

        Ok(models)
    }

    pub async fn start_thread(
        &self,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<ThreadSummaryView, String> {
        let (approval_policy, sandbox) = resolve_codex_policy(approval_policy, sandbox);
        let result = self
            .send_request(
                "thread/start",
                json!({
                    "cwd": cwd,
                    "model": model,
                    "approvalPolicy": approval_policy,
                    "sandbox": sandbox,
                    "personality": "pragmatic"
                }),
            )
            .await?;

        let thread = value_at(&result, &["thread"])
            .ok_or_else(|| "thread/start did not return a thread".to_string())?;

        parse_thread_summary(thread)
    }

    pub async fn fork_thread(
        &self,
        request: ProviderForkRequest,
    ) -> Result<ThreadSummaryView, String> {
        let (approval_policy, sandbox) =
            resolve_codex_policy(&request.approval_policy, &request.sandbox);
        let result = self
            .send_request(
                "thread/fork",
                json!({
                    "threadId": request.source_thread_id,
                    "cwd": request.cwd,
                    "model": request.model,
                    "approvalPolicy": approval_policy,
                    "sandbox": sandbox,
                    "threadSource": "agent-relay"
                }),
            )
            .await?;

        let thread = value_at(&result, &["thread"])
            .ok_or_else(|| "thread/fork did not return a thread".to_string())?;
        let mut summary = parse_thread_summary(thread)?;
        summary.provider = self.provider_name.to_string();
        if summary.source.is_empty() || summary.source == "unknown" {
            summary.source = self.provider_name.to_string();
        }
        Ok(summary)
    }

    pub async fn resume_thread(
        &self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String> {
        let (approval_policy, sandbox) = resolve_codex_policy(approval_policy, sandbox);
        self.send_request(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "approvalPolicy": approval_policy,
                "sandbox": sandbox,
                "personality": "pragmatic"
            }),
        )
        .await
        .map(|_| ())
    }

    pub async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String> {
        let result = self
            .send_request(
                "thread/read",
                json!({
                    "threadId": thread_id,
                    "includeTurns": true
                }),
            )
            .await?;

        let thread = value_at(&result, &["thread"])
            .ok_or_else(|| "thread/read did not return a thread".to_string())?;
        let summary = parse_thread_summary(thread)?;
        let (status, active_flags) = parse_status(value_at(thread, &["status"]));

        Ok(ThreadSyncData {
            thread: summary,
            status,
            active_flags,
            transcript: parse_transcript(thread),
        })
    }

    pub async fn read_thread_entry_detail(
        &self,
        thread_id: &str,
        item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        let result = self
            .send_request(
                "thread/read",
                json!({
                    "threadId": thread_id,
                    "includeTurns": true
                }),
            )
            .await?;

        let thread = value_at(&result, &["thread"])
            .ok_or_else(|| "thread/read did not return a thread".to_string())?;
        let turns = value_at(thread, &["turns"])
            .and_then(Value::as_array)
            .ok_or_else(|| "thread/read did not return transcript turns".to_string())?;

        for turn in turns {
            let turn_id = string_at(turn, &["id"]);
            let items = match value_at(turn, &["items"]).and_then(Value::as_array) {
                Some(items) => items,
                None => continue,
            };

            for item in items {
                if string_at(item, &["id"]).as_deref() != Some(item_id) {
                    continue;
                }
                return Ok(parse_transcript_detail_item(
                    item,
                    turn_id.clone(),
                    "completed",
                ));
            }
        }

        Ok(None)
    }

    pub async fn archive_thread(&self, thread_id: &str) -> Result<(), String> {
        self.send_request("thread/archive", json!({ "threadId": thread_id }))
            .await
            .map(|_| ())
    }

    pub async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        let thread_id = thread_id.to_string();
        tokio::task::spawn_blocking(move || delete_thread_permanently_local(&thread_id))
            .await
            .map_err(|error| format!("failed to join local Codex delete task: {error}"))?
    }

    pub async fn start_turn(
        &self,
        thread_id: &str,
        text: &str,
        model: &str,
        effort: &str,
    ) -> Result<Option<String>, String> {
        self.start_turn_with_images(thread_id, text, model, effort, &[])
            .await
    }

    pub async fn start_turn_with_images(
        &self,
        thread_id: &str,
        text: &str,
        model: &str,
        effort: &str,
        images: &[ProviderImage],
    ) -> Result<Option<String>, String> {
        // Re-read the thread's CURRENT settings so every turn re-asserts its
        // approval policy + sandbox (see `codex_turn_start_params`). Fall back to
        // no override only when the relay has no record — codex then keeps
        // whatever policy `thread/start` / `thread/resume` last bound.
        let policy = {
            let relay = self.state.read().await;
            relay
                .remembered_thread_settings(thread_id)
                .map(|settings| (settings.approval_policy, settings.sandbox))
        };
        let policy = policy
            .as_ref()
            .map(|(approval, sandbox)| (approval.as_str(), sandbox.as_str()));
        let params = if images.is_empty() {
            codex_turn_start_params(thread_id, text, model, effort, policy)
        } else {
            codex_turn_start_params_with_images(thread_id, text, model, effort, images, policy)
        };
        let result = match self.send_request("turn/start", params.clone()).await {
            Ok(result) => result,
            // The thread exists on disk but was never materialized in the
            // app-server WE spawned — a thread created by the Codex VSCode
            // extension / CLI, or any thread left over from a previous relay
            // process. Codex serves its history from disk (so the relay hydrated
            // a runtime and rendered the transcript happily) but rejects
            // `turn/start` for it, which surfaced as a 400 "can't send at all".
            //
            // Materialize it here, on the provider that actually owns the gap.
            // The send path deliberately does NOT resume: 1084b0a decoupled
            // viewing from control, and the take-over resume it removed had the
            // side effect of displacing the active thread's controller. Healing
            // in the bridge restores turn-startability with none of the
            // take-over semantics, and — because it keys off codex's own error
            // rather than relay-side bookkeeping — it also covers the case where
            // the relay HAS a hydrated runtime but codex still has no handle.
            Err(error) if is_thread_not_loaded_error(&error) => {
                // Resume binds the approval policy + sandbox, so a thread the
                // relay has no settings for forces a choice. Refusing to resume
                // it (the old behavior) made every such thread PERMANENTLY
                // unsendable — and those are ordinary threads: anything created
                // by the Codex VSCode extension / CLI, or predating this relay
                // process. The user's read is "codex just won't take a message".
                //
                // So heal, but never upward: fall back to the strictest policy
                // the protocol has rather than to anything inherited or
                // configured. Guessing PERMISSIVELY is what had to stay
                // impossible — a read-only sandbox with escalation on anything
                // outside codex's trusted-command set can only narrow what the
                // turn may do, and the user can widen it deliberately from the
                // composer's settings.
                let (approval_policy, sandbox) =
                    policy.unwrap_or((STRICTEST_APPROVAL_POLICY, STRICTEST_SANDBOX));
                let invented = policy.is_none();
                if let Err(resume_error) = self
                    .resume_thread(thread_id, approval_policy, sandbox)
                    .await
                {
                    let mut relay = self.state.write().await;
                    relay.push_log(
                        "warn",
                        format!(
                            "Could not resume thread {thread_id} to recover from `{error}`: {resume_error}"
                        ),
                    );
                    relay.notify();
                    return Err(error);
                }
                if invented {
                    // Record what codex was actually told. Without this the UI
                    // keeps showing the permissive values the runtime was
                    // hydrated with while the thread runs locked down, so the
                    // approval prompts that follow have no visible cause — and
                    // the next turn would re-invent the policy all over again.
                    let mut relay = self.state.write().await;
                    relay.remember_thread_settings(
                        thread_id,
                        approval_policy,
                        sandbox,
                        effort,
                        model,
                    );
                    relay.push_log(
                        "warn",
                        format!(
                            "Thread {thread_id} had no saved permissions, so it was resumed \
read-only with approvals required. Change File access if this turn needs to write."
                        ),
                    );
                    relay.notify();
                }
                // The retry must re-assert the policy the resume just bound:
                // `params` was built before the fallback existed, so a thread
                // with no remembered settings would otherwise send a turn with
                // no override at all and drift back to codex's own config
                // default — the exact silent widening this path exists to avoid.
                let params = if invented {
                    let policy = Some((approval_policy, sandbox));
                    if images.is_empty() {
                        codex_turn_start_params(thread_id, text, model, effort, policy)
                    } else {
                        codex_turn_start_params_with_images(
                            thread_id, text, model, effort, images, policy,
                        )
                    }
                } else {
                    params
                };
                self.send_request("turn/start", params).await?
            }
            Err(error) => return Err(error),
        };

        Ok(value_at(&result, &["turn", "id"])
            .and_then(Value::as_str)
            .map(ToOwned::to_owned))
    }

    pub async fn interrupt_turn(&self, thread_id: &str, turn_id: &str) -> Result<(), String> {
        self.send_request(
            "turn/interrupt",
            json!({
                "threadId": thread_id,
                "turnId": turn_id
            }),
        )
        .await
        .map(|_| ())
    }

    pub async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        self.send_json(json!({
            "id": pending.raw_request_id,
            "result": pending.decision_payload(input),
        }))
        .await
    }
}

/// The policy the bridge binds when it has to resume a thread it knows nothing
/// about (see the heal in `start_turn_with_images`). Deliberately the most
/// restrictive pair codex accepts, so recovering a thread can never hand it
/// access the user did not choose. In codex's own words: `untrusted` = "Only
/// run 'trusted' commands (e.g. ls, cat, sed) without asking for user approval.
/// Will escalate to the user if the model proposes a command that is not in the
/// 'trusted' set", and `read-only` = "Codex can read files in the current
/// workspace. Approval is required to edit files or access the internet."
///
/// Both are codex vocabulary (`AskForApproval` / `SandboxMode`); anything
/// outside those enums is rejected by the app-server before it even looks the
/// thread up, so this fallback must never drift to a relay-level word.
const STRICTEST_APPROVAL_POLICY: &str = "untrusted";
const STRICTEST_SANDBOX: &str = "read-only";

/// Does this `turn/start` failure mean "codex has no live handle for this
/// thread" (as opposed to a genuine turn error)? Codex serves `thread/read` off
/// disk but only accepts `turn/start` for a thread that `thread/start` /
/// `thread/resume` materialized in THIS app-server process, and reports the gap
/// as `thread not found: <id>`.
fn is_thread_not_loaded_error(error: &str) -> bool {
    error.to_ascii_lowercase().contains("thread not found")
}

/// Translate the relay-level approval_policy + sandbox pair into the
/// concrete values codex's app-server expects. Today only one relay-level
/// value needs reshaping: `"bypass"` is the unified YOLO knob and maps to
/// codex's `approvalPolicy=never` + `sandbox=danger-full-access` combo
/// regardless of what sandbox the user previously had selected.
fn resolve_codex_policy<'a>(approval_policy: &'a str, sandbox: &'a str) -> (&'a str, &'a str) {
    if approval_policy == "bypass" {
        ("never", "danger-full-access")
    } else {
        (approval_policy, sandbox)
    }
}

/// Build the `turn/start` params for codex. Beyond the message input, this
/// re-asserts the thread's *current* (resolved) approval policy on EVERY turn.
/// Codex only binds the approval policy at `thread/start` / `thread/resume`, so a
/// turn that reaches an app-server which never resumed this thread — after a
/// relay restart, on a background thread, or via a plain `send` that skips the
/// resume — otherwise falls back to codex's own config default and starts
/// prompting, defeating YOLO. Mirrors Claude's per-turn `permissionMode`.
fn codex_turn_start_params(
    thread_id: &str,
    text: &str,
    model: &str,
    effort: &str,
    policy: Option<(&str, &str)>,
) -> Value {
    codex_turn_start_params_with_images(thread_id, text, model, effort, &[], policy)
}

fn codex_turn_start_params_with_images(
    thread_id: &str,
    text: &str,
    model: &str,
    effort: &str,
    images: &[ProviderImage],
    policy: Option<(&str, &str)>,
) -> Value {
    let mut input = images
        .iter()
        .map(|image| {
            json!({
                "type": "image",
                "url": image.data_url(),
            })
        })
        .collect::<Vec<_>>();
    if !text.is_empty() {
        input.push(json!({
            "type": "text",
            "text": text,
        }));
    }

    let mut params = json!({
        "threadId": thread_id,
        "model": model,
        "effort": effort,
        "input": input
    });

    if let Some((approval_policy, sandbox)) = policy {
        let (approval_policy, sandbox) = resolve_codex_policy(approval_policy, sandbox);
        let object = params
            .as_object_mut()
            .expect("turn/start params is a json object");
        // `AskForApproval` is the same shape codex accepts on turn/start, so the
        // resolved policy string ("never", "on-request", …) rides through as-is.
        object.insert("approvalPolicy".to_string(), json!(approval_policy));
        // Codex's turn-level sandbox override is the structured `SandboxPolicy`,
        // not the `SandboxMode` string used by thread/start. We only re-assert the
        // two policies that have no config-derived fields to preserve, so a
        // fresh/unloaded thread (relay restart, background thread, or a send that
        // skips resume) can't drift to codex's default sandbox:
        //   • `danger-full-access` — YOLO: the whole point is "no restrictions".
        //   • `read-only` — a deliberate lockdown; its structured form carries no
        //     writableRoots, and network stays off (the restrictive direction).
        // `workspace-write` is intentionally left to the mode bound at
        // thread/start & thread/resume: reconstructing its `writableRoots` /
        // network access from config would clobber what codex derived, and its
        // default fallback is equivalently permissive anyway.
        match sandbox {
            "danger-full-access" => {
                object.insert(
                    "sandboxPolicy".to_string(),
                    json!({ "type": "dangerFullAccess" }),
                );
            }
            "read-only" => {
                object.insert(
                    "sandboxPolicy".to_string(),
                    json!({ "type": "readOnly", "networkAccess": false }),
                );
            }
            _ => {}
        }
    }

    params
}

fn parse_thread_summary(thread: &Value) -> Result<ThreadSummaryView, String> {
    Ok(ThreadSummaryView {
        workspace_trusted: false,
        id: string_at(thread, &["id"]).ok_or_else(|| "thread id is missing".to_string())?,
        name: string_at(thread, &["name"]),
        preview: string_at(thread, &["preview"]).unwrap_or_default(),
        cwd: string_at(thread, &["cwd"]).unwrap_or_default(),
        updated_at: value_at(thread, &["updatedAt"])
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        source: string_at(thread, &["source"]).unwrap_or_else(|| "unknown".to_string()),
        status: parse_status(value_at(thread, &["status"])).0,
        model_provider: string_at(thread, &["modelProvider"])
            .unwrap_or_else(|| "unknown".to_string()),
        provider: String::new(),
        forked_from: None,
        renamed: false,
    })
}

fn parse_model_option(model: &Value) -> Result<ModelOptionView, String> {
    let supported_reasoning_efforts = value_at(model, &["supportedReasoningEfforts"])
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| value_at(item, &["reasoningEffort"]).and_then(Value::as_str))
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(ModelOptionView {
        model: string_at(model, &["model"])
            .ok_or_else(|| "model/list item missing model".to_string())?,
        display_name: string_at(model, &["displayName"])
            .ok_or_else(|| "model/list item missing displayName".to_string())?,
        provider: string_at(model, &["provider"])
            .unwrap_or_default()
            .to_string(),
        supported_reasoning_efforts,
        default_reasoning_effort: string_at(model, &["defaultReasoningEffort"])
            .ok_or_else(|| "model/list item missing defaultReasoningEffort".to_string())?,
        hidden: bool_at(model, &["hidden"]).unwrap_or(false),
        is_default: bool_at(model, &["isDefault"]).unwrap_or(false),
    })
}

/// Stable per-turn id for the synthetic failure entry so that a re-delivered
/// live completion OR a rehydrated history turn upserts (never duplicates) the
/// same entry. Mirrors the Claude path (`turn-error:<turn_id>`), so both
/// providers share the frontend's `ErrorEntry` renderer.
pub(crate) fn codex_turn_error_item_id(turn_id: Option<&str>) -> String {
    format!("turn-error:{}", turn_id.unwrap_or("unknown"))
}

/// Map codex's `codexErrorInfo` (the app-server `CodexErrorInfo` enum,
/// `#[serde(rename_all = "camelCase")]`) to a bounded, user-facing label. On the
/// wire, unit variants arrive as a bare camelCase string
/// (`"usageLimitExceeded"`) and data-carrying variants as an externally-tagged
/// single-key object (`{"httpConnectionFailed":{"httpStatusCode":503}}`). This
/// closed classification is the ONLY provider-derived text safe to surface
/// cross-device — the failure entry rides broker-bound snapshots to every paired
/// device, so it must stay subtype-only, never free-form model/conversation
/// content. Returns `None` for `other` or any unknown/future variant so the
/// caller falls back to a generic bounded reason (NEVER the raw `error.message`).
pub(crate) fn codex_error_info_label(info: &Value) -> Option<String> {
    let (variant, http_status) = match info {
        Value::String(variant) => (variant.as_str(), None),
        Value::Object(map) => {
            let (variant, data) = map.iter().next()?;
            (
                variant.as_str(),
                data.get("httpStatusCode").and_then(Value::as_u64),
            )
        }
        _ => return None,
    };
    let base = match variant {
        "usageLimitExceeded" => "Usage limit reached",
        "sessionBudgetExceeded" => "Session budget exhausted",
        "contextWindowExceeded" => "The context window was exceeded",
        "serverOverloaded" => "The model provider is overloaded",
        "cyberPolicy" => "Blocked by the provider's safety policy",
        "unauthorized" => "Authentication failed",
        "badRequest" => "The request was rejected",
        "internalServerError" => "The model provider had an internal error",
        "threadRollbackFailed" => "Thread rollback failed",
        "sandboxError" => "A sandbox error occurred",
        "httpConnectionFailed" | "responseStreamConnectionFailed" => {
            "The connection to the model failed"
        }
        "responseStreamDisconnected" => "The model stream disconnected mid-turn",
        "responseTooManyFailedAttempts" => "The model failed after repeated attempts",
        "activeTurnNotSteerable" => "The active turn could not be steered",
        // "other" and any unknown/future variant fall through to a generic,
        // bounded reason in the caller — never the raw provider message.
        _ => return None,
    };
    Some(match http_status {
        Some(code) => format!("{base} (HTTP {code})"),
        None => base.to_string(),
    })
}

/// Derive a BOUNDED failure reason from a codex `turn` object (a live
/// `turn/completed` payload's `turn`, or a rehydrated history turn), or `None`
/// if the turn did not fail. A turn is failed when `status == "failed"` OR it
/// carries a non-null `error` (codex only populates `error` on failure). The
/// reason is ALWAYS bounded: the closed `codexErrorInfo` label, or a generic
/// notice. The raw `error.message` is deliberately NEVER surfaced here — this
/// text rides broker-bound snapshots to every paired device and must remain
/// subtype-only (see `TranscriptEntryKind::Error`). The live handler logs the
/// raw message separately, operator-only.
pub(crate) fn codex_turn_failure_reason(turn: &Value) -> Option<String> {
    let status = value_at(turn, &["status"]).and_then(Value::as_str);
    let error = value_at(turn, &["error"]).filter(|error| !error.is_null());
    let failed = status == Some("failed") || error.is_some();
    if !failed {
        return None;
    }
    let label = error
        .and_then(|error| value_at(error, &["codexErrorInfo"]))
        .and_then(codex_error_info_label);
    Some(label.unwrap_or_else(|| "The turn ended with an error.".to_string()))
}

/// Map codex's `codexErrorInfo` onto the shared [`TurnFailureKind`]. Codex's two
/// session limits classify; every other variant — `serverOverloaded` included —
/// yields `None` and stays an ordinary failure. The enum's table says why each
/// omission is deliberate.
pub(crate) fn codex_error_info_kind(info: &Value) -> Option<TurnFailureKind> {
    let variant = match info {
        Value::String(variant) => variant.as_str(),
        Value::Object(map) => map.keys().next()?.as_str(),
        _ => return None,
    };
    match variant {
        "usageLimitExceeded" | "sessionBudgetExceeded" => Some(TurnFailureKind::UsageLimit),
        _ => None,
    }
}

/// Companion to `codex_turn_failure_reason`: the same `turn` object's closed
/// failure kind, or `None` if unfailed/unclassified.
pub(crate) fn codex_turn_failure_kind(turn: &Value) -> Option<TurnFailureKind> {
    let error = value_at(turn, &["error"]).filter(|error| !error.is_null())?;
    value_at(error, &["codexErrorInfo"]).and_then(codex_error_info_kind)
}

fn parse_transcript(thread: &Value) -> Vec<TranscriptEntryView> {
    let mut transcript = Vec::new();
    let turns = match value_at(thread, &["turns"]).and_then(Value::as_array) {
        Some(turns) => turns,
        None => return transcript,
    };

    for turn in turns {
        let turn_id = string_at(turn, &["id"]);
        let items = match value_at(turn, &["items"]).and_then(Value::as_array) {
            Some(items) => items,
            None => continue,
        };

        for item in items {
            if let Some(entry) = parse_transcript_item(item, turn_id.clone(), "completed") {
                transcript.push(entry);
            }
        }

        if let Some(entry) = build_turn_file_summary(turn_id.clone(), items) {
            transcript.push(entry);
        }

        // Re-synthesize the failed-turn entry on rehydrate: persisted history
        // carries per-turn `status`/`error`, so a failure that happened before a
        // relay restart stays visible IN THE TRANSCRIPT (not just as a lost live
        // push). Same stable id as the live path, so no duplication when both run.
        if let Some(reason) = codex_turn_failure_reason(turn) {
            transcript.push(TranscriptEntryView {
                item_id: Some(codex_turn_error_item_id(turn_id.as_deref())),
                kind: TranscriptEntryKind::Error,
                text: Some(reason),
                status: "failed".to_string(),
                turn_id: turn_id.clone(),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::default(),
            });
        }
    }

    transcript
}

fn refresh_turn_diff_entry(relay: &mut RelayState, turn_id: &str) -> bool {
    let turn_diff_item_id = format!("turn-diff:{turn_id}");
    let existing_entry = relay
        .snapshot()
        .transcript
        .into_iter()
        .find(|entry| entry.item_id.as_deref() == Some(turn_diff_item_id.as_str()));
    let Some(existing_entry) = existing_entry else {
        return false;
    };
    let Some(existing_tool) = existing_entry.tool else {
        return false;
    };

    let fallback_file_changes = relay.turn_file_change_summary(turn_id);
    let entry = build_turn_diff_entry_with_fallback(
        turn_id.to_string(),
        existing_tool.diff,
        &existing_entry.status,
        fallback_file_changes,
        "Codex",
    );
    let Some(item_id) = entry.item_id.clone() else {
        return false;
    };
    relay.upsert_transcript_item(
        item_id,
        entry.kind,
        entry.text,
        entry.status,
        entry.turn_id,
        entry.tool,
    );
    true
}

fn upsert_transcript_item_from_value(
    relay: &mut RelayState,
    item: Option<&Value>,
    turn_id: Option<String>,
    default_status: &str,
) -> bool {
    let Some(item) = item else {
        return false;
    };
    let refresh_turn_id = (string_at(item, &["type"]).as_deref() == Some("fileChange"))
        .then(|| turn_id.clone())
        .flatten();
    let Some(entry) = parse_transcript_item(item, turn_id, default_status) else {
        return false;
    };
    let Some(item_id) = entry.item_id else {
        return false;
    };

    relay.upsert_transcript_item(
        item_id,
        entry.kind,
        entry.text,
        entry.status,
        entry.turn_id,
        entry.tool,
    );
    if let Some(turn_id) = refresh_turn_id {
        refresh_turn_diff_entry(relay, &turn_id);
    }
    true
}

fn parse_transcript_item(
    item: &Value,
    turn_id: Option<String>,
    default_status: &str,
) -> Option<TranscriptEntryView> {
    let item_id = string_at(item, &["id"])?;
    let item_type = string_at(item, &["type"])?;
    let status = transcript_item_status(item, default_status);
    let kind = transcript_item_kind(&item_type);
    let tool =
        (kind == TranscriptEntryKind::ToolCall).then(|| build_tool_call_view(item, &item_type));
    let text = transcript_item_text(item, &item_type, tool.as_ref());

    Some(TranscriptEntryView {
        item_id: Some(item_id),
        kind,
        text,
        status,
        turn_id,
        tool,
        content_state: crate::protocol::TranscriptContentState::Full,
    })
}

fn parse_transcript_detail_item(
    item: &Value,
    turn_id: Option<String>,
    default_status: &str,
) -> Option<TranscriptEntryView> {
    let item_id = string_at(item, &["id"])?;
    let item_type = string_at(item, &["type"])?;
    let status = transcript_item_status(item, default_status);
    let kind = transcript_item_kind(&item_type);
    let tool = (kind == TranscriptEntryKind::ToolCall)
        .then(|| build_tool_call_detail_view(item, &item_type));
    let text = transcript_item_detail_text(item, &item_type);

    Some(TranscriptEntryView {
        item_id: Some(item_id),
        kind,
        text,
        status,
        turn_id,
        tool,
        content_state: crate::protocol::TranscriptContentState::Full,
    })
}

fn transcript_item_kind(item_type: &str) -> TranscriptEntryKind {
    match item_type {
        "userMessage" => TranscriptEntryKind::UserText,
        "agentMessage" => TranscriptEntryKind::AgentText,
        "commandExecution" => TranscriptEntryKind::Command,
        _ if is_reasoning_item_type(item_type) => TranscriptEntryKind::Reasoning,
        _ => TranscriptEntryKind::ToolCall,
    }
}

fn transcript_item_status(item: &Value, default_status: &str) -> String {
    match value_at(item, &["status"]) {
        Some(Value::String(status)) => status.clone(),
        Some(status) => parse_status(Some(status)).0,
        None => default_status.to_string(),
    }
}

fn transcript_item_text(
    item: &Value,
    item_type: &str,
    tool: Option<&ToolCallView>,
) -> Option<String> {
    match item_type {
        "userMessage" => parse_user_text(Some(item)),
        "agentMessage" => string_at(item, &["text"]).or_else(|| parse_text_content(item)),
        "commandExecution" => Some(command_execution_text(item)),
        _ if is_reasoning_item_type(item_type) => string_at(item, &["text"])
            .or_else(|| parse_text_content(item))
            .map(|text| truncate_owned(text, MAX_TOOL_ENTRY_CHARS)),
        _ => tool
            .map(tool_preview_text)
            .or_else(|| Some(fallback_item_type_label(item_type))),
    }
}

fn transcript_item_detail_text(item: &Value, item_type: &str) -> Option<String> {
    match item_type {
        "userMessage" => parse_user_text(Some(item)),
        "agentMessage" => string_at(item, &["text"]).or_else(|| parse_text_content(item)),
        "commandExecution" => Some(command_execution_detail_text(item)),
        _ if is_reasoning_item_type(item_type) => {
            string_at(item, &["text"]).or_else(|| parse_text_content(item))
        }
        _ => None,
    }
}

fn command_execution_text(item: &Value) -> String {
    let mut text = truncate_owned(
        string_at(item, &["command"]).unwrap_or_else(|| "Command".to_string()),
        MAX_COMMAND_TEXT_CHARS,
    );
    if let Some(output) = non_empty_string(string_at(item, &["aggregatedOutput"])) {
        text.push('\n');
        text.push_str(&truncate_owned(output, MAX_COMMAND_OUTPUT_CHARS));
    }
    truncate_owned(text, MAX_COMMAND_ENTRY_CHARS)
}

fn command_execution_detail_text(item: &Value) -> String {
    let mut text = string_at(item, &["command"]).unwrap_or_else(|| "Command".to_string());
    if let Some(output) = non_empty_string(string_at(item, &["aggregatedOutput"])) {
        text.push('\n');
        text.push_str(&output);
    }
    text
}

fn build_tool_call_view(item: &Value, item_type: &str) -> ToolCallView {
    let file_change_paths = (item_type == "fileChange")
        .then(|| collect_file_change_paths(item))
        .unwrap_or_default();
    let file_changes = (item_type == "fileChange")
        .then(|| collect_file_change_diffs(item))
        .unwrap_or_default();
    let diff = joined_file_change_diff(&file_changes);
    let name = truncate_owned(
        string_at(item, &["name"])
            .or_else(|| string_at(item, &["toolName"]))
            .or_else(|| string_at(item, &["tool"]))
            .or_else(|| string_at(item, &["label"]))
            .unwrap_or_else(|| fallback_item_type_label(item_type)),
        MAX_TOOL_SUMMARY_CHARS,
    );
    let title = truncate_owned(
        string_at(item, &["title"])
            .or_else(|| string_at(item, &["summary"]))
            .or_else(|| string_at(item, &["text"]))
            .or_else(|| parse_text_content(item))
            .or_else(|| {
                (item_type == "fileChange" && !file_change_paths.is_empty())
                    .then(|| summarize_file_change(&file_change_paths))
            })
            .unwrap_or_else(|| format!("{name} call")),
        MAX_TOOL_SUMMARY_CHARS,
    );
    let detail = string_at(item, &["description"])
        .or_else(|| string_at(item, &["detail"]))
        .or_else(|| {
            (item_type == "fileChange")
                .then(|| file_change_detail(&file_change_paths))
                .flatten()
        })
        .map(|value| truncate_owned(value, MAX_TOOL_SUMMARY_CHARS));

    ToolCallView {
        item_type: item_type.to_string(),
        name,
        title,
        kind: None,
        detail,
        query: preview_string_field(item, "query"),
        path: preview_string_field(item, "path").or_else(|| {
            (file_change_paths.len() == 1)
                .then(|| truncate_owned(file_change_paths[0].clone(), MAX_TOOL_FIELD_CHARS))
        }),
        url: preview_string_field(item, "url"),
        command: preview_string_field(item, "command"),
        input_preview: preview_json_field(item, "input")
            .or_else(|| preview_json_field(item, "arguments"))
            .or_else(|| {
                (item_type == "fileChange")
                    .then(|| file_change_paths_preview(&file_change_paths))
                    .flatten()
            }),
        result_preview: preview_json_field(item, "result")
            .or_else(|| preview_json_field(item, "output")),
        diff,
        file_changes,
        apply_state: None,
        file_changes_omitted: false,
        can_apply: None,
    }
}

fn build_tool_call_detail_view(item: &Value, item_type: &str) -> ToolCallView {
    let file_change_paths = (item_type == "fileChange")
        .then(|| collect_file_change_paths(item))
        .unwrap_or_default();
    let file_changes = (item_type == "fileChange")
        .then(|| collect_file_change_diffs(item))
        .unwrap_or_default();
    let diff = joined_file_change_diff(&file_changes);
    let name = truncate_owned(
        string_at(item, &["name"])
            .or_else(|| string_at(item, &["toolName"]))
            .or_else(|| string_at(item, &["tool"]))
            .or_else(|| string_at(item, &["label"]))
            .or_else(|| string_at(item, &["type"]))
            .unwrap_or_else(|| fallback_item_type_label(item_type)),
        MAX_TOOL_SUMMARY_CHARS,
    );
    let title = truncate_owned(
        string_at(item, &["title"])
            .or_else(|| string_at(item, &["summary"]))
            .or_else(|| string_at(item, &["text"]))
            .or_else(|| parse_text_content(item))
            .or_else(|| {
                (item_type == "fileChange" && !file_change_paths.is_empty())
                    .then(|| summarize_file_change(&file_change_paths))
            })
            .unwrap_or_else(|| format!("{name} call")),
        MAX_TOOL_SUMMARY_CHARS,
    );
    let detail = string_at(item, &["description"])
        .or_else(|| string_at(item, &["detail"]))
        .or_else(|| {
            (item_type == "fileChange")
                .then(|| file_change_detail(&file_change_paths))
                .flatten()
        });

    ToolCallView {
        item_type: item_type.to_string(),
        name,
        title,
        kind: None,
        detail,
        query: full_string_field(item, "query"),
        path: full_string_field(item, "path")
            .or_else(|| (file_change_paths.len() == 1).then(|| file_change_paths[0].clone())),
        url: full_string_field(item, "url"),
        command: full_string_field(item, "command"),
        input_preview: full_json_field(item, "input")
            .or_else(|| full_json_field(item, "arguments"))
            .or_else(|| {
                (item_type == "fileChange")
                    .then(|| full_json_value(value_at(item, &["changes"])?))
                    .flatten()
            }),
        result_preview: full_json_field(item, "result").or_else(|| full_json_field(item, "output")),
        diff,
        file_changes,
        apply_state: None,
        file_changes_omitted: false,
        can_apply: None,
    }
}

fn build_turn_file_summary(
    turn_id: Option<String>,
    items: &[Value],
) -> Option<TranscriptEntryView> {
    let turn_id = turn_id?;
    let file_changes = summarize_turn_file_changes(items);
    if file_changes.is_empty() {
        return None;
    }

    Some(build_turn_diff_entry_with_fallback(
        turn_id,
        joined_file_change_diff(&file_changes),
        "completed",
        file_changes,
        "Codex",
    ))
}

fn build_turn_diff_entry(turn_id: String, diff: String, status: &str) -> TranscriptEntryView {
    build_turn_diff_entry_with_fallback(turn_id, Some(diff), status, Vec::new(), "Codex")
}

pub(crate) fn build_turn_diff_entry_with_fallback(
    turn_id: String,
    diff: Option<String>,
    status: &str,
    fallback_file_changes: Vec<FileChangeDiffView>,
    agent_label: &str,
) -> TranscriptEntryView {
    let mut file_changes = diff
        .as_deref()
        .map(split_unified_diff_by_file)
        .unwrap_or_default();
    if file_changes.is_empty() {
        for path in diff
            .as_deref()
            .map(extract_paths_from_unified_diff)
            .unwrap_or_default()
        {
            crate::file_changes::merge_file_change_view(
                &mut file_changes,
                FileChangeDiffView {
                    path,
                    change_type: "update".to_string(),
                    diff: String::new(),
                },
            );
        }
    }
    for change in fallback_file_changes {
        crate::file_changes::merge_file_change_view(&mut file_changes, change);
    }
    let paths = file_changes
        .iter()
        .map(|change| change.path.clone())
        .collect::<Vec<_>>();
    let detail = file_change_detail(&paths);

    TranscriptEntryView {
        item_id: Some(format!("turn-diff:{turn_id}")),
        kind: TranscriptEntryKind::ToolCall,
        text: Some(format!("Changed files in turn {turn_id}")),
        status: status.to_string(),
        turn_id: Some(turn_id),
        tool: Some(ToolCallView {
            item_type: "turnDiff".to_string(),
            name: "File summary".to_string(),
            title: summarize_turn_diff(&paths, agent_label),
            kind: None,
            detail,
            query: None,
            path: (paths.len() == 1).then(|| paths[0].clone()),
            url: None,
            command: None,
            input_preview: file_change_paths_preview(&paths),
            result_preview: None,
            diff,
            file_changes,
            apply_state: None,
            file_changes_omitted: false,
            can_apply: None,
        }),
        content_state: crate::protocol::TranscriptContentState::Full,
    }
}

fn tool_preview_text(tool: &ToolCallView) -> String {
    let mut lines = vec![tool.title.clone()];
    if let Some(detail) = &tool.detail {
        if detail != &tool.title {
            lines.push(detail.clone());
        }
    }

    for value in [&tool.query, &tool.path, &tool.url, &tool.command] {
        if let Some(value) = value {
            lines.push(value.clone());
        }
    }

    truncate_owned(lines.join("\n"), MAX_TOOL_ENTRY_CHARS)
}

fn preview_string_field(item: &Value, key: &str) -> Option<String> {
    non_empty_string(string_at(item, &[key]))
        .map(|value| truncate_owned(value, MAX_TOOL_FIELD_CHARS))
}

fn preview_json_field(item: &Value, key: &str) -> Option<String> {
    value_at(item, &[key]).and_then(|value| compact_json_value(value, MAX_TOOL_JSON_CHARS))
}

fn full_string_field(item: &Value, key: &str) -> Option<String> {
    non_empty_string(string_at(item, &[key]))
}

fn full_json_field(item: &Value, key: &str) -> Option<String> {
    value_at(item, &[key]).and_then(full_json_value)
}

fn parse_command_approval(
    request_id: String,
    raw_request_id: Value,
    params: &Value,
) -> PendingApproval {
    let command = string_at(params, &["command"]);
    let cwd = string_at(params, &["cwd"]);
    let summary = command
        .as_ref()
        .map(|value| {
            format!(
                "Codex wants to run {}.",
                inline_snippet(value, MAX_APPROVAL_SUMMARY_CHARS)
            )
        })
        .unwrap_or_else(|| "Codex wants to run a command.".to_string());

    PendingApproval {
        request_id,
        raw_request_id,
        kind: ApprovalKind::Command,
        thread_id: string_at(params, &["threadId"]).unwrap_or_default(),
        summary,
        detail: string_at(params, &["reason"]),
        command,
        cwd,
        context_preview: filtered_json_preview(
            params,
            &["threadId", "reason", "command", "cwd", "availableDecisions"],
            MAX_APPROVAL_CONTEXT_CHARS,
        ),
        requested_permissions: None,
        available_decisions: parse_available_decisions(params),
        supports_session_scope: true,
    }
}

fn parse_file_change_approval(
    request_id: String,
    raw_request_id: Value,
    params: &Value,
) -> PendingApproval {
    let paths = collect_file_change_paths(params);
    let summary = summarize_file_change(&paths);
    let detail = string_at(params, &["reason"]).or_else(|| file_change_detail(&paths));
    let context_preview = file_change_context_preview(params, &paths);

    PendingApproval {
        request_id,
        raw_request_id,
        kind: ApprovalKind::FileChange,
        thread_id: string_at(params, &["threadId"]).unwrap_or_default(),
        summary,
        detail,
        command: None,
        cwd: string_at(params, &["cwd"]),
        context_preview,
        requested_permissions: None,
        available_decisions: parse_available_decisions(params),
        supports_session_scope: true,
    }
}

fn parse_permissions_approval(
    request_id: String,
    raw_request_id: Value,
    params: &Value,
) -> PendingApproval {
    let requested_permissions = params.get("permissions").cloned();
    let summary = requested_permissions
        .as_ref()
        .and_then(permission_summary)
        .unwrap_or_else(|| "Codex wants additional permissions.".to_string());

    PendingApproval {
        request_id,
        raw_request_id,
        kind: ApprovalKind::Permissions,
        thread_id: string_at(params, &["threadId"]).unwrap_or_default(),
        summary,
        detail: string_at(params, &["reason"]),
        command: None,
        cwd: string_at(params, &["cwd"]),
        context_preview: filtered_json_preview(
            params,
            &[
                "threadId",
                "reason",
                "permissions",
                "cwd",
                "availableDecisions",
            ],
            MAX_APPROVAL_CONTEXT_CHARS,
        ),
        requested_permissions,
        available_decisions: vec![
            "approve".to_string(),
            "approve_for_session".to_string(),
            "deny".to_string(),
        ],
        supports_session_scope: true,
    }
}

fn summarize_file_change(paths: &[String]) -> String {
    match paths {
        [] => "Codex wants to apply a file change.".to_string(),
        [path] => format!(
            "Codex wants to edit {}.",
            inline_snippet(path, MAX_APPROVAL_SUMMARY_CHARS)
        ),
        _ => format!("Codex wants to edit {} files.", paths.len()),
    }
}

fn file_change_detail(paths: &[String]) -> Option<String> {
    match paths {
        [] => None,
        [path] => Some(format!("Target file: {path}")),
        _ => Some(format!("Target files: {}", paths.join(", "))),
    }
}

fn file_change_context_preview(params: &Value, paths: &[String]) -> Option<String> {
    let path_preview = if paths.is_empty() {
        None
    } else {
        Some(format!("Files:\n{}", paths.join("\n")))
    };
    let request_preview = filtered_json_preview(
        params,
        &["threadId", "reason", "cwd", "availableDecisions"],
        MAX_APPROVAL_CONTEXT_CHARS,
    );

    join_preview_sections(
        path_preview,
        request_preview.map(|value| format!("Request:\n{value}")),
    )
    .map(|value| truncate_owned(value, MAX_APPROVAL_CONTEXT_CHARS))
}

fn file_change_paths_preview(paths: &[String]) -> Option<String> {
    if paths.is_empty() {
        return None;
    }

    Some(truncate_owned(
        format!("Files:\n{}", paths.join("\n")),
        MAX_TOOL_JSON_CHARS,
    ))
}

fn summarize_turn_diff(paths: &[String], agent_label: &str) -> String {
    match paths {
        [] => format!("{agent_label} changed files in this turn."),
        [path] => format!(
            "{agent_label} changed {} in this turn.",
            inline_snippet(path, MAX_APPROVAL_SUMMARY_CHARS)
        ),
        _ => format!("{agent_label} changed {} files in this turn.", paths.len()),
    }
}

fn filtered_json_preview(
    params: &Value,
    excluded_keys: &[&str],
    max_chars: usize,
) -> Option<String> {
    match params {
        Value::Object(map) => {
            let filtered = map
                .iter()
                .filter(|(key, value)| !excluded_keys.contains(&key.as_str()) && !value.is_null())
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<String, Value>>();

            if filtered.is_empty() {
                None
            } else {
                compact_json_value(&Value::Object(filtered), max_chars)
            }
        }
        _ => compact_json_value(params, max_chars),
    }
}

fn join_preview_sections(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (None, None) => None,
        (Some(value), None) | (None, Some(value)) => Some(value),
        (Some(first), Some(second)) => Some(format!("{first}\n\n{second}")),
    }
}

fn collect_file_change_paths(params: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_file_change_paths_inner(params, &mut paths, 0);
    paths
}

fn collect_file_change_diffs(item: &Value) -> Vec<FileChangeDiffView> {
    let changes = match value_at(item, &["changes"]).and_then(Value::as_array) {
        Some(changes) => changes,
        None => return Vec::new(),
    };

    changes
        .iter()
        .filter_map(|change| {
            let path = string_at(change, &["path"])?;
            let change_type = parse_file_change_kind(change);
            let diff = string_at(change, &["diff"])
                .or_else(|| synthesize_file_change_diff(change, &path, &change_type))?;
            Some(FileChangeDiffView {
                path,
                change_type,
                diff,
            })
        })
        .collect()
}

fn synthesize_file_change_diff(change: &Value, path: &str, change_type: &str) -> Option<String> {
    match change_type {
        "add" | "create" => {
            let content = string_at(change, &["content"])?;
            Some(render_added_file_diff(path, &content))
        }
        _ => None,
    }
}

fn render_added_file_diff(path: &str, content: &str) -> String {
    let normalized_lines = content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    let line_count = normalized_lines.len();
    let mut diff_lines = vec![
        format!("diff --git a/{path} b/{path}"),
        "new file mode 100644".to_string(),
        "--- /dev/null".to_string(),
        format!("+++ b/{path}"),
        format!("@@ -0,0 +1,{line_count} @@"),
    ];
    diff_lines.extend(normalized_lines.into_iter().map(|line| format!("+{line}")));
    diff_lines.join("\n")
}

fn summarize_turn_file_changes(items: &[Value]) -> Vec<FileChangeDiffView> {
    let mut file_changes = Vec::new();
    for item in items {
        if string_at(item, &["type"]).as_deref() != Some("fileChange") {
            continue;
        }
        for path in collect_file_change_paths(item) {
            crate::file_changes::merge_file_change_view(
                &mut file_changes,
                FileChangeDiffView {
                    path,
                    change_type: "update".to_string(),
                    diff: String::new(),
                },
            );
        }
        for change in collect_file_change_diffs(item) {
            crate::file_changes::merge_file_change_view(&mut file_changes, change);
        }
    }
    file_changes
}

fn parse_file_change_kind(change: &Value) -> String {
    value_at(change, &["kind", "type"])
        .and_then(Value::as_str)
        .or_else(|| value_at(change, &["type"]).and_then(Value::as_str))
        .unwrap_or("update")
        .to_string()
}

fn joined_file_change_diff(file_changes: &[FileChangeDiffView]) -> Option<String> {
    let parts = file_changes
        .iter()
        .filter_map(|change| non_empty_string(Some(change.diff.clone())))
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

pub(crate) fn split_unified_diff_by_file(diff: &str) -> Vec<FileChangeDiffView> {
    let mut changes = Vec::new();
    let mut current = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_kind = "update".to_string();

    for line in diff.lines() {
        if line.starts_with("diff --git ") && !current.is_empty() {
            if let Some(path) = current_path.take() {
                changes.push(FileChangeDiffView {
                    path,
                    change_type: current_kind.clone(),
                    diff: current.join("\n"),
                });
            }
            current.clear();
            current_kind = "update".to_string();
        }

        if let Some(path) = line.strip_prefix("+++ ") {
            let normalized = normalize_diff_path(path);
            if normalized != "/dev/null" {
                current_path = Some(normalized);
            }
        } else if current_path.is_none() {
            if let Some(path) = line.strip_prefix("--- ") {
                let normalized = normalize_diff_path(path);
                if normalized != "/dev/null" {
                    current_path = Some(normalized);
                }
            }
        }

        if line.starts_with("new file mode") {
            current_kind = "add".to_string();
        } else if line.starts_with("deleted file mode") {
            current_kind = "delete".to_string();
        }

        current.push(line.to_string());
    }

    if let Some(path) = current_path {
        changes.push(FileChangeDiffView {
            path,
            change_type: current_kind,
            diff: current.join("\n"),
        });
    }

    changes
}

fn extract_paths_from_unified_diff(diff: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in diff.lines() {
        let candidate = line
            .strip_prefix("+++ ")
            .or_else(|| line.strip_prefix("--- "));
        if let Some(path) = candidate {
            let path = normalize_diff_path(path);
            if path != "/dev/null" {
                push_unique_path(&mut paths, &path);
            }
        }
    }
    paths
}

fn normalize_diff_path(path: &str) -> String {
    path.trim()
        .strip_prefix("a/")
        .or_else(|| path.trim().strip_prefix("b/"))
        .unwrap_or_else(|| path.trim())
        .to_string()
}

fn collect_file_change_paths_inner(value: &Value, paths: &mut Vec<String>, depth: usize) {
    if depth > 4 || paths.len() >= 6 {
        return;
    }

    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                let key = key.as_str();
                if is_file_path_key(key) {
                    match nested {
                        Value::String(text) => push_unique_path(paths, text),
                        Value::Array(values) => {
                            for entry in values {
                                if let Some(text) = entry.as_str() {
                                    push_unique_path(paths, text);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                collect_file_change_paths_inner(nested, paths, depth + 1);
                if paths.len() >= 6 {
                    break;
                }
            }
        }
        Value::Array(values) => {
            for entry in values {
                collect_file_change_paths_inner(entry, paths, depth + 1);
                if paths.len() >= 6 {
                    break;
                }
            }
        }
        _ => {}
    }
}

fn is_file_path_key(key: &str) -> bool {
    matches!(
        key,
        "path"
            | "paths"
            | "file"
            | "files"
            | "filePath"
            | "targetPath"
            | "relativePath"
            | "destinationPath"
            | "sourcePath"
    )
}

fn push_unique_path(paths: &mut Vec<String>, candidate: &str) {
    let Some(candidate) = non_empty_string(Some(candidate.to_string())) else {
        return;
    };
    if !looks_like_path(&candidate) || paths.iter().any(|path| path == &candidate) {
        return;
    }
    paths.push(candidate);
}

fn looks_like_path(candidate: &str) -> bool {
    candidate.contains('/') || candidate.contains('\\') || candidate.contains('.')
}

fn permission_summary(value: &Value) -> Option<String> {
    let (labels, total_count) = match value {
        Value::Object(map) => (map.keys().take(3).cloned().collect::<Vec<_>>(), map.len()),
        Value::Array(values) => values
            .iter()
            .filter_map(|entry| entry.as_str().map(ToOwned::to_owned))
            .fold((Vec::new(), 0_usize), |(mut labels, count), entry| {
                if labels.len() < 3 {
                    labels.push(entry);
                }
                (labels, count + 1)
            }),
        _ => (Vec::new(), 0),
    };

    if labels.is_empty() {
        None
    } else {
        let label_text = if total_count > labels.len() {
            format!("{}, ...", labels.join(", "))
        } else {
            labels.join(", ")
        };
        Some(format!(
            "Codex wants additional permissions ({label_text})."
        ))
    }
}

fn inline_snippet(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact = truncate_owned(compact, max_chars);
    format!("`{compact}`")
}

fn parse_text_content(item: &Value) -> Option<String> {
    let content = value_at(item, &["content"]).and_then(Value::as_array)?;
    let parts = content
        .iter()
        .filter_map(|entry| {
            entry
                .as_str()
                .map(ToOwned::to_owned)
                .or_else(|| string_at(entry, &["text"]))
        })
        .collect::<Vec<_>>();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn compact_json_value(value: &Value, max_chars: usize) -> Option<String> {
    if value.is_null() {
        return None;
    }

    match value {
        Value::String(text) => non_empty_string(Some(truncate_owned(text.clone(), max_chars))),
        _ => serde_json::to_string_pretty(value)
            .ok()
            .map(|text| truncate_owned(text, max_chars)),
    }
}

fn full_json_value(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }

    match value {
        Value::String(text) => non_empty_string(Some(text.clone())),
        _ => serde_json::to_string_pretty(value)
            .ok()
            .and_then(|text| non_empty_string(Some(text))),
    }
}

fn fallback_item_type_label(item_type: &str) -> String {
    match item_type {
        "mcpToolCall" => "MCP tool call".to_string(),
        "webSearch" => "Web search".to_string(),
        "fileSearch" => "File search".to_string(),
        "fileChange" => "File change".to_string(),
        _ => item_type.to_string(),
    }
}

fn is_reasoning_item_type(item_type: &str) -> bool {
    item_type.contains("reasoning") || item_type.contains("thinking")
}

fn parse_available_decisions(params: &Value) -> Vec<String> {
    value_at(params, &["availableDecisions"])
        .and_then(Value::as_array)
        .map(|decisions| {
            decisions
                .iter()
                .filter_map(parse_decision_label)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec!["accept".to_string(), "cancel".to_string()])
}

fn parse_decision_label(value: &Value) -> Option<String> {
    if let Some(label) = value.as_str() {
        return Some(label.to_string());
    }

    if value.get("acceptWithExecpolicyAmendment").is_some() {
        return Some("acceptWithExecpolicyAmendment".to_string());
    }

    None
}

fn parse_user_text(item: Option<&Value>) -> Option<String> {
    let content = value_at(item?, &["content"]).and_then(Value::as_array)?;
    let parts = content
        .iter()
        .filter_map(|entry| string_at(entry, &["text"]))
        .collect::<Vec<_>>();
    let image_count = content
        .iter()
        .filter(|entry| {
            matches!(
                string_at(entry, &["type"]).as_deref(),
                Some("image" | "localImage")
            )
        })
        .count();

    user_message_transcript_text(&parts.join("\n"), image_count)
}

fn non_empty_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn truncate_owned(mut value: String, max_chars: usize) -> String {
    truncate_with_ellipsis(&mut value, max_chars);
    value
}

fn parse_status(status: Option<&Value>) -> (String, Vec<String>) {
    let Some(status) = status else {
        return ("unknown".to_string(), Vec::new());
    };

    let kind = string_at(status, &["type"]).unwrap_or_else(|| "unknown".to_string());
    let active_flags = value_at(status, &["activeFlags"])
        .and_then(Value::as_array)
        .map(|flags| {
            flags
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    (kind, active_flags)
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    Some(current)
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    value_at(value, path)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn bool_at(value: &Value, path: &[&str]) -> Option<bool> {
    value_at(value, path).and_then(Value::as_bool)
}

fn normalize_id(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => value.to_string(),
    }
}
