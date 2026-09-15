//! Explicit cloud access release (`sealwire cloud unbind`).
//!
//! Product-neutral client for `POST /api/public/relay/access/release`. Never
//! prints refresh tokens or activation keys. Handles the cleanup-ambiguous
//! post-strategy 503 via a secret-free pending-release marker.

use std::path::{Path, PathBuf};
use std::time::Duration;

use relay_broker::public_control::{AccessReleaseRequest, AccessReleaseResponse};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use url::Url;

use super::activation::scrub_activation_env;
use super::auth::{RELAY_BROKER_CONTROL_URL_ENV, RELAY_BROKER_REGISTRATION_PATH_ENV};
use super::lifecycle::{delete_registration_if_matches, BrokerLifecycleLock, RegistrationIdentity};
use super::{
    load_public_relay_registration_raw, resolve_public_relay_registration_path,
    PersistedPublicRelayRegistration, PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION,
};

const RELEASE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_LOCAL_FILE_BYTES: usize = 256 * 1024;
const PENDING_RELEASE_SCHEMA_VERSION: u32 = 1;
const PENDING_RELEASE_FILE: &str = "public-broker-pending-release.json";
/// Truncated one-way fingerprint length (hex chars). Not a full digest.
const BEARER_FINGERPRINT_HEX_CHARS: usize = 16;

#[cfg(test)]
std::thread_local! {
    static TEST_RELEASE_TIMEOUT: std::cell::Cell<Option<Duration>> = const { std::cell::Cell::new(None) };
}

fn release_timeout() -> Duration {
    #[cfg(test)]
    {
        if let Some(timeout) = TEST_RELEASE_TIMEOUT.with(|cell| cell.get()) {
            return timeout;
        }
    }
    RELEASE_TIMEOUT
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PendingReleaseMarker {
    schema_version: u32,
    control_url: String,
    relay_id: String,
    broker_room_id: String,
    /// Truncated SHA-256 hex of the refresh bearer — not reversible to the token.
    bearer_fingerprint: String,
}

#[derive(Debug, Deserialize)]
struct ReleaseErrorBody {
    error: Option<String>,
    message: Option<String>,
    access_released: Option<bool>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReleaseOutcome {
    Released,
    AlreadyReleased,
    NotLinked,
    Failed(String),
}

/// CLI entry used by `npx sealwire cloud unbind` (via `relay-server cloud-access-release`).
pub async fn run_cloud_access_release() -> i32 {
    scrub_activation_env();
    match release_cloud_access_from_env().await {
        ReleaseOutcome::Released => {
            eprintln!("sealwire: cloud access unbound; registration cache removed.");
            eprintln!("sealwire: next `sealwire cloud` will prompt for a Cloud access key.");
            0
        }
        ReleaseOutcome::AlreadyReleased => {
            eprintln!("sealwire: cloud access already released; local registration cache cleared.");
            0
        }
        ReleaseOutcome::NotLinked => {
            eprintln!("sealwire: not linked to SealWire Cloud (no matching registration cache).");
            0
        }
        ReleaseOutcome::Failed(message) => {
            eprintln!("sealwire: cloud unbind failed: {message}");
            1
        }
    }
}

pub(crate) async fn release_cloud_access_from_env() -> ReleaseOutcome {
    let control_url = match std::env::var(RELAY_BROKER_CONTROL_URL_ENV)
        .ok()
        .and_then(|v| {
            let t = v.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }) {
        Some(url) => url,
        None => {
            return ReleaseOutcome::Failed(format!(
                "{RELAY_BROKER_CONTROL_URL_ENV} is required for cloud unbind"
            ));
        }
    };
    let control_url = match normalize_control_origin(&control_url) {
        Ok(url) => url,
        Err(error) => return ReleaseOutcome::Failed(error),
    };

    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            return ReleaseOutcome::Failed(format!("failed to resolve current directory: {error}"))
        }
    };
    let registration_path = resolve_public_relay_registration_path(
        &cwd,
        std::env::var(RELAY_BROKER_REGISTRATION_PATH_ENV).ok(),
    );
    let marker_path = pending_release_marker_path(&registration_path);

    release_cloud_access(&control_url, &registration_path, &marker_path).await
}

