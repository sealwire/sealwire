use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, VecDeque},
    ffi::OsString,
    fs,
    hash::{Hash, Hasher},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use url::Url;

const HOSTED_BROKER_URL: &str = "wss://agent-relay.up.railway.app";
const LOG_LIMIT: usize = 400;
const RELAY_SIDECAR: &str = "binaries/relay-server";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    workspace_dir: String,
    preferred_port: u16,
    broker_mode: BrokerMode,
    custom_broker_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum BrokerMode {
    LocalOnly,
    Hosted,
    Custom,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    config: DesktopConfig,
    relay: RelayStatus,
    logs: Vec<LogEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayStatus {
    running: bool,
    ready: bool,
    pid: Option<u32>,
    port: Option<u16>,
    local_url: Option<String>,
    remote_url: Option<String>,
    broker_url: Option<String>,
    broker_label: String,
    workspace_dir: Option<String>,
    started_at_ms: Option<u128>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    timestamp_ms: u128,
    stream: String,
    message: String,
}

struct RelayProcess {
    child: CommandChild,
    pid: u32,
    port: u16,
    ready: bool,
    broker_url: Option<String>,
    broker_label: String,
    workspace_dir: String,
    started_at_ms: u128,
}

struct RelaySupervisor {
    config_path: PathBuf,
    config: Mutex<DesktopConfig>,
    logs: Mutex<VecDeque<LogEntry>>,
    process: Mutex<Option<RelayProcess>>,
}

impl RelaySupervisor {
    fn new(app: &AppHandle) -> Result<Self, String> {
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|error| format!("failed to resolve app config directory: {error}"))?;
        fs::create_dir_all(&config_dir)
            .map_err(|error| format!("failed to create app config directory: {error}"))?;
        let config_path = config_dir.join("desktop-config.json");
        let default_config = default_config(app);
        let config = load_config(&config_path, default_config)?;

        Ok(Self {
            config_path,
            config: Mutex::new(config),
            logs: Mutex::new(VecDeque::with_capacity(LOG_LIMIT)),
            process: Mutex::new(None),
        })
    }

    fn status(&self) -> DesktopStatus {
        let config = self
            .config
            .lock()
            .expect("desktop config lock should not be poisoned")
            .clone();
        let relay = self
            .process
            .lock()
            .expect("relay process lock should not be poisoned")
            .as_ref()
            .map(RelayStatus::from_process)
            .unwrap_or_else(RelayStatus::stopped);
        let logs = self
            .logs
            .lock()
            .expect("relay log lock should not be poisoned")
            .iter()
            .cloned()
            .collect();

        DesktopStatus {
            config,
            relay,
            logs,
        }
    }

    fn current_config(&self) -> DesktopConfig {
        self.config
            .lock()
            .expect("desktop config lock should not be poisoned")
            .clone()
    }

    fn save_config(&self, config: DesktopConfig) -> Result<(), String> {
        let serialized = serde_json::to_string_pretty(&config)
            .map_err(|error| format!("failed to serialize desktop config: {error}"))?;
        fs::write(&self.config_path, format!("{serialized}\n"))
            .map_err(|error| format!("failed to write desktop config: {error}"))?;
        *self
            .config
            .lock()
            .expect("desktop config lock should not be poisoned") = config;
        Ok(())
    }

    fn replace_process(&self, process: RelayProcess) -> Option<RelayProcess> {
        self.process
            .lock()
            .expect("relay process lock should not be poisoned")
            .replace(process)
    }

    fn take_process(&self) -> Option<RelayProcess> {
        self.process
            .lock()
            .expect("relay process lock should not be poisoned")
            .take()
    }

    fn clear_process_if_pid(&self, pid: u32) {
        let mut process = self
            .process
            .lock()
            .expect("relay process lock should not be poisoned");
        if process.as_ref().is_some_and(|current| current.pid == pid) {
            *process = None;
        }
    }

    /// Marks the tracked process ready once its port accepts connections.
    /// Returns true only on the transition (so callers log/emit exactly once).
    fn mark_ready(&self, pid: u32) -> bool {
        let mut process = self
            .process
            .lock()
            .expect("relay process lock should not be poisoned");
        if let Some(current) = process.as_mut() {
            if current.pid == pid && !current.ready {
                current.ready = true;
                return true;
            }
        }
        false
    }

    /// Pushes the authoritative relay status to the UI. Backend-driven state
    /// changes (ready, exit) happen outside any command, so they must be
    /// broadcast explicitly — a `desktop://relay-log` append alone would leave
    /// `state.status.relay` stale (Open buttons stuck, crashes unnoticed).
    fn emit_status(&self, app: &AppHandle) {
        let _ = app.emit("desktop://relay-status", self.status());
    }

    fn push_log(
        &self,
        app: Option<&AppHandle>,
        stream: impl Into<String>,
        message: impl Into<String>,
    ) {
        let entry = LogEntry {
            timestamp_ms: now_ms(),
            stream: stream.into(),
            message: message.into(),
        };

        {
            let mut logs = self
                .logs
                .lock()
                .expect("relay log lock should not be poisoned");
            if logs.len() >= LOG_LIMIT {
                logs.pop_front();
            }
            logs.push_back(entry.clone());
        }

        if let Some(app) = app {
            let _ = app.emit("desktop://relay-log", entry);
        }
    }
}

