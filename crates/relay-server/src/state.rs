mod app;
mod persistence;
mod relay;
mod review;
mod security;
#[cfg(test)]
mod tests;
mod workflow;

use std::{
    env,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub use self::app::{AppState, ApprovalError, AskUserAnswerError};
#[cfg(test)]
use self::relay::TranscriptRecord;
pub(crate) use self::relay::{
    parse_ask_user_questions, ApprovalKind, BrokerPendingMessage, CachedRemoteActionResult,
    ClaimChallenge, CompletedRemoteClaim, DeviceRecord, IssuedClaimChallenge, PairedDevice,
    PendingApproval, PendingAskUserQuestion, PendingPairingResult, PendingTranscriptDelta,
    RelayState, RemoteActionReplayDecision, ReviewerThread, ThreadSessionSettings,
    TranscriptDeltaKind, MAX_REVIEWERS_PER_PARENT,
};
pub(crate) use self::review::{
    parent_fix_prompt, parent_recap_prompt, parse_verdict, post_back_message, re_review_prompt,
    review_approved_message, review_escalated_message, reviewer_prompt, ReviewJob, ReviewJobStatus,
    ReviewMode, ReviewRecapSource, Verdict,
};
pub(crate) use self::security::SecurityProfile;
#[allow(unused_imports)]
pub(crate) use self::workflow::{
    ArtifactKind, FindingSet, LoopSpec, RunStatus, StepRole, StopCondition, Workflow, WorkflowRun,
    WorkflowStep, WorkflowVerdict,
};

use crate::protocol::ThreadSummaryView;

pub const DEFAULT_MODEL: &str = "gpt-5.5";
pub const DEFAULT_APPROVAL_POLICY: &str = "untrusted";
pub const DEFAULT_SANDBOX: &str = "workspace-write";
pub const DEFAULT_EFFORT: &str = "medium";
pub const CONTROLLER_LEASE_SECS: u64 = 15;
const MAX_LOG_LINES: usize = 200;
const PERSISTED_STATE_VERSION: u32 = 2;
const DEFAULT_STATE_FILE: &str = ".agent-relay/session.json";

/// Shared session-settings invariants for the test harness.
///
/// Every config bug we have hit was the same shape: a per-session setting
/// (model / effort / approval / sandbox) flows through many layers — SDK
/// events, relay state, persistence, the snapshot, and finally the UI — and
/// some operation that should not touch it breaks one of these invariants.
/// Call this after every operation in a scenario so the violation surfaces at
/// the step that caused it rather than three layers downstream.
#[cfg(test)]
pub(crate) fn assert_settings_invariants(snap: &crate::protocol::SessionSnapshot, ctx: &str) {
    // Invariants only apply once a session exists.
    if snap.active_thread_id.is_none() {
        return;
    }

    // I1 — matchable model: when the catalog is loaded, the selected model must
    // be one of its options. Otherwise the model picker synthesizes a duplicate
    // "ghost" row for the unmatched id (the claude-opus-4-8 bug).
    if !snap.available_models.is_empty() {
        assert!(
            snap.available_models
                .iter()
                .any(|option| option.model == snap.model),
            "[{ctx}] settings invariant I1 (matchable model) violated: model {:?} is not in catalog {:?}",
            snap.model,
            snap.available_models
                .iter()
                .map(|option| option.model.clone())
                .collect::<Vec<_>>(),
        );
    }

    // I2 — populated: a control must never blank out. Empty values render as a
    // selector with nothing chosen (the "max disappeared" symptom).
    assert!(
        !snap.model.is_empty(),
        "[{ctx}] settings invariant I2 violated: model is empty"
    );
    assert!(
        !snap.reasoning_effort.is_empty(),
        "[{ctx}] settings invariant I2 violated: reasoning_effort is empty"
    );
    assert!(
        !snap.approval_policy.is_empty(),
        "[{ctx}] settings invariant I2 violated: approval_policy is empty"
    );
    assert!(
        !snap.sandbox.is_empty(),
        "[{ctx}] settings invariant I2 violated: sandbox is empty"
    );
}

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

fn sort_threads_by_recency(threads: &mut [ThreadSummaryView]) {
    threads.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.provider.cmp(&right.provider))
            .then_with(|| left.id.cmp(&right.id))
    });
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

pub(super) fn path_within_device_scope(
    path: &str,
    device_scope: &[String],
    relay_allowed_roots: &[String],
) -> bool {
    path_within_allowed_roots(path, relay_allowed_roots)
        && (device_scope.is_empty() || path_within_allowed_roots(path, device_scope))
}

pub(super) fn ensure_path_within_device_scope(
    path: &str,
    device_scope: &[String],
    relay_allowed_roots: &[String],
) -> Result<(), String> {
    ensure_path_within_allowed_roots(path, relay_allowed_roots)?;
    if !device_scope.is_empty() && !path_within_allowed_roots(path, device_scope) {
        let normalized_path = normalize_cwd(path);
        let hint = match device_scope {
            [one] => format!("choose a directory under {one}"),
            _ => "choose a directory under one of this device's allowed paths".to_string(),
        };
        return Err(format!(
            "workspace {normalized_path} is outside this device's allowed paths; {hint}"
        ));
    }
    Ok(())
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

pub(crate) fn unix_now() -> u64 {
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
