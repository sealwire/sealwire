//! Generic ACP (Agent Client Protocol) provider bridge.
//!
//! ACP is a protocol, not a vendor: `cursor-agent acp` speaks it, and so do
//! several other agents. This bridge is therefore parameterized by binary name
//! and launch args rather than being a `CursorBridge`, so a second ACP agent is
//! a registry row rather than a second bridge.
//!
//! Transport is JSON-RPC 2.0 over stdio with newline framing and server→client
//! requests — the same shape as `codex app-server`, which is why the reader and
//! response-correlation plumbing mirrors `codex/rpc.rs`.
//!
//! Wire shapes here were measured against `cursor-agent 2026.08.04-aaa8809`;
//! see `markdown/cursor-acp-provider-plan.md`.

use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex, RwLock},
    time::{timeout, Duration},
};

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{ApprovalDecisionInput, ModelOptionView, ThreadSummaryView, TranscriptEntryView},
    provider::{
        ProviderBridge, ProviderImage, StartThreadRequest, StartThreadResult, ThreadSyncData,
    },
    state::{PendingApproval, RelayState},
};

mod protocol;
mod rpc;

/// How long `<agent> mcp list` gets before the relay gives up on it.
const MCP_LIST_TIMEOUT: Duration = Duration::from_secs(5);

/// Ask the agent's CLI what its MCP servers are doing, and say so.
///
/// Why the CLI and not ACP: measured 2026-08-12, ACP reports nothing about
/// loaded MCP servers — see `protocol::summarize_mcp_servers`. Codex reached the
/// same dead end with its app-server and probes `codex mcp list --json`; this is
/// the same move against a text-only `mcp list`.
///
/// Best-effort throughout. A missing subcommand, a non-zero exit, a hang or
/// unparseable output must never be louder than the thing it is reporting on, so
/// only a genuine failure to *run* the probe is surfaced. `kill_on_drop` matters:
/// cancelling `output()` at the timeout only stops awaiting, so without it a hung
/// CLI survives as an orphan.
async fn report_mcp_config(
    binary_name: &'static str,
    provider_key: &'static str,
    state: Arc<RwLock<RelayState>>,
) {
    let mut command = Command::new(crate::provider::resolve_binary(binary_name));
    command.arg("mcp").arg("list").kill_on_drop(true);

    let summary = match timeout(MCP_LIST_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            protocol::summarize_mcp_servers(provider_key, &String::from_utf8_lossy(&output.stdout))
        }
        // Non-zero exit: the subcommand is missing or refused. Not this relay's
        // problem to narrate — an agent without `mcp list` is not misconfigured.
        Ok(Ok(_)) => return,
        Ok(Err(error)) => protocol::McpSummary {
            headline: None,
            problems: vec![format!(
                "Could not check {binary_name} MCP servers: {error}"
            )],
        },
        Err(_) => protocol::McpSummary {
            headline: None,
            problems: vec![format!(
                "`{binary_name} mcp list` timed out; MCP state unknown."
            )],
        },
    };

    log_mcp_summary(&state, summary).await;
}

/// Put an MCP census in the log panel — on channels a user can actually see.
///
/// Deliberately NOT the provider's own channel. `push_log(provider_key, …)` is
/// classified as subprocess chatter and filtered out of the audit view unless it
/// happens to match a lifecycle regex, which is why codex's equivalent MCP lines
/// (filed under `push_log("codex", …)`) are mostly invisible today. A failing
/// MCP server is precisely the thing that must not be swallowed.
async fn log_mcp_summary(state: &Arc<RwLock<RelayState>>, summary: protocol::McpSummary) {
    if summary.headline.is_none() && summary.problems.is_empty() {
        return;
    }
    let mut relay = state.write().await;
    if let Some(headline) = summary.headline {
        relay.push_log("info", headline);
    }
    for problem in summary.problems {
        relay.push_log("warn", problem);
    }
    relay.notify();
}

#[cfg(test)]
pub(crate) async fn log_mcp_summary_for_test(
    state: &Arc<RwLock<RelayState>>,
    summary: protocol::McpSummary,
) {
    log_mcp_summary(state, summary).await;
}

#[cfg(test)]
mod tests;

pub(crate) type PendingResponses =
    Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

/// The bridge's outbound pipe.
///
/// A trait object rather than `ChildStdin` so tests can drive the real request
/// and turn-lifecycle code over `tokio::io::duplex` instead of a real
/// `cursor-agent` — which is the only way to exercise send failures and stream
/// death, neither of which a live agent can be asked to produce on cue.
pub(crate) type Outbound = Arc<Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>;
pub(crate) type Inbound = Box<dyn tokio::io::AsyncRead + Send + Unpin>;

const ACP_REQUEST_TIMEOUT_SECS: u64 = 60;
/// `session/prompt` runs for as long as the agent works, so it gets no deadline
/// from the request layer — the turn ends when the agent says it does, or when
/// the stream dies.
const ACP_PROMPT_TIMEOUT_SECS: u64 = 60 * 60;
/// Backstop on `session/list` pagination so an agent that always hands back a
/// cursor cannot spin the bridge forever.
const MAX_LIST_PAGES: usize = 50;

