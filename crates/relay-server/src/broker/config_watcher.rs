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