impl RelayStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            ready: false,
            pid: None,
            port: None,
            local_url: None,
            remote_url: None,
            broker_url: None,
            broker_label: "Stopped".to_string(),
            workspace_dir: None,
            started_at_ms: None,
        }
    }

    fn from_process(process: &RelayProcess) -> Self {
        Self {
            running: true,
            ready: process.ready,
            pid: Some(process.pid),
            port: Some(process.port),
            local_url: Some(local_url(process.port)),
            remote_url: Some(remote_url(process.port)),
            broker_url: process.broker_url.clone(),
            broker_label: process.broker_label.clone(),
            workspace_dir: Some(process.workspace_dir.clone()),
            started_at_ms: Some(process.started_at_ms),
        }
    }
}

#[tauri::command]
async fn desktop_status(
    supervisor: State<'_, Arc<RelaySupervisor>>,
) -> Result<DesktopStatus, String> {
    Ok(supervisor.status())
}

#[tauri::command]
async fn desktop_restart(
    app: AppHandle,
    supervisor: State<'_, Arc<RelaySupervisor>>,
    input: DesktopConfig,
) -> Result<DesktopStatus, String> {
    start_relay(app, supervisor.inner().clone(), Some(input)).await?;
    Ok(supervisor.status())
}

#[tauri::command]
async fn desktop_stop_relay(
    app: AppHandle,
    supervisor: State<'_, Arc<RelaySupervisor>>,
) -> Result<DesktopStatus, String> {
    stop_relay(&app, supervisor.inner());
    Ok(supervisor.status())
}

#[tauri::command]
async fn desktop_open_surface(
    app: AppHandle,
    supervisor: State<'_, Arc<RelaySupervisor>>,
    surface: String,
) -> Result<(), String> {
    let status = supervisor.status().relay;
    let port = status
        .port
        .ok_or_else(|| "relay is not running".to_string())?;
    let (label, title, url) = match surface.as_str() {
        "local" => ("sealwire-local", "Sealwire Local", local_url(port)),
        "remote" => ("sealwire-remote", "Sealwire Remote", remote_url(port)),
        _ => return Err(format!("unknown surface: {surface}")),
    };
    open_surface_window(&app, label, title, &url)
}