pub(crate) async fn release_cloud_access(
    expected_control_url: &str,
    registration_path: &Path,
    marker_path: &Path,
) -> ReleaseOutcome {
    release_cloud_access_after_acquire(expected_control_url, registration_path, marker_path, || {})
        .await
}

/// Same as [`release_cloud_access`], with a per-call hook invoked immediately
/// after the lifecycle lock is held and before any registration read or remote
/// release. Used by contention tests to force lock order without sleeping or
/// assuming flock FIFO; production callers pass a no-op via
/// [`release_cloud_access`].
pub(crate) async fn release_cloud_access_after_acquire(
    expected_control_url: &str,
    registration_path: &Path,
    marker_path: &Path,
    after_acquire: impl FnOnce(),
) -> ReleaseOutcome {
    let _lifecycle = match BrokerLifecycleLock::acquire_for_registration(registration_path) {
        Ok(lock) => lock,
        Err(error) => return ReleaseOutcome::Failed(error),
    };
    after_acquire();

    let persisted = match load_registration_for_release(registration_path, expected_control_url) {
        Ok(Some(persisted)) => persisted,
        Ok(None) => {
            let _ = tokio::fs::remove_file(marker_path).await;
            return ReleaseOutcome::NotLinked;
        }
        Err(error) => return ReleaseOutcome::Failed(error),
    };

    let expected_identity = RegistrationIdentity::from_persisted(&persisted, expected_control_url);
    let fingerprint = expected_identity.bearer_fingerprint.clone();
    let existing_marker = match load_pending_release_marker(marker_path) {
        Ok(marker) => marker,
        Err(error) => return ReleaseOutcome::Failed(error),
    };
    let marker_matches = existing_marker.as_ref().is_some_and(|m| {
        m.control_url == expected_control_url
            && m.relay_id == persisted.relay_id
            && m.broker_room_id == persisted.broker_room_id
            && m.bearer_fingerprint == fingerprint
    });

    let client = match build_release_client() {
        Ok(client) => client,
        Err(error) => return ReleaseOutcome::Failed(error),
    };

    let request = AccessReleaseRequest {
        relay_id: persisted.relay_id.clone(),
        broker_room_id: persisted.broker_room_id.clone(),
    };
    let result = post_access_release(
        &client,
        expected_control_url,
        &persisted.relay_refresh_token,
        &request,
    )
    .await;

    match result {
        Ok(()) => {
            finish_confirmed_release(
                registration_path,
                marker_path,
                &expected_identity,
                ReleaseOutcome::Released,
            )
            .await
        }
        Err(ReleaseHttpError::Unauthorized) if marker_matches => {
            finish_confirmed_release(
                registration_path,
                marker_path,
                &expected_identity,
                ReleaseOutcome::AlreadyReleased,
            )
            .await
        }
        Err(ReleaseHttpError::Unavailable {
            access_released: true,
            message,
        }) => {
            let marker = PendingReleaseMarker {
                schema_version: PENDING_RELEASE_SCHEMA_VERSION,
                control_url: expected_control_url.to_string(),
                relay_id: persisted.relay_id.clone(),
                broker_room_id: persisted.broker_room_id.clone(),
                bearer_fingerprint: fingerprint.clone(),
            };
            match save_pending_release_marker(marker_path, &marker).await {
                Ok(()) => ReleaseOutcome::Failed(format!(
                    "{message} (access released remotely; local cleanup pending — re-run `sealwire cloud unbind`)"
                )),
                Err(marker_error) => {
                    // Do NOT delete registration merely because private release
                    // succeeded. Confirm with an immediate in-process retry.
                    match post_access_release(
                        &client,
                        expected_control_url,
                        &persisted.relay_refresh_token,
                        &request,
                    )
                    .await
                    {
                        Ok(()) => {
                            finish_confirmed_release(
                                registration_path,
                                marker_path,
                                &expected_identity,
                                ReleaseOutcome::Released,
                            )
                            .await
                        }
                        Err(ReleaseHttpError::Unauthorized) => {
                            // In-process post-strategy fact is known for this attempt.
                            finish_confirmed_release(
                                registration_path,
                                marker_path,
                                &expected_identity,
                                ReleaseOutcome::AlreadyReleased,
                            )
                            .await
                        }
                        Err(ReleaseHttpError::Unavailable {
                            access_released: true,
                            ..
                        }) => {
                            if save_pending_release_marker(marker_path, &marker)
                                .await
                                .is_ok()
                            {
                                ReleaseOutcome::Failed(format!(
                                    "{message} (access released remotely; marker persisted after retry — re-run `sealwire cloud unbind`)"
                                ))
                            } else {
                                // Post-strategy release is known but neither
                                // public confirmation nor a durable marker is
                                // available. Do not claim an ordinary re-run
                                // will converge (401 without a marker cannot
                                // auto-delete). Preserve registration and
                                // require operator/support confirmation.
                                ReleaseOutcome::Failed(
                                    "cloud access appears released remotely, but local \
                                     cleanup could not be confirmed and the pending-release \
                                     marker could not be saved. Registration was preserved. \
                                     Do not delete the registration cache yourself. Contact \
                                     support/operator confirmation before removing it; an \
                                     ordinary re-run of `sealwire cloud unbind` alone may \
                                     not resolve this state."
                                        .to_string(),
                                )
                            }
                        }
                        other => {
                            let detail = match other {
                                Err(ReleaseHttpError::Network(m))
                                | Err(ReleaseHttpError::Forbidden { message: m })
                                | Err(ReleaseHttpError::RateLimited { message: m })
                                | Err(ReleaseHttpError::Other { message: m, .. })
                                | Err(ReleaseHttpError::Unavailable {
                                    message: m,
                                    ..
                                }) => m,
                                Err(ReleaseHttpError::Redirect) => {
                                    "redirect refused".to_string()
                                }
                                Err(ReleaseHttpError::Unauthorized) => {
                                    "unauthorized".to_string()
                                }
                                Ok(()) => unreachable!(),
                            };
                            ReleaseOutcome::Failed(format!(
                                "{message}; confirmation retry failed ({detail}); \
                                 failed to persist pending-release marker ({marker_error}). \
                                 Registration preserved at {}. Re-run `sealwire cloud unbind`.",
                                registration_path.display()
                            ))
                        }
                    }
                }
            }
        }
        Err(ReleaseHttpError::Unavailable {
            access_released: false,
            message,
        })
        | Err(ReleaseHttpError::RateLimited { message, .. })
        | Err(ReleaseHttpError::Forbidden { message })
        | Err(ReleaseHttpError::Other { message, .. }) => ReleaseOutcome::Failed(message),
        Err(ReleaseHttpError::Unauthorized) => ReleaseOutcome::Failed(
            "cloud access release was denied (unauthorized). Registration preserved.".to_string(),
        ),
        Err(ReleaseHttpError::Redirect) => ReleaseOutcome::Failed(
            "cloud access release refused a redirect; check the control origin".to_string(),
        ),
        Err(ReleaseHttpError::Network(message)) => ReleaseOutcome::Failed(message),
    }
}

