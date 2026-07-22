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
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use url::Url;

const HOSTED_BROKER_URL: &str = "wss://agent-relay.up.railway.app";
const LOG_LIMIT: usize = 400;
const TRAY_ID: &str = "sealwire-tray";
const TRAY_OPEN_LOCAL_ID: &str = "open-local";
const TRAY_OPEN_REMOTE_ID: &str = "open-remote";
const TRAY_OPEN_LAUNCHER_ID: &str = "open-launcher";
const TRAY_QUIT_ID: &str = "quit";
// Window labels. Windows in IPC_WINDOW_LABELS load the Tauri UI (desktop.html) and
// therefore depend on IPC + dialog capabilities: in Tauri v2 a window that matches
// no capability opens with NO IPC access, so its controls silently do nothing.
// Every label here MUST appear in capabilities/default.json's `windows` list —
// enforced by test `tauri_ipc_windows_are_capability_covered`. (Product windows
// created by open_surface_window load an External http(s) URL and talk to the relay
// directly, so they need no Tauri capability and are intentionally not listed.)
const MAIN_WINDOW_LABEL: &str = "main";
const LAUNCHER_WINDOW_LABEL: &str = "launcher";
#[cfg(test)]
const IPC_WINDOW_LABELS: &[&str] = &[MAIN_WINDOW_LABEL, LAUNCHER_WINDOW_LABEL];
// Tauri flattens externalBin next to the executable by basename; the shell
// plugin resolves .sidecar(name) as <exe_dir>/name verbatim. Must be the bare
// basename (NOT "binaries/relay-server", which would resolve to a missing
// <exe_dir>/binaries/relay-server and fail to spawn with ENOENT).
const RELAY_SIDECAR: &str = "relay-server";

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
    provider_status: Vec<ProviderStatusRow>,
    pid: Option<u32>,
    port: Option<u16>,
    local_url: Option<String>,
    remote_url: Option<String>,
    broker_url: Option<String>,
    broker_label: String,
    broker_status: Option<String>, // "disabled"/"connecting"/"connected"/"offline"
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

/// One provider row surfaced to the launcher (mirrors relay-server's
/// `ProviderStatusView`). Serialized camelCase for the webview; the incoming
/// relay JSON is snake_case and parsed by hand in `parse_provider_status`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProviderStatusRow {
    provider: String,
    display_name: String,
    status: String,
    connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

struct RelayProcess {
    child: CommandChild,
    pid: u32,
    port: u16,
    ready: bool,
    provider_status: Vec<ProviderStatusRow>,
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

    fn get_config_path(&self) -> &Path {
        &self.config_path
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
        // Write atomically: temp file → sync → rename. This ensures the relay's
        // watcher (in Phase 2) won't see truncate/write windows and parse partial JSON.
        let temp_path = self.config_path.with_extension("json.tmp");
        fs::write(&temp_path, format!("{serialized}\n"))
            .map_err(|error| format!("failed to write temp desktop config: {error}"))?;
        // Sync to disk so relay watcher sees complete data.
        if let Ok(file) = std::fs::File::open(&temp_path) {
            let _ = file.sync_all();
        }
        fs::rename(&temp_path, &self.config_path)
            .map_err(|error| format!("failed to rename desktop config: {error}"))?;
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

    /// True while `pid` is still the tracked relay (so a poll loop knows to stop
    /// once its process is replaced/terminated).
    fn is_current_pid(&self, pid: u32) -> bool {
        self.process
            .lock()
            .expect("relay process lock should not be poisoned")
            .as_ref()
            .is_some_and(|current| current.pid == pid)
    }

    /// Stores the latest provider health for `pid`. Returns true only when it
    /// actually changed (so the caller emits a status event only on a delta).
    fn set_provider_status(&self, pid: u32, rows: Vec<ProviderStatusRow>) -> bool {
        let mut process = self
            .process
            .lock()
            .expect("relay process lock should not be poisoned");
        if let Some(current) = process.as_mut() {
            if current.pid == pid && current.provider_status != rows {
                current.provider_status = rows;
                return true;
            }
        }
        false
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
            provider_status: Vec::new(),
            pid: None,
            port: None,
            local_url: None,
            remote_url: None,
            broker_url: None,
            broker_label: "Stopped".to_string(),
            broker_status: None,
            workspace_dir: None,
            started_at_ms: None,
        }
    }