async fn start_relay(
    app: AppHandle,
    supervisor: Arc<RelaySupervisor>,
    next_config: Option<DesktopConfig>,
) -> Result<(), String> {
    let config = sanitize_config(
        next_config.unwrap_or_else(|| supervisor.current_config()),
        &app,
    )?;
    let broker = broker_runtime_config(&config)?;
    let workspace = PathBuf::from(&config.workspace_dir);
    ensure_workspace(&workspace)?;

    supervisor.save_config(config.clone())?;
    // F3: stop any running relay BEFORE picking a port, so the preferred port it
    // was holding is released and can be reused instead of drifting each restart.
    if let Some(previous) = supervisor.take_process() {
        let _ = previous.child.kill();
    }
    let port = pick_port(config.preferred_port)?;

    let envs = relay_env(&app, &workspace, port, broker.as_ref())?;
    let command = app
        .shell()
        .sidecar(RELAY_SIDECAR)
        .map_err(|error| format!("failed to resolve relay-server sidecar: {error}"))?
        .env_clear()
        .envs(envs)
        .current_dir(&workspace);
    let (mut rx, child) = command
        .spawn()
        .map_err(|error| format!("failed to start relay-server sidecar: {error}"))?;
    let pid = child.pid();
    let process = RelayProcess {
        child,
        pid,
        port,
        ready: false,
        broker_url: broker.as_ref().map(|value| value.websocket_url.clone()),
        broker_label: broker
            .as_ref()
            .map(|value| value.label.clone())
            .unwrap_or_else(|| "Local only".to_string()),
        workspace_dir: workspace.display().to_string(),
        started_at_ms: now_ms(),
    };
    // F5: don't leak a process a concurrent start may have slipped into the slot.
    if let Some(orphan) = supervisor.replace_process(process) {
        let _ = orphan.child.kill();
    }
    supervisor.push_log(
        Some(&app),
        "relay",
        format!("started relay-server pid {pid} on http://127.0.0.1:{port}"),
    );
    // Broadcast running=true, ready=false (covers the auto-start-on-launch case
    // where the UI's initial fetch can race ahead of the spawned process).
    supervisor.emit_status(&app);

    // F4: flip the surface buttons on only once the port actually accepts
    // connections, so "Open Local" can't race ahead of the listener.
    let ready_app = app.clone();
    let ready_supervisor = supervisor.clone();
    std::thread::spawn(move || {
        for _ in 0..100 {
            if port_is_ready(port) {
                if ready_supervisor.mark_ready(pid) {
                    ready_supervisor.push_log(
                        Some(&ready_app),
                        "relay",
                        format!("relay-server pid {pid} is ready on http://127.0.0.1:{port}"),
                    );
                    ready_supervisor.emit_status(&ready_app);
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        ready_supervisor.push_log(
            Some(&ready_app),
            "error",
            format!("relay-server pid {pid} did not accept connections within timeout"),
        );
    });

    let log_app = app.clone();
    let log_supervisor = supervisor.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    for line in decode_lines(bytes) {
                        log_supervisor.push_log(Some(&log_app), "stdout", line);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    for line in decode_lines(bytes) {
                        log_supervisor.push_log(Some(&log_app), "stderr", line);
                    }
                }
                CommandEvent::Error(error) => {
                    log_supervisor.push_log(Some(&log_app), "error", error);
                }
                CommandEvent::Terminated(payload) => {
                    log_supervisor.push_log(
                        Some(&log_app),
                        "relay",
                        format!("relay-server pid {pid} exited with code {:?}", payload.code),
                    );
                    log_supervisor.clear_process_if_pid(pid);
                    // Surface running=false so the UI doesn't keep believing a
                    // crashed/exited relay is still up.
                    log_supervisor.emit_status(&log_app);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn stop_relay(app: &AppHandle, supervisor: &RelaySupervisor) {
    if let Some(process) = supervisor.take_process() {
        let pid = process.pid;
        let _ = process.child.kill();
        supervisor.push_log(
            Some(app),
            "relay",
            format!("stopped relay-server pid {pid}"),
        );
    }
}

fn open_surface_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    target: &str,
) -> Result<(), String> {
    let parsed = Url::parse(target).map_err(|error| format!("invalid surface URL: {error}"))?;
    if let Some(window) = app.get_webview_window(label) {
        window
            .navigate(parsed)
            .map_err(|error| format!("failed to navigate {title}: {error}"))?;
        window
            .show()
            .map_err(|error| format!("failed to show {title}: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("failed to focus {title}: {error}"))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(1320.0, 880.0)
        .min_inner_size(900.0, 620.0)
        .build()
        .map_err(|error| format!("failed to open {title}: {error}"))?;
    Ok(())
}

#[derive(Clone, Debug)]
struct BrokerRuntimeConfig {
    websocket_url: String,
    control_url: String,
    label: String,
}

fn broker_runtime_config(config: &DesktopConfig) -> Result<Option<BrokerRuntimeConfig>, String> {
    let value = match config.broker_mode {
        BrokerMode::LocalOnly => return Ok(None),
        BrokerMode::Hosted => HOSTED_BROKER_URL,
        BrokerMode::Custom => config.custom_broker_url.trim(),
    };
    if value.is_empty() {
        return Err("custom broker URL is required".to_string());
    }

    let mut parsed = Url::parse(value).map_err(|error| format!("invalid broker URL: {error}"))?;
    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);

    let protocol = parsed.scheme().to_ascii_lowercase();
    if !matches!(protocol.as_str(), "http" | "https" | "ws" | "wss") {
        return Err("broker URL must start with http://, https://, ws://, or wss://".to_string());
    }

    let mut control = parsed.clone();
    let control_scheme = match protocol.as_str() {
        "ws" => "http",
        "wss" => "https",
        _ => protocol.as_str(),
    };
    control
        .set_scheme(control_scheme)
        .map_err(|_| "failed to normalize broker control URL".to_string())?;

    let mut websocket = parsed;
    let websocket_scheme = match protocol.as_str() {
        "http" => "ws",
        "https" => "wss",
        _ => protocol.as_str(),
    };
    websocket
        .set_scheme(websocket_scheme)
        .map_err(|_| "failed to normalize broker websocket URL".to_string())?;

    let websocket_url = strip_trailing_slash(websocket.as_str());
    let control_url = strip_trailing_slash(control.as_str());
    let label = if config.broker_mode == BrokerMode::Hosted {
        "Hosted public broker".to_string()
    } else {
        control_url.clone()
    };

    Ok(Some(BrokerRuntimeConfig {
        websocket_url,
        control_url,
        label,
    }))
}

fn relay_env(
    app: &AppHandle,
    workspace: &Path,
    port: u16,
    broker: Option<&BrokerRuntimeConfig>,
) -> Result<Vec<(OsString, OsString)>, String> {
    let mut envs: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| !is_relay_broker_env(key))
        .collect();

    upsert_env(&mut envs, "PORT", port.to_string());
    upsert_env(&mut envs, "BIND_HOST", "127.0.0.1");
    let bundled_node = if std::env::var_os("CLAUDE_NODE_BINARY").is_none() {
        resolve_bundled_node()
    } else {
        None
    };

    let peer_seed = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|| workspace.display().to_string());
    upsert_env(&mut envs, "RELAY_SECURITY_MODE", "private");
    upsert_env(
        &mut envs,
        "RELAY_BROKER_PEER_ID",
        default_peer_id(&peer_seed),
    );
    upsert_env(
        &mut envs,
        "PATH",
        expanded_path(bundled_node.as_ref().and_then(|node| node.parent())),
    );
    upsert_env(
        &mut envs,
        "RELAY_STATE_PATH",
        workspace
            .join(".agent-relay")
            .join("desktop-session.json")
            .display()
            .to_string(),
    );
    upsert_env(
        &mut envs,
        "RELAY_BROKER_REGISTRATION_PATH",
        workspace
            .join(".agent-relay")
            .join("desktop-public-broker-registration.json")
            .display()
            .to_string(),
    );
    upsert_env(
        &mut envs,
        "RELAY_BROKER_IDENTITY_PATH",
        workspace
            .join(".agent-relay")
            .join("desktop-public-broker-identity.json")
            .display()
            .to_string(),
    );
    upsert_env(
        &mut envs,
        "RELAY_VAPID_KEY_PATH",
        workspace
            .join(".agent-relay")
            .join("desktop-vapid.key")
            .display()
            .to_string(),
    );

    if std::env::var_os("CLAUDE_WORKER_PATH").is_none() {
        if let Some(worker) = resolve_claude_worker(app) {
            upsert_env(
                &mut envs,
                "CLAUDE_WORKER_PATH",
                worker.display().to_string(),
            );
        }
    }
    if let Some(node) = bundled_node {
        upsert_env(&mut envs, "CLAUDE_NODE_BINARY", node.display().to_string());
    }

    if let Some(broker) = broker {
        upsert_env(&mut envs, "RELAY_BROKER_URL", broker.websocket_url.clone());
        upsert_env(
            &mut envs,
            "RELAY_BROKER_PUBLIC_URL",
            broker.websocket_url.clone(),
        );
        upsert_env(
            &mut envs,
            "RELAY_BROKER_CONTROL_URL",
            broker.control_url.clone(),
        );
        upsert_env(&mut envs, "RELAY_BROKER_AUTH_MODE", "public");
    }

    Ok(envs)
}

fn is_relay_broker_env(key: &OsString) -> bool {
    matches!(
        key.to_string_lossy().as_ref(),
        "AGENT_RELAY_PUBLIC_BROKER_ORIGIN"
            | "AGENT_RELAY_PUBLIC_BROKER_URL"
            | "RELAY_BROKER_AUTH_MODE"
            | "RELAY_BROKER_CONTROL_URL"
            | "RELAY_BROKER_PUBLIC_URL"
            | "RELAY_BROKER_URL"
    )
}

fn upsert_env(
    envs: &mut Vec<(OsString, OsString)>,
    key: impl Into<OsString>,
    value: impl Into<OsString>,
) {
    let key = key.into();
    envs.retain(|(existing, _)| existing != &key);
    envs.push((key, value.into()));
}

fn expanded_path(extra_first: Option<&Path>) -> OsString {
    let mut entries = Vec::new();
    if let Some(path) = extra_first {
        entries.push(path.to_path_buf());
    }
    entries.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ]);
    if let Some(current) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&current));
    }
    std::env::join_paths(dedup_paths(entries)).unwrap_or_else(|_| OsString::from("/usr/bin:/bin"))
}

