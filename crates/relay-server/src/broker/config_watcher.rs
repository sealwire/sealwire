// Desktop config file watcher for hot broker switching (Phase 2).
// Monitors RELAY_CONFIG_PATH (the desktop-config.json file) for changes to
// broker configuration, allowing the relay to restart the broker task without
// restarting the core, thus preserving local session state.
//
// This module is tested but not yet wired into spawn_broker_task — the broker
// lifecycle refactor that consumes it is the next Phase 2 step. `allow(dead_code)`
// keeps the tree warning-clean until that landing; remove it once integrated.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{debug, warn};
use url::Url;

/// Desktop config structure, deserialized from desktop-config.json.
/// We only care about broker fields for Phase 2.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub workspace_dir: String,
    pub preferred_port: u16,
    pub broker_mode: String, // camelCase from desktop: "localOnly" | "hosted" | "custom"
    pub custom_broker_url: String,
}

/// The broker-relevant subset of DesktopConfig.
#[derive(Debug, Clone, PartialEq)]
pub struct BrokerConfigPart {
    pub mode: String,
    pub custom_url: String,
}

impl BrokerConfigPart {
    pub fn from_desktop(config: &DesktopConfig) -> Self {
        Self {
            mode: config.broker_mode.clone(),
            custom_url: config.custom_broker_url.clone(),
        }
    }
}

/// The resolved broker endpoints for a given mode: the ws(s) URL the relay dials
/// and the http(s) control-plane URL. `None` means "no broker" (local-only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerEndpoints {
    pub ws_url: String,
    pub control_url: String,
}

fn strip_trailing_slash(value: &str) -> String {
    value.strip_suffix('/').unwrap_or(value).to_string()
}

/// Resolve a broker mode into the ws + control endpoints, mirroring the desktop
/// launcher's `broker_runtime_config` normalization so a hot switch lands on the
/// exact same URLs a restart would. `hosted_url` is the (stable) hosted broker URL
/// handed to the relay at startup; it is only consulted for the "hosted" mode.
///
/// Returns `Ok(None)` for local-only, `Ok(Some(_))` for an enabled broker, and
/// `Err` for an unknown mode or an unusable URL (so a bad edit keeps the current
/// broker rather than tearing it down — the caller decides that policy).
pub fn resolve_broker_endpoints(
    mode: &str,
    custom_url: &str,
    hosted_url: Option<&str>,
) -> Result<Option<BrokerEndpoints>, String> {
    let value = match mode {
        "localOnly" => return Ok(None),
        "hosted" => hosted_url
            .ok_or_else(|| "hosted broker URL is not available to the relay".to_string())?
            .trim(),
        "custom" => custom_url.trim(),
        other => return Err(format!("unknown broker mode: {other}")),
    };
    if value.is_empty() {
        return Err("broker URL is required".to_string());
    }

    let mut parsed = Url::parse(value).map_err(|error| format!("invalid broker URL: {error}"))?;
    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);

    let scheme = parsed.scheme().to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "ws" | "wss") {
        return Err("broker URL must start with http://, https://, ws://, or wss://".to_string());
    }

    let mut control = parsed.clone();
    let control_scheme = match scheme.as_str() {
        "ws" => "http",
        "wss" => "https",
        other => other,
    };
    control
        .set_scheme(control_scheme)
        .map_err(|_| "failed to normalize broker control URL".to_string())?;

    let ws_scheme = match scheme.as_str() {
        "http" => "ws",
        "https" => "wss",
        other => other,
    };
    parsed
        .set_scheme(ws_scheme)
        .map_err(|_| "failed to normalize broker websocket URL".to_string())?;

    Ok(Some(BrokerEndpoints {
        ws_url: strip_trailing_slash(parsed.as_str()),
        control_url: strip_trailing_slash(control.as_str()),
    }))
}