async fn finish_confirmed_release(
    registration_path: &Path,
    marker_path: &Path,
    expected: &RegistrationIdentity,
    success: ReleaseOutcome,
) -> ReleaseOutcome {
    match delete_registration_if_matches(registration_path, expected) {
        Ok(true) => {
            let _ = tokio::fs::remove_file(marker_path).await;
            success
        }
        Ok(false) => {
            let _ = tokio::fs::remove_file(marker_path).await;
            ReleaseOutcome::Failed(
                "remote release confirmed, but local registration was replaced or removed \
                 before deletion; left the newer cache untouched"
                    .to_string(),
            )
        }
        Err(error) => ReleaseOutcome::Failed(format!(
            "remote release confirmed but failed to remove local registration cache {}: {error}. \
             Delete that file manually only if it still matches the released binding. \
             Do not share or paste any tokens from that file.",
            registration_path.display()
        )),
    }
}

#[derive(Debug)]
enum ReleaseHttpError {
    Unauthorized,
    Redirect,
    RateLimited {
        message: String,
    },
    Forbidden {
        message: String,
    },
    Unavailable {
        access_released: bool,
        message: String,
    },
    Other {
        status: u16,
        message: String,
    },
    Network(String),
}

fn build_release_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(release_timeout())
        .build()
        .map_err(|error| format!("failed to build HTTP client: {error}"))
}

