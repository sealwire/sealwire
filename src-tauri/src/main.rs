use serde::Serialize;
use std::{
    collections::VecDeque,
    ffi::OsString,
    io::{BufRead, BufReader, Read},
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Wry,
};
use url::Url;

// Same default as `npx sealwire`. Keeping it stable also keeps the page's saved
// settings, which the webview stores per origin (port included).
const DEFAULT_PORT: u16 = 8787;
const LOG_LIMIT: usize = 200;
const READY_TIMEOUT: Duration = Duration::from_secs(60);
// The relay stops its agents before exiting; past this it is killed outright.
const STOP_GRACE: Duration = Duration::from_secs(5);
const STATUS_EVENT: &str = "desktop://status";
const TRAY_ID: &str = "sealwire-tray";
const TRAY_OPEN_ID: &str = "open";
const TRAY_QUIT_ID: &str = "quit";
const TRAY_RELAY_ID: &str = "relay";
// How often a window with no relay looks for one started elsewhere.
const WATCH_INTERVAL: Duration = Duration::from_secs(2);
const SETTINGS_TABS: [(&str, &str); 3] = [
    ("providers", "Providers"),
    ("devices", "Devices"),
    ("access", "Access"),
];
const THEMES: [(&str, &str); 3] = [("auto", "Auto"), ("light", "Light"), ("dark", "Dark")];
const DEFAULT_THEME: &str = "light";
const THEME_STORAGE_KEY: &str = "agent-relay.theme";
const DESKTOP_COMMAND_EVENT: &str = "sealwire:desktop-command";
const MAIN_WINDOW_LABEL: &str = "main";
// In Tauri v2 a window no capability names opens with no IPC at all, so the
// startup page's status/retry calls would silently do nothing.
#[cfg(test)]
const IPC_WINDOW_LABELS: &[&str] = &[MAIN_WINDOW_LABEL];
// Tauri flattens externalBin next to the executable by basename, so this must be
// a bare basename.
const RELAY_SIDECAR: &str = "relay-server";
// The installed localhost web app's theme_color, which is what its title bar shows;
// dark reads right above the page in either theme.
#[cfg(target_os = "macos")]
const TITLE_BAR_COLOR: tauri::webview::Color = tauri::webview::Color(0x17, 0x17, 0x17, 0xff);

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
enum Phase {
    #[default]
    Starting,
    Ready {
        port: u16,
    },
    /// Nothing running, and the app waits to be asked rather than starting one.
    Stopped,
    Failed {
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
struct DesktopStatus {
    #[serde(flatten)]
    phase: Phase,
    logs: Vec<String>,
}

/// A relay this app started. A relay that was already running is used, never owned,
/// so quitting the app leaves it alone.
struct OwnedRelay {
    pid: u32,
    exited: mpsc::Receiver<()>,
}

impl OwnedRelay {
    /// SIGTERM first, as `npx sealwire` forwards Ctrl-C, so the relay can stop its agents.
    fn stop(self) {
        signal(self.pid, false);
        if self.exited.recv_timeout(STOP_GRACE).is_err() {
            signal(self.pid, true);
        }
    }
}

#[cfg(unix)]
fn signal(pid: u32, kill: bool) {
    let signal = if kill { libc::SIGKILL } else { libc::SIGTERM };
    // SAFETY: plain kill(2) on a pid this process spawned and has not reaped yet.
    unsafe {
        libc::kill(pid as libc::pid_t, signal);
    }
}

#[cfg(not(unix))]
fn signal(pid: u32, _kill: bool) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

#[derive(Default)]
struct Supervisor {
    phase: Mutex<Phase>,
    logs: Mutex<VecDeque<String>>,
    relay: Mutex<Option<OwnedRelay>>,
    startup_page: Mutex<Option<Url>>,
}

impl Supervisor {
    fn status(&self) -> DesktopStatus {
        DesktopStatus {
            phase: self.phase.lock().unwrap().clone(),
            logs: self.recent_logs(),
        }
    }

    fn recent_logs(&self) -> Vec<String> {
        self.logs.lock().unwrap().iter().cloned().collect()
    }

    fn push_log(&self, line: impl Into<String>) {
        let mut logs = self.logs.lock().unwrap();
        if logs.len() >= LOG_LIMIT {
            logs.pop_front();
        }
        logs.push_back(line.into());
    }

    fn phase(&self) -> Phase {
        self.phase.lock().unwrap().clone()
    }

    fn set_phase(&self, app: &AppHandle, phase: Phase) {
        *self.phase.lock().unwrap() = phase;
        self.publish(app);
    }

    /// Moves to `next` only from a phase `from` accepts, so a background check that
    /// raced a click cannot undo what the click started.
    fn advance(&self, app: &AppHandle, from: impl Fn(&Phase) -> bool, next: Phase) -> bool {
        {
            let mut phase = self.phase.lock().unwrap();
            if !from(&phase) {
                return false;
            }
            *phase = next;
        }
        self.publish(app);
        true
    }

    fn publish(&self, app: &AppHandle) {
        let status = self.status();
        let _ = app.emit(STATUS_EVENT, &status);
        sync_tray(app, &status.phase, self.owns_relay());
        let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
            return;
        };
        let target = match status.phase {
            Phase::Ready { port } => Url::parse(&local_url(port)).ok(),
            // Without a relay the page is dead; the startup page says why and offers Start.
            Phase::Stopped | Phase::Failed { .. } => self.startup_page.lock().unwrap().clone(),
            Phase::Starting => None,
        };
        if let Some(target) = target {
            if window.url().ok().as_ref() != Some(&target) {
                let _ = window.navigate(target);
            }
        }
    }

    fn begin_start(&self, app: &AppHandle) -> bool {
        self.logs.lock().unwrap().clear();
        self.advance(app, is_idle, Phase::Starting)
    }

    fn owns_relay(&self) -> bool {
        self.relay.lock().unwrap().is_some()
    }

    fn replace_relay(&self, relay: OwnedRelay) -> Option<OwnedRelay> {
        self.relay.lock().unwrap().replace(relay)
    }

    fn take_relay(&self) -> Option<OwnedRelay> {
        self.relay.lock().unwrap().take()
    }

    fn owns(&self, pid: u32) -> bool {
        self.relay
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|relay| relay.pid == pid)
    }

