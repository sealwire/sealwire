use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::{
    sync::RwLock,
    time::{timeout, Duration},
};
use tracing::warn;

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{ApprovalDecisionInput, ModelOptionView, ThreadSummaryView, TranscriptEntryView},
    state::{PendingApproval, RelayState},
};

#[derive(Clone)]
pub struct ThreadSyncData {
    pub thread: ThreadSummaryView,
    pub status: String,
    pub active_flags: Vec<String>,
    pub transcript: Vec<ProviderTranscriptEntry>,
}

/// One entry of a provider read, carrying its own provenance.
///
/// Provenance is paired with the ENTRY rather than looked up by its id, because
/// the id is exactly the thing that can be ambiguous: a read may contain a
/// provider item called `x` and an adapter-synthesized row keyed `x`, and a set of
/// names would classify both the same way — re-creating the collision the row /
/// provider split exists to represent.
#[derive(Clone, Debug)]
pub struct ProviderTranscriptEntry {
    pub view: TranscriptEntryView,
    /// What the PROVIDER calls this entry. `None` when the adapter invented it.
    /// Never sent back to a provider unless set.
    pub provider_item_id: Option<String>,
    /// The RELAY's own deterministic name for an entry the adapter invented while
    /// parsing this read. Carried separately from the view's `item_id` because the
    /// relay may have to mint a different `row_id` on a collision — after which
    /// this is the only name that still recognises the row on the NEXT read.
    pub relay_item_id: Option<String>,
}

impl ProviderTranscriptEntry {
    /// The provider named this entry, so its own id is how to address it back.
    pub fn provider_named(view: TranscriptEntryView) -> Self {
        Self {
            provider_item_id: view.item_id.clone(),
            relay_item_id: None,
            view,
        }
    }

    /// The adapter synthesized this entry while parsing the read. Its id is a
    /// relay-derived source name, not a provider one.
    pub fn relay_named(view: TranscriptEntryView) -> Self {
        Self {
            provider_item_id: None,
            relay_item_id: view.item_id.clone(),
            view,
        }
    }

    pub fn all_provider_named(views: Vec<TranscriptEntryView>) -> Vec<Self> {
        views.into_iter().map(Self::provider_named).collect()
    }
}

impl ThreadSyncData {
    /// A read whose every entry the provider named itself.
    pub fn provider_named(
        thread: ThreadSummaryView,
        status: String,
        active_flags: Vec<String>,
        transcript: Vec<TranscriptEntryView>,
    ) -> Self {
        Self {
            thread,
            status,
            active_flags,
            transcript: ProviderTranscriptEntry::all_provider_named(transcript),
        }
    }

    pub fn views(&self) -> impl Iterator<Item = &TranscriptEntryView> + '_ {
        self.transcript.iter().map(|entry| &entry.view)
    }

    pub fn to_views(&self) -> Vec<TranscriptEntryView> {
        self.views().cloned().collect()
    }

    pub fn into_views(self) -> Vec<TranscriptEntryView> {
        self.transcript
            .into_iter()
            .map(|entry| entry.view)
            .collect()
    }
}

#[derive(Clone)]
pub struct ThreadTranscriptPageData {
    pub sync: ThreadSyncData,
    pub prev_cursor: Option<usize>,
    pub paged: bool,
}

#[derive(Clone)]
pub struct StartThreadResult {
    pub thread: ThreadSummaryView,
    pub consumed_initial_prompt: bool,
    pub initial_user_message: Option<TranscriptEntryView>,
    pub started_turn_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderImage {
    pub media_type: String,
    /// Canonical base64 without a data-URL prefix.
    pub data: String,
}

impl ProviderImage {
    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.media_type, self.data)
    }
}