fn dedup_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut output = Vec::new();
    for path in paths {
        if !output.iter().any(|existing| existing == &path) {
            output.push(path);
        }
    }
    output
}

fn sanitize_config(input: DesktopConfig, app: &AppHandle) -> Result<DesktopConfig, String> {
    let default = default_config(app);
    let workspace_dir = normalize_workspace(input.workspace_dir, &default.workspace_dir)?;
    let preferred_port = if input.preferred_port == 0 {
        default.preferred_port
    } else {
        input.preferred_port
    };
    let custom_broker_url = input.custom_broker_url.trim().to_string();
    let config = DesktopConfig {
        workspace_dir,
        preferred_port,
        broker_mode: input.broker_mode,
        custom_broker_url,
    };
    let _ = broker_runtime_config(&config)?;
    Ok(config)
}

fn normalize_workspace(input: String, fallback: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let path = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    let path = expand_tilde(path);
    if !path.exists() {
        return Err(format!("workspace does not exist: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("workspace is not a directory: {}", path.display()));
    }
    Ok(path.display().to_string())
}

fn expand_tilde(value: &str) -> PathBuf {
    if value == "~" || value.starts_with("~/") {
        if let Some(home) = home_dir_from_env() {
            if value == "~" {
                return home;
            }
            return home.join(&value[2..]);
        }
    }
    PathBuf::from(value)
}

fn ensure_workspace(workspace: &Path) -> Result<(), String> {
    if !workspace.exists() {
        return Err(format!("workspace does not exist: {}", workspace.display()));
    }
    if !workspace.is_dir() {
        return Err(format!(
            "workspace is not a directory: {}",
            workspace.display()
        ));
    }
    fs::create_dir_all(workspace.join(".agent-relay"))
        .map_err(|error| format!("failed to create workspace state directory: {error}"))
}

fn pick_port(preferred: u16) -> Result<u16, String> {
    // A relay we just killed can take a brief moment to release its listening
    // socket; give the preferred port a short window before drifting away.
    for attempt in 0..20 {
        if port_is_available(preferred) {
            return Ok(preferred);
        }
        if attempt + 1 < 20 {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    for port in 8788..=8877 {
        if port_is_available(port) {
            return Ok(port);
        }
    }
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("failed to allocate a relay port: {error}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|error| format!("failed to inspect allocated relay port: {error}"))
}

fn port_is_available(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn port_is_ready(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn default_config(app: &AppHandle) -> DesktopConfig {
    let workspace_dir = app
        .path()
        .home_dir()
        .ok()
        .or_else(home_dir_from_env)
        .unwrap_or_else(|| PathBuf::from("."))
        .display()
        .to_string();
    DesktopConfig {
        workspace_dir,
        preferred_port: 8787,
        broker_mode: BrokerMode::LocalOnly,
        custom_broker_url: String::new(),
    }
}

fn load_config(path: &Path, default_config: DesktopConfig) -> Result<DesktopConfig, String> {
    let Ok(contents) = fs::read_to_string(path) else {
        return Ok(default_config);
    };
    let parsed: DesktopConfig = serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse desktop config: {error}"))?;
    Ok(DesktopConfig {
        workspace_dir: if parsed.workspace_dir.trim().is_empty() {
            default_config.workspace_dir
        } else {
            parsed.workspace_dir
        },
        preferred_port: if parsed.preferred_port == 0 {
            default_config.preferred_port
        } else {
            parsed.preferred_port
        },
        broker_mode: parsed.broker_mode,
        custom_broker_url: parsed.custom_broker_url,
    })
}

fn resolve_claude_worker(app: &AppHandle) -> Option<PathBuf> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .to_path_buf();
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("claude-worker").join("worker.mjs"));
    }
    candidates.push(
        repo_root
            .join("src-tauri")
            .join("resources")
            .join("claude-worker")
            .join("worker.mjs"),
    );
    candidates.push(repo_root.join("claude-worker").join("worker.mjs"));
    candidates.into_iter().find(|candidate| candidate.exists())
}

fn resolve_bundled_node() -> Option<PathBuf> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let current_exe = std::env::current_exe().ok()?;
    current_exe
        .parent()
        .map(|dir| dir.join(executable))
        .filter(|candidate| candidate.exists())
}

fn sanitize_peer_id(raw: &str) -> String {
    raw.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                ch
            } else {
                '-'
            }
        })
        .take(48)
        .collect()
}

