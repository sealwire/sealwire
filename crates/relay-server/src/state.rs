mod app;
mod persistence;
mod relay;
mod security;
#[cfg(test)]
mod tests;

use std::{
    env,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub use self::app::{AppState, ApprovalError};
use self::relay::TranscriptRecord;
pub(crate) use self::relay::{
    ApprovalKind, BrokerPendingMessage, CachedRemoteActionResult, ClaimChallenge,
    CompletedRemoteClaim, DeviceRecord, IssuedClaimChallenge, PairedDevice, PendingApproval,
    PendingPairingResult, PendingTranscriptDelta, RelayState, RemoteActionReplayDecision,
    TranscriptDeltaKind,
};
pub(crate) use self::security::SecurityProfile;

use crate::protocol::ThreadSummaryView;

pub const DEFAULT_MODEL: &str = "gpt-5.4";
pub const DEFAULT_APPROVAL_POLICY: &str = "untrusted";
pub const DEFAULT_SANDBOX: &str = "workspace-write";
pub const DEFAULT_EFFORT: &str = "medium";
pub const CONTROLLER_LEASE_SECS: u64 = 15;
const MAX_LOG_LINES: usize = 200;
const THREAD_SCAN_LIMIT: usize = 200;
const PERSISTED_STATE_VERSION: u32 = 2;
const DEFAULT_STATE_FILE: &str = ".agent-relay/session.json";

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn require_device_id(device_id: Option<String>) -> Result<String, String> {
    non_empty(device_id).ok_or_else(|| "device_id is required".to_string())
}

fn short_device_id(device_id: &str) -> String {
    let compact = device_id.trim();
    if compact.len() <= 8 {
        compact.to_string()
    } else {
        compact[..8].to_string()
    }
}

fn filter_threads(
    threads: Vec<ThreadSummaryView>,
    cwd: Option<&str>,
    limit: usize,
) -> Vec<ThreadSummaryView> {
    let normalized_cwd = cwd.map(normalize_cwd);
    let mut filtered = threads
        .into_iter()
        .filter(|thread| thread_matches_cwd_scope(&thread.cwd, normalized_cwd.as_deref()))
        .collect::<Vec<_>>();
    filtered.truncate(limit);
    filtered
}

fn thread_matches_cwd_scope(thread_cwd: &str, cwd: Option<&str>) -> bool {
    let Some(cwd) = cwd else {
        return true;
    };

    let normalized_thread_cwd = normalize_cwd(thread_cwd);
    let thread_path = Path::new(&normalized_thread_cwd);
    let selected_path = Path::new(cwd);
    thread_path == selected_path || thread_path.starts_with(selected_path)
}

pub(super) fn path_within_allowed_roots(path: &str, allowed_roots: &[String]) -> bool {
    if allowed_roots.is_empty() {
        return true;
    }

    let normalized_path = normalize_cwd(path);
    let candidate_path = Path::new(&normalized_path);
    allowed_roots.iter().any(|root| {
        let root_path = Path::new(root);
        candidate_path == root_path || candidate_path.starts_with(root_path)
    })
}

pub(super) fn ensure_path_within_allowed_roots(
    path: &str,
    allowed_roots: &[String],
) -> Result<(), String> {
    if path_within_allowed_roots(path, allowed_roots) {
        return Ok(());
    }

    let normalized_path = normalize_cwd(path);
    let root_hint = match allowed_roots {
        [] => "this relay is unrestricted".to_string(),
        [root] => format!("choose a directory under {root}"),
        _ => "choose a directory under one of this relay's allowed roots".to_string(),
    };

    Err(format!(
        "workspace {normalized_path} is outside this relay's allowed roots; {root_hint}"
    ))
}

pub(super) fn normalize_allowed_roots(roots: Vec<String>) -> Result<Vec<String>, String> {
    let mut normalized = roots
        .into_iter()
        .filter_map(|root| non_empty(Some(root)))
        .map(|root| {
            let normalized_root = normalize_cwd(&root);
            let root_path = PathBuf::from(&normalized_root);
            let metadata = std::fs::metadata(&root_path).map_err(|error| {
                format!("allowed root {normalized_root} is not accessible: {error}")
            })?;
            if !metadata.is_dir() {
                return Err(format!(
                    "allowed root {normalized_root} must be a directory"
                ));
            }
            Ok(normalized_root)
        })
        .collect::<Result<Vec<_>, String>>()?;

    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

pub(super) fn normalize_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let expanded = expand_home_dir(trimmed)
        .or_else(|| make_absolute(trimmed))
        .unwrap_or_else(|| PathBuf::from(trimmed));

    normalize_path_lossy(expanded).display().to_string()
}

fn expand_home_dir(path: &str) -> Option<PathBuf> {
    if path == "~" {
        return env::var_os("HOME").map(PathBuf::from);
    }

    if let Some(stripped) = path.strip_prefix("~/") {
        return env::var_os("HOME").map(|home| PathBuf::from(home).join(stripped));
    }

    None
}

fn make_absolute(path: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        return Some(candidate);
    }

    env::current_dir().ok().map(|cwd| cwd.join(candidate))
}

fn normalize_path_lossy(path: PathBuf) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }

    let mut current = path.clone();
    let mut unresolved = Vec::new();

    while !current.exists() {
        let Some(component) = current.file_name().map(|value| value.to_os_string()) else {
            break;
        };
        unresolved.push(component);
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent.to_path_buf();
    }

    let mut normalized = if current.exists() {
        current.canonicalize().unwrap_or(current)
    } else {
        current
    };

    for component in unresolved.into_iter().rev() {
        normalized.push(component);
    }

    collapse_lexical_components(normalized)
}

fn collapse_lexical_components(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    let mut has_root = false;

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => {
                normalized.push(component.as_os_str());
                has_root = true;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                let last_is_parent = normalized
                    .components()
                    .next_back()
                    .is_some_and(|part| matches!(part, Component::ParentDir));
                if normalized.file_name().is_some() && !last_is_parent {
                    normalized.pop();
                } else if !has_root {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }

    normalized
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn expire_controller_if_needed(relay: &mut RelayState) -> bool {
    let Some(expired_device_id) = relay.expire_stale_controller(unix_now()) else {
        return false;
    };

    relay.push_log(
        "info",
        format!(
            "Control lease expired for {}. Session is now unclaimed.",
            short_device_id(&expired_device_id)
        ),
    );
    relay.notify();
    true
}
