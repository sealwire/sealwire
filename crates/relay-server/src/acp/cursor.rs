use super::*;
use crate::provider::ProviderForkCapability;
use crate::state::app::TrustedWorkspace;
use futures_util::future::BoxFuture;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub(super) struct Dirs {
    /// Empty and sealwire's own, so a process started here finds no repo config.
    pub(super) neutral: PathBuf,
    /// Cursor's per-project trust markers and MCP approvals, kept apart from the user's.
    pub(super) data: PathBuf,
}

/// In the temp dir because Cursor reads `AGENTS.md`/`.cursor` from every parent; a random
/// name created exclusively, so a path or symlink pre-planted in a shared `/tmp` is refused.
pub(super) fn neutral_dir() -> Result<PathBuf, String> {
    static NEUTRAL: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    if let Some(path) = NEUTRAL.get() {
        return Ok(path.clone());
    }
    let created = create_isolated_dir(&std::env::temp_dir())?;
    // A racing initializer may have won; its dir is just as valid, ours is then orphaned.
    Ok(NEUTRAL.get_or_init(|| created).clone())
}

/// A fresh directory we own, created with `create_dir` (not `_all`) so an existing path —
/// a symlink into a repo, say — fails rather than being adopted.
fn create_isolated_dir(base: &Path) -> Result<PathBuf, String> {
    use rand::RngCore;
    for _ in 0..16 {
        let mut bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut bytes);
        let suffix: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = base.join(format!("sealwire-cursor-neutral-{suffix}"));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("could not create an isolated Cursor directory".into())
}

pub(super) async fn dirs() -> Result<Dirs, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    // Approvals persist with the state dir; Cursor never reads repo config from here.
    let data = crate::state_paths::state_dir(&cwd).join("cursor-data");
    tokio::fs::create_dir_all(&data)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Dirs {
        neutral: neutral_dir()?,
        data,
    })
}

/// Cursor reads `.cursor/` MCP servers, rules and AGENTS.md from its process folder, and
/// trust and MCP approvals from `CURSOR_DATA_DIR`; sealwire decides both.
pub(super) fn configure_launch(
    command: &mut Command,
    dirs: &Dirs,
    workspace: Option<&TrustedWorkspace>,
) {
    match workspace {
        Some(workspace) => command.current_dir(workspace.as_str()),
        None => command.current_dir(&dirs.neutral),
    };
    command.env("CURSOR_DATA_DIR", &dirs.data);
    // So closing a folder's Cursor also stops the repo's MCP servers it started.
    #[cfg(unix)]
    command.process_group(0);
}

type SpawnFolder =
    Arc<dyn Fn(TrustedWorkspace) -> BoxFuture<'static, Result<AcpBridge, String>> + Send + Sync>;

const MAX_IDLE_FOLDERS: usize = 2;
const IDLE_FOLDER_TIMEOUT: Duration = Duration::from_secs(120);

struct FolderProcess {
    bridge: Arc<AcpBridge>,
    last_used: Instant,
}

type Folders = Arc<Mutex<HashMap<String, FolderProcess>>>;
type Homes = Arc<Mutex<HashMap<String, String>>>;

/// The shared Cursor, run where it can read nothing, plus one Cursor per trusted folder
/// in use, run in that folder so its own rules and MCP servers load.
pub(crate) struct CursorBridge {
    shared: Arc<AcpBridge>,
    /// Trusted folder -> the process running in it.
    folders: Folders,
    /// Session -> the trusted folder whose process holds it.
    homes: Homes,
    /// Sessions that have taken a turn, so Cursor has persisted them and any process can
    /// `session/load` them. An unprompted session exists only in its creator's memory.
    prompted: Arc<Mutex<std::collections::HashSet<String>>>,
    spawn_folder: SpawnFolder,
}