/// Builds a peer id that is stable for a given install (via `seed`) yet differs
/// across installs, so distinct desktops don't collide on a shared broker even
/// when the hostname env is empty (common on macOS).
fn build_peer_id(host_raw: &str, seed: &str) -> String {
    let host = sanitize_peer_id(host_raw);
    let base = if host.is_empty() {
        "relay".to_string()
    } else {
        host
    };
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    format!("desktop-relay-{base}-{:08x}", hasher.finish() as u32)
}

fn default_peer_id(seed: &str) -> String {
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_default();
    build_peer_id(&host, seed)
}

fn home_dir_from_env() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn local_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

fn remote_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/static/remote.html")
}

fn strip_trailing_slash(value: &str) -> String {
    value.strip_suffix('/').unwrap_or(value).to_string()
}

fn decode_lines(bytes: Vec<u8>) -> Vec<String> {
    String::from_utf8_lossy(&bytes)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            desktop_restart,
            desktop_stop_relay,
            desktop_open_surface,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let supervisor = Arc::new(
                RelaySupervisor::new(&handle)
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?,
            );
            let startup_supervisor = supervisor.clone();
            let startup_app = handle.clone();
            app.manage(supervisor);
            tauri::async_runtime::spawn(async move {
                if let Err(error) =
                    start_relay(startup_app.clone(), startup_supervisor.clone(), None).await
                {
                    startup_supervisor.push_log(Some(&startup_app), "error", error);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    let supervisor = window.state::<Arc<RelaySupervisor>>();
                    stop_relay(&window.app_handle(), supervisor.inner());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Sealwire desktop")
        .run(|app_handle, event| {
            // F2: guarantee the relay-server (and its node worker / codex children)
            // are killed on every quit path — Cmd+Q, app-menu Quit, last window
            // closing — not just the main window's close button.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(supervisor) = app_handle.try_state::<Arc<RelaySupervisor>>() {
                    stop_relay(app_handle, supervisor.inner());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(mode: BrokerMode, custom: &str) -> DesktopConfig {
        DesktopConfig {
            workspace_dir: "/tmp".to_string(),
            preferred_port: 8787,
            broker_mode: mode,
            custom_broker_url: custom.to_string(),
        }
    }

    // F8 documentation: RELAY_BROKER_PUBLIC_URL must stay a ws/wss URL (relay-server
    // rejects http(s) there), while the control URL is the http(s) counterpart.
    #[test]
    fn broker_local_only_is_none() {
        assert!(broker_runtime_config(&cfg(BrokerMode::LocalOnly, ""))
            .unwrap()
            .is_none());
    }

    #[test]
    fn broker_hosted_normalizes_schemes() {
        let broker = broker_runtime_config(&cfg(BrokerMode::Hosted, ""))
            .unwrap()
            .unwrap();
        assert!(broker.websocket_url.starts_with("wss://"));
        assert!(broker.control_url.starts_with("https://"));
        assert_eq!(broker.label, "Hosted public broker");
    }

    #[test]
    fn broker_custom_https_maps_to_wss_and_https() {
        let broker = broker_runtime_config(&cfg(BrokerMode::Custom, "https://broker.example.com"))
            .unwrap()
            .unwrap();
        assert_eq!(broker.websocket_url, "wss://broker.example.com");
        assert_eq!(broker.control_url, "https://broker.example.com");
    }

    #[test]
    fn broker_custom_ws_maps_to_http_control() {
        let broker = broker_runtime_config(&cfg(BrokerMode::Custom, "ws://127.0.0.1:9000"))
            .unwrap()
            .unwrap();
        assert_eq!(broker.websocket_url, "ws://127.0.0.1:9000");
        assert_eq!(broker.control_url, "http://127.0.0.1:9000");
    }

    #[test]
    fn broker_custom_requires_a_url() {
        assert!(broker_runtime_config(&cfg(BrokerMode::Custom, "   ")).is_err());
    }

    #[test]
    fn broker_custom_rejects_unknown_scheme() {
        assert!(broker_runtime_config(&cfg(BrokerMode::Custom, "ftp://nope")).is_err());
    }

    // F9: peer id must be stable per install, sanitized, and vary across installs.
    #[test]
    fn sanitize_peer_id_replaces_unsafe_chars() {
        assert_eq!(sanitize_peer_id("My Mac.local"), "My-Mac.local");
        assert_eq!(sanitize_peer_id("a/b:c"), "a-b-c");
        assert_eq!(sanitize_peer_id(""), "");
    }

    #[test]
    fn build_peer_id_is_stable_and_seed_sensitive() {
        let a = build_peer_id("host", "/Users/alice/config");
        let b = build_peer_id("host", "/Users/alice/config");
        let c = build_peer_id("host", "/Users/bob/config");
        assert_eq!(a, b, "same host+seed is stable across calls");
        assert_ne!(a, c, "different seed yields a different peer id");
        assert!(a.starts_with("desktop-relay-host-"));
    }

    #[test]
    fn build_peer_id_handles_empty_host() {
        assert!(build_peer_id("", "seed").starts_with("desktop-relay-relay-"));
    }

    // F3: a busy preferred port falls back; a free preferred port is reused.
    #[test]
    fn pick_port_prefers_free_and_falls_back_when_busy() {
        let occupied = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let busy = occupied.local_addr().unwrap().port();
        let chosen = pick_port(busy).unwrap();
        assert_ne!(chosen, busy, "does not choose a busy preferred port");
        assert!(port_is_available(chosen));
        drop(occupied);

        let probe = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let free = probe.local_addr().unwrap().port();
        drop(probe);
        assert_eq!(
            pick_port(free).unwrap(),
            free,
            "reuses a free preferred port"
        );
    }

    // F4: readiness reflects whether the port actually accepts connections.
    #[test]
    fn port_is_ready_reflects_listener_presence() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_is_ready(port), "ready while a listener is up");
        drop(listener);

        let probe = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let closed = probe.local_addr().unwrap().port();
        drop(probe);
        assert!(!port_is_ready(closed), "not ready with no listener");
    }
}