    /// Drops `pid` if it is still the owned relay. False means it was stopped on
    /// purpose (quit, timeout) and its exit is not a failure to report.
    fn forget(&self, pid: u32) -> bool {
        let mut relay = self.relay.lock().unwrap();
        if relay.as_ref().is_some_and(|current| current.pid == pid) {
            *relay = None;
            true
        } else {
            false
        }
    }
}

#[tauri::command]
fn desktop_status(supervisor: State<'_, Arc<Supervisor>>) -> DesktopStatus {
    supervisor.status()
}

#[tauri::command]
fn desktop_start(app: AppHandle, supervisor: State<'_, Arc<Supervisor>>) {
    start_relay(app, supervisor.inner().clone());
}

fn is_idle(phase: &Phase) -> bool {
    matches!(phase, Phase::Stopped | Phase::Failed { .. })
}

fn shared_state_db() -> PathBuf {
    state_db_path(std::env::var_os("RELAY_STATE_DB"), &relay_cwd())
}

/// Shows the relay that owns the shared database when there is one, as a localhost
/// tab would, and keeps looking while there is none so dev:full is picked up by itself.
fn watch_for_relay(app: AppHandle, supervisor: Arc<Supervisor>) {
    std::thread::spawn(move || {
        let state_db = shared_state_db();
        match running_relay_port(&state_db) {
            Some(port) => supervisor.set_phase(&app, Phase::Ready { port }),
            None => supervisor.set_phase(&app, Phase::Stopped),
        }
        loop {
            std::thread::sleep(WATCH_INTERVAL);
            if is_idle(&supervisor.phase()) {
                if let Some(port) = running_relay_port(&state_db) {
                    supervisor.advance(&app, is_idle, Phase::Ready { port });
                }
            }
        }
    });
}

/// A relay started elsewhere is not watched; this notices it has gone once someone
/// reaches for the menu, so Start is offered again.
fn recheck_relay(app: &AppHandle) {
    let Some(supervisor) = app.try_state::<Arc<Supervisor>>() else {
        return;
    };
    let supervisor = supervisor.inner().clone();
    let app = app.clone();
    std::thread::spawn(move || {
        if let Phase::Ready { port } = supervisor.phase() {
            if !supervisor.owns_relay() && probe_health(port).is_none() {
                supervisor.advance(&app, |now| *now == Phase::Ready { port }, Phase::Stopped);
            }
        }
    });
}

fn start_relay(app: AppHandle, supervisor: Arc<Supervisor>) {
    if supervisor.begin_start(&app) {
        std::thread::spawn(move || start_blocking(&app, &supervisor));
    }
}

fn stop_relay(app: AppHandle, supervisor: Arc<Supervisor>) {
    std::thread::spawn(move || {
        if let Some(relay) = supervisor.take_relay() {
            relay.stop();
            supervisor.set_phase(&app, Phase::Stopped);
        }
    });
}