/// Per-session bookkeeping the stdout reader needs in order to translate
/// events. Keyed by ACP `sessionId`, which is also the relay thread id.
#[derive(Debug, Default)]
pub(crate) struct SessionRuntime {
    pub(crate) cwd: String,
    pub(crate) approval_policy: String,
    /// The ACP model id this session is currently configured with.
    ///
    /// ACP models are *session* config (`session/set_model`), not a per-turn
    /// argument the way `ProviderBridge::start_turn` passes them — so the bridge
    /// tracks the session's model and pushes a change only when the relay's
    /// selection actually differs.
    pub(crate) model: String,
    /// The mode the session is actually in, per the agent's own reporting.
    pub(crate) mode: String,
    /// Whether THIS connection has the session open.
    ///
    /// Not the same as being in the map — `absorb_thread_cwds` puts every listed
    /// session there, cold. A prompt sent to a cold one fails.
    pub(crate) attached: bool,
    /// Whether this session has ever carried a turn.
    ///
    /// Measured: Cursor cannot load a session with no content — it answers
    /// `Session "…" not found`. So a thread created and not yet prompted has to
    /// read as empty rather than as a provider error.
    pub(crate) has_content: bool,
    /// The mode the relay's policy REQUIRES, when it requires one.
    ///
    /// Set only for a read-only thread (a reviewer, a read-only sandbox). ACP
    /// lets the agent change its own mode, so without this the relay would keep
    /// believing a thread is contained after the agent moved it back to full
    /// `agent` — a permission change the user never asked for.
    pub(crate) required_mode: Option<&'static str>,
    /// The turn the relay minted for the in-flight `session/prompt`. ACP has no
    /// turn concept of its own — a prompt is one request/response — so turn ids
    /// are relay-owned.
    pub(crate) turn_id: Option<String>,
    /// Per-kind ordinal counters backing `protocol::item_id`. Ordinals are used
    /// instead of ACP's own ids because a live `toolCallId` embeds a raw newline
    /// and `session/load` reassigns ids on replay; see `protocol::item_id`.
    pub(crate) ordinals: HashMap<&'static str, u64>,
    /// ACP `toolCallId` → the stable relay item id minted for it.
    pub(crate) tool_items: HashMap<String, String>,
    /// Accumulated view of each tool call, keyed by the minted item id.
    ///
    /// ACP tool updates are *partial*: `tool_call` carries the title and input,
    /// `tool_call_update` carries only the id, status and output. Emitting one
    /// event's fields alone would blank out whatever the other event supplied,
    /// so the merge happens here — where the session state lives — and every
    /// emitted op is a complete snapshot.
    pub(crate) tool_meta: HashMap<String, ToolMeta>,
    /// The open agent message, if one is streaming.
    pub(crate) agent_item: Option<String>,
    pub(crate) agent_text: String,
    /// The open reasoning entry, if one is streaming.
    pub(crate) thought_item: Option<String>,
    pub(crate) thought_text: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolMeta {
    pub(crate) title: String,
    pub(crate) command: Option<String>,
    pub(crate) output: Option<String>,
    /// Sticky like `status`: ACP lets a `tool_call_update` omit every field but
    /// `toolCallId`, so a trailing content-only update must not blank these.
    pub(crate) kind: Option<String>,
    pub(crate) path: Option<String>,
    /// Last status the agent actually reported.
    ///
    /// Held here rather than recomputed per event because ACP allows every
    /// field but `toolCallId` to be omitted from a `tool_call_update` — so a
    /// trailing content-only update would otherwise read as "no status" and
    /// regress a finished tool back to pending.
    pub(crate) status: String,
}

impl Default for ToolMeta {
    fn default() -> Self {
        Self {
            title: String::new(),
            command: None,
            output: None,
            kind: None,
            path: None,
            status: "pending".to_string(),
        }
    }
}

impl SessionRuntime {
    pub(crate) fn next_item_id(&mut self, kind: &'static str) -> String {
        let counter = self.ordinals.entry(kind).or_insert(0);
        *counter += 1;
        protocol::item_id(kind, *counter)
    }

    /// The model id to push to the agent, or `None` if nothing needs sending.
    ///
    /// Placeholders are not selections: the relay passes `""` (and codex's
    /// literal `"default"`) to mean "whatever the provider picks", and forwarding
    /// those as a model id would either be rejected or accepted as a bogus model.
    pub(crate) fn model_change_needed(&self, requested: &str) -> Option<String> {
        if requested.is_empty() || requested == "default" || requested == self.model {
            return None;
        }
        Some(requested.to_string())
    }

    /// The mode this session must be restored to, if it has drifted out of it.
    ///
    /// `None` means either "no requirement" or "already correct".
    pub(crate) fn mode_drift(&self) -> Option<&'static str> {
        let required = self.required_mode?;
        (!self.mode.is_empty() && self.mode != required).then_some(required)
    }

    /// Whether it is safe to run a `session/load` replay through this session.
    ///
    /// A replay renumbers items from the start, and the counters are shared with
    /// whatever turn is streaming — so replaying under a live turn makes the
    /// turn resume minting `acp-msg-1` on top of the ids the replay just
    /// produced, overwriting settled entries. Losing the tail of a turn would be
    /// bad; corrupting the history behind it is worse.
    pub(crate) fn can_replay_into(&self) -> bool {
        self.turn_id.is_none()
    }

    /// Clear transcript numbering ahead of a replay, keeping the session
    /// identity (cwd, policy, model) that outlives any single transcript.
    pub(crate) fn reset_for_replay(&mut self) {
        self.close_streams();
        self.ordinals.clear();
        self.tool_items.clear();
        self.tool_meta.clear();
    }

    /// Drop the streaming cursors so the next chunk opens a fresh entry. Called
    /// at turn boundaries and before a replay.
    pub(crate) fn close_streams(&mut self) {
        self.agent_item = None;
        self.agent_text.clear();
        self.thought_item = None;
        self.thought_text.clear();
    }
}

pub(crate) type Sessions = Arc<Mutex<HashMap<String, SessionRuntime>>>;

/// Drop a thread's runtime state. Nothing else removes from `sessions`, so a
/// deleted thread would otherwise leak its `tool_meta` for the relay's life.
pub(crate) async fn forget_session(sessions: &Sessions, thread_id: &str) {
    sessions.lock().await.remove(thread_id);
}

/// Only once the delete succeeded: a failed one leaves the thread usable, and
/// reset `ordinals` would re-mint item ids the surviving transcript still holds.
pub(crate) async fn settle_delete<T>(
    sessions: &Sessions,
    thread_id: &str,
    result: &Result<T, String>,
) {
    if result.is_ok() {
        forget_session(sessions, thread_id).await;
    }
}

/// Transcript captured out of a `session/load` replay instead of being applied
/// to `RelayState`.
///
/// `session/load` answers by replaying the whole conversation as `session/update`
/// notifications and only then returning — but `read_thread` has to *return* a
/// transcript rather than mutate live state. Installing a capture for the
/// session id redirects the replay into a buffer.
pub(crate) type Captures = Arc<Mutex<HashMap<String, Vec<TranscriptEntryView>>>>;

/// Installs a capture for the length of one `session/load`, and takes it back
/// out on drop.
///
/// Manual insert/remove around an `.await` leaks the capture whenever the future
/// does not run to completion — an aborted task, a disconnected client. A leaked
/// capture is not inert: the notification path diverts EVERY later update for
/// that session into a buffer nobody will ever read, so the thread's transcript
/// silently stops advancing. Tying removal to the guard's lifetime makes the
/// cleanup unconditional.
pub(crate) struct CaptureGuard {
    captures: Captures,
    thread_id: String,
}

impl CaptureGuard {
    async fn install(captures: Captures, thread_id: &str) -> Self {
        captures
            .lock()
            .await
            .insert(thread_id.to_string(), Vec::new());
        Self {
            captures,
            thread_id: thread_id.to_string(),
        }
    }

    /// The replay collected so far, leaving the capture installed until drop.
    async fn take(&self) -> Vec<TranscriptEntryView> {
        self.captures
            .lock()
            .await
            .get_mut(&self.thread_id)
            .map(std::mem::take)
            .unwrap_or_default()
    }
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        let captures = self.captures.clone();
        let thread_id = std::mem::take(&mut self.thread_id);
        // Drop is sync and the map is behind an async mutex, so the removal is
        // handed to the runtime. `try_lock` first keeps the common (uncontended)
        // case immediate.
        if let Ok(mut guard) = captures.try_lock() {
            guard.remove(&thread_id);
            return;
        }
        tokio::spawn(async move {
            captures.lock().await.remove(&thread_id);
        });
    }
}