pub fn user_message_transcript_text(text: &str, image_count: usize) -> Option<String> {
    let image_label = match image_count {
        0 => return (!text.is_empty()).then(|| text.to_string()),
        1 => "[Attached image]".to_string(),
        count => format!("[Attached {count} images]"),
    };
    if text.is_empty() {
        Some(image_label)
    } else {
        Some(format!("{text}\n\n{image_label}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderForkCapability {
    pub native_fork: bool,
    pub native_fork_at_message: bool,
}

impl ProviderForkCapability {
    pub const REPLAY_ONLY: Self = Self {
        native_fork: false,
        native_fork_at_message: false,
    };
    /// A native fork that always branches at the thread tip (Codex).
    pub const NATIVE_TIP_ONLY: Self = Self {
        native_fork: true,
        native_fork_at_message: false,
    };
    /// A native fork that accepts a branch point (Claude `upToMessageId`).
    pub const NATIVE_AT_MESSAGE: Self = Self {
        native_fork: true,
        native_fork_at_message: true,
    };
}

pub struct ProviderForkRequest {
    pub source_thread_id: String,
    /// Branch point (transcript item id), inclusive. A bridge that cannot fork
    /// at an arbitrary point must return `Ok(None)` when this is set so the
    /// caller falls back to transcript replay, which truncates correctly.
    pub up_to_item_id: Option<String>,
    pub cwd: String,
    pub model: String,
    pub approval_policy: String,
    pub sandbox: String,
}

/// Everything a bridge needs to open a thread.
///
/// A struct rather than positional arguments because the list had grown to four
/// adjacent `&str` (swapping `approval_policy` and `sandbox` compiles silently)
/// and was about to gain a second `Option<&str>` next to `initial_prompt`. Named
/// fields make both classes of mix-up a compile error instead of a subtle
/// misconfiguration. Mirrors `ProviderForkRequest`.
pub struct StartThreadRequest {
    pub cwd: String,
    pub model: String,
    pub approval_policy: String,
    pub sandbox: String,
    /// Reasoning effort for the session this creates. Empty means "the
    /// provider's own default". Session-scoped rather than per-turn because the
    /// Claude SDK bakes it in at creation; a bridge that takes it per turn may
    /// ignore this.
    pub effort: String,
    /// A first USER turn. Visible in the transcript, and it runs a turn: the
    /// model answers it. `StartThreadResult::consumed_initial_prompt` tells the
    /// relay whether the bridge already delivered it or it still needs replay.
    pub initial_prompt: Option<String>,
    /// Persona (not a turn / not transcript). Bridges without a surface ignore it.
    pub system_prompt: Option<String>,
    /// Attach Orchestrator tools for this `device_id`. Claude → mcpServers;
    /// others may no-op. Must not half-attach.
    pub orchestrator_tools: Option<String>,
}

/// Where the sealwire MCP bridge script lives, beside the worker that is
/// actually running. One definition: two providers resolve it, and a path rule
/// kept in two places is a path rule that drifts.
pub fn sealwire_mcp_bridge_path() -> String {
    let worker = std::env::var("CLAUDE_WORKER_PATH").unwrap_or_default();
    std::path::Path::new(&worker)
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join("orchestrator-mcp.mjs").display().to_string())
        .unwrap_or_else(|| "claude-worker/orchestrator-mcp.mjs".to_string())
}

/// The relay's own URL, as the bridge subprocess must reach it.
pub fn sealwire_relay_url() -> String {
    std::env::var("SEALWIRE_RELAY_URL").unwrap_or_else(|_| {
        let port = std::env::var("PORT").unwrap_or_else(|_| "8787".to_string());
        format!("http://127.0.0.1:{port}")
    })
}

impl StartThreadRequest {
    /// The common case: no persona, no opening turn.
    pub fn new(cwd: &str, model: &str, approval_policy: &str, sandbox: &str) -> Self {
        Self {
            cwd: cwd.to_string(),
            model: model.to_string(),
            approval_policy: approval_policy.to_string(),
            sandbox: sandbox.to_string(),
            effort: String::new(),
            initial_prompt: None,
            system_prompt: None,
            orchestrator_tools: None,
        }
    }

    pub fn with_effort(mut self, effort: &str) -> Self {
        self.effort = effort.to_string();
        self
    }

    pub fn with_initial_prompt(mut self, prompt: Option<&str>) -> Self {
        self.initial_prompt = prompt.map(str::to_string);
        self
    }

    pub fn with_system_prompt(mut self, prompt: Option<String>) -> Self {
        self.system_prompt = prompt;
        self
    }

    /// Attach the Orchestrator's toolset, acting as `device_id`.
    pub fn with_orchestrator_tools(mut self, device_id: Option<String>) -> Self {
        self.orchestrator_tools = device_id;
        self
    }
}

#[async_trait]
pub trait ProviderBridge: Send + Sync {
    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String>;
    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String>;
    async fn start_thread(&self, request: StartThreadRequest) -> Result<StartThreadResult, String>;
    async fn fork_thread(
        &self,
        _request: ProviderForkRequest,
    ) -> Result<Option<StartThreadResult>, String> {
        Ok(None)
    }

    /// Must agree with `fork_thread`: the default impl replays, so the default
    /// capability claims nothing. A bridge that implements one without the
    /// other makes the UI lie about whether context is preserved.
    fn fork_capability(&self) -> ProviderForkCapability {
        ProviderForkCapability::REPLAY_ONLY
    }

    /// Must agree with `archive_thread`, which is why the default is `false`:
    /// there is no default archive to inherit, so a bridge that has not written
    /// one cannot have it advertised on its behalf.
    ///
    /// Archive is genuinely rare — Codex has a `thread/archive` RPC, ACP has no
    /// archive method at all, and Claude's bridge refuses. The relay has no
    /// stand-in to offer either: "archive" here means removing the thread from
    /// local history, and dropping the row without the provider forgetting it
    /// just means the next `list_threads` fetches it straight back. Surfaces
    /// gate the affordance on this rather than offering a control that reports
    /// success and changes nothing.
    fn supports_archive(&self) -> bool {
        false
    }
    async fn resume_thread(
        &self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String>;
    async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String>;
    /// Whether a recorded session can still be given a turn.
    ///
    /// Reading the history back is the general test but a stricter one: an agent
    /// may refuse to replay a session it can still be prompted with.
    async fn session_can_take_a_turn(&self, thread_id: &str) -> bool {
        self.read_thread(thread_id).await.is_ok()
    }
    async fn read_thread_transcript_page(
        &self,
        _thread_id: &str,
        _before: Option<usize>,
    ) -> Result<Option<ThreadTranscriptPageData>, String> {
        Ok(None)
    }
    async fn read_thread_entry_detail(
        &self,
        thread_id: &str,
        item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String>;
    async fn archive_thread(&self, thread_id: &str) -> Result<(), String>;

    /// Hand back a thread's per-session resources, keeping the conversation.
    /// Defaults to a no-op: only Claude spends a process per session.
    async fn release_thread(&self, _thread_id: &str) -> Result<(), String> {
        Ok(())
    }
    async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String>;
    /// Delete a thread whose ownership by this provider was recorded when the
    /// task seat was created. `None` means it was already absent, which makes a
    /// crash-retried task delete idempotent without weakening ordinary Session
    /// deletion or guessing across providers.
    async fn delete_owned_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<Option<LocalThreadDeleteSummary>, String> {
        self.delete_thread_permanently(thread_id).await.map(Some)
    }
    async fn start_turn(
        &self,
        thread_id: &str,
        text: &str,
        model: &str,
        effort: &str,
        images: &[ProviderImage],
    ) -> Result<Option<String>, String>;
    /// Resolve the public thread id after `start_turn`. Providers whose first
    /// turn promotes a placeholder id (Claude deferred start) override this.
    async fn resolve_started_thread_id(&self, requested_thread_id: &str) -> String {
        requested_thread_id.to_string()
    }
    /// Request that the provider stop the in-flight work for `thread_id`.
    ///
    /// Providers with turn-scoped cancellation (Codex) require `turn_id`.
    /// Providers with session-scoped cancellation (Claude) may stop by thread
    /// alone. Acceptance is not proof of completion; provider lifecycle events
    /// remain the source of truth for relay runtime state.
    async fn request_turn_stop(&self, thread_id: &str, turn_id: Option<&str>)
        -> Result<(), String>;
    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String>;
    /// Submit an answer to a pending AskUserQuestion. The `answers` map is
    /// keyed by question text (matching the SDK's expected
    /// `updatedInput.answers` shape). Providers that don't support
    /// AskUserQuestion should return an error rather than silently no-op.
    async fn respond_to_ask_user_question(
        &self,
        request_id: &str,
        answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String>;
    fn provider_name(&self) -> &'static str;

    /// Whether this provider's `read_thread` reports an `updated_at` that is the
    /// thread's genuine last-activity time (resume-safe) rather than a session
    /// file mtime that a no-prompt resume bumps to ~now. Claude derives it from
    /// the transcript (see the worker's `read_session`), so the relay can
    /// max-fold it into the activity sort key — which also heals activity the
    /// relay never witnessed (e.g. the session used via the CLI between views).
    /// Providers that report a bumpable mtime return `false`; the relay then
    /// freezes their first observation (or-insert) so repeated selection can't
    /// creep the thread up the list.
    fn read_thread_reports_activity_time(&self) -> bool {
        false
    }
}

/// Which bridge implementation backs a provider entry.
///
/// This is *data on the entry*, not something inferred from the key. It used to
/// be inferred, with `spawn_provider` falling through to `CodexBridge` for any
/// unrecognized key — so a new provider that wasn't codex-app-server-compatible
/// would spawn the wrong bridge and fail in a way that pointed nowhere near the
/// cause. Making it an enum means the match is exhaustive and the compiler
/// catches a missing arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderKind {
    /// `codex app-server` — JSON-RPC over stdio, natively multi-session.
    Codex,
    /// The Node worker wrapping `@anthropic-ai/claude-agent-sdk`.
    ClaudeCode,
    /// Agent Client Protocol over stdio (`cursor-agent acp`, and any other ACP
    /// agent — the bridge is parameterized, not vendor-specific).
    Acp,
    /// In-process test double.
    Fake,
}

struct ProviderEntry {
    binary_name: &'static str,
    display_name: &'static str,
    provider_key: &'static str,
    kind: ProviderKind,
    /// Argv passed to `binary_name` to put it in protocol mode. Empty for
    /// bridges that build their own command line.
    launch_args: &'static [&'static str],
    /// Extra names accepted in `AGENT_PROVIDERS` beyond the key and binary name.
    aliases: &'static [&'static str],
}

/// Static per-provider identity captured while spawning, one entry per
/// *configured* provider (in configured order). `spawn_error` is `None` when
/// the bridge spawned OK, or the raw error string when the spawn attempt
/// failed — the string that used to be dropped on the floor at the `warn!`
/// site. The relay pairs this with the live connection map to derive a
/// `ProviderStatusView` on every snapshot.
#[derive(Debug, Clone)]
pub struct ProviderStatusBase {
    pub provider_key: String,
    pub display_name: String,
    pub spawn_error: Option<String>,
}

/// Classify a spawn-error string into "the binary isn't there" (`NotInstalled`)
/// vs. "it's there but failed" (`Failed`). Matches ONLY the canonical OS
/// exec-failure (ENOENT) signatures that `Command::spawn` surfaces — not a
/// loose "not found" substring, which wrongly caught POST-spawn RPC/handshake
/// errors like "method not found" (the binary launched, so it IS installed;
/// `initialize().await?` failed). Still a heuristic, but scoped to exec errors,
/// and it reflects whatever binary actually failed to exec (e.g. `node` for the
/// Claude worker) without needing a separate PATH probe.
pub fn classify_spawn_error(reason: &str) -> crate::protocol::ProviderStatusKind {
    let low = reason.to_ascii_lowercase();
    if low.contains("os error 2")                 // ENOENT errno (Unix + Windows)
        || low.contains("no such file or directory") // Unix ENOENT text
        || low.contains("cannot find the file")   // Windows ENOENT text
        || low.contains("program not found")
    {
        crate::protocol::ProviderStatusKind::NotInstalled
    } else {
        crate::protocol::ProviderStatusKind::Failed
    }
}

/// Directories searched for a provider binary when `$PATH` misses, in order.
///
/// `~/.local/bin` is where a vendor's install *script* puts a CLI when it is not
/// going through a package manager — `cursor-agent`'s official installer lands
/// there, as do pipx/uv-style installers. It is on `$PATH` only if the user's
/// shell profile put it there, and a profile that never did is the common case
/// (macOS ships none of it by default). The failure that produces is maximally
/// misleading: the binary IS installed and logged in, `Command::spawn` still
/// gets ENOENT, and `classify_spawn_error` faithfully reports "not installed".
///
/// This covers the relay's own exec only. A child that itself shells out by
/// bare name (the Claude worker spawning the `claude` CLI) still uses the
/// inherited `$PATH` and would need that `$PATH` augmented instead.
fn fallback_bin_dirs(home: &Path) -> [PathBuf; 1] {
    [home.join(".local").join("bin")]
}

/// The program to hand `Command::new` for `binary_name`.
///
/// `$PATH` wins and is returned as the *bare name*, so the OS keeps doing the
/// lookup and a shim the user deliberately put ahead of the vendor copy still
/// takes precedence. Only when `$PATH` has no answer does this fall back to an
/// absolute path in [`fallback_bin_dirs`]. A binary that is genuinely absent
/// stays bare, so the spawn still fails with the ENOENT text
/// [`classify_spawn_error`] keys on rather than a synthesized error.
pub(crate) fn resolve_binary(binary_name: &str) -> OsString {
    resolve_binary_within(
        binary_name,
        std::env::var_os("PATH").as_deref(),
        crate::state_paths::home_dir().as_deref(),
    )
}

/// Pure core of [`resolve_binary`], with the environment passed in — env is
/// process-global and shared across the test binary's threads, so the tests
/// must not have to mutate it.
fn resolve_binary_within(
    binary_name: &str,
    path_var: Option<&OsStr>,
    home: Option<&Path>,
) -> OsString {
    let bare = || OsString::from(binary_name);

    // Already a path, so `Command::new` would skip `$PATH` anyway. Rewriting it
    // would redirect an explicit choice.
    if binary_name.contains(['/', '\\']) {
        return bare();
    }

    // An empty `$PATH` entry means "the current directory" to a shell; leaving
    // the lookup to the OS keeps that quirk out of here, and a `$PATH` hit is
    // returned bare precisely so the OS still performs it.
    let on_path = path_var.is_some_and(|path_var| {
        std::env::split_paths(path_var)
            .filter(|dir| !dir.as_os_str().is_empty())
            .any(|dir| is_executable_file(&dir.join(binary_name)))
    });
    if on_path {
        return bare();
    }

    let Some(home) = home else {
        return bare();
    };
    fallback_bin_dirs(home)
        .into_iter()
        .map(|dir| dir.join(binary_name))
        .find(|candidate| is_executable_file(candidate))
        .map(PathBuf::into_os_string)
        .unwrap_or_else(bare)
}

/// Whether `path` is something `exec` would accept: a file (following symlinks,
/// which is the shape the cursor installer leaves behind — `~/.local/bin/x` ->
/// a versioned directory) carrying an execute bit.
fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

const DEFAULT_PROVIDERS: &[ProviderEntry] = &[
    ProviderEntry {
        binary_name: "codex",
        display_name: "Codex",
        provider_key: "codex",
        kind: ProviderKind::Codex,
        launch_args: &["app-server"],
        aliases: &[],
    },
    ProviderEntry {
        binary_name: "claude",
        display_name: "Claude Code",
        provider_key: "claude_code",
        kind: ProviderKind::ClaudeCode,
        launch_args: &[],
        aliases: &["claude-code"],
    },
    ProviderEntry {
        binary_name: "cursor-agent",
        display_name: "Cursor",
        provider_key: "cursor",
        kind: ProviderKind::Acp,
        launch_args: &["acp"],
        aliases: &["cursor-agent", "cursor_agent"],
    },
];

const FAKE_PROVIDER: ProviderEntry = ProviderEntry {
    binary_name: "fake",
    display_name: "Fake",
    provider_key: "fake",
    kind: ProviderKind::Fake,
    launch_args: &[],
    aliases: &[],
};

/// Which provider a fresh relay adopts as its own, in preference order.
///
/// Only providers with an opinion belong here; anything else falls back to
/// registry order. Claude is first because that is what a relay with everything
/// installed has always reported, and changing it would move every new user's
/// default agent without anyone deciding to.
const DEFAULT_PROVIDER_PREFERENCE: &[&str] = &["claude_code", "codex"];

/// Pick the relay's provider from the ones that actually spawned.
///
/// This used to be emergent rather than chosen: each bridge called
/// `set_provider_name` as it started, so the winner was whichever provider sat
/// last in the registry loop. That silently made the answer a function of
/// registry ORDER — so adding a provider to the end of the list, or adding the
/// "missing" call to one that lacked it, would reassign every fresh relay's
/// default agent as a side effect. It also left a cursor-only relay reporting no
/// provider at all, because the ACP bridge never made the call.
///
/// `spawned` must be in registry order so the fallback is stable.
pub(crate) fn preferred_default_provider<'a>(spawned: &[&'a str]) -> Option<&'a str> {
    DEFAULT_PROVIDER_PREFERENCE
        .iter()
        .find_map(|preferred| spawned.iter().find(|key| key == &preferred).copied())
        .or_else(|| spawned.first().copied())
}