/// Read and parse the desktop config file at the given path.
pub async fn read_desktop_config(path: &PathBuf) -> Result<DesktopConfig, String> {
    tokio::fs::read_to_string(path)
        .await
        .map_err(|e| format!("failed to read config file: {e}"))
        .and_then(|content| {
            serde_json::from_str(&content).map_err(|e| format!("failed to parse config JSON: {e}"))
        })
}

/// Default poll interval for the production watcher.
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Watch the desktop config file for changes and signal on broker config changes.
///
/// Establishes a baseline by reading the file immediately (before returning), then
/// spawns a background poller. Returns (receiver, baseline) so the caller knows the
/// initial state and can detect changes that occur between watcher creation and the
/// first poll.
///
/// The receiver gets a signal whenever the broker config part changes. The watcher
/// task stops (dropping the sender, which closes the receiver) when the config file
/// becomes unreadable OR when all receivers have been dropped — so a caller that only
/// wanted the baseline can drop the receiver and the poll task cleans itself up.
pub async fn watch_broker_config_changes(
    config_path: PathBuf,
) -> Result<
    (
        tokio::sync::broadcast::Receiver<BrokerConfigPart>,
        BrokerConfigPart,
    ),
    String,
> {
    let (rx, baseline, _handle) = spawn_config_watch(config_path, DEFAULT_POLL_INTERVAL).await?;
    Ok((rx, baseline))
}

/// Core watcher with an injectable poll interval (so tests run fast) that also
/// returns the poll task's JoinHandle, letting tests observe that it stops.
/// Production callers use `watch_broker_config_changes`, which detaches the handle.
async fn spawn_config_watch(
    config_path: PathBuf,
    poll_interval: Duration,
) -> Result<
    (
        tokio::sync::broadcast::Receiver<BrokerConfigPart>,
        BrokerConfigPart,
        tokio::task::JoinHandle<()>,
    ),
    String,