pub struct AcpBridge {
    /// `None` in tests, where the peer is an in-memory duplex rather than a
    /// process.
    _child: Option<Arc<Mutex<Child>>>,
    stdin: Outbound,
    pending_responses: PendingResponses,
    next_request_id: AtomicU64,
    next_turn_id: AtomicU64,
    state: Arc<RwLock<RelayState>>,
    provider_name: &'static str,
    display_name: &'static str,
    /// The executable, which is NOT the provider key: `cursor-agent` vs
    /// `cursor`. Any instruction telling a user to run something has to use
    /// this, or it names a command that does not exist.
    binary_name: &'static str,
    sessions: Sessions,
    captures: Captures,
    /// Catalog captured from the first `session/new`, which returns the full
    /// model list — ACP has no standalone catalog method.
    models: Arc<Mutex<Vec<ModelOptionView>>>,
    /// One lock per session, held across a `session/load`.
    ///
    /// A replay is a session-wide side effect on a shared notification channel,
    /// so two of them at once would overwrite each other's capture buffer and
    /// spill replayed events into live state.
    load_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// What the agent advertised at `initialize`. ACP makes session load, list
    /// and image prompts optional and requires clients to check first.
    capabilities: Arc<Mutex<protocol::AgentCapabilities>>,
    authenticated: AtomicBool,
}