/// The human-facing name for a provider key, for messages a user reads.
///
/// The registry already carries one per provider; without a lookup, call sites
/// end up hardcoding a single vendor's name and telling everyone else's users
/// something false. Falls back to the key so a provider added to the registry
/// but not here degrades to "cursor" rather than to a lie.
pub fn provider_display_name(provider_key: &str) -> &str {
    DEFAULT_PROVIDERS
        .iter()
        .chain(std::iter::once(&FAKE_PROVIDER))
        .find(|entry| entry.provider_key == provider_key)
        .map(|entry| entry.display_name)
        .unwrap_or(provider_key)
}

const PROVIDER_START_TIMEOUT_SECS: u64 = 30;

fn provider_start_timeout_secs() -> u64 {
    std::env::var("AGENT_RELAY_PROVIDER_START_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(PROVIDER_START_TIMEOUT_SECS)
}

fn configured_providers() -> Vec<&'static ProviderEntry> {
    let names = std::env::var("AGENT_PROVIDERS").unwrap_or_default();
    select_providers(&names)
}

/// Resolve an `AGENT_PROVIDERS` value to entries. Split out from the env read so
/// it is testable without mutating process-global state (env is shared across
/// the test binary's threads).
///
/// An empty value means "the defaults"; `fake` is reachable only by naming it.
fn select_providers(names: &str) -> Vec<&'static ProviderEntry> {
    let requested: Vec<&str> = names
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    if requested.is_empty() {
        return DEFAULT_PROVIDERS.iter().collect();
    }

    DEFAULT_PROVIDERS
        .iter()
        .chain(std::iter::once(&FAKE_PROVIDER))
        .filter(|entry| {
            requested.iter().any(|name| {
                *name == entry.provider_key
                    || *name == entry.binary_name
                    || entry.aliases.contains(name)
            })
        })
        .collect()
}