impl CursorBridge {
    pub(crate) async fn spawn(
        state: Arc<RwLock<RelayState>>,
        binary_name: &'static str,
        launch_args: &'static [&'static str],
        display_name: &'static str,
    ) -> Result<Self, String> {
        let shared = AcpBridge::spawn_connection(
            state.clone(),
            binary_name,
            launch_args,
            display_name,
            "cursor",
            true,
            None,
        )
        .await?;
        let spawn_folder: SpawnFolder = Arc::new(move |workspace: TrustedWorkspace| {
            let state = state.clone();
            Box::pin(async move {
                approve_repo_mcp_servers(binary_name, &workspace, &state).await;
                AcpBridge::spawn_connection(
                    state,
                    binary_name,
                    launch_args,
                    display_name,
                    "cursor",
                    false,
                    Some(workspace),
                )
                .await
            })
        });
        let bridge = Self::assemble(shared, spawn_folder);
        let (folders, homes) = (
            Arc::downgrade(&bridge.folders),
            Arc::downgrade(&bridge.homes),
        );
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let (Some(folders), Some(homes)) = (folders.upgrade(), homes.upgrade()) else {
                    break;
                };
                evict_idle_folders(&folders, &homes).await;
            }
        });
        Ok(bridge)
    }

    fn assemble(shared: AcpBridge, spawn_folder: SpawnFolder) -> Self {
        Self {
            shared: Arc::new(shared),
            folders: Arc::new(Mutex::new(HashMap::new())),
            homes: Arc::new(Mutex::new(HashMap::new())),
            prompted: Arc::new(Mutex::new(std::collections::HashSet::new())),
            spawn_folder,
        }
    }

    async fn trusted(&self, cwd: &str) -> Option<TrustedWorkspace> {
        let grants = { self.shared.state.read().await.trust_grants() };
        grants.admit(cwd).await.trusted().cloned()
    }

    /// Loaded content proves Cursor persisted the session, so after a restart its first send
    /// can go to the trusted folder's process; an unprompted session reads back empty.
    async fn note_loadable(&self, bridge: &AcpBridge, id: &str) {
        let loaded = bridge
            .sessions
            .lock()
            .await
            .get(id)
            .is_some_and(|session| session.has_content);
        if loaded {
            self.prompted.lock().await.insert(id.to_string());
        }
    }

    async fn folder(&self, workspace: TrustedWorkspace) -> Result<Arc<AcpBridge>, String> {
        let key = workspace.as_str().to_string();
        let mut folders = self.folders.lock().await;
        if let Some(folder) = folders.get_mut(&key) {
            if !folder.bridge.stream_closed.load(Ordering::Acquire) {
                folder.last_used = Instant::now();
                return Ok(folder.bridge.clone());
            }
        }
        let bridge = Arc::new((self.spawn_folder)(workspace).await?);
        folders.insert(
            key,
            FolderProcess {
                bridge: bridge.clone(),
                last_used: Instant::now(),
            },
        );
        Ok(bridge)
    }

    /// The process a session lives in now, starting nothing.
    async fn current(&self, id: &str) -> Arc<AcpBridge> {
        if let Some(key) = self.homes.lock().await.get(id).cloned() {
            if let Some(folder) = self.folders.lock().await.get_mut(&key) {
                folder.last_used = Instant::now();
                return folder.bridge.clone();
            }
        }
        self.shared.clone()
    }

    /// Decided by the folder's trust every turn, so a grant or withdrawal the eager refresh
    /// missed still corrects itself here.
    async fn route(&self, id: &str) -> Result<Arc<AcpBridge>, String> {
        let current = self.current(id).await;
        // Unprompted sessions live only in their creator's memory; Cursor cannot load one
        // into another process, so it stays put until it has content.
        if !self.prompted.lock().await.contains(id) {
            return Ok(current);
        }
        // A running turn finishes where it started.
        if current
            .sessions
            .lock()
            .await
            .get(id)
            .is_some_and(|session| session.turn_id.is_some())
        {
            return Ok(current);
        }
        let target = match self.shared.resolve_cwd(id).await {
            Ok(cwd) => self.trusted(&cwd).await,
            Err(_) => None,
        };
        match target {
            Some(workspace) => {
                let key = workspace.as_str().to_string();
                let bridge = self.folder(workspace).await?;
                self.homes.lock().await.insert(id.to_string(), key);
                Ok(bridge)
            }
            None => {
                self.homes.lock().await.remove(id);
                Ok(self.shared.clone())
            }
        }
    }

    /// Load a persisted session into whichever process is about to serve it, if that
    /// process does not already hold it. A never-prompted session has nothing to load.
    async fn ensure_attached(&self, bridge: &AcpBridge, id: &str) -> Result<(), String> {
        if !self.prompted.lock().await.contains(id) {
            return Ok(());
        }
        if bridge
            .sessions
            .lock()
            .await
            .get(id)
            .is_some_and(|session| session.attached)
        {
            return Ok(());
        }
        // Seed the cwd this process must `session/load` in, then settings for its policy.
        if let Ok(cwd) = self.shared.resolve_cwd(id).await {
            let mut sessions = bridge.sessions.lock().await;
            let session = sessions.entry(id.to_string()).or_default();
            if session.cwd.is_empty() {
                session.cwd = cwd;
            }
            session.has_content = true;
        }
        let settings = {
            let relay = self.shared.state.read().await;
            let session_id = relay
                .session_for_provider_handle("cursor", id)
                .unwrap_or_else(|| id.to_string());
            relay.thread_settings(&session_id)
        };
        let (approval, sandbox) = settings
            .map(|settings| (settings.approval_policy, settings.sandbox))
            .unwrap_or_else(|| ("on-request".into(), "workspace-write".into()));
        bridge.resume_thread(id, &approval, &sandbox).await
    }
}

