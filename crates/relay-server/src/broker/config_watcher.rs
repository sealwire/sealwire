// Desktop config file watcher for hot broker switching (Phase 2).
// Monitors RELAY_CONFIG_PATH (the desktop-config.json file) for changes to
// broker configuration, allowing the relay to restart the broker task without
// restarting the core, thus preserving local session state.

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
    pub broker_mode: String, // "LocalOnly" | "Hosted" | "Custom"
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

/// Watch the desktop config file for changes and signal on broker config changes.
/// This is a long-running task; call it via tokio::spawn.
///
/// Returns a receiver that gets a signal whenever the broker config part changes.
/// The receiver is closed when this task exits (config file becomes unreadable or deleted).
/// Does NOT emit the initial config as a change; only signals on actual changes after startup.
pub async fn watch_broker_config_changes(
    config_path: PathBuf,
) -> Result<tokio::sync::broadcast::Receiver<BrokerConfigPart>, String> {
    let (tx, rx) = tokio::sync::broadcast::channel::<BrokerConfigPart>(1);

    // Poll the file every 500ms for changes, using content hash (not mtime) to avoid
    // missing rapid updates within the same second.
    tokio::spawn(async move {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut last_content_hash: u64 = 0;
        let mut last_config: Option<BrokerConfigPart> = None;
        let mut initialized = false;

        loop {
            sleep(Duration::from_millis(500)).await;

            // Read file content.
            match tokio::fs::read_to_string(&config_path).await {
                Ok(content) => {
                    // Compute hash of the raw content.
                    let mut hasher = DefaultHasher::new();
                    content.hash(&mut hasher);
                    let current_hash = hasher.finish();

                    // Only proceed if content changed.
                    if current_hash != last_content_hash {
                        last_content_hash = current_hash;

                        // Try to parse the new config.
                        match serde_json::from_str::<DesktopConfig>(&content) {
                            Ok(config) => {
                                let broker_part = BrokerConfigPart::from_desktop(&config);

                                // On first successful read, just record it (don't signal as a change).
                                if !initialized {
                                    debug!("broker watcher initialized, baseline config loaded");
                                    last_config = Some(broker_part);
                                    initialized = true;
                                } else if last_config.as_ref() != Some(&broker_part) {
                                    // Broker config actually changed; signal it.
                                    debug!(
                                        broker_mode = %broker_part.mode,
                                        "desktop config broker part changed, signaling"
                                    );
                                    last_config = Some(broker_part.clone());
                                    let _ = tx.send(broker_part);
                                }
                            }
                            Err(e) => {
                                warn!("failed to parse broker config from file: {e}");
                                // Don't update last_mtime, so we retry on next change.
                            }
                        }
                    }
                }
                Err(_) => {
                    // File doesn't exist or became unreadable. Stop watching.
                    debug!("config file no longer exists, stopping watcher");
                    break;
                }
            }
        }
    });

    Ok(rx)
}