pub async fn spawn_providers(
    state: Arc<RwLock<RelayState>>,
) -> (
    HashMap<String, Arc<dyn ProviderBridge>>,
    Vec<ProviderStatusBase>,
) {
    let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
    // One entry per *configured* provider, in configured order, whether or not
    // it spawned — so the status panel can show failed providers too.
    let mut status_base: Vec<ProviderStatusBase> = Vec::new();

    for entry in configured_providers() {
        let timeout_secs = provider_start_timeout_secs();
        let result = match timeout(
            Duration::from_secs(timeout_secs),
            spawn_provider(entry, state.clone()),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(format!(
                "timed out after {timeout_secs}s while starting {}",
                entry.display_name
            )),
        };

        let spawn_error = match result {
            Ok(bridge) => {
                let name = bridge.provider_name().to_string();
                providers.insert(name, bridge);
                None
            }
            Err(error) => {
                warn!(
                    "Failed to start {} agent provider: {}",
                    entry.display_name, error
                );
                Some(error)
            }
        };
        status_base.push(ProviderStatusBase {
            provider_key: entry.provider_key.to_string(),
            display_name: entry.display_name.to_string(),
            spawn_error,
        });
    }

    // Decide the relay's provider ONCE, here, from what actually came up — the
    // bridges no longer each claim it on the way past. `status_base` is built in
    // registry order, so the fallback is stable.
    let spawned: Vec<&str> = status_base
        .iter()
        .filter(|base| base.spawn_error.is_none())
        .map(|base| base.provider_key.as_str())
        .collect();
    if let Some(default_provider) = preferred_default_provider(&spawned) {
        let mut relay = state.write().await;
        relay.set_provider_name(default_provider.to_string());
    }

    (providers, status_base)
}