/// An idle folder's process goes, unless it holds a session never prompted: Cursor
/// cannot load one of those back.
async fn evict_idle_folders(folders: &Folders, homes: &Homes) {
    let mut folders = folders.lock().await;
    let mut idle = Vec::new();
    for (key, folder) in folders.iter() {
        if Arc::strong_count(&folder.bridge) != 1 {
            continue;
        }
        let Ok(sessions) = folder.bridge.sessions.try_lock() else {
            continue;
        };
        if sessions
            .values()
            .any(|session| session.turn_id.is_some() || !session.has_content)
        {
            continue;
        }
        idle.push((key.clone(), folder.last_used));
    }
    idle.sort_by_key(|(_, used)| std::cmp::Reverse(*used));
    let evicted: Vec<String> = idle
        .into_iter()
        .enumerate()
        .filter(|(rank, (_, used))| {
            *rank >= MAX_IDLE_FOLDERS || used.elapsed() >= IDLE_FOLDER_TIMEOUT
        })
        .map(|(_, (key, _))| key)
        .collect();
    for key in &evicted {
        folders.remove(key);
    }
    drop(folders);
    if !evicted.is_empty() {
        homes.lock().await.retain(|_, home| !evicted.contains(home));
    }
}

/// The user trusted this repo, so its own `.cursor/mcp.json` servers run, as a trusted
/// repo's do for Claude. Cursor ignores `--approve-mcps` over ACP, so approve each one.
async fn approve_repo_mcp_servers(
    binary_name: &'static str,
    workspace: &TrustedWorkspace,
    state: &Arc<RwLock<RelayState>>,
) {
    let Ok(dirs) = dirs().await else {
        return;
    };
    let repo = crate::state::app::grant_key(workspace.as_str()).await;
    let mut names = repo_mcp_server_names(Path::new(workspace.as_str()));
    names.extend(repo_mcp_server_names(Path::new(&repo)));
    names.sort();
    names.dedup();
    for name in names {
        // Read from the repo's own file: a leading dash would reach the CLI as a flag.
        if name.starts_with('-') {
            continue;
        }
        let mut command = enable_command(binary_name, &dirs, workspace, &name);
        let approved = matches!(
            timeout(MCP_LIST_TIMEOUT, command.output()).await,
            Ok(Ok(output)) if output.status.success()
        );
        if !approved {
            let mut relay = state.write().await;
            relay.push_log(
                "warn",
                format!(
                    "Could not approve Cursor MCP server {name} for {}",
                    workspace.as_str()
                ),
            );
            relay.notify();
        }
    }
}

fn repo_mcp_server_names(dir: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(dir.join(".cursor").join("mcp.json")) else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|config| {
            config["mcpServers"]
                .as_object()
                .map(|servers| servers.keys().cloned().collect())
        })
        .unwrap_or_default()
}

fn enable_command(
    binary_name: &'static str,
    dirs: &Dirs,
    workspace: &TrustedWorkspace,
    name: &str,
) -> Command {
    let mut command = Command::new(crate::provider::resolve_binary(binary_name));
    command
        .args(["mcp", "enable", name])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    configure_launch(&mut command, dirs, Some(workspace));
    command
}