/// Starts the bundled relay the way `npx sealwire local` does.
fn start_blocking(app: &AppHandle, supervisor: &Arc<Supervisor>) {
    // One may have come up since the last look; starting a second would only hit its lock.
    if let Some(port) = running_relay_port(&shared_state_db()) {
        supervisor.set_phase(app, Phase::Ready { port });
        return;
    }
    let cwd = relay_cwd();
    let port = match pick_port(DEFAULT_PORT) {
        Ok(port) => port,
        Err(error) => return supervisor.set_phase(app, Phase::Failed { message: error }),
    };
    let launch_id = launch_id();
    let pid = match spawn_relay(app, supervisor, &cwd, port, &launch_id) {
        Ok(pid) => pid,
        Err(error) => return supervisor.set_phase(app, Phase::Failed { message: error }),
    };

    // Waiting for our own launch id, not just an open port, so a different server
    // that grabbed the port in the meantime is never mistaken for this relay.
    let deadline = Instant::now() + READY_TIMEOUT;
    while supervisor.owns(pid) {
        if probe_health(port)
            .is_some_and(|health| health.launch_id.as_deref() == Some(launch_id.as_str()))
        {
            supervisor.set_phase(app, Phase::Ready { port });
            return;
        }
        if Instant::now() >= deadline {
            if let Some(relay) = supervisor.take_relay() {
                relay.stop();
            }
            supervisor.set_phase(
                app,
                Phase::Failed {
                    message: "Sealwire did not start within a minute.".to_string(),
                },
            );
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn spawn_relay(
    app: &AppHandle,
    supervisor: &Arc<Supervisor>,
    cwd: &Path,
    port: u16,
    launch_id: &str,
) -> Result<u32, String> {
    let envs = relay_env(
        std::env::vars_os().collect(),
        port,
        launch_id,
        resolve_claude_worker(app).as_deref(),
        resolve_bundled_node().as_deref(),
    );
    let sidecar = std::env::current_exe()
        .map_err(|error| format!("Could not find the bundled relay-server: {error}"))?
        .with_file_name(format!("{RELAY_SIDECAR}{}", std::env::consts::EXE_SUFFIX));
    let mut child = Command::new(&sidecar)
        .env_clear()
        .envs(envs)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", sidecar.display()))?;
    let pid = child.id();
    let (exited_tx, exited) = mpsc::channel();
    if let Some(stale) = supervisor.replace_relay(OwnedRelay { pid, exited }) {
        stale.stop();
    }
    supervisor.push_log(format!("started relay-server (pid {pid}) on port {port}"));

    let (drained_tx, drained) = mpsc::channel();
    let stdout = child.stdout.take().expect("relay stdout is piped");
    let stderr = child.stderr.take().expect("relay stderr is piped");
    forward_lines(stdout, supervisor.clone(), drained_tx.clone());
    forward_lines(stderr, supervisor.clone(), drained_tx);

    let app = app.clone();
    let supervisor = supervisor.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        let _ = exited_tx.send(());
        // Let the readers deliver the relay's last words before judging its exit. Not
        // until EOF: an agent it started can hold its stderr open after it is gone.
        for _ in 0..2 {
            if drained.recv_timeout(Duration::from_millis(500)).is_err() {
                break;
            }
        }
        supervisor.push_log(format!(
            "relay-server (pid {pid}) exited with code {code:?}"
        ));
        if supervisor.forget(pid) {
            let message = failure_message(&supervisor.recent_logs(), code);
            supervisor.set_phase(&app, Phase::Failed { message });
        }
    });
    Ok(pid)
}

fn forward_lines(
    stream: impl Read + Send + 'static,
    supervisor: Arc<Supervisor>,
    drained: mpsc::Sender<()>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        while reader
            .read_until(b'\n', &mut line)
            .is_ok_and(|read| read > 0)
        {
            for text in decode_lines(&line) {
                supervisor.push_log(text);
            }
            line.clear();
        }
        let _ = drained.send(());
    });
}

fn stop_owned_relay(app: &AppHandle) {
    if let Some(supervisor) = app.try_state::<Arc<Supervisor>>() {
        if let Some(relay) = supervisor.take_relay() {
            relay.stop();
        }
    }
}

/// The relay's last own error line names the cause (a lock held by another relay,
/// state that needs migrating); the exit code alone says nothing.
fn failure_message(logs: &[String], code: Option<i32>) -> String {
    logs.iter()
        .rev()
        .find(|line| line.starts_with("relay-server:") || line.starts_with("sealwire:"))
        .cloned()
        .unwrap_or_else(|| match code {
            Some(code) => format!("Sealwire stopped unexpectedly (exit code {code})."),
            None => "Sealwire stopped unexpectedly.".to_string(),
        })
}

/// Same rule as relay-server's `state_db_path`: `RELAY_STATE_DB`, else `~/.sealwire/sealwire.db`.
fn state_db_path(override_value: Option<OsString>, cwd: &Path) -> PathBuf {
    let explicit = override_value
        .map(|value| PathBuf::from(value.to_string_lossy().trim()))
        .filter(|path| !path.as_os_str().is_empty());
    match explicit {
        Some(path) => cwd.join(path),
        None => home_dir()
            .unwrap_or_else(|| cwd.to_path_buf())
            .join(".sealwire")
            .join("sealwire.db"),
    }
}

/// The port of a live relay that holds `state_db`, read from the owner file the
/// relay writes beside its lock. A leftover file from a crashed relay fails the probe.
fn running_relay_port(state_db: &Path) -> Option<u16> {
    let identity = std::fs::canonicalize(state_db).unwrap_or_else(|_| state_db.to_path_buf());
    let mut owner_file = identity.into_os_string();
    owner_file.push(".owner.json");
    let port = parse_owner_port(&std::fs::read(owner_file).ok()?)?;
    probe_health(port).map(|_| port)
}

fn parse_owner_port(bytes: &[u8]) -> Option<u16> {
    let json: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    u16::try_from(json.get("port")?.as_u64()?)
        .ok()
        .filter(|port| *port != 0)
}

#[derive(Debug, PartialEq, Eq)]
struct Health {
    launch_id: Option<String>,
}

fn parse_health(body: &str) -> Option<Health> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let data = json.get("data")?;
    let healthy = json.get("ok")?.as_bool()? && data.get("status")?.as_str()? == "ok";
    (healthy && data.get("service")?.as_str()? == "relay-server").then(|| Health {
        launch_id: data
            .get("launch_id")
            .and_then(|value| value.as_str())
            .map(str::to_string),
    })
}

fn probe_health(port: u16) -> Option<Health> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(500))
        .timeout_read(Duration::from_millis(1500))
        .build();
    let body = agent
        .get(&format!("http://127.0.0.1:{port}/api/health"))
        .call()
        .ok()?
        .into_string()
        .ok()?;
    parse_health(&body)
}