async fn spawn_provider(
    entry: &'static ProviderEntry,
    state: Arc<RwLock<RelayState>>,
) -> Result<Arc<dyn ProviderBridge>, String> {
    // Exhaustive on purpose — no `_` arm. A new `ProviderKind` must be handled
    // here explicitly rather than silently inheriting another bridge.
    match entry.kind {
        ProviderKind::Fake => {
            bridge_arc(crate::fake_provider::FakeProviderBridge::spawn(state).await)
        }
        ProviderKind::ClaudeCode => bridge_arc(crate::claude::ClaudeCodeBridge::spawn(state).await),
        ProviderKind::Acp => bridge_arc(
            crate::acp::AcpBridge::spawn(
                state,
                entry.binary_name,
                entry.launch_args,
                entry.display_name,
                entry.provider_key,
            )
            .await,
        ),
        ProviderKind::Codex => bridge_arc(
            crate::codex::CodexBridge::spawn(
                state,
                entry.binary_name,
                entry.display_name,
                entry.provider_key,
            )
            .await,
        ),
    }
}

fn bridge_arc<T>(result: Result<T, String>) -> Result<Arc<dyn ProviderBridge>, String>
where
    T: ProviderBridge + 'static,
{
    result.map(|bridge| Arc::new(bridge) as Arc<dyn ProviderBridge>)
}