async fn post_access_release(
    client: &reqwest::Client,
    control_url: &str,
    bearer: &str,
    body: &AccessReleaseRequest,
) -> Result<(), ReleaseHttpError> {
    let mut url = Url::parse(control_url).map_err(|e| {
        ReleaseHttpError::Network(format!("invalid control URL `{control_url}`: {e}"))
    })?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ReleaseHttpError::Network(
            "control URL must not include userinfo credentials".to_string(),
        ));
    }
    url.set_path("/api/public/relay/access/release");
    url.set_query(None);

    let response = client
        .post(url.clone())
        .bearer_auth(bearer)
        .json(body)
        .send()
        .await
        .map_err(|error| ReleaseHttpError::Network(format!("request failed: {error}")))?;

    let status = response.status();
    if status.is_redirection() {
        return Err(ReleaseHttpError::Redirect);
    }

    if let Some(len) = response.content_length() {
        if len > MAX_RESPONSE_BYTES as u64 {
            return Err(ReleaseHttpError::Network(format!(
                "response Content-Length exceeded {MAX_RESPONSE_BYTES} bytes"
            )));
        }
    }

    let bytes = read_body_bounded(response, MAX_RESPONSE_BYTES)
        .await
        .map_err(ReleaseHttpError::Network)?;

    if status.is_success() {
        let parsed: AccessReleaseResponse = serde_json::from_slice(&bytes).map_err(|error| {
            ReleaseHttpError::Network(format!("failed to decode release response: {error}"))
        })?;
        if !parsed.released {
            return Err(ReleaseHttpError::Other {
                status: status.as_u16(),
                message: "cloud access release response did not confirm released=true; registration preserved"
                    .to_string(),
            });
        }
        return Ok(());
    }

    let parsed: ReleaseErrorBody = serde_json::from_slice(&bytes).unwrap_or(ReleaseErrorBody {
        error: None,
        message: None,
        access_released: None,
    });
    let code = parsed.error.as_deref().unwrap_or("unavailable");
    // Never surface arbitrary remote prose (may reflect secrets).
    let safe = explain_release_status(status.as_u16(), code);

    match status.as_u16() {
        401 => Err(ReleaseHttpError::Unauthorized),
        403 => Err(ReleaseHttpError::Forbidden { message: safe }),
        429 => Err(ReleaseHttpError::RateLimited { message: safe }),
        503 => Err(ReleaseHttpError::Unavailable {
            access_released: parsed.access_released == Some(true),
            message: safe,
        }),
        other => Err(ReleaseHttpError::Other {
            status: other,
            message: safe,
        }),
    }
}

async fn read_body_bounded(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buf = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("failed to read response: {error}"))?;
        if buf.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("response exceeded {max_bytes} bytes"));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

fn explain_release_status(status: u16, code: &str) -> String {
    match known_release_error_code(code) {
        Some(message) => message.to_string(),
        None => match status {
            429 => "cloud access release rate-limited; try again later".to_string(),
            403 => "cloud access release forbidden".to_string(),
            503 => "cloud access release temporarily unavailable".to_string(),
            409 => "cloud access release conflict; registration preserved".to_string(),
            _ => "cloud access release failed".to_string(),
        },
    }
}

fn known_release_error_code(code: &str) -> Option<&'static str> {
    match code {
        "rate_limited" => Some("cloud access release rate-limited; try again later"),
        "forbidden" => Some("cloud access release forbidden"),
        "unavailable" => Some("cloud access release temporarily unavailable"),
        "unauthorized" | "invalid" | "expired" | "revoked" => {
            Some("cloud access credential is invalid, expired, or revoked")
        }
        "conflict" => Some("cloud access release conflict; registration preserved"),
        _ => None,
    }
}