fn relay_env(
    inherited: Vec<(OsString, OsString)>,
    port: u16,
    launch_id: &str,
    worker: Option<&Path>,
    bundled_node: Option<&Path>,
) -> Vec<(OsString, OsString)> {
    let mut envs: Vec<(OsString, OsString)> = inherited
        .into_iter()
        .filter(|(key, _)| !is_scrubbed_env(&key.to_string_lossy()))
        .collect();
    let has = |envs: &Vec<(OsString, OsString)>, key: &str| envs.iter().any(|(k, _)| k == key);
    let node = bundled_node.filter(|_| !has(&envs, "CLAUDE_NODE_BINARY"));
    let current_path = envs
        .iter()
        .find(|(key, _)| key == "PATH")
        .map(|(_, value)| value.clone());

    upsert_env(&mut envs, "PORT", port.to_string());
    upsert_env(&mut envs, "BIND_HOST", "127.0.0.1");
    upsert_env(&mut envs, "SEALWIRE_LAUNCH_ID", launch_id);
    upsert_env(
        &mut envs,
        "PATH",
        expanded_path(node.and_then(Path::parent), current_path),
    );
    if let Some(worker) = worker.filter(|_| !has(&envs, "CLAUDE_WORKER_PATH")) {
        upsert_env(&mut envs, "CLAUDE_WORKER_PATH", worker.as_os_str());
    }
    if let Some(node) = node {
        upsert_env(&mut envs, "CLAUDE_NODE_BINARY", node.as_os_str());
    }
    envs
}

/// Local only, like `npx sealwire local`: a broker or Cloud setting inherited from
/// a shell would otherwise put this relay online without anyone asking.
fn is_scrubbed_env(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.starts_with("RELAY_BROKER_")
        || key.starts_with("RELAY_CLOUD_")
        || key.starts_with("SEALWIRE_CLOUD_")
        || matches!(
            key.as_str(),
            "AGENT_RELAY_PUBLIC_BROKER_ORIGIN"
                | "AGENT_RELAY_PUBLIC_BROKER_URL"
                | "RELAY_LICENSE_CODE"
                | "RELAY_API_TOKEN"
                | "RELAY_ALLOWED_HOSTS"
                | "RELAY_ALLOW_INSECURE_NO_AUTH"
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

/// Apps opened from Finder get a bare PATH, so the provider CLIs that Homebrew
/// installs would not be found without these.
fn expanded_path(extra_first: Option<&Path>, current: Option<OsString>) -> OsString {
    let mut entries = Vec::new();
    entries.extend(extra_first.map(Path::to_path_buf));
    entries.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
            "/bin",
        ]
        .map(PathBuf::from),
    );
    if let Some(current) = current {
        entries.extend(std::env::split_paths(&current));
    }
    let mut unique: Vec<PathBuf> = Vec::new();
    for entry in entries {
        if !unique.contains(&entry) {
            unique.push(entry);
        }
    }
    std::env::join_paths(unique).unwrap_or_else(|_| OsString::from("/usr/bin:/bin"))
}

/// The startup page and the relay's own pages; anything else would strand the
/// window on a page with no way back.
fn stays_in_window(url: &Url) -> bool {
    use url::Host;
    match (url.scheme(), url.host()) {
        ("tauri" | "about", _) => true,
        ("http" | "https", Some(Host::Domain(host))) => {
            matches!(host, "localhost" | "tauri.localhost")
        }
        ("http" | "https", Some(Host::Ipv4(ip))) => ip.is_loopback(),
        ("http" | "https", Some(Host::Ipv6(ip))) => ip.is_loopback(),
        _ => false,
    }
}