    fn from_process(process: &RelayProcess) -> Self {
        // Phase 1: broker_status is set based on broker_url presence. Phase 2 will
        // update this in real-time as the broker connection state changes.
        let broker_status = if process.broker_url.is_some() {
            Some("connecting".to_string())
        } else {
            Some("disabled".to_string())
        };
        Self {
            running: true,
            ready: process.ready,
            provider_status: process.provider_status.clone(),
            pid: Some(process.pid),
            port: Some(process.port),
            local_url: Some(local_url(process.port)),
            remote_url: Some(remote_url(process.port)),
            broker_url: process.broker_url.clone(),
            broker_label: process.broker_label.clone(),
            broker_status,
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

/// Resolve the (window label, title, url) for a product surface. Shared by the
/// IPC command and the tray so the two can never route "remote" to different
/// windows. These surfaces load an External http URL and talk to the relay
/// directly, so their windows need no Tauri capability (see IPC_WINDOW_LABELS).
fn surface_target(
    surface: &str,
    port: u16,
) -> Result<(&'static str, &'static str, String), String> {
    match surface {
        "local" => Ok(("sealwire-local", "Sealwire Local", local_url(port))),
        "remote" => Ok(("sealwire-remote", "Sealwire Remote", remote_url(port))),
        _ => Err(format!("unknown surface: {surface}")),
    }
}

/// The port a product surface may open on, or an error explaining why not. A
/// surface must not open until the relay is `ready` — `port` is `Some` as soon
/// as the process is spawned, but during the ready-poll it is not yet accepting
/// connections, so opening then lands the webview on a connection-error page.
/// The launcher UI already gates its Open buttons on `ready`; the tray "Open
/// Remote" item has no such gate, so the invariant lives here for both callers.
fn surface_ready_port(relay: &RelayStatus) -> Result<u16, String> {
    if !relay.running {
        return Err("relay is not running".to_string());
    }
    if !relay.ready {
        return Err("relay is still starting".to_string());
    }
    relay.port.ok_or_else(|| "relay is not running".to_string())
}

/// Open (or focus) a product surface window for the running relay. Errors if the
/// relay is not ready yet or the surface name is unknown.
fn open_surface(
    app: &AppHandle,
    supervisor: &RelaySupervisor,
    surface: &str,
) -> Result<(), String> {
    let port = surface_ready_port(&supervisor.status().relay)?;
    let (label, title, url) = surface_target(surface, port)?;
    open_surface_window(app, label, title, &url)
}

#[tauri::command]
async fn desktop_open_surface(
    app: AppHandle,
    supervisor: State<'_, Arc<RelaySupervisor>>,
    surface: String,
) -> Result<(), String> {
    open_surface(&app, &supervisor, &surface)
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

    let envs = relay_env(
        &app,
        &workspace,
        port,
        broker.as_ref(),
        supervisor.get_config_path(),
    )?;
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
        provider_status: Vec::new(),
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

    // F4 + provider panel: once the port accepts connections, flip the surface
    // buttons on, then poll the relay's /api/session provider health so the
    // launcher's Providers panel reflects which providers came up (or failed).
    let ready_app = app.clone();
    let ready_supervisor = supervisor.clone();
    std::thread::spawn(move || {
        let mut became_ready = false;
        for _ in 0..100 {
            if port_is_ready(port) {
                became_ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        if !became_ready {
            ready_supervisor.push_log(
                Some(&ready_app),
                "error",
                format!("relay-server pid {pid} did not accept connections within timeout"),
            );
            return;
        }
        if ready_supervisor.mark_ready(pid) {
            ready_supervisor.push_log(
                Some(&ready_app),
                "relay",
                format!("relay-server pid {pid} is ready on http://127.0.0.1:{port}"),
            );
        }
        // Land the main window on the live local product the moment the relay is
        // up, instead of leaving it on the launcher config. This runs inside every
        // start_relay (including Save & Restart), so a port change re-points the
        // window automatically. Navigating to the external local URL drops Tauri
        // IPC for this window — intentional: the product is a plain web app; the
        // relay-lifecycle IPC lives in the launcher window (tray → Launcher).
        if let Some(main) = ready_app.get_webview_window(MAIN_WINDOW_LABEL) {
            if let Ok(url) = Url::parse(&local_url(port)) {
                let _ = main.navigate(url);
            }
        }
        // Seed the provider panel immediately, then keep it fresh while this
        // relay is the tracked process (drops/reconnects stream in).
        let rows = fetch_provider_status(port);
        ready_supervisor.set_provider_status(pid, rows);
        ready_supervisor.emit_status(&ready_app);
        loop {
            std::thread::sleep(Duration::from_millis(4000));
            if !ready_supervisor.is_current_pid(pid) {
                return;
            }
            let rows = fetch_provider_status(port);
            if ready_supervisor.set_provider_status(pid, rows) {
                ready_supervisor.emit_status(&ready_app);
            }
        }
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
            .unminimize()
            .map_err(|error| format!("failed to restore {title}: {error}"))?;
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

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Err("launcher window is not available".to_string());
    };
    window
        .show()
        .map_err(|error| format!("failed to show Sealwire: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("failed to restore Sealwire: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus Sealwire: {error}"))
}

// The main window IS the local product now (it navigates to the relay's local URL
// on ready — see the ready poll in start_relay), so "open Sealwire" just brings
// that window to the front. There is no separate product window in the primary
// flow anymore.
fn bring_app_to_front(app: &AppHandle) {
    let _ = show_main_window(app);
}

// The launcher (workspace / port / broker config + start/stop) is now a dedicated,
// on-demand window rather than the primary one. It loads the same desktop.html in
// the Tauri context; its LAUNCHER_WINDOW_LABEL is covered by capabilities/default.json
// so it keeps IPC access to the relay-lifecycle commands and the file dialog.
fn show_launcher_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LAUNCHER_WINDOW_LABEL) {
        window
            .show()
            .map_err(|error| format!("failed to show launcher: {error}"))?;
        let _ = window.unminimize();
        return window
            .set_focus()
            .map_err(|error| format!("failed to focus launcher: {error}"));
    }
    WebviewWindowBuilder::new(
        app,
        LAUNCHER_WINDOW_LABEL,
        WebviewUrl::App("desktop.html".into()),
    )
    .title("Sealwire Launcher")
    .inner_size(1180.0, 760.0)
    .min_inner_size(860.0, 620.0)
    .build()
    .map(|_| ())
    .map_err(|error| format!("failed to open launcher: {error}"))
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open_local =
        MenuItem::with_id(app, TRAY_OPEN_LOCAL_ID, "Open Sealwire", true, None::<&str>)?;
    let open_remote =
        MenuItem::with_id(app, TRAY_OPEN_REMOTE_ID, "Open Remote", true, None::<&str>)?;
    let open_launcher = MenuItem::with_id(
        app,
        TRAY_OPEN_LAUNCHER_ID,
        "Launcher (advanced)…",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit Sealwire", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open_local, &open_remote, &open_launcher, &separator, &quit],
    )?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Sealwire");
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon).icon_as_template(true);
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        TRAY_OPEN_LOCAL_ID => bring_app_to_front(app),
        TRAY_OPEN_REMOTE_ID => {
            if let Some(supervisor) = app.try_state::<Arc<RelaySupervisor>>() {
                if let Err(error) = open_surface(app, &supervisor, "remote") {
                    supervisor.push_log(
                        Some(app),
                        "desktop",
                        format!("open remote failed: {error}"),
                    );
                }
            }
        }
        TRAY_OPEN_LAUNCHER_ID => {
            if let Err(error) = show_launcher_window(app) {
                if let Some(supervisor) = app.try_state::<Arc<RelaySupervisor>>() {
                    supervisor.push_log(
                        Some(app),
                        "desktop",
                        format!("open launcher failed: {error}"),
                    );
                }
            }
        }
        TRAY_QUIT_ID => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            bring_app_to_front(tray.app_handle());
        }
    })
    .build(app)?;

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
    config_path: &Path,
) -> Result<Vec<(OsString, OsString)>, String> {
    let mut envs: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| !is_launcher_managed_env(&key.to_string_lossy()))
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
    // Prepared for Phase 2: relay will watch this file to detect broker config
    // changes and reboots the broker task (if any) without restarting the relay
    // core. For now (Phase 1), changing broker mode requires restarting the relay.
    // Config writes are atomic (temp + rename) so Phase 2 won't parse partial JSON.
    upsert_env(
        &mut envs,
        "RELAY_CONFIG_PATH",
        config_path.display().to_string(),
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

/// Env vars the launcher takes full control of, so a value inherited from the
/// user's shell can never leak into the relay sidecar. Broker vars are set from
/// the picker; `RELAY_API_TOKEN` is scrubbed because the desktop relay is a
/// zero-config loopback server with auth disabled — inheriting a token would
/// enable auth and make both the local webview and `/api/session` provider
/// polling demand a bearer the launcher never sends.
fn is_launcher_managed_env(key: &str) -> bool {
    matches!(
        key,
        "AGENT_RELAY_PUBLIC_BROKER_ORIGIN"
            | "AGENT_RELAY_PUBLIC_BROKER_URL"
            | "RELAY_API_TOKEN"
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

/// Pulls the per-provider health rows out of a relay `/api/session` envelope
/// (`{ ok, data: { provider_status: [...] } }`). The relay JSON is snake_case,
/// so fields are read by hand rather than derived, keeping the serialize side
/// camelCase for the webview. Returns empty on any parse/shape mismatch.
fn parse_provider_status(body: &str) -> Vec<ProviderStatusRow> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(array) = json
        .get("data")
        .and_then(|data| data.get("provider_status"))
        .and_then(|value| value.as_array())
    else {
        return Vec::new();
    };
    array
        .iter()
        .filter_map(|row| {
            Some(ProviderStatusRow {
                provider: row.get("provider")?.as_str()?.to_string(),
                display_name: row
                    .get("display_name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                status: row.get("status")?.as_str()?.to_string(),
                connected: row
                    .get("connected")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
                reason: row
                    .get("reason")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
            })
        })
        .collect()
}

fn fetch_provider_status(port: u16) -> Vec<ProviderStatusRow> {
    let url = format!("http://127.0.0.1:{port}/api/session");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1000))
        .timeout_read(Duration::from_millis(2000))
        .build();
    match agent.get(&url).call() {
        Ok(response) => response
            .into_string()
            .map(|body| parse_provider_status(&body))
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
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
            setup_tray(app)?;
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
            if window.label() == MAIN_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Sealwire desktop")
        .run(|app_handle, event| {
            // F2: guarantee the relay-server (and its node worker / codex children)
            // are killed on true app quit (tray Quit, Cmd+Q, app-menu Quit).
            // Closing the launcher window is now a background/minimize action.
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

    // Every window that loads the Tauri UI (desktop.html) must be covered by a
    // capability, or in Tauri v2 it opens with NO IPC access: desktop_status, the
    // start/stop commands, and the file dialog all silently fail. This regressed
    // once when the launcher moved from the (covered) "main" window to a freshly
    // built "launcher" window that no capability matched.
    #[test]
    fn tauri_ipc_windows_are_capability_covered() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("capabilities/default.json parses");
        let covered: Vec<&str> = caps["windows"]
            .as_array()
            .expect("capability has a `windows` array")
            .iter()
            .map(|w| w.as_str().expect("window label is a string"))
            .collect();
        for label in IPC_WINDOW_LABELS {
            assert!(
                covered.iter().any(|w| *w == "*" || w == label),
                "window {label:?} loads the Tauri IPC UI but is not covered by \
                 capabilities/default.json `windows` {covered:?}; add it or its IPC \
                 (status/start/stop/dialog) is dead"
            );
        }
    }

    // The tray "Open Remote" item and the desktop_open_surface IPC command both
    // route through surface_target, so this pins the labels/URLs they share: a
    // typo that pointed "remote" at the local URL (or vice versa) would regress
    // both entry points at once.
    #[test]
    fn surface_target_routes_local_and_remote() {
        let (local_label, _, local) = surface_target("local", 8811).unwrap();
        assert_eq!(local_label, "sealwire-local");
        assert_eq!(local, "http://127.0.0.1:8811/");

        let (remote_label, _, remote) = surface_target("remote", 8811).unwrap();
        assert_eq!(remote_label, "sealwire-remote");
        assert_eq!(remote, "http://127.0.0.1:8811/static/remote.html");

        assert_ne!(local_label, remote_label);
        assert!(surface_target("bogus", 8811).is_err());
    }

    // A product surface must not open until the relay is `ready`: `port` is
    // `Some` the instant the process spawns, but during the ready-poll it is not
    // yet accepting connections. The launcher UI disables its Open buttons until
    // ready; the tray "Open Remote" item relies on this gate instead. Opening a
    // surface at a not-yet-listening port dumps the user on a browser error page.
    #[test]
    fn surface_wont_open_until_relay_is_ready() {
        let ready = RelayStatus {
            running: true,
            ready: true,
            port: Some(8811),
            ..RelayStatus::stopped()
        };
        assert_eq!(surface_ready_port(&ready).unwrap(), 8811);

        let starting = RelayStatus {
            running: true,
            ready: false,
            port: Some(8811),
            ..RelayStatus::stopped()
        };
        assert!(
            surface_ready_port(&starting).is_err(),
            "a starting (port bound but not ready) relay must not open a surface"
        );

        assert!(surface_ready_port(&RelayStatus::stopped()).is_err());
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

    // Tauri flattens externalBin next to the executable by basename, and the
    // shell plugin's relative_command_path joins the .sidecar() argument onto
    // the exe dir verbatim (no triple, no dir stripping). So the sidecar name
    // must be a bare basename — a "binaries/…" prefix resolves to
    // <exe>/binaries/… which does not exist -> ENOENT at spawn.
    #[test]
    fn relay_sidecar_is_a_bare_basename_matching_external_bin() {
        assert!(
            !RELAY_SIDECAR.contains('/') && !RELAY_SIDECAR.contains('\\'),
            "RELAY_SIDECAR must be a bare basename, got {RELAY_SIDECAR:?}"
        );
        let conf: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
                .expect("read tauri.conf.json"),
        )
        .expect("parse tauri.conf.json");
        let basenames: Vec<String> = conf["bundle"]["externalBin"]
            .as_array()
            .expect("externalBin is an array")
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .expect("externalBin entry is a string")
                    .rsplit('/')
                    .next()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert!(
            basenames.iter().any(|name| name == RELAY_SIDECAR),
            "RELAY_SIDECAR {RELAY_SIDECAR:?} must match an externalBin basename {basenames:?}"
        );
    }

    #[test]
    fn parse_provider_status_extracts_rows_from_session_envelope() {
        let body = r#"{"ok":true,"data":{"provider_status":[
            {"provider":"claude_code","display_name":"Claude Code","status":"connected","connected":true},
            {"provider":"codex","display_name":"Codex","status":"not_installed","connected":false,"reason":"codex: command not found"}
        ]}}"#;
        let rows = parse_provider_status(body);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].provider, "claude_code");
        assert_eq!(rows[0].display_name, "Claude Code");
        assert_eq!(rows[0].status, "connected");
        assert!(rows[0].connected);
        assert_eq!(rows[0].reason, None);
        assert_eq!(rows[1].status, "not_installed");
        assert_eq!(rows[1].reason.as_deref(), Some("codex: command not found"));
    }

    #[test]
    fn parse_provider_status_is_empty_on_garbage_or_missing_field() {
        assert!(parse_provider_status("not json at all").is_empty());
        assert!(parse_provider_status(r#"{"ok":true,"data":{}}"#).is_empty());
    }

    // The desktop relay is loopback + auth-disabled by design. An inherited
    // RELAY_API_TOKEN would flip auth on and make the local webview and the
    // provider poll demand a bearer the launcher never sends, so it must be
    // scrubbed from the sidecar env alongside the broker vars.
    #[test]
    fn launcher_scrubs_inherited_auth_and_broker_env() {
        assert!(
            is_launcher_managed_env("RELAY_API_TOKEN"),
            "inherited RELAY_API_TOKEN must be scrubbed"
        );
        assert!(is_launcher_managed_env("RELAY_BROKER_URL"));
        assert!(is_launcher_managed_env("RELAY_BROKER_AUTH_MODE"));
        assert!(!is_launcher_managed_env("PATH"));
        assert!(!is_launcher_managed_env("HOME"));
        assert!(!is_launcher_managed_env("CLAUDE_WORKER_PATH"));
    }
}