#[async_trait]
impl ProviderBridge for CursorBridge {
    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        self.shared.list_threads(limit).await
    }
    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        self.shared.list_models().await
    }
    async fn default_model(&self, cwd: &str) -> Result<String, String> {
        self.shared.default_model(cwd).await
    }
    /// Withdrawn trust closes a folder's process at once, mid-turn or not; a grant waits
    /// for each session's next turn, which `route` sends to the folder's own process.
    async fn refresh_workspace_trust(&self) -> Result<(), String> {
        let keys: Vec<String> = self.folders.lock().await.keys().cloned().collect();
        for key in keys {
            if self.trusted(&key).await.is_some() {
                continue;
            }
            if let Some(folder) = self.folders.lock().await.remove(&key) {
                folder.bridge.kill_process_group();
            }
            let displaced: Vec<String> = {
                let mut homes = self.homes.lock().await;
                let ids = homes
                    .iter()
                    .filter(|(_, home)| **home == key)
                    .map(|(id, _)| id.clone())
                    .collect();
                homes.retain(|_, home| *home != key);
                ids
            };
            // Cursor cannot reload a session that was never prompted, so one that lived only
            // in this process is gone. Withdrawal is API-only; say so rather than recover.
            let prompted = self.prompted.lock().await.clone();
            let mut relay = self.shared.state.write().await;
            relay.push_log(
                "info",
                format!("Closing Cursor for {key} after workspace trust was withdrawn"),
            );
            for id in displaced.iter().filter(|id| !prompted.contains(*id)) {
                relay.push_log(
                    "warn",
                    format!(
                        "Cursor session {id} was never used and closed with {key}; start a new one"
                    ),
                );
            }
            relay.notify();
        }
        Ok(())
    }
    async fn start_thread(&self, request: StartThreadRequest) -> Result<StartThreadResult, String> {
        let Some(workspace) = self.trusted(&request.cwd).await else {
            return self.shared.start_thread(request).await;
        };
        let key = workspace.as_str().to_string();
        let bridge = self.folder(workspace).await?;
        let result = bridge.start_thread(request).await?;
        {
            // Only the cwd, so routing can resolve it; marking content here would make an
            // unprompted session look loadable.
            let mut shared = self.shared.sessions.lock().await;
            let session = shared.entry(result.thread.id.clone()).or_default();
            if session.cwd.is_empty() {
                session.cwd = result.thread.cwd.clone();
            }
        }
        // Account-wide, and the picker reads the shared copy, so the latest one learned wins.
        let learned = bridge.models.lock().await.clone();
        if !learned.is_empty() {
            *self.shared.models.lock().await = learned;
        }
        self.homes
            .lock()
            .await
            .insert(result.thread.id.clone(), key);
        Ok(result)
    }
    fn fork_capability(&self) -> ProviderForkCapability {
        self.shared.fork_capability()
    }
    async fn resume_thread(&self, id: &str, approval: &str, sandbox: &str) -> Result<(), String> {
        let bridge = self.route(id).await?;
        bridge.resume_thread(id, approval, sandbox).await?;
        self.note_loadable(&bridge, id).await;
        Ok(())
    }
    async fn session_can_take_a_turn(&self, id: &str) -> bool {
        match self.route(id).await {
            Ok(bridge) => bridge.session_can_take_a_turn(id).await,
            Err(_) => false,
        }
    }
    async fn read_thread(&self, id: &str) -> Result<ThreadSyncData, String> {
        let bridge = self.current(id).await;
        let data = bridge.read_thread(id).await?;
        self.note_loadable(&bridge, id).await;
        Ok(data)
    }
    async fn read_thread_in_cwd(&self, id: &str, cwd: &str) -> Result<ThreadSyncData, String> {
        let bridge = self.current(id).await;
        let data = bridge.read_thread_in_cwd(id, cwd).await?;
        self.note_loadable(&bridge, id).await;
        Ok(data)
    }
    async fn read_thread_entry_detail(
        &self,
        id: &str,
        item: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        self.current(id)
            .await
            .read_thread_entry_detail(id, item)
            .await
    }
    async fn archive_thread(&self, id: &str) -> Result<(), String> {
        self.shared.archive_thread(id).await
    }
    async fn release_thread(&self, id: &str) -> Result<(), String> {
        let bridge = self.current(id).await;
        bridge.release_thread(id).await?;
        if !Arc::ptr_eq(&bridge, &self.shared) {
            let mut sessions = bridge.sessions.lock().await;
            if sessions
                .get(id)
                .is_some_and(|session| session.turn_id.is_some())
            {
                return Err("Cursor cannot release a session while its turn is running".into());
            }
            sessions.remove(id);
            drop(sessions);
            self.homes.lock().await.remove(id);
        }
        Ok(())
    }
    async fn delete_thread_permanently(
        &self,
        id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        self.release_thread(id).await?;
        self.prompted.lock().await.remove(id);
        self.shared.delete_thread_permanently(id).await
    }
    async fn delete_owned_thread_permanently(
        &self,
        id: &str,
    ) -> Result<Option<LocalThreadDeleteSummary>, String> {
        self.release_thread(id).await?;
        self.prompted.lock().await.remove(id);
        self.shared.delete_owned_thread_permanently(id).await
    }
    async fn start_turn(
        &self,
        id: &str,
        text: &str,
        model: &str,
        effort: &str,
        images: &[ProviderImage],
    ) -> Result<Option<String>, String> {
        let bridge = self.route(id).await?;
        self.ensure_attached(&bridge, id).await?;
        let result = bridge.start_turn(id, text, model, effort, images).await;
        if result.is_ok() {
            // It has taken a turn, so Cursor has persisted it and any process can load it.
            self.prompted.lock().await.insert(id.to_string());
        }
        result
    }
    async fn request_turn_stop(&self, id: &str, turn: Option<&str>) -> Result<(), String> {
        self.current(id).await.request_turn_stop(id, turn).await
    }
    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        self.current(&pending.thread_id)
            .await
            .respond_to_approval(pending, input)
            .await
    }
    async fn respond_to_ask_user_question(
        &self,
        id: &str,
        answers: &serde_json::Map<String, Value>,
    ) -> Result<(), String> {
        self.shared.respond_to_ask_user_question(id, answers).await
    }
    fn skills_are_per_session(&self) -> bool {
        true
    }
    async fn list_skills(
        &self,
        id: &str,
        cwd: &str,
    ) -> Result<Option<Vec<crate::protocol::ProviderSkillView>>, String> {
        self.current(id).await.list_skills(id, cwd).await
    }
    fn provider_name(&self) -> &'static str {
        "cursor"
    }
    async fn account(&self) -> Result<crate::provider::account::ProviderAccount, String> {
        self.shared.account().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn test_dirs(base: &Path) -> Dirs {
        Dirs {
            neutral: base.join("neutral"),
            data: base.join("data"),
        }
    }

    fn data_dir(command: &Command) -> Option<PathBuf> {
        command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == "CURSOR_DATA_DIR")
            .and_then(|(_, value)| value)
            .map(PathBuf::from)
    }

    // Cursor walks up from its process cwd past git roots, so a neutral dir under the
    // state path would expose the repo that path sits in. It must be outside any repo.
    #[test]
    fn the_neutral_dir_is_outside_any_project_tree() {
        let neutral = neutral_dir().unwrap();
        assert!(
            neutral.starts_with(std::env::temp_dir()),
            "neutral cwd must be in the OS temp dir, got {}",
            neutral.display()
        );
    }

    // On a shared /tmp another user can pre-plant the dir or a symlink into a checkout.
    // Exclusive creation under a random name means the result is always ours and fresh.
    #[test]
    fn the_isolated_dir_is_freshly_ours_never_a_pre_planted_path() {
        let base = tempfile::tempdir().unwrap();
        // A symlink at a fixed name must never be adopted.
        let decoy = base.path().join("decoy-repo");
        std::fs::create_dir(&decoy).unwrap();
        let first = create_isolated_dir(base.path()).unwrap();
        let second = create_isolated_dir(base.path()).unwrap();
        assert_ne!(
            first, second,
            "each call must mint a fresh, unpredictable dir"
        );
        for dir in [&first, &second] {
            let meta = std::fs::symlink_metadata(dir).unwrap();
            assert!(meta.file_type().is_dir() && !meta.file_type().is_symlink());
            assert!(dir.starts_with(base.path()) && *dir != decoy);
        }
    }

    // Cursor reads `.cursor/mcp.json`, rules and AGENTS.md from the folder its process
    // runs in, whatever folder a session names.
    #[test]
    fn a_process_with_no_trusted_repo_runs_where_there_is_nothing_to_read() {
        let base = tempfile::tempdir().unwrap();
        let dirs = test_dirs(base.path());
        let mut command = Command::new("cursor-agent");
        configure_launch(&mut command, &dirs, None);
        assert_eq!(
            command.as_std().get_current_dir(),
            Some(dirs.neutral.as_path())
        );
        assert_eq!(data_dir(&command), Some(dirs.data.clone()));
    }

    // The user's own Cursor approvals must not let a repo's MCP servers run here.
    #[test]
    fn a_process_for_a_trusted_repo_runs_in_it_with_sealwires_own_approvals() {
        let base = tempfile::tempdir().unwrap();
        let dirs = test_dirs(base.path());
        let repo = tempfile::tempdir().unwrap();
        let repo = repo.path().to_string_lossy().to_string();
        let workspace = TrustedWorkspace::granted_for_test(&repo).unwrap();
        let mut command = Command::new("cursor-agent");
        configure_launch(&mut command, &dirs, Some(&workspace));
        assert_eq!(command.as_std().get_current_dir(), Some(Path::new(&repo)));
        assert_eq!(data_dir(&command), Some(dirs.data.clone()));
    }

    #[test]
    fn a_repos_own_mcp_servers_are_named_from_its_cursor_config() {
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir(repo.path().join(".cursor")).unwrap();
        std::fs::write(
            repo.path().join(".cursor/mcp.json"),
            r#"{"mcpServers":{"db":{"command":"x"},"docs":{"url":"http://x"}}}"#,
        )
        .unwrap();
        let mut names = repo_mcp_server_names(repo.path());
        names.sort();
        assert_eq!(names, ["db", "docs"]);
    }

    // Approved from inside the repo, where Cursor looks the server up, and in sealwire's
    // store, so the user's own Cursor approvals never change.
    #[test]
    fn a_trusted_repos_mcp_server_is_approved_in_sealwires_store() {
        let base = tempfile::tempdir().unwrap();
        let dirs = test_dirs(base.path());
        let repo = tempfile::tempdir().unwrap();
        let repo = repo.path().to_string_lossy().to_string();
        let workspace = TrustedWorkspace::granted_for_test(&repo).unwrap();
        let command = enable_command("cursor-agent", &dirs, &workspace, "db");
        let args: Vec<String> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, ["mcp", "enable", "db"]);
        assert_eq!(command.as_std().get_current_dir(), Some(Path::new(&repo)));
        assert_eq!(data_dir(&command), Some(dirs.data.clone()));
    }

    type Disk = Arc<std::sync::Mutex<HashSet<String>>>;
    type WireLog = Arc<std::sync::Mutex<Vec<(&'static str, String)>>>;

    /// Cursor's cross-process rule: only a prompted session is persisted and loadable
    /// elsewhere, and a process rejects ids it never created or loaded.
    fn tracking_cursor(
        state: &Arc<RwLock<RelayState>>,
        pooled: bool,
        prefix: &'static str,
        disk: Disk,
        log: WireLog,
    ) -> AcpBridge {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (outbound, peer) = tokio::io::duplex(8192);
        let (mut writer, inbound) = tokio::io::duplex(8192);
        tokio::spawn(async move {
            let mut lines = BufReader::new(peer).lines();
            let mut sessions = 0;
            let mut known: HashSet<String> = HashSet::new();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(sent) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if sent.get("id").is_none() {
                    continue;
                }
                let method = sent["method"].as_str().unwrap_or("").to_string();
                let sid = sent["params"]["sessionId"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                log.lock().unwrap().push((prefix, method.clone()));
                let mut error = None;
                let result = match method.as_str() {
                    "session/new" => {
                        sessions += 1;
                        let id = format!("{prefix}-{sessions}");
                        known.insert(id.clone());
                        let model = format!("m-{prefix}");
                        json!({
                            "sessionId": id,
                            "configOptions": [{
                                "category": "model", "type": "select",
                                "currentValue": model, "options": [{ "value": model }],
                            }],
                        })
                    }
                    "session/load" => {
                        if disk.lock().unwrap().contains(&sid) {
                            known.insert(sid.clone());
                            json!({})
                        } else {
                            error = Some("Session not found");
                            Value::Null
                        }
                    }
                    "session/prompt" => {
                        if known.contains(&sid) {
                            disk.lock().unwrap().insert(sid.clone());
                            json!({ "stopReason": "end_turn" })
                        } else {
                            error = Some("Session not found");
                            Value::Null
                        }
                    }
                    _ => json!({}),
                };
                let reply = match error {
                    Some(message) => json!({
                        "jsonrpc": "2.0", "id": sent["id"],
                        "error": { "code": -32603, "message": message }
                    }),
                    None => json!({ "jsonrpc": "2.0", "id": sent["id"], "result": result }),
                };
                if writer
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        if pooled {
            AcpBridge::for_test_pooled(state.clone(), outbound, inbound, "cursor")
        } else {
            AcpBridge::for_test(state.clone(), outbound, inbound, "cursor")
        }
    }

    fn request(cwd: &str) -> StartThreadRequest {
        StartThreadRequest::new(cwd, "", "on-request", "workspace-write")
    }

    struct MigFixture {
        bridge: CursorBridge,
        state: Arc<RwLock<RelayState>>,
        spawned: Arc<std::sync::Mutex<Vec<String>>>,
        disk: Disk,
        log: WireLog,
        trusted: String,
        other: String,
        _dirs: (tempfile::TempDir, tempfile::TempDir),
    }

    // One Cursor on-disk store shared by the shared process and every folder process, so a
    // session persisted in one is loadable in another — Cursor's real cross-process rule.
    async fn migrating_fixture() -> MigFixture {
        let trusted_dir = tempfile::tempdir().unwrap();
        let other_dir = tempfile::tempdir().unwrap();
        let trusted = trusted_dir.path().canonicalize().unwrap();
        let other = other_dir.path().canonicalize().unwrap();
        let (changes, _) = tokio::sync::watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp".into(),
            changes,
            crate::state::SecurityProfile::private(),
        )));
        state
            .write()
            .await
            .trusted_workspaces
            .push(trusted.to_string_lossy().into());
        let disk: Disk = Arc::new(std::sync::Mutex::new(HashSet::new()));
        let log: WireLog = Arc::new(std::sync::Mutex::new(Vec::new()));
        let spawned = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (record, folder_state, folder_disk, folder_log) =
            (spawned.clone(), state.clone(), disk.clone(), log.clone());
        let spawn_folder: SpawnFolder = Arc::new(move |workspace: TrustedWorkspace| {
            record.lock().unwrap().push(workspace.as_str().to_string());
            let bridge = tracking_cursor(
                &folder_state,
                true,
                "folder",
                folder_disk.clone(),
                folder_log.clone(),
            );
            Box::pin(async move {
                bridge.capabilities.lock().await.load_session = true;
                Ok(bridge)
            })
        });
        let shared = tracking_cursor(&state, false, "shared", disk.clone(), log.clone());
        shared.capabilities.lock().await.load_session = true;
        MigFixture {
            bridge: CursorBridge::assemble(shared, spawn_folder),
            state,
            spawned,
            disk,
            log,
            trusted: trusted.to_string_lossy().into(),
            other: other.to_string_lossy().into(),
            _dirs: (trusted_dir, other_dir),
        }
    }

    fn sent(log: &WireLog, process: &str, method: &str) -> bool {
        log.lock()
            .unwrap()
            .iter()
            .any(|(p, m)| *p == process && m == method)
    }

    // `session/prompt` is fire-and-forget, so give the mock a moment to log it.
    async fn wait_sent(log: &WireLog, process: &str, method: &str) -> bool {
        for _ in 0..200 {
            if sent(log, process, method) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    }

    // Trust granted before the first prompt: the session exists only in the shared
    // process's memory, so it cannot migrate to a folder process that can't load it.
    #[tokio::test]
    async fn granting_trust_before_the_first_prompt_keeps_the_session_sendable() {
        let fx = migrating_fixture().await;
        let started = fx.bridge.start_thread(request(&fx.other)).await.unwrap();
        assert!(
            started.thread.id.starts_with("shared-"),
            "{}",
            started.thread.id
        );

        fx.state
            .write()
            .await
            .trusted_workspaces
            .push(fx.other.clone());

        let turn = fx
            .bridge
            .start_turn(&started.thread.id, "hi", "", "", &[])
            .await;
        assert!(turn.is_ok(), "first prompt must still send: {turn:?}");
        assert!(
            fx.spawned.lock().unwrap().is_empty(),
            "an unprompted session must not spawn a folder it cannot be loaded into"
        );
        assert!(wait_sent(&fx.log, "shared", "session/prompt").await);
    }

    // A send completes asynchronously when the agent's `session/prompt` reply lands; the
    // next turn must wait for that or it collides with the still-active turn id.
    async fn send(fx: &MigFixture, id: &str, text: &str) {
        fx.bridge.start_turn(id, text, "", "", &[]).await.unwrap();
        for _ in 0..400 {
            let active = {
                let relay = fx.state.read().await;
                relay
                    .runtime_for_thread(id)
                    .and_then(|runtime| runtime.active_turn_id.clone())
            };
            if active.is_none() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    // A folder trusted before the session exists gets its own Cursor from the start, so the
    // repo's rules and MCP servers are there for the very first turn.
    #[tokio::test]
    async fn a_trusted_session_runs_its_first_turn_in_its_folder() {
        let fx = migrating_fixture().await;
        let started = fx.bridge.start_thread(request(&fx.trusted)).await.unwrap();
        assert!(
            started.thread.id.starts_with("folder-"),
            "{}",
            started.thread.id
        );
        assert_eq!(*fx.spawned.lock().unwrap(), vec![fx.trusted.clone()]);

        send(&fx, &started.thread.id, "one").await;
        assert!(wait_sent(&fx.log, "folder", "session/prompt").await);
        assert!(!sent(&fx.log, "shared", "session/prompt"));
    }

    // Withdrawing trust closes the folder process; the displaced session's next send must
    // reach the shared process, which has to load it first or the prompt hits a stranger.
    #[tokio::test]
    async fn withdrawing_trust_closes_the_folder_and_sends_fall_back_to_shared() {
        let fx = migrating_fixture().await;
        let started = fx.bridge.start_thread(request(&fx.trusted)).await.unwrap();
        send(&fx, &started.thread.id, "one").await;
        let folder = fx.bridge.folders.lock().await[&fx.trusted].bridge.clone();

        fx.state.write().await.trusted_workspaces.clear();
        fx.bridge.refresh_workspace_trust().await.unwrap();
        assert!(fx.bridge.folders.lock().await.is_empty());
        assert!(fx.bridge.homes.lock().await.is_empty());
        // Dropping it from the map is not enough while a call still holds it.
        assert!(folder.closing.load(Ordering::Acquire));

        let turn = fx
            .bridge
            .start_turn(&started.thread.id, "two", "", "", &[])
            .await;
        assert!(
            turn.is_ok(),
            "the displaced session must still send: {turn:?}"
        );
        assert!(sent(&fx.log, "shared", "session/load"));
        assert!(wait_sent(&fx.log, "shared", "session/prompt").await);
    }

    // An unprompted session reads back empty without being loaded, so a successful read proves
    // nothing; trusting it sends the session to a process that cannot load it.
    #[tokio::test]
    async fn an_empty_read_does_not_make_an_unprompted_session_migrate() {
        let fx = migrating_fixture().await;
        let started = fx.bridge.start_thread(request(&fx.other)).await.unwrap();
        fx.state
            .write()
            .await
            .trusted_workspaces
            .push(fx.other.clone());

        fx.bridge.read_thread(&started.thread.id).await.unwrap();
        let turn = fx
            .bridge
            .start_turn(&started.thread.id, "hi", "", "", &[])
            .await;

        assert!(turn.is_ok(), "the first send must still work: {turn:?}");
        assert!(fx.spawned.lock().unwrap().is_empty());
    }

    // The catalog is account-wide; whichever process learned it last is current, and the
    // picker reads the shared one, so a folder process's catalog replaces a stale copy.
    #[tokio::test]
    async fn a_catalog_a_folder_process_learns_replaces_the_shared_one() {
        let fx = migrating_fixture().await;
        let stale = fx.bridge.start_thread(request(&fx.other)).await.unwrap();
        assert!(stale.thread.id.starts_with("shared-"));
        assert_eq!(fx.bridge.shared.models.lock().await[0].model, "m-shared");

        fx.bridge.start_thread(request(&fx.trusted)).await.unwrap();

        let models = fx.bridge.shared.models.lock().await.clone();
        assert_eq!(
            models.iter().map(|m| m.model.as_str()).collect::<Vec<_>>(),
            ["m-folder"]
        );
    }

    // After a restart `prompted` is empty; without the read marking it, a persisted trusted
    // session's first reply would run on the neutral process, without its repo config.
    #[tokio::test]
    async fn a_persisted_trusted_session_reaches_its_folder_on_the_first_send_after_restart() {
        let fx = migrating_fixture().await;
        let id = "ses_restored";
        // As after a boot: the thread is known and persisted on disk, no process holds it.
        {
            let mut relay = fx.state.write().await;
            relay.ensure_runtime_for_thread(id).current_cwd = fx.trusted.clone();
        }
        fx.disk.lock().unwrap().insert(id.to_string());

        fx.bridge.read_thread(id).await.unwrap();
        send(&fx, id, "hello").await;

        assert_eq!(
            *fx.spawned.lock().unwrap(),
            vec![fx.trusted.clone()],
            "the first send after a read must use the trusted folder, not the neutral process"
        );
    }
}