impl AcpBridge {
    pub async fn spawn(
        state: Arc<RwLock<RelayState>>,
        binary_name: &'static str,
        launch_args: &'static [&'static str],
        display_name: &'static str,
        provider_key: &'static str,
    ) -> Result<Self, String> {
        // Resolved, not bare: the binary may only exist in `~/.local/bin`, which
        // is where cursor's installer puts it and is often not on `$PATH`. The
        // error text below stays bare — it names a command for a human to run.
        let mut command = Command::new(crate::provider::resolve_binary(binary_name));
        command
            .args(launch_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().map_err(|error| {
            format!(
                "failed to start `{binary_name} {}`: {error}",
                launch_args.join(" ")
            )
        })?;

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
        let pending_responses: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        let captures: Captures = Arc::new(Mutex::new(HashMap::new()));
        let stdin: Outbound = Arc::new(Mutex::new(Box::new(stdin)));

        rpc::spawn_stdout_reader(rpc::ReaderContext {
            stdout: Box::new(stdout),
            stdin: stdin.clone(),
            pending_responses: pending_responses.clone(),
            state: state.clone(),
            sessions: sessions.clone(),
            captures: captures.clone(),
            provider_key,
        });
        rpc::spawn_stderr_reader(stderr, state.clone(), provider_key);

        let bridge = Self {
            _child: Some(child),
            stdin,
            pending_responses,
            next_request_id: AtomicU64::new(1),
            next_turn_id: AtomicU64::new(1),
            state,
            provider_name: provider_key,
            display_name,
            binary_name,
            sessions,
            captures,
            models: Arc::new(Mutex::new(read_cached_models(&models_cache_path(
                provider_key,
            )))),
            load_locks: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(protocol::AgentCapabilities::default())),
            authenticated: AtomicBool::new(false),
        };

        bridge.initialize().await?;

        {
            let mut relay = bridge.state.write().await;
            relay.set_provider_connection(provider_key, true);
            relay.push_log("info", format!("Connected to {display_name} (ACP)."));
            relay.notify();
        }

        // Off the startup critical path, like codex's: a hung `mcp list` must
        // not delay bridge creation or the providers queued behind it.
        tokio::spawn(report_mcp_config(
            binary_name,
            provider_key,
            bridge.state.clone(),
        ));

        Ok(bridge)
    }

    /// Handshake, then authenticate if the agent advertises an auth method.
    ///
    /// A not-logged-in agent is a *live connection with no sessions*, not a
    /// spawn failure — the binary is installed and speaking. Treating it as a
    /// hard error would report the provider as `NotInstalled` and tell the user
    /// to install something they already have; instead the bridge connects and
    /// surfaces the login instruction, and session calls fail with the agent's
    /// own "Authentication required" text until `agent login` is run.
    async fn initialize(&self) -> Result<(), String> {
        let result = self
            .send_request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        // The agent does its own file and terminal IO; the relay
                        // is a transport, not an editor host.
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": {
                        "name": "agent-relay",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
            .await?;

        *self.capabilities.lock().await = protocol::AgentCapabilities::from_initialize(&result);

        let auth_methods = result
            .get("authMethods")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if auth_methods.is_empty() {
            self.authenticated.store(true, Ordering::Relaxed);
            return Ok(());
        }

        let method_id = auth_methods
            .first()
            .and_then(|method| method.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        match self
            .send_request("authenticate", json!({ "methodId": method_id }))
            .await
        {
            Ok(_) => {
                self.authenticated.store(true, Ordering::Relaxed);
                Ok(())
            }
            Err(error) => {
                // Not fatal: connect anyway and tell the user what to run.
                //
                // On `warn`, not the provider's own channel: a line filed under
                // `cursor` is treated as subprocess chatter and filtered out of
                // the audit view, and this is the one instruction that unblocks
                // the provider. And the command names the BINARY — `cursor` is
                // the relay's key for it, not something the user can run.
                let mut relay = self.state.write().await;
                relay.push_log(
                    "warn",
                    format!(
                        "{} is not authenticated ({error}). Run `{} login`, then reconnect.",
                        self.display_name, self.binary_name
                    ),
                );
                relay.notify();
                Ok(())
            }
        }
    }

    pub(crate) async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.send_request_with_timeout(method, params, ACP_REQUEST_TIMEOUT_SECS)
            .await
    }

    async fn send_request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
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
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }))
            .await
        {
            self.pending_responses.lock().await.remove(&request_id_key);
            return Err(error);
        }

        match timeout(Duration::from_secs(timeout_secs), receiver).await {
            Ok(result) => result.map_err(|_| {
                format!(
                    "{} dropped the response channel for `{method}`",
                    self.display_name
                )
            })?,
            Err(_) => {
                self.pending_responses.lock().await.remove(&request_id_key);
                Err(format!(
                    "{} timed out waiting for `{method}`",
                    self.display_name
                ))
            }
        }
    }

    /// Fire a JSON-RPC notification (no id, no response expected).
    pub(crate) async fn send_notification(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(), String> {
        self.send_json(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn send_json(&self, value: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        rpc::write_line(&mut **stdin, &value, self.display_name).await
    }

    fn mint_turn_id(&self) -> String {
        format!(
            "acp-turn-{}",
            self.next_turn_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// Cache the model catalog that rides along on `session/new` / `session/load`.
    /// `from_new_session` marks a `session/new` answer, whose `currentModelId` is
    /// the model a FRESH session starts on — the provider's default. A
    /// `session/load` reports that conversation's own model, so treating it as
    /// the default would make opening one old thread change what every later new
    /// session starts on.
    async fn absorb_catalog(&self, result: &Value, from_new_session: bool) {
        let Some(models) = result.get("models") else {
            return;
        };
        let available = models
            .get("availableModels")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if available.is_empty() {
            return;
        }
        let current = from_new_session
            .then(|| models.get("currentModelId").and_then(Value::as_str))
            .flatten();
        let options = protocol::model_options(&available, current, self.provider_name);
        write_cached_models(&models_cache_path(self.provider_name), &options);
        *self.models.lock().await = options;
    }

    /// The absolute cwd for a session, hydrating from `session/list` if the
    /// relay has not seen this session in this process.
    ///
    /// `session/load` requires an absolute cwd, and after a restart the session
    /// map is empty — so a cold thread has to recover its cwd from the listing
    /// rather than silently sending `""`, which loads an empty, path-scope
    /// invalid session.
    async fn resolve_cwd(&self, thread_id: &str) -> Result<String, String> {
        if let Some(cwd) = self
            .sessions
            .lock()
            .await
            .get(thread_id)
            .map(|session| session.cwd.clone())
            .filter(|cwd| !cwd.is_empty())
        {
            return Ok(cwd);
        }

        // Cold: refresh the listing, which caches every cwd it reports.
        self.list_threads(usize::MAX).await?;

        self.sessions
            .lock()
            .await
            .get(thread_id)
            .map(|session| session.cwd.clone())
            .filter(|cwd| !cwd.is_empty())
            .ok_or_else(|| {
                format!(
                    "{} did not report a working directory for session `{thread_id}`",
                    self.display_name
                )
            })
    }
}

impl AcpBridge {
    /// Build a bridge whose peer is an in-memory duplex instead of a process.
    ///
    /// Exists so the request/turn lifecycle can be driven against a scripted
    /// agent: send failures and stream death are the two paths a live
    /// `cursor-agent` cannot be asked to produce on demand, and they are exactly
    /// where a turn can be stranded.
    #[cfg(test)]
    pub(crate) fn for_test(
        state: Arc<RwLock<RelayState>>,
        outbound: impl tokio::io::AsyncWrite + Send + Unpin + 'static,
        inbound: impl tokio::io::AsyncRead + Send + Unpin + 'static,
        provider_key: &'static str,
    ) -> Self {
        let pending_responses: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        let captures: Captures = Arc::new(Mutex::new(HashMap::new()));
        let stdin: Outbound = Arc::new(Mutex::new(Box::new(outbound)));

        rpc::spawn_stdout_reader(rpc::ReaderContext {
            stdout: Box::new(inbound),
            stdin: stdin.clone(),
            pending_responses: pending_responses.clone(),
            state: state.clone(),
            sessions: sessions.clone(),
            captures: captures.clone(),
            provider_key,
        });

        Self {
            _child: None,
            stdin,
            pending_responses,
            next_request_id: AtomicU64::new(1),
            next_turn_id: AtomicU64::new(1),
            state,
            provider_name: provider_key,
            display_name: "TestAgent",
            // Deliberately different from the provider key, which is the whole
            // point of the field.
            binary_name: "cursor-agent",
            sessions,
            captures,
            models: Arc::new(Mutex::new(Vec::new())),
            load_locks: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(protocol::AgentCapabilities::default())),
            authenticated: AtomicBool::new(true),
        }
    }

    #[cfg(test)]
    pub(crate) async fn initialize_for_test(&self) -> Result<(), String> {
        self.initialize().await
    }

    #[cfg(test)]
    pub(crate) async fn seed_session_for_test(&self, thread_id: &str, cwd: &str) {
        self.sessions.lock().await.insert(
            thread_id.to_string(),
            SessionRuntime {
                cwd: cwd.to_string(),
                approval_policy: "on-request".to_string(),
                // Every caller of this helper then drives a turn on it.
                attached: true,
                ..Default::default()
            },
        );
    }

    #[cfg(test)]
    #[cfg(test)]
    pub(crate) async fn set_session_turn_for_test(&self, thread_id: &str, turn_id: Option<&str>) {
        if let Some(session) = self.sessions.lock().await.get_mut(thread_id) {
            session.turn_id = turn_id.map(str::to_string);
        }
    }

    pub(crate) async fn seed_session_with_policy_for_test(
        &self,
        thread_id: &str,
        cwd: &str,
        approval_policy: &str,
    ) {
        self.sessions.lock().await.insert(
            thread_id.to_string(),
            SessionRuntime {
                cwd: cwd.to_string(),
                approval_policy: approval_policy.to_string(),
                attached: true,
                ..Default::default()
            },
        );
    }

    /// Absorb a thread the way a `session/list` response does: a cwd cached for
    /// a LATER `session/load`, not a session this connection has opened.
    #[cfg(test)]
    pub(crate) async fn absorb_listing_for_test(&self, thread_id: &str, cwd: &str) {
        let listed = ThreadSummaryView {
            workspace_trusted: false,
            id: thread_id.to_string(),
            name: None,
            preview: String::new(),
            cwd: cwd.to_string(),
            updated_at: crate::state::unix_now(),
            source: "cursor".to_string(),
            status: "idle".to_string(),
            model_provider: "cursor".to_string(),
            provider: "cursor".to_string(),
            forked_from: None,
            renamed: false,
        };
        absorb_thread_cwds(&mut *self.sessions.lock().await, &[listed]);
    }

    #[cfg(test)]
    pub(crate) async fn mark_session_content_for_test(&self, thread_id: &str) {
        if let Some(session) = self.sessions.lock().await.get_mut(thread_id) {
            session.has_content = true;
        }
    }

    #[cfg(test)]
    pub(crate) async fn allow_session_load_for_test(&self) {
        self.capabilities.lock().await.load_session = true;
    }

    #[cfg(test)]
    pub(crate) async fn has_capture_for_test(&self, thread_id: &str) -> bool {
        self.captures.lock().await.contains_key(thread_id)
    }

    #[cfg(test)]
    pub(crate) async fn session_turn_for_test(&self, thread_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .await
            .get(thread_id)
            .and_then(|session| session.turn_id.clone())
    }

    async fn load_lock(&self, thread_id: &str) -> Arc<Mutex<()>> {
        self.load_locks
            .lock()
            .await
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Push the relay's model selection onto the session, if it differs.
    ///
    /// Measured: `session/set_model {sessionId, modelId}` is the method Cursor
    /// implements (`session/set_config` and `session/select_model` both answer
    /// "Method not found"). Failure is surfaced rather than swallowed — the
    /// relay records the selection as applied, so silently running a different
    /// model would make the UI lie about what answered.
    async fn apply_model(&self, thread_id: &str, model: &str) -> Result<(), String> {
        let Some(target) = self
            .sessions
            .lock()
            .await
            .get(thread_id)
            .map(|session| session.model_change_needed(model))
            .unwrap_or_else(|| SessionRuntime::default().model_change_needed(model))
        else {
            return Ok(());
        };

        // A model this agent does not offer is not a selection for it — the
        // relay's session defaults carry another provider's id until this
        // provider's picker has been populated, and a catalog refresh can drop a
        // model a cached selection still names. Skipping keeps the turn alive,
        // but it is a DISCREPANCY: the relay records the requested model as the
        // thread's, so saying nothing would leave the UI naming a model that
        // never answered. Logged on a relay-owned channel so the audit view
        // shows it rather than filtering it as provider chatter.
        if !protocol::model_is_known(&self.models.lock().await, &target) {
            let effective = self
                .sessions
                .lock()
                .await
                .get(thread_id)
                .map(|session| session.model.clone())
                .filter(|model| !model.is_empty())
                .unwrap_or_else(|| "the agent's own default".to_string());
            let mut relay = self.state.write().await;
            relay.push_log(
                "warn",
                format!(
                    "{} does not offer `{target}`; `{thread_id}` is running {effective} instead.",
                    self.display_name
                ),
            );
            relay.notify();
            return Ok(());
        }

        self.send_request(
            "session/set_model",
            json!({ "sessionId": thread_id, "modelId": target }),
        )
        .await
        .map_err(|error| {
            format!(
                "{} could not switch `{thread_id}` to model `{target}`: {error}",
                self.display_name
            )
        })?;

        self.sessions
            .lock()
            .await
            .entry(thread_id.to_string())
            .or_default()
            .model = target;
        Ok(())
    }

    /// Re-assert the relay's current policy on the session, as codex and claude
    /// both do per turn: `SessionRuntime.approval_policy` decides
    /// `session/request_permission`, and only `start_thread`/`resume_thread`
    /// write it — so it is stale whenever a policy change skipped those (the
    /// relay already read `bypass`) and absent after a restart. Both read as
    /// "YOLO still asks for permission". No settings means nothing to assert;
    /// inventing a default here could only widen the turn.
    async fn sync_thread_policy(&self, thread_id: &str) -> Result<(), String> {
        let settings = {
            let relay = self.state.read().await;
            relay.thread_settings(thread_id)
        };
        let Some(settings) = settings else {
            return Ok(());
        };

        let mode = protocol::acp_mode_for_policy(&settings.approval_policy, &settings.sandbox);
        let needs_mode_push = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions.entry(thread_id.to_string()).or_default();
            session.approval_policy = settings.approval_policy.clone();
            session.required_mode = (mode != protocol::MODE_AGENT).then_some(mode);
            // Only a restriction is worth a round trip; pinning `agent` would
            // fight an agent that entered plan mode on its own.
            mode != protocol::MODE_AGENT && session.mode != mode
        };

        if needs_mode_push {
            self.apply_mode(thread_id, &settings.approval_policy, &settings.sandbox)
                .await?;
        }
        Ok(())
    }

    /// Put the session into the mode the relay's policy demands.
    ///
    /// Failing to *restrict* is fatal: the caller (a reviewer thread, a workflow
    /// step) is relying on the thread being read-only, and running it as a full
    /// agent instead would let it edit the very artifact it was asked to judge.
    /// Failing to *relax* is only an inconvenience, so it warns and continues.
    ///
    /// Note this is prompt/tool-level containment, not OS isolation — see the
    /// provider capability note in `state/app/review.rs`.
    async fn apply_mode(
        &self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String> {
        let mode = protocol::acp_mode_for_policy(approval_policy, sandbox);
        let outcome = self
            .send_request(
                "session/set_mode",
                json!({ "sessionId": thread_id, "modeId": mode }),
            )
            .await;

        {
            // Record the requirement even if the call below fails, so a later
            // `current_mode_update` is still measured against the right target.
            let mut sessions = self.sessions.lock().await;
            let session = sessions.entry(thread_id.to_string()).or_default();
            // Only a read-only mode is a REQUIREMENT; `agent` is just the
            // default, and pinning it would fight an agent that legitimately
            // enters plan mode on its own.
            session.required_mode = (mode != protocol::MODE_AGENT).then_some(mode);
            if outcome.is_ok() {
                session.mode = mode.to_string();
            }
        }

        match outcome {
            Ok(_) => Ok(()),
            Err(error) if mode == protocol::MODE_AGENT => {
                let mut relay = self.state.write().await;
                relay.push_log(
                    self.provider_name,
                    format!("Could not restore full agent mode on `{thread_id}`: {error}"),
                );
                relay.notify();
                Ok(())
            }
            Err(error) => Err(format!(
                "{} could not enter read-only `{mode}` mode for `{thread_id}` ({error}); \
                 refusing to start an unconfined session for a read-only request",
                self.display_name
            )),
        }
    }
}

/// A thread row for a session that exists but has no content yet.
fn empty_thread_sync(thread_id: &str, cwd: &str, provider_key: &'static str) -> ThreadSyncData {
    ThreadSyncData {
        thread: ThreadSummaryView {
            workspace_trusted: false,
            id: thread_id.to_string(),
            name: None,
            preview: String::new(),
            cwd: cwd.to_string(),
            updated_at: crate::state::unix_now(),
            source: provider_key.to_string(),
            status: "idle".to_string(),
            model_provider: provider_key.to_string(),
            provider: provider_key.to_string(),
            forked_from: None,
            renamed: false,
        },
        status: "idle".to_string(),
        active_flags: Vec::new(),
        transcript: Vec::new(),
    }
}

/// Record the mode and model a `session/new` or `session/load` reports.
///
/// Cursor persists both with the session — measured to survive a reload and a
/// process restart — so the response is authoritative about what the session is
/// actually set to. Recording it stops a resume from re-pushing a model that is
/// already in place, and gives drift detection a baseline before the first
/// `current_mode_update`. A response that carries neither leaves what we knew.
pub(crate) fn absorb_session_settings(session: &mut SessionRuntime, result: &Value) {
    if let Some(mode) = result
        .get("modes")
        .and_then(|modes| modes.get("currentModeId"))
        .and_then(Value::as_str)
        .filter(|mode| !mode.is_empty())
    {
        session.mode = mode.to_string();
    }
    if let Some(model) = result
        .get("models")
        .and_then(|models| models.get("currentModelId"))
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
    {
        session.model = model.to_string();
    }
}

/// Read a previously harvested model catalog.
///
/// ACP has no standalone catalog method — `availableModels` rides on
/// `session/new` — so a fresh process has nothing to show in the model picker
/// until the user has already created a thread. Caching the catalog moves that
/// empty window to the very first ACP session ever, instead of the first one
/// after every restart.
///
/// A missing or unreadable cache is *absence*, never an error: it degrades to
/// exactly the uncached behaviour, and a stale file must not block startup.
pub(crate) fn read_cached_models(path: &std::path::Path) -> Vec<ModelOptionView> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Persist the catalog harvested from `session/new`. Best-effort: a failed write
/// only costs the next process an empty picker.
pub(crate) fn write_cached_models(path: &std::path::Path, models: &[ModelOptionView]) {
    if models.is_empty() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(encoded) = serde_json::to_string(models) {
        let _ = std::fs::write(path, encoded);
    }
}

/// Where a provider's catalog cache lives — beside the relay's own state file.
pub(crate) fn models_cache_path(provider_key: &str) -> std::path::PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    crate::state_paths::state_dir(&cwd).join(format!("acp-models-{provider_key}.json"))
}

/// Seed session cwds from a `session/list` response.
///
/// Fills gaps only: a session the relay opened itself already knows its cwd
/// first-hand, and a listing must not overwrite that (or reset the approval
/// policy that rides on the same record).
pub(crate) fn absorb_thread_cwds(
    sessions: &mut HashMap<String, SessionRuntime>,
    threads: &[ThreadSummaryView],
) {
    for thread in threads {
        if thread.cwd.is_empty() {
            continue;
        }
        let entry = sessions.entry(thread.id.clone()).or_default();
        if entry.cwd.is_empty() {
            entry.cwd = thread.cwd.clone();
        }
        // Being listed IS the evidence of content: the agent only returns
        // sessions that have some (an un-prompted one is not listed and cannot
        // be loaded). Without this the entry created here would default to
        // "empty" and make every cold thread read back as blank.
        entry.has_content = true;
    }
}

#[async_trait]
impl ProviderBridge for AcpBridge {
    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        // Optional in ACP. An agent without it simply has no history to offer;
        // the relay still drives sessions it starts itself, so this is an empty
        // list rather than an error.
        //
        // Measured: Cursor lists only sessions that have CONTENT — a
        // `session/new` that was never prompted does not come back, so a thread
        // created and abandoned before its first turn will not survive a relay
        // restart. Same shape as Claude's deferred start. It also means the
        // pagination below cannot be reached by creating empty sessions; 132 of
        // them still came back as one page with no `nextCursor`.
        if !self.capabilities.lock().await.list_sessions {
            return Ok(Vec::new());
        }
        let now = crate::state::unix_now();
        let mut threads: Vec<ThreadSummaryView> = Vec::new();
        let mut cursor: Option<String> = None;

        // `session/list` is cursor-paginated. Stopping at the first page hides
        // later threads AND leaves their cwd uncached, so `resolve_cwd` cannot
        // reload them after a restart. Bounded so an agent that always hands
        // back a cursor cannot spin the bridge forever.
        for _ in 0..MAX_LIST_PAGES {
            let params = match &cursor {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            let result = self.send_request("session/list", params).await?;
            threads.extend(
                result
                    .get("sessions")
                    .and_then(Value::as_array)
                    .map(|sessions| {
                        sessions
                            .iter()
                            .filter_map(|session| {
                                protocol::thread_summary(session, self.provider_name, now)
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
            );
            match protocol::next_list_cursor(&result) {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        // Cache before truncating: a session outside the requested window still
        // needs its cwd on hand for a later `session/load`.
        absorb_thread_cwds(&mut *self.sessions.lock().await, &threads);

        threads.truncate(limit);
        Ok(threads)
    }

    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        Ok(self.models.lock().await.clone())
    }

    /// `system_prompt` is IGNORED. ACP's `session/new` carries `cwd` and
    /// `mcpServers` and nothing resembling an instruction field. (The
    /// `mcpServers` array IS the hook a future toolset would use — it is
    /// hardcoded empty here.) Not smuggled in as a user turn: see
    /// `StartThreadRequest::system_prompt`.
    async fn start_thread(&self, request: StartThreadRequest) -> Result<StartThreadResult, String> {
        let cwd = request.cwd.as_str();
        let model = request.model.as_str();
        let approval_policy = request.approval_policy.as_str();
        let sandbox = request.sandbox.as_str();
        let result = self
            .send_request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
            .await?;

        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{} returned no sessionId", self.display_name))?
            .to_string();

        self.absorb_catalog(&result, true).await;

        {
            let mut runtime = SessionRuntime {
                cwd: cwd.to_string(),
                approval_policy: approval_policy.to_string(),
                // `session/new` just opened it on this connection.
                attached: true,
                ..Default::default()
            };
            // Whatever `session/new` chose, until the relay says otherwise.
            absorb_session_settings(&mut runtime, &result);
            self.sessions
                .lock()
                .await
                .insert(session_id.clone(), runtime);
        }

        self.apply_mode(&session_id, approval_policy, sandbox)
            .await?;
        self.apply_model(&session_id, model).await?;

        Ok(StartThreadResult {
            thread: ThreadSummaryView {
                workspace_trusted: false,
                id: session_id,
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: crate::state::unix_now(),
                source: self.provider_name.to_string(),
                status: "idle".to_string(),
                model_provider: self.provider_name.to_string(),
                provider: self.provider_name.to_string(),
                forked_from: None,
                renamed: false,
            },
            consumed_initial_prompt: false,
            initial_user_message: None,
            started_turn_id: None,
        })
    }

    async fn resume_thread(
        &self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String> {
        // Same lock as `read_thread`: two replays into one session would
        // overwrite each other's capture and leak replay events into live state.
        let lock = self.load_lock(thread_id).await;
        let _guard = lock.lock().await;

        // A resume is "re-attach, then apply policy". The re-attach is only
        // needed for a session this process is not already streaming. Replaying
        // one that IS streaming would swallow the live turn's updates into the
        // capture AND advance the shared item ordinals, so the next live id
        // would no longer match the id the same item gets on a cold read — the
        // fork anchors drift. Policy is applied either way.
        let needs_load = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(thread_id)
                // An un-prompted session has nothing to replay and cannot be
                // loaded at all; a streaming one must not be replayed over.
                .map(|session| session.has_content && session.can_replay_into())
                .unwrap_or(true)
        };

        if needs_load {
            let cwd = self.resolve_cwd(thread_id).await?;
            {
                // Reset before replaying, exactly as `read_thread` does: the
                // replay renumbers from 1, so the counters must start there or a
                // resumed thread's next live id drifts past the id the same item
                // gets on a cold read.
                let mut sessions = self.sessions.lock().await;
                let session = sessions.entry(thread_id.to_string()).or_default();
                session.reset_for_replay();
                if session.cwd.is_empty() {
                    session.cwd = cwd.clone();
                }
            }
            // A resume replays the whole conversation; capture and discard it so
            // it does not double-write the transcript the relay already holds.
            let _capture = CaptureGuard::install(self.captures.clone(), thread_id).await;

            let result = self
                .send_request(
                    "session/load",
                    json!({ "sessionId": thread_id, "cwd": cwd, "mcpServers": [] }),
                )
                .await;

            let result = result?;
            self.absorb_catalog(&result, false).await;
            {
                let mut sessions = self.sessions.lock().await;
                let session = sessions.entry(thread_id.to_string()).or_default();
                absorb_session_settings(session, &result);
                session.has_content = true;
                // The replay landed, so this connection now holds it.
                session.attached = true;
            }
        }

        // Unconditional: a resume that relaxes a thread from read-only back to
        // workspace-write has to move the session out of `plan`, and only
        // setting the non-default mode would strand it there forever.
        self.apply_mode(thread_id, approval_policy, sandbox).await?;

        let mut sessions = self.sessions.lock().await;
        sessions
            .entry(thread_id.to_string())
            .or_default()
            .approval_policy = approval_policy.to_string();
        Ok(())
    }

    /// An attached session is promptable whatever the agent says about replaying
    /// it. A cold one really does need the load, so it falls through.
    async fn session_can_take_a_turn(&self, thread_id: &str) -> bool {
        if let Some(session) = self.sessions.lock().await.get(thread_id) {
            if session.attached {
                return true;
            }
        }
        self.read_thread(thread_id).await.is_ok()
    }

    async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String> {
        // Codex and Claude both answer `read_thread` out of an RPC *response*,
        // so a read never disturbs the live event stream. ACP has no such
        // method — `session/load` answers by replaying over the same
        // notification channel a running turn is using — so the equivalent
        // guarantee has to be reconstructed here.
        //
        // While a turn is in flight, the relay's own runtime already holds this
        // session's complete transcript (the bridge wrote every event into it),
        // and every caller of `ThreadSyncData.transcript` either merges by item
        // id or prefers `runtime.transcript_views()` already. So serve that,
        // and leave the wire alone.
        let lock = self.load_lock(thread_id).await;
        let _guard = lock.lock().await;

        // Checked before the capability gate on purpose: serving the relay's own
        // runtime issues no `session/load`, so an agent without `loadSession`
        // can still have a streaming thread read.
        if let Some(data) =
            rpc::sync_data_from_runtime(&*self.state.read().await, thread_id, self.provider_name)
        {
            return Ok(data);
        }

        // A session the relay opened but never prompted has no content, and the
        // agent answers `Session "…" not found` for it. That is an empty thread,
        // not a failure — Claude short-circuits its pending threads the same way.
        let (known, has_content, cwd_hint) = {
            let sessions = self.sessions.lock().await;
            match sessions.get(thread_id) {
                Some(session) => (true, session.has_content, session.cwd.clone()),
                None => (false, false, String::new()),
            }
        };
        if known && !has_content {
            return Ok(empty_thread_sync(thread_id, &cwd_hint, self.provider_name));
        }

        if !self.capabilities.lock().await.load_session {
            return Err(format!(
                "{} does not support loading a session, so its history cannot be read",
                self.display_name
            ));
        }

        let cwd = self.resolve_cwd(thread_id).await?;

        {
            let mut sessions = self.sessions.lock().await;
            let session = sessions.entry(thread_id.to_string()).or_default();
            if !session.can_replay_into() {
                return Err(format!(
                    "{} cannot reload `{thread_id}` while its turn is still running",
                    self.display_name
                ));
            }
            session.reset_for_replay();
        }
        let capture = CaptureGuard::install(self.captures.clone(), thread_id).await;

        let result = self
            .send_request(
                "session/load",
                json!({ "sessionId": thread_id, "cwd": cwd, "mcpServers": [] }),
            )
            .await;

        let transcript = capture.take().await;
        let result = result?;
        self.absorb_catalog(&result, false).await;
        {
            let mut sessions = self.sessions.lock().await;
            let session = sessions.entry(thread_id.to_string()).or_default();
            absorb_session_settings(session, &result);
            session.has_content = true;
            // Without this the next probe pays for the whole replay again.
            session.attached = true;
        }

        let preview = transcript
            .iter()
            .rev()
            .find_map(|entry| entry.text.clone())
            .unwrap_or_default();

        Ok(ThreadSyncData {
            thread: ThreadSummaryView {
                workspace_trusted: false,
                id: thread_id.to_string(),
                name: None,
                preview,
                cwd,
                updated_at: crate::state::unix_now(),
                source: self.provider_name.to_string(),
                status: "idle".to_string(),
                model_provider: self.provider_name.to_string(),
                provider: self.provider_name.to_string(),
                forked_from: None,
                renamed: false,
            },
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript,
        })
    }

    async fn read_thread_entry_detail(
        &self,
        thread_id: &str,
        item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        // ACP has no per-item read; the whole conversation is the unit. Reload
        // and pick the item out of the replay.
        let data = self.read_thread(thread_id).await?;
        Ok(data
            .transcript
            .into_iter()
            .find(|entry| entry.item_id.as_deref() == Some(item_id)))
    }

    async fn archive_thread(&self, _thread_id: &str) -> Result<(), String> {
        // No ACP method, and no relay-side stand-in either. This used to answer
        // `Ok(())` on the theory that the relay hides the thread on its own
        // side, but archive only drops the row from the in-memory list — the
        // very next `session/list` handed it straight back, so the user got a
        // "Session archived" message next to a session that had not moved.
        // Refusing is what `supports_archive` reports, and the surfaces gate on
        // that; this is the backstop for a caller that asks anyway.
        Err(format!(
            "{} does not support archiving sessions",
            self.display_name
        ))
    }

    /// ACP itself has no delete, so this goes to the vendor's local store —
    /// see [`crate::acp_local`]. Blocking file I/O, so it is handed to the
    /// blocking pool the same way Codex's local delete is.
    async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        let provider_name = self.provider_name;
        let display_name = self.display_name;
        let thread_id = thread_id.to_string();
        let forget_key = thread_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::acp_local::delete_thread_permanently(provider_name, display_name, &thread_id)
        })
        .await
        .map_err(|error| format!("local ACP session delete task failed: {error}"))?;
        settle_delete(&self.sessions, &forget_key, &result).await;
        result
    }

    async fn delete_owned_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<Option<LocalThreadDeleteSummary>, String> {
        let provider_name = self.provider_name;
        let display_name = self.display_name;
        let thread_id = thread_id.to_string();
        let forget_key = thread_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::acp_local::delete_thread_permanently_if_present(
                provider_name,
                display_name,
                &thread_id,
            )
        })
        .await
        .map_err(|error| format!("local ACP session delete task failed: {error}"))?;
        settle_delete(&self.sessions, &forget_key, &result).await;
        result
    }

    async fn start_turn(
        &self,
        thread_id: &str,
        text: &str,
        model: &str,
        _effort: &str,
        images: &[ProviderImage],
    ) -> Result<Option<String>, String> {
        // `promptCapabilities.image` is optional. Dropping the blocks silently
        // would leave "[Attached image]" in the transcript beside an answer the
        // agent gave without ever seeing the image — refuse the turn rather than
        // succeed on a different question than the user asked. Checked before
        // anything is recorded so a rejected turn leaves no trace.
        if !images.is_empty() && !self.capabilities.lock().await.prompt_images {
            return Err(format!(
                "{} did not negotiate image prompts, so it cannot accept attachments",
                self.display_name
            ));
        }

        // Before the prompt, not after: the model is session config, so it has
        // to be in place for this turn rather than the next one. Reasoning
        // effort has no separate axis here — ACP model ids encode it (see
        // `protocol::model_effort`), so it rides along inside `model`.
        self.apply_model(thread_id, model).await?;
        // Same reason: this turn's permissions must be decided against the
        // policy the relay holds now.
        self.sync_thread_policy(thread_id).await?;

        let turn_id = self.mint_turn_id();

        let user_item_id = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions.entry(thread_id.to_string()).or_default();
            session.turn_id = Some(turn_id.clone());
            // From here the session is loadable; before it, the agent has
            // nothing to replay and refuses the id outright.
            session.has_content = true;
            session.close_streams();
            session.next_item_id("user")
        };

        // ACP emits `user_message_chunk` only on replay, so the live user turn
        // is the relay's to record.
        if let Some(display) = crate::provider::user_message_transcript_text(text, images.len()) {
            let mut relay = self.state.write().await;
            rpc::apply_user_message(
                &mut relay,
                thread_id,
                user_item_id,
                display,
                turn_id.clone(),
                self.provider_name,
            );
            relay.notify();
        }

        let mut blocks = vec![json!({ "type": "text", "text": text })];
        for image in images {
            blocks.push(json!({
                "type": "image",
                "mimeType": image.media_type,
                "data": image.data,
            }));
        }

        Ok(Some(
            self.dispatch_prompt(thread_id, turn_id, blocks).await?,
        ))
    }

    async fn request_turn_stop(
        &self,
        thread_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<(), String> {
        // Session-scoped, like Claude: ACP cancels the session's in-flight turn
        // and there is no turn addressing to pass along.
        self.send_notification("session/cancel", json!({ "sessionId": thread_id }))
            .await
    }

    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        // Plans and permissions share this method and the same `result.outcome`
        // envelope, but not its vocabulary: a permission is answered with a
        // `selected` optionId chosen from the list the agent offered, a plan
        // with `accepted`/`rejected`/`cancelled`. The discriminator is the
        // relay-minted id prefix — see `protocol::PLAN_APPROVAL_PREFIX` for why
        // it is not "the pending has no options".
        let outcome = if protocol::is_plan_approval(&pending.request_id) {
            protocol::plan_outcome(input.decision)
        } else {
            let options = pending
                .requested_permissions
                .as_ref()
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            match protocol::approval_option_id(input, &options) {
                Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
                // Nothing matched — cancel rather than leave the agent parked.
                None => json!({ "outcome": "cancelled" }),
            }
        };

        self.send_json(json!({
            "jsonrpc": "2.0",
            "id": pending.raw_request_id,
            "result": { "outcome": outcome },
        }))
        .await
    }

    async fn respond_to_ask_user_question(
        &self,
        _request_id: &str,
        _answers: &serde_json::Map<String, Value>,
    ) -> Result<(), String> {
        Err(format!(
            "{} does not support AskUserQuestion over ACP",
            self.display_name
        ))
    }

    fn provider_name(&self) -> &'static str {
        self.provider_name
    }
}

impl AcpBridge {
    /// Fire `session/prompt` without awaiting it.
    ///
    /// Unlike codex's `turn/start`, an ACP prompt is a long-running *request*
    /// that only answers when the turn ends. Awaiting it inline would block the
    /// caller for the whole turn, so the response is finalized on a task and the
    /// turn id is handed back immediately.
    async fn dispatch_prompt(
        &self,
        thread_id: &str,
        turn_id: String,
        blocks: Vec<Value>,
    ) -> Result<String, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request_id_key = request_id.to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending_responses
            .lock()
            .await
            .insert(request_id_key.clone(), sender);

        {
            let mut relay = self.state.write().await;
            rpc::apply_turn_started(&mut relay, thread_id, &turn_id, self.provider_name);
            relay.notify();
        }

        if let Err(error) = self
            .send_json(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/prompt",
                "params": { "sessionId": thread_id, "prompt": blocks },
            }))
            .await
        {
            // The relay was already marked working and the session already
            // holds this turn id, so a failed write has to undo both — otherwise
            // the thread is stuck "working" on a turn the agent never received,
            // with no event coming to settle it.
            self.pending_responses.lock().await.remove(&request_id_key);
            {
                let mut sessions = self.sessions.lock().await;
                if let Some(session) = sessions.get_mut(thread_id) {
                    if session.turn_id.as_deref() == Some(turn_id.as_str()) {
                        session.turn_id = None;
                    }
                    session.close_streams();
                }
            }
            let mut relay = self.state.write().await;
            rpc::apply_turn_finished(
                &mut relay,
                thread_id,
                &turn_id,
                Err(error.clone()),
                self.provider_name,
            );
            relay.notify();
            return Err(error);
        }

        let state = self.state.clone();
        let sessions = self.sessions.clone();
        let pending_responses = self.pending_responses.clone();
        let provider_key = self.provider_name;
        let display_name = self.display_name;
        let thread = thread_id.to_string();
        let finished_turn = turn_id.clone();

        tokio::spawn(async move {
            let outcome =
                match timeout(Duration::from_secs(ACP_PROMPT_TIMEOUT_SECS), receiver).await {
                    Ok(Ok(result)) => result,
                    Ok(Err(_)) => Err(format!(
                        "{display_name} dropped the turn before it finished"
                    )),
                    Err(_) => {
                        pending_responses.lock().await.remove(&request_id_key);
                        Err(format!("{display_name} turn exceeded its time limit"))
                    }
                };

            {
                let mut sessions = sessions.lock().await;
                if let Some(session) = sessions.get_mut(&thread) {
                    if session.turn_id.as_deref() == Some(finished_turn.as_str()) {
                        session.turn_id = None;
                    }
                    session.close_streams();
                }
            }

            let mut relay = state.write().await;
            rpc::apply_turn_finished(&mut relay, &thread, &finished_turn, outcome, provider_key);
            relay.notify();
        });

        Ok(turn_id)
    }
}