fn opens_in_browser(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

fn open_in_browser(url: &Url) {
    if opens_in_browser(url) {
        if let Err(error) = open::that_detached(url.as_str()) {
            eprintln!("sealwire-desktop: could not open {url}: {error}");
        }
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_main_window(app: &tauri::App) -> tauri::Result<Url> {
    let builder = WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW_LABEL,
        WebviewUrl::App("desktop.html".into()),
    )
    .title("Sealwire")
    .inner_size(1280.0, 820.0)
    .min_inner_size(860.0, 620.0);
    // A transparent title bar shows the window colour; the title is hidden because
    // its text follows the system appearance and would be dark on dark.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Transparent)
        .hidden_title(true)
        .background_color(TITLE_BAR_COLOR);
    let window = builder
        .on_navigation(|url| {
            if stays_in_window(url) {
                return true;
            }
            open_in_browser(url);
            false
        })
        // The app has no tabs: links that would open one go to the default browser.
        .on_new_window(|url, _features| {
            open_in_browser(&url);
            NewWindowResponse::Deny
        })
        .build()?;
    window.url()
}

enum TrayAction {
    Open,
    Quit,
    Relay,
    Settings(&'static str),
    Theme(&'static str),
}

fn tray_action(id: &str) -> Option<TrayAction> {
    let pick = |list: [(&'static str, &str); 3], wanted: &str| {
        list.into_iter()
            .map(|(value, _)| value)
            .find(|value| *value == wanted)
    };
    match id.split_once(':') {
        Some(("settings", tab)) => pick(SETTINGS_TABS, tab).map(TrayAction::Settings),
        Some(("theme", theme)) => pick(THEMES, theme).map(TrayAction::Theme),
        _ if id == TRAY_OPEN_ID => Some(TrayAction::Open),
        _ if id == TRAY_QUIT_ID => Some(TrayAction::Quit),
        _ if id == TRAY_RELAY_ID => Some(TrayAction::Relay),
        _ => None,
    }
}

fn page_command_script(detail: &serde_json::Value) -> String {
    format!(
        "window.dispatchEvent(new CustomEvent({}, {{ detail: {detail} }}))",
        serde_json::Value::from(DESKTOP_COMMAND_EVENT)
    )
}

/// Reads an `eval` result of the page's stored theme the way the page itself does.
fn page_theme(result: &str) -> &'static str {
    let stored = serde_json::from_str::<String>(result).unwrap_or_default();
    THEMES
        .into_iter()
        .map(|(value, _)| value)
        .find(|value| *value == stored)
        .unwrap_or(DEFAULT_THEME)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RelayAction {
    Start,
    Stop,
}

struct RelayItem {
    label: String,
    action: Option<RelayAction>,
}

fn relay_item(phase: &Phase, owned: bool) -> RelayItem {
    let (label, action) = match phase {
        Phase::Stopped | Phase::Failed { .. } => {
            ("Start Sealwire".to_string(), Some(RelayAction::Start))
        }
        Phase::Ready { .. } if owned => ("Stop Sealwire".to_string(), Some(RelayAction::Stop)),
        Phase::Ready { port } => (format!("Sealwire is already running (port {port})"), None),
        Phase::Starting => ("Starting Sealwire…".to_string(), None),
    };
    RelayItem { label, action }
}

struct TrayItems {
    relay: MenuItem<Wry>,
    settings: Submenu<Wry>,
}

fn sync_tray(app: &AppHandle, phase: &Phase, owned: bool) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let item = relay_item(phase, owned);
        let _ = items.relay.set_text(item.label);
        let _ = items.relay.set_enabled(item.action.is_some());
        // Settings lives in the relay's page, so there is nothing to open without one.
        let _ = items
            .settings
            .set_enabled(matches!(phase, Phase::Ready { .. }));
    }
}

struct ThemeMenu(Vec<CheckMenuItem<Wry>>);

fn check_theme(app: &AppHandle, theme: &str) {
    if let Some(menu) = app.try_state::<ThemeMenu>() {
        for item in &menu.0 {
            let _ = item.set_checked(item.id().as_ref() == format!("theme:{theme}"));
        }
    }
}

/// The page's Settings can change the theme too, so the checkmark is read back from
/// the page whenever the pointer reaches the icon, before the menu can open.
fn refresh_theme_checks(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let app = app.clone();
        let read = format!(
            "localStorage.getItem({})",
            serde_json::Value::from(THEME_STORAGE_KEY)
        );
        let _ =
            window.eval_with_callback(read, move |result| check_theme(&app, page_theme(&result)));
    }
}

fn run_page_command(app: &AppHandle, detail: serde_json::Value) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.eval(page_command_script(&detail));
    }
}