#[cfg(test)]
mod registry_tests {
    use super::*;

    #[test]
    fn the_default_provider_is_declared_not_an_accident_of_spawn_order() {
        // It used to be whichever provider called `set_provider_name` last
        // during boot. That is not a decision anyone made: it is the tail of a
        // `for` loop over the registry. Three measured consequences (2026-08-12,
        // fresh relay, `snapshot.provider`):
        //
        //   all three installed  -> "claude_code"   (only because cursor, which
        //                                            sorts last, never called it)
        //   cursor only          -> ""              <- a working relay reporting
        //                                              no provider at all
        //   codex + cursor       -> "codex"
        //
        // Adding the missing call to the ACP bridge — the "obvious" symmetry fix
        // — would have silently moved the all-three default from Claude to
        // Cursor, because Cursor is last in the registry. The order has to be
        // declared instead.
        assert_eq!(
            preferred_default_provider(&["codex", "claude_code", "cursor"]),
            Some("claude_code"),
            "Claude stays the default when it is available"
        );
        assert_eq!(
            preferred_default_provider(&["cursor", "claude_code", "codex"]),
            Some("claude_code"),
            "the answer must not depend on the order things spawned in"
        );

        // The case that was broken: a relay with a working provider reported none.
        assert_eq!(preferred_default_provider(&["cursor"]), Some("cursor"));

        assert_eq!(
            preferred_default_provider(&["codex", "cursor"]),
            Some("codex")
        );
        // Nothing preferred spawned: fall back to what did, in registry order.
        assert_eq!(
            preferred_default_provider(&["cursor", "fake"]),
            Some("cursor")
        );
        assert_eq!(preferred_default_provider(&[]), None);
    }