> {
    // Establish baseline immediately, before returning, to avoid missing changes
    // that occur between watcher creation and the first poll.
    let baseline_config = read_desktop_config(&config_path)
        .await
        .map(|cfg| BrokerConfigPart::from_desktop(&cfg))?;

    let (tx, rx) = tokio::sync::broadcast::channel::<BrokerConfigPart>(8);
    let baseline = baseline_config.clone();

    // Poll for changes, using content hash (not mtime) so rapid updates within the
    // same second are never collapsed.
    let handle = tokio::spawn(async move {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        fn hash_content(content: &str) -> u64 {
            let mut hasher = DefaultHasher::new();
            content.hash(&mut hasher);
            hasher.finish()
        }

        let mut last_content_hash: u64 = 0;
        let mut last_config = baseline;

        loop {
            sleep(poll_interval).await;

            // Nobody is listening anymore — don't keep polling forever.
            if tx.receiver_count() == 0 {
                debug!("no broker-config receivers left, stopping watcher");
                break;
            }

            match tokio::fs::read_to_string(&config_path).await {
                Ok(content) => {
                    let current_hash = hash_content(&content);
                    // Only reparse when the bytes changed.
                    if current_hash == last_content_hash {
                        continue;
                    }
                    // Advance the hash regardless of parse outcome: identical bad
                    // content should not be reparsed every tick (log spam), while any
                    // new content — including a later valid write — has a new hash and
                    // is retried.
                    last_content_hash = current_hash;

                    match serde_json::from_str::<DesktopConfig>(&content) {
                        Ok(config) => {
                            let broker_part = BrokerConfigPart::from_desktop(&config);
                            if last_config != broker_part {
                                debug!(
                                    broker_mode = %broker_part.mode,
                                    "desktop config broker part changed, signaling"
                                );
                                last_config = broker_part.clone();
                                let _ = tx.send(broker_part);
                            }
                        }
                        Err(e) => {
                            warn!("failed to parse broker config from file: {e}");
                        }
                    }
                }
                Err(_) => {
                    // File deleted / unreadable. Stop watching.
                    debug!("config file no longer exists, stopping watcher");
                    break;
                }
            }
        }
    });

    Ok((rx, baseline_config, handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::sync::broadcast::error::RecvError;
    use tokio::sync::broadcast::Receiver;

    const TEST_POLL: Duration = Duration::from_millis(15);

    fn unique_path(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "relay-broker-watch-{}-{tag}-{n}.json",
            std::process::id()
        ))
    }

    fn config_json(mode: &str, url: &str) -> String {
        format!(
            r#"{{"workspaceDir":"/tmp/ws","preferredPort":8787,"brokerMode":"{mode}","customBrokerUrl":"{url}"}}"#
        )
    }

    // Write atomically (temp + rename), mirroring how the desktop shell saves the
    // config, so the watcher never observes a partial file.
    fn write_raw(path: &Path, content: &str) {
        let tmp = PathBuf::from(format!("{}.tmp", path.display()));
        std::fs::write(&tmp, content).unwrap();
        std::fs::rename(&tmp, path).unwrap();
    }

    fn write_config(path: &Path, mode: &str, url: &str) {
        write_raw(path, &config_json(mode, url));
    }

    // Collect every change delivered until the channel goes quiet for `quiet`,
    // tolerating broadcast Lagged. Returns them in order (last = most recent).
    async fn drain(rx: &mut Receiver<BrokerConfigPart>, quiet: Duration) -> Vec<BrokerConfigPart> {
        let mut out = Vec::new();
        loop {
            match tokio::time::timeout(quiet, rx.recv()).await {
                Ok(Ok(part)) => out.push(part),
                Ok(Err(RecvError::Lagged(_))) => continue,
                Ok(Err(RecvError::Closed)) => break,
                Err(_) => break, // quiet window elapsed with nothing new
            }
        }
        out
    }

    #[tokio::test]
    async fn missing_file_is_an_error() {
        let path = unique_path("missing");
        assert!(watch_broker_config_changes(path).await.is_err());
    }

    #[tokio::test]
    async fn baseline_reflects_the_file() {
        let path = unique_path("baseline");
        write_config(&path, "hosted", "");
        let (_rx, baseline) = watch_broker_config_changes(path.clone()).await.unwrap();
        assert_eq!(baseline.mode, "hosted");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn unchanged_file_never_emits() {
        let path = unique_path("unchanged");
        write_config(&path, "hosted", "");
        let (mut rx, _baseline) = watch_broker_config_changes(path.clone()).await.unwrap();
        // Give the poller several ticks; the baseline must not be re-emitted.
        let changes = drain(&mut rx, Duration::from_millis(120)).await;
        assert!(changes.is_empty(), "unchanged file emitted: {changes:?}");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn change_right_after_start_is_captured() {
        let path = unique_path("poststart");
        write_config(&path, "localOnly", "");
        let (mut rx, baseline) = spawn_config_watch(path.clone(), TEST_POLL)
            .await
            .map(|(rx, base, _h)| (rx, base))
            .unwrap();
        assert_eq!(baseline.mode, "localOnly");
        // Change immediately, before the first poll tick.
        write_config(&path, "hosted", "");
        let changes = drain(&mut rx, Duration::from_millis(200)).await;
        assert_eq!(changes.last().map(|c| c.mode.as_str()), Some("hosted"));
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn rapid_updates_converge_to_latest() {
        let path = unique_path("rapid");
        write_config(&path, "localOnly", "");
        let (mut rx, _baseline) = spawn_config_watch(path.clone(), TEST_POLL)
            .await
            .map(|(rx, base, _h)| (rx, base))
            .unwrap();
        write_config(&path, "hosted", "");
        write_config(&path, "custom", "wss://a.example.com");
        write_config(&path, "custom", "wss://b.example.com");
        let changes = drain(&mut rx, Duration::from_millis(200)).await;
        let last = changes.last().expect("at least one change");
        assert_eq!(last.mode, "custom");
        assert_eq!(last.custom_url, "wss://b.example.com");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn parse_failure_does_not_kill_the_watcher() {
        let path = unique_path("parsefail");
        write_config(&path, "localOnly", "");
        let (mut rx, _baseline) = spawn_config_watch(path.clone(), TEST_POLL)
            .await
            .map(|(rx, base, _h)| (rx, base))
            .unwrap();
        // Garbage write: must NOT emit and must NOT kill the poller.
        write_raw(&path, "{ this is not valid json ");
        assert!(
            drain(&mut rx, Duration::from_millis(120)).await.is_empty(),
            "invalid config should not emit a change"
        );
        // A later valid write is still detected — the watcher recovered.
        write_config(&path, "hosted", "");
        let changes = drain(&mut rx, Duration::from_millis(200)).await;
        assert_eq!(changes.last().map(|c| c.mode.as_str()), Some("hosted"));
        let _ = std::fs::remove_file(&path);
    }

    const HOSTED: &str = "wss://agent-relay.up.railway.app";

    #[test]
    fn local_only_resolves_to_no_broker() {
        assert_eq!(
            resolve_broker_endpoints("localOnly", "", Some(HOSTED)),
            Ok(None)
        );
    }

    #[test]
    fn hosted_maps_to_wss_and_https() {
        let ep = resolve_broker_endpoints("hosted", "", Some(HOSTED))
            .unwrap()
            .unwrap();
        assert_eq!(ep.ws_url, "wss://agent-relay.up.railway.app");
        assert_eq!(ep.control_url, "https://agent-relay.up.railway.app");
    }

    #[test]
    fn hosted_without_a_hosted_url_errors() {
        assert!(resolve_broker_endpoints("hosted", "", None).is_err());
    }

    #[test]
    fn custom_ws_maps_to_http_control() {
        let ep = resolve_broker_endpoints("custom", "ws://127.0.0.1:9000", None)
            .unwrap()
            .unwrap();
        assert_eq!(ep.ws_url, "ws://127.0.0.1:9000");
        assert_eq!(ep.control_url, "http://127.0.0.1:9000");
    }

    #[test]
    fn custom_https_maps_to_wss_and_https() {
        let ep = resolve_broker_endpoints("custom", "https://broker.example.com", None)
            .unwrap()
            .unwrap();
        assert_eq!(ep.ws_url, "wss://broker.example.com");
        assert_eq!(ep.control_url, "https://broker.example.com");
    }

    #[test]
    fn custom_strips_path_query_and_fragment() {
        let ep = resolve_broker_endpoints("custom", "wss://h.example.com/foo?x=1#y", None)
            .unwrap()
            .unwrap();
        assert_eq!(ep.ws_url, "wss://h.example.com");
        assert_eq!(ep.control_url, "https://h.example.com");
    }

    #[test]
    fn empty_custom_url_errors() {
        assert!(resolve_broker_endpoints("custom", "   ", None).is_err());
    }

    #[test]
    fn unknown_scheme_errors() {
        assert!(resolve_broker_endpoints("custom", "ftp://nope", None).is_err());
    }

    #[test]
    fn unknown_mode_errors() {
        assert!(resolve_broker_endpoints("banana", "", Some(HOSTED)).is_err());
    }

    #[tokio::test]
    async fn dropping_the_receiver_stops_polling() {
        let path = unique_path("dropped");
        write_config(&path, "localOnly", "");
        let (rx, _baseline, handle) = spawn_config_watch(path.clone(), TEST_POLL).await.unwrap();
        drop(rx); // no receivers left
        let stopped = tokio::time::timeout(Duration::from_secs(1), handle).await;
        assert!(
            matches!(stopped, Ok(Ok(()))),
            "poll task should stop after all receivers drop, got {stopped:?}"
        );
        let _ = std::fs::remove_file(&path);
    }
}