fn on_tray_menu(app: &AppHandle, id: &str) {
    match tray_action(id) {
        Some(TrayAction::Open) => show_main_window(app),
        Some(TrayAction::Quit) => app.exit(0),
        Some(TrayAction::Relay) => {
            let Some(supervisor) = app.try_state::<Arc<Supervisor>>() else {
                return;
            };
            let supervisor = supervisor.inner().clone();
            match relay_item(&supervisor.phase(), supervisor.owns_relay()).action {
                Some(RelayAction::Start) => start_relay(app.clone(), supervisor),
                Some(RelayAction::Stop) => stop_relay(app.clone(), supervisor),
                None => {}
            }
        }
        Some(TrayAction::Settings(tab)) => {
            show_main_window(app);
            run_page_command(
                app,
                serde_json::json!({"command": "open-settings", "tab": tab}),
            );
        }
        Some(TrayAction::Theme(theme)) => {
            run_page_command(
                app,
                serde_json::json!({"command": "set-theme", "theme": theme}),
            );
            // Clicking a check item toggles it, so a re-picked theme would come out unchecked.
            check_theme(app, theme);
        }
        None => {}
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open Sealwire", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit Sealwire", true, None::<&str>)?;
    let relay = MenuItem::with_id(
        app,
        TRAY_RELAY_ID,
        relay_item(&Phase::Starting, false).label,
        false,
        None::<&str>,
    )?;
    let tabs = SETTINGS_TABS
        .into_iter()
        .map(|(tab, label)| {
            MenuItem::with_id(app, format!("settings:{tab}"), label, true, None::<&str>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let themes = THEMES
        .into_iter()
        .map(|(theme, label)| {
            CheckMenuItem::with_id(
                app,
                format!("theme:{theme}"),
                label,
                true,
                theme == DEFAULT_THEME,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let theme_menu = Submenu::with_items(
        app,
        "Theme",
        true,
        &themes
            .iter()
            .map(|item| item as &dyn tauri::menu::IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;
    let settings_separator = PredefinedMenuItem::separator(app)?;
    let mut settings_items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = tabs
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<Wry>)
        .collect();
    settings_items.push(&settings_separator);
    settings_items.push(&theme_menu);
    let settings = Submenu::with_items(app, "Settings", false, &settings_items)?;
    let relay_separator = PredefinedMenuItem::separator(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &relay,
            &relay_separator,
            &settings,
            &separator,
            &quit,
        ],
    )?;
    app.manage(ThemeMenu(themes));
    app.manage(TrayItems { relay, settings });

    // A template image is drawn from its alpha alone, so the opaque app icon would
    // render as a solid disc; the tray needs its own cut-out silhouette.
    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Sealwire")
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true)
        .on_menu_event(|app, event| on_tray_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Enter { .. } = event {
                refresh_theme_checks(tray.app_handle());
                recheck_relay(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn pick_port(preferred: u16) -> Result<u16, String> {
    if port_is_available(preferred) {
        return Ok(preferred);
    }
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Could not find a free port for Sealwire: {error}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|error| format!("Could not find a free port for Sealwire: {error}"))
}

fn port_is_available(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn resolve_claude_worker(app: &AppHandle) -> Option<PathBuf> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .to_path_buf();
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("claude-worker").join("worker.mjs"));
    }
    candidates.push(repo_root.join("src-tauri/resources/claude-worker/worker.mjs"));
    candidates.push(repo_root.join("claude-worker/worker.mjs"));
    candidates.into_iter().find(|candidate| candidate.exists())
}

fn resolve_bundled_node() -> Option<PathBuf> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|dir| dir.join(executable))
        .filter(|candidate| candidate.exists())
}

fn home_dir() -> Option<PathBuf> {
    ["HOME", "USERPROFILE"].into_iter().find_map(|key| {
        std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    })
}

/// New sessions default to the relay's working directory; from Finder there is
/// no meaningful one, so use home.
fn relay_cwd() -> PathBuf {
    home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn launch_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("desktop-{}-{nanos:x}", std::process::id())
}

fn local_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

fn decode_lines(bytes: &[u8]) -> Vec<String> {
    strip_ansi(&String::from_utf8_lossy(bytes))
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

/// The relay's log lines carry terminal colour codes, which would show up as
/// garbage on the startup page.
fn strip_ansi(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            output.push(ch);
        }
    }
    output
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![desktop_status, desktop_start])
        .setup(|app| {
            let supervisor = Arc::new(Supervisor::default());
            app.manage(supervisor.clone());
            *supervisor.startup_page.lock().unwrap() = Some(build_main_window(app)?);
            setup_tray(app)?;
            watch_for_relay(app.handle().clone(), supervisor);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the relay running, like closing a browser tab.
            if window.label() == MAIN_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Sealwire desktop")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => stop_owned_relay(app),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => show_main_window(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn links_to_other_sites_open_in_the_default_browser() {
        for link in [
            "https://github.com/sealwire/sealwire/pull/1",
            "http://example.com/",
            "mailto:someone@example.com",
            "http://localhost:3000/",
        ] {
            assert!(
                opens_in_browser(&url(link)),
                "{link} should open in the browser"
            );
        }
        for link in [
            "file:///etc/passwd",
            "vscode://file/tmp/x",
            "javascript:alert(1)",
        ] {
            assert!(
                !opens_in_browser(&url(link)),
                "{link} must not be handed to the OS"
            );
        }
    }

    // Both plugins inject a script into every page that turns a target=_blank click
    // into an IPC call and cancels it; the relay's page has no IPC, so links went dead.
    #[test]
    fn no_plugin_swallows_link_clicks_on_the_relay_page() {
        let manifest = include_str!("../Cargo.toml");
        for plugin in ["tauri-plugin-shell", "tauri-plugin-opener"] {
            assert!(
                !manifest.contains(plugin),
                "{plugin} intercepts link clicks on the relay page; open links in on_new_window instead"
            );
        }
    }

    #[test]
    fn the_window_only_shows_the_startup_page_and_the_local_relay() {
        for target in [
            "tauri://localhost/desktop.html",
            "http://127.0.0.1:5173/static/desktop.html",
            "http://127.0.0.1:8787/",
            "http://localhost:8790/?thread=abc",
            "http://[::1]:8787/",
            "about:blank",
        ] {
            assert!(
                stays_in_window(&url(target)),
                "{target} belongs in the window"
            );
        }
        for target in [
            "https://github.com/",
            "http://192.168.1.5:8787/",
            "file:///Users/me/notes.md",
            "data:text/html,hi",
        ] {
            assert!(
                !stays_in_window(&url(target)),
                "{target} must not replace the app"
            );
        }
    }

    // Only a relay this app started may be stopped from here; one started elsewhere
    // (dev:full, `npx sealwire`) is shown but left alone.
    #[test]
    fn the_relay_menu_item_follows_who_runs_the_relay() {
        let ready = Phase::Ready { port: 8787 };
        let item = |phase: &Phase, owned| {
            let item = relay_item(phase, owned);
            (item.label, item.action)
        };
        assert_eq!(
            item(&Phase::Stopped, false),
            ("Start Sealwire".to_string(), Some(RelayAction::Start))
        );
        assert_eq!(
            item(
                &Phase::Failed {
                    message: "x".into()
                },
                false
            ),
            ("Start Sealwire".to_string(), Some(RelayAction::Start))
        );
        assert_eq!(
            item(&ready, true),
            ("Stop Sealwire".to_string(), Some(RelayAction::Stop))
        );
        assert_eq!(
            item(&ready, false),
            ("Sealwire is already running (port 8787)".to_string(), None)
        );
        assert_eq!(
            item(&Phase::Starting, false),
            ("Starting Sealwire…".to_string(), None)
        );
        assert!(matches!(tray_action("relay"), Some(TrayAction::Relay)));
    }

    #[test]
    fn tray_items_map_to_page_commands() {
        assert!(matches!(tray_action("open"), Some(TrayAction::Open)));
        assert!(matches!(tray_action("quit"), Some(TrayAction::Quit)));
        assert!(matches!(
            tray_action("settings:devices"),
            Some(TrayAction::Settings("devices"))
        ));
        assert!(matches!(
            tray_action("theme:dark"),
            Some(TrayAction::Theme("dark"))
        ));
        assert!(tray_action("settings:billing").is_none());
        assert!(tray_action("theme:sepia").is_none());

        let script =
            page_command_script(&serde_json::json!({"command": "open-settings", "tab": "access"}));
        assert_eq!(
            script,
            r#"window.dispatchEvent(new CustomEvent("sealwire:desktop-command", { detail: {"command":"open-settings","tab":"access"} }))"#
        );
    }

    // The page owns these names; the menu only works while both sides agree.
    #[test]
    fn tray_commands_match_what_the_local_page_listens_for() {
        let commands = include_str!("../../frontend/local/desktop-commands.js");
        assert!(commands.contains(&format!("\"{DESKTOP_COMMAND_EVENT}\"")));
        assert!(commands.contains("\"open-settings\"") && commands.contains("\"set-theme\""));

        let tabs = include_str!("../../frontend/local/settings-view.js");
        for (tab, _) in SETTINGS_TABS {
            assert!(
                tabs.contains(&format!("\"{tab}\"")),
                "settings page has no {tab:?} tab"
            );
        }

        let theme = include_str!("../../frontend/shared/theme.js");
        assert!(theme.contains(&format!("\"{THEME_STORAGE_KEY}\"")));
        assert!(theme.contains(&format!("DEFAULT_THEME = \"{DEFAULT_THEME}\"")));
        for (value, _) in THEMES {
            assert!(
                theme.contains(&format!("\"{value}\"")),
                "page has no {value:?} theme"
            );
        }
    }

    #[test]
    fn page_theme_reads_like_the_page_does() {
        assert_eq!(page_theme(r#""dark""#), "dark");
        assert_eq!(page_theme(r#""auto""#), "auto");
        assert_eq!(page_theme("null"), "light");
        assert_eq!(page_theme(r#""purple""#), "light");
        assert_eq!(page_theme(""), "light");
    }

    #[test]
    fn health_identifies_a_relay_and_its_launch() {
        assert_eq!(
            parse_health(
                r#"{"ok":true,"data":{"status":"ok","service":"relay-server","provider":"claude_code"}}"#
            ),
            Some(Health { launch_id: None })
        );
        assert_eq!(
            parse_health(
                r#"{"ok":true,"data":{"status":"ok","service":"relay-server","launch_id":"desktop-1"}}"#
            ),
            Some(Health {
                launch_id: Some("desktop-1".to_string())
            })
        );
        assert_eq!(
            parse_health(r#"{"ok":true,"data":{"status":"ok","service":"vite"}}"#),
            None
        );
        assert_eq!(
            parse_health(r#"{"ok":false,"data":{"status":"ok","service":"relay-server"}}"#),
            None
        );
        assert_eq!(parse_health("<html>not a relay</html>"), None);
    }

    #[test]
    fn owner_file_gives_the_running_relays_port() {
        assert_eq!(
            parse_owner_port(br#"{"pid":84175,"port":8787}"#),
            Some(8787)
        );
        assert_eq!(parse_owner_port(br#"{"pid":1,"port":0}"#), None);
        assert_eq!(parse_owner_port(br#"{"pid":1,"port":70000}"#), None);
        assert_eq!(parse_owner_port(b"garbage"), None);
    }

    // The window must open the same database `npx sealwire` uses, or the sessions
    // in it and in a localhost tab drift apart.
    #[test]
    fn state_database_matches_the_cli_default() {
        let cwd = Path::new("/somewhere");
        let home = home_dir().expect("tests run with HOME set");
        assert_eq!(state_db_path(None, cwd), home.join(".sealwire/sealwire.db"));
        assert_eq!(
            state_db_path(Some(OsString::from("  ")), cwd),
            home.join(".sealwire/sealwire.db")
        );
        assert_eq!(
            state_db_path(Some(OsString::from("/tmp/isolated.db")), cwd),
            PathBuf::from("/tmp/isolated.db")
        );
        assert_eq!(
            state_db_path(Some(OsString::from("rel.db")), cwd),
            PathBuf::from("/somewhere/rel.db")
        );
    }

    fn env_value<'a>(envs: &'a [(OsString, OsString)], key: &str) -> Option<&'a OsString> {
        envs.iter().find(|(k, _)| k == key).map(|(_, value)| value)
    }

    #[test]
    fn relay_env_is_local_only_and_shares_the_default_database() {
        let inherited = vec![
            (OsString::from("HOME"), OsString::from("/Users/me")),
            (OsString::from("PORT"), OsString::from("1234")),
            (
                OsString::from("PATH"),
                OsString::from("/usr/bin:/custom/bin"),
            ),
            (
                OsString::from("RELAY_BROKER_URL"),
                OsString::from("wss://x"),
            ),
            (
                OsString::from("relay_broker_public_url"),
                OsString::from("wss://x"),
            ),
            (
                OsString::from("RELAY_CLOUD_EXPECTED_RELAY_ID"),
                OsString::from("r"),
            ),
            (
                OsString::from("SEALWIRE_CLOUD_ACCESS_KEY"),
                OsString::from("k"),
            ),
            (OsString::from("RELAY_API_TOKEN"), OsString::from("t")),
        ];
        let envs = relay_env(
            inherited,
            8787,
            "launch-1",
            Some(Path::new("/App/Resources/claude-worker/worker.mjs")),
            Some(Path::new("/App/MacOS/node")),
        );

        assert_eq!(env_value(&envs, "PORT").unwrap(), "8787");
        assert_eq!(env_value(&envs, "BIND_HOST").unwrap(), "127.0.0.1");
        assert_eq!(env_value(&envs, "SEALWIRE_LAUNCH_ID").unwrap(), "launch-1");
        assert_eq!(env_value(&envs, "HOME").unwrap(), "/Users/me");
        assert_eq!(env_value(&envs, "RELAY_STATE_DB"), None);
        for (key, _) in &envs {
            let key = key.to_string_lossy().to_ascii_uppercase();
            assert!(
                !key.starts_with("RELAY_BROKER_")
                    && !key.starts_with("RELAY_CLOUD_")
                    && !key.starts_with("SEALWIRE_CLOUD_")
                    && key != "RELAY_API_TOKEN",
                "{key} must not reach a local-only relay"
            );
        }
        assert_eq!(
            env_value(&envs, "CLAUDE_WORKER_PATH").unwrap(),
            "/App/Resources/claude-worker/worker.mjs"
        );
        assert_eq!(
            env_value(&envs, "CLAUDE_NODE_BINARY").unwrap(),
            "/App/MacOS/node"
        );
        let path = env_value(&envs, "PATH")
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(path.starts_with("/App/MacOS:/opt/homebrew/bin:"), "{path}");
        assert!(path.ends_with("/custom/bin"), "{path}");
    }

    #[test]
    fn relay_env_keeps_explicit_worker_and_node_overrides() {
        let inherited = vec![
            (
                OsString::from("CLAUDE_WORKER_PATH"),
                OsString::from("/dev/worker.mjs"),
            ),
            (
                OsString::from("CLAUDE_NODE_BINARY"),
                OsString::from("/dev/node"),
            ),
            (
                OsString::from("RELAY_STATE_DB"),
                OsString::from("/tmp/isolated.db"),
            ),
        ];
        let envs = relay_env(
            inherited,
            8787,
            "launch-1",
            Some(Path::new("/App/worker.mjs")),
            Some(Path::new("/App/MacOS/node")),
        );
        assert_eq!(
            env_value(&envs, "CLAUDE_WORKER_PATH").unwrap(),
            "/dev/worker.mjs"
        );
        assert_eq!(env_value(&envs, "CLAUDE_NODE_BINARY").unwrap(), "/dev/node");
        assert_eq!(
            env_value(&envs, "RELAY_STATE_DB").unwrap(),
            "/tmp/isolated.db"
        );
        assert!(!env_value(&envs, "PATH")
            .unwrap()
            .to_string_lossy()
            .contains("/App/MacOS"));
    }

    #[test]
    fn failure_message_prefers_the_relays_own_error() {
        let logs = vec![
            "started relay-server (pid 1) on port 8787".to_string(),
            "relay-server: another relay is already running (pid 9, port 8787) against the state database".to_string(),
            "relay-server (pid 1) exited with code Some(1)".to_string(),
        ];
        assert!(failure_message(&logs, Some(1)).starts_with("relay-server: another relay"));
        assert_eq!(
            failure_message(&["noise".to_string()], Some(101)),
            "Sealwire stopped unexpectedly (exit code 101)."
        );
        assert_eq!(failure_message(&[], None), "Sealwire stopped unexpectedly.");
    }

    #[test]
    fn status_serializes_the_phase_flat() {
        let status = DesktopStatus {
            phase: Phase::Failed {
                message: "boom".to_string(),
            },
            logs: vec!["line".to_string()],
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({"phase": "failed", "message": "boom", "logs": ["line"]})
        );
        let ready = DesktopStatus {
            phase: Phase::Ready { port: 8787 },
            logs: vec![],
        };
        assert_eq!(
            serde_json::to_value(ready).unwrap(),
            serde_json::json!({"phase": "ready", "port": 8787, "logs": []})
        );
        let stopped = DesktopStatus {
            phase: Phase::Stopped,
            logs: vec![],
        };
        assert_eq!(
            serde_json::to_value(stopped).unwrap(),
            serde_json::json!({"phase": "stopped", "logs": []})
        );
    }

    #[test]
    fn log_lines_lose_terminal_colours() {
        assert_eq!(
            decode_lines(b"\x1b[2m2026-10-12\x1b[0m \x1b[32m INFO\x1b[0m relay up\n\n  second  \n"),
            vec![
                "2026-10-12  INFO relay up".to_string(),
                "second".to_string()
            ]
        );
    }

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
                "window {label:?} loads the startup page but is not covered by \
                 capabilities/default.json `windows` {covered:?}"
            );
        }
    }

    #[test]
    fn pick_port_prefers_free_and_falls_back_when_busy() {
        let occupied = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let busy = occupied.local_addr().unwrap().port();
        let chosen = pick_port(busy).unwrap();
        assert_ne!(chosen, busy, "does not choose a busy preferred port");
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
}