fn normalize_control_origin(raw: &str) -> Result<String, String> {
    let mut url = Url::parse(raw)
        .map_err(|_| "invalid control URL: could not parse control origin".to_string())?;
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("control URL must use http:// or https://".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("control URL must not include userinfo credentials".to_string());
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn load_registration_for_release(
    path: &Path,
    expected_control_url: &str,
) -> Result<Option<PersistedPublicRelayRegistration>, String> {
    let Some(persisted) = load_public_relay_registration_raw(path)? else {
        return Ok(None);
    };
    if persisted.schema_version != PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION {
        return Err(format!(
            "unsupported broker registration cache schema {} in {}",
            persisted.schema_version,
            path.display()
        ));
    }
    let persisted_origin = normalize_control_origin(&persisted.control_url)?;
    if persisted_origin != expected_control_url {
        return Err(format!(
            "registration cache control origin does not match selected cloud origin \
             (cache is for a different broker). No release request was sent. \
             Path: {}",
            path.display()
        ));
    }
    Ok(Some(persisted))
}

fn pending_release_marker_path(registration_path: &Path) -> PathBuf {
    registration_path
        .parent()
        .map(|parent| parent.join(PENDING_RELEASE_FILE))
        .unwrap_or_else(|| PathBuf::from(PENDING_RELEASE_FILE))
}

fn bearer_fingerprint(token: &str) -> String {
    super::lifecycle::bearer_fingerprint(token)
}

async fn save_pending_release_marker(
    path: &Path,
    marker: &PendingReleaseMarker,
) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("pending-release marker path must have a parent directory".to_string());
    };
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let payload = serde_json::to_vec_pretty(marker)
        .map_err(|error| format!("failed to encode pending-release marker: {error}"))?;
    let temporary_path = path.with_extension("tmp");
    let write_path = temporary_path.clone();
    let payload_clone = payload.clone();
    tokio::task::spawn_blocking(move || {
        crate::instance_lock::write_new_exclusive_with_mode(
            &write_path,
            &payload_clone,
            Some(0o600),
        )
    })
    .await
    .map_err(|error| format!("marker write task panicked: {error}"))?
    .map_err(|error| format!("failed to write {}: {error}", temporary_path.display()))?;
    tokio::fs::rename(&temporary_path, path)
        .await
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn load_pending_release_marker(path: &Path) -> Result<Option<PendingReleaseMarker>, String> {
    let contents = read_local_file_bounded(path, MAX_LOCAL_FILE_BYTES)?;
    let Some(contents) = contents else {
        return Ok(None);
    };
    let marker: PendingReleaseMarker = serde_json::from_slice(&contents).map_err(|error| {
        format!(
            "failed to decode pending-release marker {}: {error}",
            path.display()
        )
    })?;
    if marker.schema_version != PENDING_RELEASE_SCHEMA_VERSION {
        return Err(format!(
            "unsupported pending-release marker schema {}",
            marker.schema_version
        ));
    }
    Ok(Some(marker))
}

fn read_local_file_bounded(path: &Path, max_bytes: usize) -> Result<Option<Vec<u8>>, String> {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => return Ok(None),
        // Older kernels/libcs may surface ENOTDIR without NotADirectory.
        Err(error) if error.raw_os_error() == Some(20) => return Ok(None),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };
    if let Ok(meta) = file.metadata() {
        if meta.len() > max_bytes as u64 {
            return Err(format!("{} exceeds {max_bytes} bytes", path.display()));
        }
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = file
            .read(&mut chunk)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        if n == 0 {
            break;
        }
        if buf.len().saturating_add(n) > max_bytes {
            return Err(format!("{} exceeds {max_bytes} bytes", path.display()));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(Some(buf))
}

/// Test helper: fingerprint is truncated and does not embed the raw token.
#[cfg(test)]
pub(crate) fn bearer_fingerprint_for_test(token: &str) -> String {
    bearer_fingerprint(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::post,
        Json, Router,
    };
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    #[derive(Clone)]
    struct MockState {
        calls: Arc<Mutex<u32>>,
        mode: Arc<Mutex<&'static str>>,
    }

    async fn mock_release(
        State(state): State<MockState>,
        headers: HeaderMap,
        Json(_body): Json<AccessReleaseRequest>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let _ = headers
            .get(axum::http::header::AUTHORIZATION)
            .expect("bearer required");
        *state.calls.lock().unwrap() += 1;
        match *state.mode.lock().unwrap() {
            "ok" => (
                StatusCode::OK,
                Json(serde_json::json!({ "released": true })),
            ),
            "unauthorized" => (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "error": "unauthorized",
                    "message": "invalid refresh"
                })),
            ),
            "cleanup_uncertain" => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "unavailable",
                    "message": "cleanup uncertain",
                    "access_released": true
                })),
            ),
            "pre_strategy_unavailable" => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "unavailable",
                    "message": "backend down"
                })),
            ),
            "redirect" => (StatusCode::FOUND, Json(serde_json::json!({}))),
            "rate" => (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({
                    "error": "rate_limited",
                    "message": "slow down"
                })),
            ),
            "not_released" => (
                StatusCode::OK,
                Json(serde_json::json!({ "released": false })),
            ),
            "forbidden" => (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "forbidden",
                    "message": "denied"
                })),
            ),
            _ => (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "forbidden",
                    "message": "denied"
                })),
            ),
        }
    }

    async fn spawn_mock(mode: &'static str) -> (String, MockState) {
        let state = MockState {
            calls: Arc::new(Mutex::new(0)),
            mode: Arc::new(Mutex::new(mode)),
        };
        let app = Router::new()
            .route("/api/public/relay/access/release", post(mock_release))
            .with_state(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (format!("http://{addr}"), state)
    }

    fn write_reg(path: &Path, control_url: &str, token: &str) {
        let payload = serde_json::to_vec_pretty(&PersistedPublicRelayRegistration {
            schema_version: PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION,
            control_url: control_url.to_string(),
            relay_id: "relay-1".into(),
            broker_room_id: "room-1".into(),
            relay_refresh_token: token.into(),
        })
        .unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, payload).unwrap();
    }

    #[test]
    fn fingerprint_is_truncated_and_stable() {
        let fp = bearer_fingerprint("refresh-secret-token");
        assert_eq!(fp.len(), BEARER_FINGERPRINT_HEX_CHARS);
        assert!(!fp.contains("refresh"));
        assert_eq!(fp, bearer_fingerprint("refresh-secret-token"));
        assert_ne!(fp, bearer_fingerprint("other-token"));
    }

    #[tokio::test]
    async fn release_success_deletes_registration_only() {
        let (origin, state) = spawn_mock("ok").await;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");
        // Identity sibling should be preserved (we never touch it).
        let identity = dir.path().join("public-broker-identity.json");
        std::fs::write(&identity, b"{\"keep\":true}").unwrap();

        let outcome = release_cloud_access(&origin, &reg, &marker).await;
        assert_eq!(outcome, ReleaseOutcome::Released);
        assert!(!reg.exists());
        assert!(identity.exists());
        assert!(!marker.exists());
        assert_eq!(*state.calls.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn missing_registration_is_not_linked() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("missing.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        let outcome = release_cloud_access("http://127.0.0.1:9", &reg, &marker).await;
        assert_eq!(outcome, ReleaseOutcome::NotLinked);
    }

    #[tokio::test]
    async fn wrong_origin_is_local_error_without_request() {
        let (origin, state) = spawn_mock("ok").await;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, "https://other.example", "refresh-token-abc");
        let outcome = release_cloud_access(&origin, &reg, &marker).await;
        assert!(matches!(outcome, ReleaseOutcome::Failed(_)));
        assert!(reg.exists());
        assert_eq!(*state.calls.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn pre_strategy_503_preserves_registration_without_marker() {
        let (origin, _state) = spawn_mock("pre_strategy_unavailable").await;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");
        let outcome = release_cloud_access(&origin, &reg, &marker).await;
        assert!(matches!(outcome, ReleaseOutcome::Failed(_)));
        assert!(reg.exists());
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn post_strategy_503_commits_marker_then_401_converges() {
        let (origin, state) = spawn_mock("cleanup_uncertain").await;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");

        let first = release_cloud_access(&origin, &reg, &marker).await;
        assert!(matches!(first, ReleaseOutcome::Failed(_)));
        assert!(reg.exists());
        assert!(marker.exists());
        let loaded = load_pending_release_marker(&marker).unwrap().unwrap();
        assert_eq!(
            loaded.bearer_fingerprint,
            bearer_fingerprint("refresh-token-abc")
        );
        assert!(!serde_json::to_string(&loaded)
            .unwrap()
            .contains("refresh-token"));

        *state.mode.lock().unwrap() = "unauthorized";
        let second = release_cloud_access(&origin, &reg, &marker).await;
        assert_eq!(second, ReleaseOutcome::AlreadyReleased);
        assert!(!reg.exists());
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn first_401_without_marker_preserves_registration() {
        let (origin, _state) = spawn_mock("unauthorized").await;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");
        let outcome = release_cloud_access(&origin, &reg, &marker).await;
        assert!(matches!(outcome, ReleaseOutcome::Failed(_)));
        assert!(reg.exists());
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn redirect_is_refused() {
        let (origin, _state) = spawn_mock("redirect").await;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");
        let outcome = release_cloud_access(&origin, &reg, &marker).await;
        assert!(matches!(outcome, ReleaseOutcome::Failed(msg) if msg.contains("redirect")));
        assert!(reg.exists());
    }

    #[tokio::test]
    async fn released_false_preserves_registration() {
        let (origin, _state) = spawn_mock("not_released").await;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");
        let outcome = release_cloud_access(&origin, &reg, &marker).await;
        assert!(matches!(outcome, ReleaseOutcome::Failed(msg) if msg.contains("released=true")));
        assert!(reg.exists());
    }

    #[tokio::test]
    async fn forbidden_and_rate_limit_preserve_registration() {
        for mode in ["forbidden", "rate"] {
            let (origin, _state) = spawn_mock(mode).await;
            let dir = tempfile::tempdir().unwrap();
            let reg = dir.path().join("public-broker-registration.json");
            let marker = dir.path().join(PENDING_RELEASE_FILE);
            write_reg(&reg, &origin, "refresh-token-abc");
            let outcome = release_cloud_access(&origin, &reg, &marker).await;
            assert!(matches!(outcome, ReleaseOutcome::Failed(_)), "{mode}");
            assert!(reg.exists(), "{mode}");
            assert!(!marker.exists(), "{mode}");
        }
    }

    #[tokio::test]
    async fn chunked_oversized_response_is_rejected_without_full_buffer() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = Router::new().route(
                "/api/public/relay/access/release",
                axum::routing::post(|| async {
                    let body = "x".repeat(MAX_RESPONSE_BYTES + 8);
                    (
                        StatusCode::OK,
                        [(axum::http::header::CONTENT_TYPE, "application/json")],
                        format!(r#"{{"released":true,"pad":"{body}"}}"#),
                    )
                }),
            );
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let origin = format!("http://{addr}");
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");
        let outcome = release_cloud_access(&origin, &reg, &marker).await;
        assert!(matches!(outcome, ReleaseOutcome::Failed(msg) if msg.contains("exceeded")));
        assert!(reg.exists());
    }

    #[tokio::test]
    async fn timeout_can_be_injected_for_tests() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = Router::new().route(
                "/api/public/relay/access/release",
                axum::routing::post(|| async {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({ "released": true })),
                    )
                }),
            );
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let origin = format!("http://{addr}");
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");
        TEST_RELEASE_TIMEOUT.with(|cell| cell.set(Some(Duration::from_millis(50))));
        let outcome = tokio::time::timeout(
            Duration::from_secs(2),
            release_cloud_access(&origin, &reg, &marker),
        )
        .await
        .expect("test must finish quickly");
        TEST_RELEASE_TIMEOUT.with(|cell| cell.set(None));
        assert!(matches!(outcome, ReleaseOutcome::Failed(_)));
        assert!(reg.exists());
    }

    #[tokio::test]
    async fn marker_write_failure_preserves_registration_without_deleting() {
        let (origin, _state) = spawn_mock("cleanup_uncertain").await;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        // Make marker path unwritable by pointing at a file-as-directory parent.
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        let marker = blocker.join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");
        let outcome = release_cloud_access(&origin, &reg, &marker).await;
        assert!(
            matches!(outcome, ReleaseOutcome::Failed(ref msg) if msg.contains("Registration was preserved") || msg.contains("Registration preserved")),
            "got: {outcome:?}"
        );
        assert!(
            matches!(outcome, ReleaseOutcome::Failed(ref msg) if msg.contains("ordinary re-run") || msg.contains("may not resolve")),
            "must not claim ordinary re-run alone converges; got: {outcome:?}"
        );
        assert!(
            reg.exists(),
            "must not delete registration when cleanup is unconfirmed"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pending_marker_is_mode_0600() {
        let (origin, _state) = spawn_mock("cleanup_uncertain").await;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");
        let _ = release_cloud_access(&origin, &reg, &marker).await;
        assert!(marker.exists());
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&marker).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn explain_release_never_interpolates_secret_as_error_code() {
        let secret = "exact-secret-as-error-code";
        let msg = explain_release_status(400, secret);
        assert!(!msg.contains(secret));
        assert_eq!(msg, "cloud access release failed");
    }

    #[tokio::test]
    async fn release_error_field_secret_is_not_reflected() {
        let secret = "exact-secret-as-error-code";
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let secret_owned = secret.to_string();
        tokio::spawn(async move {
            let app = Router::new().route(
                "/api/public/relay/access/release",
                axum::routing::post(move || {
                    let secret_owned = secret_owned.clone();
                    async move {
                        (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({ "error": secret_owned })),
                        )
                    }
                }),
            );
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let origin = format!("http://{addr}");
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "refresh-token-abc");
        let outcome = release_cloud_access(&origin, &reg, &marker).await;
        match outcome {
            ReleaseOutcome::Failed(msg) => {
                assert!(!msg.contains(secret), "got: {msg}");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
        assert!(reg.exists());
    }

    #[tokio::test]
    async fn stale_unbind_does_not_delete_newer_registration() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let started = Arc::new(std::sync::Barrier::new(2));
        let started_server = started.clone();
        tokio::spawn(async move {
            let app = Router::new().route(
                "/api/public/relay/access/release",
                axum::routing::post(move || {
                    let started_server = started_server.clone();
                    async move {
                        // Signal the test that HTTP is in flight, then delay.
                        tokio::task::spawn_blocking(move || {
                            started_server.wait();
                        })
                        .await
                        .ok();
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({ "released": true })),
                        )
                    }
                }),
            );
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let origin = format!("http://{addr}");
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let marker = dir.path().join(PENDING_RELEASE_FILE);
        write_reg(&reg, &origin, "token-a-old");

        let reg_clone = reg.clone();
        let marker_clone = marker.clone();
        let origin_clone = origin.clone();
        let release_task = tokio::spawn(async move {
            release_cloud_access(&origin_clone, &reg_clone, &marker_clone).await
        });

        // Wait until unbind has loaded A and is blocked in HTTP.
        tokio::task::spawn_blocking(move || {
            started.wait();
        })
        .await
        .unwrap();
        // Concurrent re-enrollment wrote bearer B.
        write_reg(&reg, &origin, "token-b-new");

        let outcome = release_task.await.unwrap();
        assert!(
            matches!(outcome, ReleaseOutcome::Failed(ref msg) if msg.contains("replaced") || msg.contains("newer")),
            "got: {outcome:?}"
        );
        assert!(reg.exists(), "newer registration must survive stale unbind");
        let raw = std::fs::read_to_string(&reg).unwrap();
        assert!(raw.contains("token-b-new"));
        assert!(!raw.contains("token-a-old"));
    }

    #[test]
    fn normalize_control_origin_malformed_secret_is_not_echoed() {
        let secret = "exact-secret-in-malformed-url";
        let err = normalize_control_origin(&format!("::::{secret}")).unwrap_err();
        assert!(!err.contains(secret), "got: {err}");
        assert!(err.contains("could not parse"));
    }

    #[test]
    fn normalize_control_origin_userinfo_is_rejected_without_echo() {
        let err = normalize_control_origin("https://user:s3cret@broker.example/").unwrap_err();
        assert!(err.contains("userinfo"));
        assert!(!err.contains("s3cret"));
    }
}