    fn entry(key: &str) -> &'static ProviderEntry {
        DEFAULT_PROVIDERS
            .iter()
            .chain(std::iter::once(&FAKE_PROVIDER))
            .find(|entry| entry.provider_key == key)
            .unwrap_or_else(|| panic!("no provider entry for `{key}`"))
    }

    #[test]
    fn every_entry_declares_the_bridge_it_wants() {
        // The regression guard for the old `_ => CodexBridge` fallthrough: a
        // provider that is not codex-app-server-compatible must never resolve
        // to the Codex bridge just because nothing else matched its key.
        assert_eq!(entry("codex").kind, ProviderKind::Codex);
        assert_eq!(entry("claude_code").kind, ProviderKind::ClaudeCode);
        assert_eq!(entry("cursor").kind, ProviderKind::Acp);
        assert_eq!(entry("fake").kind, ProviderKind::Fake);
    }

    #[test]
    fn protocol_mode_bridges_declare_launch_args() {
        // `codex` and `cursor-agent` both default to an interactive TUI; without
        // the subcommand the bridge would attach to a terminal UI and hang
        // rather than speak a protocol.
        for entry in DEFAULT_PROVIDERS {
            if matches!(entry.kind, ProviderKind::Codex | ProviderKind::Acp) {
                assert!(
                    !entry.launch_args.is_empty(),
                    "`{}` needs launch args to enter protocol mode",
                    entry.provider_key
                );
            }
        }
        assert_eq!(entry("cursor").launch_args, &["acp"]);
    }

    #[test]
    fn provider_keys_and_binaries_are_unique() {
        let all: Vec<_> = DEFAULT_PROVIDERS
            .iter()
            .chain(std::iter::once(&FAKE_PROVIDER))
            .collect();
        for (i, a) in all.iter().enumerate() {
            for b in all.iter().skip(i + 1) {
                assert_ne!(a.provider_key, b.provider_key);
                assert_ne!(a.binary_name, b.binary_name);
                // An alias must not collide with another provider's key, or
                // `AGENT_PROVIDERS` would select two bridges for one name.
                assert!(!a.aliases.contains(&b.provider_key));
                assert!(!b.aliases.contains(&a.provider_key));
            }
        }
    }

    #[test]
    fn empty_selection_is_the_defaults_and_never_fake() {
        let keys: Vec<_> = select_providers("")
            .iter()
            .map(|e| e.provider_key)
            .collect();
        assert_eq!(keys, vec!["codex", "claude_code", "cursor"]);
        assert!(select_providers("   ")
            .iter()
            .all(|e| e.provider_key != "fake"));
    }

    #[test]
    fn selection_accepts_keys_binaries_and_aliases() {
        let by_key: Vec<_> = select_providers("cursor")
            .iter()
            .map(|e| e.provider_key)
            .collect();
        assert_eq!(by_key, vec!["cursor"]);

        let by_binary: Vec<_> = select_providers("cursor-agent")
            .iter()
            .map(|e| e.provider_key)
            .collect();
        assert_eq!(by_binary, vec!["cursor"]);

        // Pre-existing claude aliases must keep working.
        for name in ["claude", "claude-code", "claude_code"] {
            let keys: Vec<_> = select_providers(name)
                .iter()
                .map(|e| e.provider_key)
                .collect();
            assert_eq!(keys, vec!["claude_code"], "alias `{name}` regressed");
        }

        let multi: Vec<_> = select_providers("fake, cursor")
            .iter()
            .map(|e| e.provider_key)
            .collect();
        assert_eq!(multi, vec!["cursor", "fake"]);
    }

    #[test]
    fn unknown_names_select_nothing_rather_than_defaulting() {
        assert!(select_providers("gemini").is_empty());
    }
}

#[cfg(test)]
mod binary_resolution_tests {
    use super::*;
    use std::fs;

    /// A file `exec` would accept, so the resolver's own executability check is
    /// exercised rather than assumed.
    fn install(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).expect("create bin dir");
        let path = dir.join(name);
        fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("write binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod +x");
        }
        path
    }

    fn path_var(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs).expect("join PATH")
    }

    fn local_bin(home: &Path) -> PathBuf {
        home.join(".local").join("bin")
    }

    #[test]
    fn a_binary_installed_only_in_local_bin_is_found_there() {
        // The reported bug, verbatim: `cursor-agent`'s installer drops the
        // binary in `~/.local/bin`, that directory is not on the user's `$PATH`,
        // and the relay logged "failed to start `cursor-agent acp`: No such file
        // or directory (os error 2)" for a CLI that was installed and logged in.
        let home = tempfile::tempdir().expect("tempdir");
        let elsewhere = tempfile::tempdir().expect("tempdir");
        let installed = install(&local_bin(home.path()), "cursor-agent");

        let resolved = resolve_binary_within(
            "cursor-agent",
            Some(path_var(&[elsewhere.path()]).as_os_str()),
            Some(home.path()),
        );

        assert_eq!(resolved, installed.into_os_string());
    }

    #[test]
    fn a_local_bin_symlink_is_followed() {
        // The real install is not a file in `~/.local/bin` but a symlink into
        // `~/.local/share/cursor-agent/versions/<v>/`, so an executability check
        // that used `symlink_metadata` would reject the actual shipped shape.
        #[cfg(unix)]
        {
            let home = tempfile::tempdir().expect("tempdir");
            let versioned = install(
                &home.path().join(".local/share/x/versions/1"),
                "cursor-agent",
            );
            let bin = local_bin(home.path());
            fs::create_dir_all(&bin).expect("create bin dir");
            let link = bin.join("cursor-agent");
            std::os::unix::fs::symlink(&versioned, &link).expect("symlink");

            let resolved = resolve_binary_within("cursor-agent", None, Some(home.path()));

            assert_eq!(resolved, link.into_os_string());
        }
    }

    #[test]
    fn path_wins_over_local_bin_and_stays_bare() {
        // Returning the bare name keeps the OS doing the lookup, so a shim the
        // user put earlier on `$PATH` still shadows the vendor copy. Resolving
        // to the first `$PATH` hit ourselves would quietly take that away.
        let home = tempfile::tempdir().expect("tempdir");
        let on_path = tempfile::tempdir().expect("tempdir");
        install(&local_bin(home.path()), "cursor-agent");
        install(on_path.path(), "cursor-agent");

        let resolved = resolve_binary_within(
            "cursor-agent",
            Some(path_var(&[on_path.path()]).as_os_str()),
            Some(home.path()),
        );

        assert_eq!(resolved, OsString::from("cursor-agent"));
    }

    #[test]
    fn a_genuinely_missing_binary_stays_bare_so_the_error_is_still_enoent() {
        // `classify_spawn_error` reads the ENOENT text out of the spawn failure.
        // Synthesizing a path for a binary that is nowhere would change that
        // message and mislabel a not-installed provider as `Failed`.
        let home = tempfile::tempdir().expect("tempdir");
        let empty = tempfile::tempdir().expect("tempdir");

        let resolved = resolve_binary_within(
            "cursor-agent",
            Some(path_var(&[empty.path()]).as_os_str()),
            Some(home.path()),
        );

        assert_eq!(resolved, OsString::from("cursor-agent"));
    }

    #[test]
    fn a_non_executable_file_in_local_bin_is_ignored() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let home = tempfile::tempdir().expect("tempdir");
            let bin = local_bin(home.path());
            fs::create_dir_all(&bin).expect("create bin dir");
            let path = bin.join("cursor-agent");
            fs::write(&path, b"not a program").expect("write");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod -x");

            let resolved = resolve_binary_within("cursor-agent", None, Some(home.path()));

            assert_eq!(resolved, OsString::from("cursor-agent"));
        }
    }

    #[test]
    fn a_directory_with_the_binarys_name_is_not_mistaken_for_it() {
        let home = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(local_bin(home.path()).join("cursor-agent")).expect("create dir");

        let resolved = resolve_binary_within("cursor-agent", None, Some(home.path()));

        assert_eq!(resolved, OsString::from("cursor-agent"));
    }

    #[test]
    fn a_name_that_is_already_a_path_is_never_rewritten() {
        // `Command::new` skips `$PATH` entirely for anything with a separator,
        // so rewriting it would redirect an explicit choice.
        let home = tempfile::tempdir().expect("tempdir");
        install(&local_bin(home.path()), "cursor-agent");

        let resolved = resolve_binary_within("./cursor-agent", None, Some(home.path()));

        assert_eq!(resolved, OsString::from("./cursor-agent"));
    }

    #[test]
    fn no_home_is_not_a_panic() {
        // Containers running as a user without `$HOME`: there is no fallback to
        // try, and the answer is the unchanged bare name.
        assert_eq!(
            resolve_binary_within("cursor-agent", None, None),
            OsString::from("cursor-agent")
        );
    }
}

#[cfg(test)]
mod classify_tests {
    use super::classify_spawn_error;
    use crate::protocol::ProviderStatusKind;

    #[test]
    fn enoent_from_command_spawn_is_not_installed() {
        assert_eq!(
            classify_spawn_error(
                "failed to start `codex app-server`: No such file or directory (os error 2)"
            ),
            ProviderStatusKind::NotInstalled
        );
    }

    #[test]
    fn post_spawn_method_not_found_is_failed_not_not_installed() {
        // These come from `initialize().await?` AFTER the binary launched, so
        // the binary IS installed and the classification must be `Failed`. A
        // loose "not found" substring used to mislabel them as `NotInstalled`.
        assert_eq!(
            classify_spawn_error("initialize failed: Method not found (-32601)"),
            ProviderStatusKind::Failed
        );
        assert_eq!(
            classify_spawn_error("handshake rejected: method not found"),
            ProviderStatusKind::Failed
        );
    }

    #[test]
    fn timeout_is_failed() {
        assert_eq!(
            classify_spawn_error("timed out after 30s while starting Codex"),
            ProviderStatusKind::Failed
        );
    }
}
