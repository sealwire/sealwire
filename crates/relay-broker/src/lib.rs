pub mod auth;
pub mod join_ticket;
pub mod protocol;
pub mod public_control;
mod state;

pub use state::BrokerState;

use std::path::PathBuf;
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use auth::BrokerAuthMode;
use axum::{
    extract::{
        connect_info::ConnectInfo,
        ws::{Message, WebSocket},
        Path, Query, Request, State, WebSocketUpgrade,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{sink::SinkExt, StreamExt};
use join_ticket::{JoinTicketClaims, JoinTicketKey, JoinTicketKind, JOIN_TICKET_SECRET_ENV};
use protocol::{
    ClientMessage, ConnectQuery, HealthResponse, PublicBrokerMonitoring, ServerMessage,
};
use public_control::{
    ClientGrantRequest, ClientGrantResponse, ClientIdentityRevokeResponse,
    ClientIdentityRotateResponse, ClientRelaysResponse, ClientSessionResponse,
    DeviceGrantBulkRevokeRequest, DeviceGrantBulkRevokeResponse, DeviceGrantRequest,
    DeviceGrantResponse, DeviceGrantRevokeRequest, DeviceGrantRevokeResponse,
    DeviceSessionResponse, DeviceWsTokenResponse, PairingWsTokenRequest, PairingWsTokenResponse,
    PublicControlPlane, RelayEnrollmentChallengeRequest, RelayEnrollmentChallengeResponse,
    RelayEnrollmentCompleteRequest, RelayEnrollmentResponse, RelayWsTokenRequest,
    RelayWsTokenResponse,
};
use rand::{distributions::Alphanumeric, Rng};
use relay_http::{
    apply_standard_security_headers, header_origin, parse_optional_string_env, request_origin,
    request_uses_https, SecurityHeadersConfig,
};
use relay_util::{sha256_hex, trimmed_option_string};
use tokio::{sync::Mutex, time::Instant};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{debug, warn};

const RATE_LIMIT_WINDOW_SECS: u64 = 60;
const DEFAULT_PUBLIC_API_RATE_LIMIT_PER_MINUTE: usize = 120;
const DEFAULT_JOIN_RATE_LIMIT_PER_MINUTE: usize = 40;
const DEFAULT_PUBLISH_RATE_LIMIT_PER_MINUTE: usize = 240;
const DEFAULT_MAX_CONNECTIONS_PER_IP: usize = 24;
const DEFAULT_MAX_TEXT_FRAME_BYTES: usize = 64 * 1024;
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 120;
const DEVICE_SESSION_COOKIE_NAME: &str = "agent_relay_device_session";
const CLIENT_SESSION_COOKIE_NAME: &str = "agent_relay_client_session";
const DEVICE_SESSION_COOKIE_MAX_AGE_SECS: u64 = 60 * 60 * 24 * 400;
const PUBLIC_API_RATE_LIMIT_ENV: &str = "RELAY_BROKER_PUBLIC_API_RATE_LIMIT_PER_MINUTE";
const JOIN_RATE_LIMIT_ENV: &str = "RELAY_BROKER_JOIN_RATE_LIMIT_PER_MINUTE";
const PUBLISH_RATE_LIMIT_ENV: &str = "RELAY_BROKER_PUBLISH_RATE_LIMIT_PER_MINUTE";
const MAX_CONNECTIONS_PER_IP_ENV: &str = "RELAY_BROKER_MAX_CONNECTIONS_PER_IP";
const MAX_TEXT_FRAME_BYTES_ENV: &str = "RELAY_BROKER_MAX_TEXT_FRAME_BYTES";
const IDLE_TIMEOUT_SECS_ENV: &str = "RELAY_BROKER_IDLE_TIMEOUT_SECS";
const CSP_CONNECT_SRC_ENV: &str = "RELAY_BROKER_CSP_CONNECT_SRC";
const ENABLE_HSTS_ENV: &str = "RELAY_BROKER_ENABLE_HSTS";
const HSTS_VALUE_ENV: &str = "RELAY_BROKER_HSTS_VALUE";

pub async fn app(state: BrokerState) -> Router {
    let join_verifier = BrokerJoinVerifier::from_env().await;
    let hardening = BrokerHardeningConfig::from_env().unwrap_or_else(|error| {
        warn!(%error, "invalid broker hardening config; using safe defaults");
        BrokerHardeningConfig::default()
    });
    let security_headers = security_headers_from_env().unwrap_or_else(|error| {
        warn!(%error, "invalid broker security header config; HSTS will stay disabled");
        SecurityHeadersConfig::default()
    });
    app_with_web_root_and_verifier_and_hardening(
        state,
        default_web_root(),
        join_verifier,
        hardening,
        security_headers,
    )
}

fn summarize_published_payload(payload: &serde_json::Value) -> String {
    let kind = payload
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    match kind {
        "session_snapshot" => format!(
            "kind=session_snapshot active_thread_id={} transcript_entries={} logs={}",
            payload
                .get("snapshot")
                .and_then(|snapshot| snapshot.get("active_thread_id"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-"),
            payload
                .get("snapshot")
                .and_then(|snapshot| snapshot.get("transcript"))
                .and_then(serde_json::Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0),
            payload
                .get("snapshot")
                .and_then(|snapshot| snapshot.get("logs"))
                .and_then(serde_json::Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0),
        ),
        "remote_action_result" => {
            let entry_count = payload
                .get("thread_transcript")
                .and_then(|page| page.get("entries"))
                .and_then(serde_json::Value::as_array)
                .map(|entries| entries.len())
                .unwrap_or(0);
            let part_count = payload
                .get("thread_transcript")
                .and_then(|page| page.get("entries"))
                .and_then(serde_json::Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| {
                            entry
                                .get("parts")
                                .and_then(serde_json::Value::as_array)
                                .map(|parts| parts.len())
                                .unwrap_or(0)
                        })
                        .sum::<usize>()
                })
                .unwrap_or(0);
            format!(
                "kind=remote_action_result action={} ok={} entries={} parts={} next_cursor={} prev_cursor={}",
                payload
                    .get("action")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("-"),
                payload
                    .get("ok")
                    .and_then(serde_json::Value::as_bool)
                    .map(|ok| ok.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                entry_count,
                part_count,
                payload
                    .get("thread_transcript")
                    .and_then(|page| page.get("next_cursor"))
                    .and_then(serde_json::Value::as_u64)
                    .map(|cursor| cursor.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                payload
                    .get("thread_transcript")
                    .and_then(|page| page.get("prev_cursor"))
                    .and_then(serde_json::Value::as_u64)
                    .map(|cursor| cursor.to_string())
                    .unwrap_or_else(|| "-".to_string()),
            )
        }
        "encrypted_session_snapshot" => format!(
            "kind=encrypted_session_snapshot target_peer_id={} device_id={}",
            payload
                .get("target_peer_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-"),
            payload
                .get("device_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-"),
        ),
        "encrypted_remote_action_result" => format!(
            "kind=encrypted_remote_action_result action_id={} target_peer_id={} device_id={}",
            payload
                .get("action_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-"),
            payload
                .get("target_peer_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-"),
            payload
                .get("device_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-"),
        ),
        "encrypted_pairing_result" => format!(
            "kind=encrypted_pairing_result pairing_id={} target_peer_id={}",
            payload
                .get("pairing_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-"),
            payload
                .get("target_peer_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-"),
        ),
        other => format!("kind={other}"),
    }
}

#[derive(Clone)]
struct BrokerAppState {
    broker: BrokerState,
    join_verifier: BrokerJoinVerifier,
    hardening: BrokerHardeningState,
    public_monitoring: PublicMonitoringState,
}

#[derive(Clone)]
enum BrokerJoinVerifier {
    SelfHosted(JoinTicketKey),
    PublicControlPlane(PublicControlPlane),
    Misconfigured(String),
}

#[derive(Debug)]
struct VerifiedBrokerJoin {
    peer_id: Option<String>,
}

#[derive(Clone)]
struct BrokerHardeningState {
    config: BrokerHardeningConfig,
    rate_limiter: SlidingWindowRateLimiter,
    connection_tracker: ActiveConnectionTracker,
}

#[derive(Clone, Debug)]
struct BrokerHardeningConfig {
    public_api_rate_limit_per_minute: usize,
    join_rate_limit_per_minute: usize,
    publish_rate_limit_per_minute: usize,
    max_connections_per_ip: usize,
    max_text_frame_bytes: usize,
    idle_timeout: Duration,
}

#[derive(Clone, Default)]
struct SlidingWindowRateLimiter {
    buckets: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
}

#[derive(Clone, Default)]
struct ActiveConnectionTracker {
    counts: Arc<StdMutex<HashMap<IpAddr, usize>>>,
}

#[derive(Clone, Default)]
struct PublicMonitoringState {
    inner: Arc<Mutex<PublicMonitoringInner>>,
}

#[derive(Default)]
struct PublicMonitoringInner {
    relay_ws_token_refresh_successes: u64,
    relay_ws_token_refresh_failures: u64,
    device_ws_token_refresh_successes: u64,
    device_ws_token_refresh_failures: u64,
    invalid_refresh_token_uses: u64,
    repeated_invalid_refresh_token_uses: u64,
    environment_mutation_events: u64,
    invalid_refresh_token_counts: HashMap<String, u64>,
    observed_chain_environments: HashMap<String, RequestEnvironment>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RequestEnvironment {
    origin: Option<String>,
    user_agent_hash: Option<String>,
}

#[derive(Clone, Copy, Debug)]
enum RefreshChainKind {
    RelayWsToken,
    DeviceWsToken,
    ClientIdentity,
}

struct ActiveConnectionPermit {
    tracker: ActiveConnectionTracker,
    remote_ip: IpAddr,
}

impl Default for BrokerHardeningConfig {
    fn default() -> Self {
        Self {
            public_api_rate_limit_per_minute: DEFAULT_PUBLIC_API_RATE_LIMIT_PER_MINUTE,
            join_rate_limit_per_minute: DEFAULT_JOIN_RATE_LIMIT_PER_MINUTE,
            publish_rate_limit_per_minute: DEFAULT_PUBLISH_RATE_LIMIT_PER_MINUTE,
            max_connections_per_ip: DEFAULT_MAX_CONNECTIONS_PER_IP,
            max_text_frame_bytes: DEFAULT_MAX_TEXT_FRAME_BYTES,
            idle_timeout: Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS),
        }
    }
}

impl BrokerHardeningConfig {
    fn from_env() -> Result<Self, String> {
        Ok(Self {
            public_api_rate_limit_per_minute: parse_usize_env(
                PUBLIC_API_RATE_LIMIT_ENV,
                DEFAULT_PUBLIC_API_RATE_LIMIT_PER_MINUTE,
            )?,
            join_rate_limit_per_minute: parse_usize_env(
                JOIN_RATE_LIMIT_ENV,
                DEFAULT_JOIN_RATE_LIMIT_PER_MINUTE,
            )?,
            publish_rate_limit_per_minute: parse_usize_env(
                PUBLISH_RATE_LIMIT_ENV,
                DEFAULT_PUBLISH_RATE_LIMIT_PER_MINUTE,
            )?,
            max_connections_per_ip: parse_usize_env(
                MAX_CONNECTIONS_PER_IP_ENV,
                DEFAULT_MAX_CONNECTIONS_PER_IP,
            )?,
            max_text_frame_bytes: parse_usize_env(
                MAX_TEXT_FRAME_BYTES_ENV,
                DEFAULT_MAX_TEXT_FRAME_BYTES,
            )?,
            idle_timeout: Duration::from_secs(parse_u64_env(
                IDLE_TIMEOUT_SECS_ENV,
                DEFAULT_IDLE_TIMEOUT_SECS,
            )?),
        })
    }
}

impl SlidingWindowRateLimiter {
    async fn allow(&self, key: String, limit: usize) -> bool {
        let window = Duration::from_secs(RATE_LIMIT_WINDOW_SECS);
        let now = Instant::now();
        let cutoff = now.checked_sub(window).unwrap_or(now);
        let mut buckets = self.buckets.lock().await;
        let bucket = buckets.entry(key).or_default();
        while bucket.front().is_some_and(|timestamp| *timestamp <= cutoff) {
            bucket.pop_front();
        }
        if bucket.len() >= limit {
            return false;
        }
        bucket.push_back(now);
        true
    }
}

impl ActiveConnectionTracker {
    fn try_acquire(&self, remote_ip: IpAddr, limit: usize) -> Option<ActiveConnectionPermit> {
        let mut counts = self
            .counts
            .lock()
            .expect("active broker connection tracker should not be poisoned");
        let entry = counts.entry(remote_ip).or_insert(0);
        if *entry >= limit {
            return None;
        }
        *entry += 1;
        Some(ActiveConnectionPermit {
            tracker: self.clone(),
            remote_ip,
        })
    }

    fn release(&self, remote_ip: IpAddr) {
        let mut counts = self
            .counts
            .lock()
            .expect("active broker connection tracker should not be poisoned");
        let Some(entry) = counts.get_mut(&remote_ip) else {
            return;
        };
        if *entry <= 1 {
            counts.remove(&remote_ip);
        } else {
            *entry -= 1;
        }
    }
}

impl RefreshChainKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::RelayWsToken => "relay_ws_token",
            Self::DeviceWsToken => "device_ws_token",
            Self::ClientIdentity => "client_identity",
        }
    }
}

impl RequestEnvironment {
    fn summary(&self) -> String {
        let origin = self.origin.as_deref().unwrap_or("origin:none");
        let user_agent = self.user_agent_hash.as_deref().unwrap_or("ua:none");
        format!("{origin}|{user_agent}")
    }
}

impl PublicMonitoringState {
    async fn snapshot(&self) -> PublicBrokerMonitoring {
        let inner = self.inner.lock().await;
        PublicBrokerMonitoring {
            relay_ws_token_refresh_successes: inner.relay_ws_token_refresh_successes,
            relay_ws_token_refresh_failures: inner.relay_ws_token_refresh_failures,
            device_ws_token_refresh_successes: inner.device_ws_token_refresh_successes,
            device_ws_token_refresh_failures: inner.device_ws_token_refresh_failures,
            invalid_refresh_token_uses: inner.invalid_refresh_token_uses,
            repeated_invalid_refresh_token_uses: inner.repeated_invalid_refresh_token_uses,
            environment_mutation_events: inner.environment_mutation_events,
        }
    }

    async fn record_refresh_success(&self, kind: RefreshChainKind) {
        let mut inner = self.inner.lock().await;
        match kind {
            RefreshChainKind::RelayWsToken => inner.relay_ws_token_refresh_successes += 1,
            RefreshChainKind::DeviceWsToken => inner.device_ws_token_refresh_successes += 1,
            RefreshChainKind::ClientIdentity => {}
        }
    }

    async fn record_refresh_failure(&self, kind: RefreshChainKind, token: &str, error: &str) {
        let mut inner = self.inner.lock().await;
        match kind {
            RefreshChainKind::RelayWsToken => inner.relay_ws_token_refresh_failures += 1,
            RefreshChainKind::DeviceWsToken => inner.device_ws_token_refresh_failures += 1,
            RefreshChainKind::ClientIdentity => {}
        }
        if !error.contains("refresh token is invalid") {
            return;
        }
        inner.invalid_refresh_token_uses += 1;
        let token_hash = sha256_hex(token.trim());
        let attempts = {
            let entry = inner
                .invalid_refresh_token_counts
                .entry(token_hash.clone())
                .or_insert(0);
            *entry += 1;
            *entry
        };
        if attempts > 1 {
            inner.repeated_invalid_refresh_token_uses += 1;
            let short_hash = &token_hash[..12];
            warn!(
                chain = %kind.as_str(),
                token_hash = short_hash,
                attempts,
                "invalid refresh token was reused"
            );
        }
    }

    async fn observe_chain_environment(&self, chain_key: String, headers: &HeaderMap) {
        let Some(environment) = request_environment(headers) else {
            return;
        };
        let mut inner = self.inner.lock().await;
        if let Some(previous) = inner
            .observed_chain_environments
            .insert(chain_key.clone(), environment.clone())
        {
            if previous != environment {
                inner.environment_mutation_events += 1;
                warn!(
                    chain = %chain_key,
                    previous = %previous.summary(),
                    current = %environment.summary(),
                    "public broker observed an environment change on the same chain"
                );
            }
        }
    }
}

impl Drop for ActiveConnectionPermit {
    fn drop(&mut self) {
        self.tracker.release(self.remote_ip);
    }
}

impl BrokerJoinVerifier {
    async fn from_env() -> Self {
        match BrokerAuthMode::from_env() {
            Ok(BrokerAuthMode::SelfHostedSharedSecret) => {
                match JoinTicketKey::from_env_var(JOIN_TICKET_SECRET_ENV) {
                    Ok(Some(key)) => Self::SelfHosted(key),
                    Ok(None) => Self::Misconfigured(format!(
                        "{JOIN_TICKET_SECRET_ENV} is required in self-hosted broker auth mode"
                    )),
                    Err(error) => Self::Misconfigured(error),
                }
            }
            Ok(BrokerAuthMode::PublicControlPlane) => match PublicControlPlane::from_env().await {
                Ok(control_plane) => Self::PublicControlPlane(control_plane),
                Err(error) => Self::Misconfigured(error),
            },
            Err(error) => Self::Misconfigured(error),
        }
    }

    fn verify_connection(
        &self,
        join_ticket: Option<&str>,
        broker_room_id: &str,
        role: protocol::PeerRole,
    ) -> Result<VerifiedBrokerJoin, String> {
        match self {
            Self::SelfHosted(key) => verify_self_hosted_join_ticket_for_connection(
                key,
                join_ticket,
                broker_room_id,
                role,
            )
            .map(|claims| VerifiedBrokerJoin {
                peer_id: claims.peer_id,
            }),
            Self::PublicControlPlane(control_plane) => verify_join_ticket_for_connection(
                control_plane.issuer_key(),
                join_ticket,
                broker_room_id,
                role,
            )
            .map(|claims| VerifiedBrokerJoin {
                peer_id: claims.peer_id,
            }),
            Self::Misconfigured(error) => Err(error.clone()),
        }
    }

    fn public_control_plane(&self) -> Option<PublicControlPlane> {
        match self {
            Self::PublicControlPlane(control_plane) => Some(control_plane.clone()),
            _ => None,
        }
    }

    fn client_join_error_message(&self) -> &'static str {
        match self {
            Self::SelfHosted(_) | Self::PublicControlPlane(_) | Self::Misconfigured(_) => {
                "broker join rejected"
            }
        }
    }

    fn health_response(
        &self,
        public_monitoring: Option<PublicBrokerMonitoring>,
    ) -> (StatusCode, HealthResponse) {
        match self {
            Self::SelfHosted(_) => (
                StatusCode::OK,
                HealthResponse {
                    status: "ok".to_string(),
                    service: "relay-broker".to_string(),
                    broker_auth_mode: BrokerAuthMode::SelfHostedSharedSecret.as_str().to_string(),
                    join_auth_ready: true,
                    message: None,
                    public_monitoring: None,
                },
            ),
            Self::PublicControlPlane(_) => (
                StatusCode::OK,
                HealthResponse {
                    status: "ok".to_string(),
                    service: "relay-broker".to_string(),
                    broker_auth_mode: BrokerAuthMode::PublicControlPlane.as_str().to_string(),
                    join_auth_ready: true,
                    message: self
                        .public_control_plane()
                        .and_then(|control_plane| control_plane.health_message()),
                    public_monitoring,
                },
            ),
            Self::Misconfigured(error) => (
                StatusCode::SERVICE_UNAVAILABLE,
                HealthResponse {
                    status: "misconfigured".to_string(),
                    service: "relay-broker".to_string(),
                    broker_auth_mode: "unknown".to_string(),
                    join_auth_ready: false,
                    message: Some(error.clone()),
                    public_monitoring: None,
                },
            ),
        }
    }
}

fn app_with_web_root_and_verifier_and_hardening(
    state: BrokerState,
    web_root: PathBuf,
    join_verifier: BrokerJoinVerifier,
    hardening_config: BrokerHardeningConfig,
    security_headers: SecurityHeadersConfig,
) -> Router {
    if !web_root.join("remote.html").exists() {
        warn!(
            path = %web_root.join("remote.html").display(),
            "broker web assets are missing; run `npm run build` before serving the remote UI"
        );
    }
    match &join_verifier {
        BrokerJoinVerifier::SelfHosted(_) => {}
        BrokerJoinVerifier::PublicControlPlane(_) => {}
        BrokerJoinVerifier::Misconfigured(error) => {
            warn!(%error, "broker websocket joins will be rejected");
        }
    }
    Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/public/relay-enrollment/challenge",
            post(public_create_relay_enrollment_challenge),
        )
        .route(
            "/api/public/relay-enrollment/complete",
            post(public_complete_relay_enrollment),
        )
        .route(
            "/api/public/relay/ws-token",
            post(public_issue_relay_ws_token),
        )
        .route(
            "/api/public/pairing/ws-token",
            post(public_issue_pairing_ws_token),
        )
        .route("/api/public/devices", post(public_issue_device_grant))
        .route(
            "/api/public/clients/grants",
            post(public_issue_client_grant),
        )
        .route("/api/public/relays", get(public_list_client_relays))
        .route(
            "/api/public/client/session",
            post(public_issue_client_session).delete(public_clear_client_session),
        )
        .route(
            "/api/public/client/rotate",
            post(public_rotate_client_identity),
        )
        .route(
            "/api/public/client",
            axum::routing::delete(public_revoke_client_identity),
        )
        .route(
            "/api/public/device/session",
            post(public_issue_device_session).delete(public_clear_device_session),
        )
        .route(
            "/api/public/device/ws-token",
            post(public_issue_device_ws_token),
        )
        .route(
            "/api/public/devices/:device_id/revoke",
            post(public_revoke_device_grant),
        )
        .route(
            "/api/public/devices/revoke-others",
            post(public_revoke_other_device_grants),
        )
        .route("/ws/:channel_id", get(websocket))
        .route_service(
            "/manifest.webmanifest",
            ServeFile::new(web_root.join("remote-manifest.webmanifest")),
        )
        .route_service("/sw.js", ServeFile::new(web_root.join("remote-sw.js")))
        .route_service("/icon.svg", ServeFile::new(web_root.join("icon.svg")))
        .route_service("/", ServeFile::new(web_root.join("remote.html")))
        .nest_service("/static", ServeDir::new(web_root))
        .with_state(BrokerAppState {
            broker: state,
            join_verifier,
            hardening: BrokerHardeningState {
                config: hardening_config,
                rate_limiter: SlidingWindowRateLimiter::default(),
                connection_tracker: ActiveConnectionTracker::default(),
            },
            public_monitoring: PublicMonitoringState::default(),
        })
        .layer(middleware::from_fn_with_state(
            security_headers,
            with_security_headers,
        ))
        .layer(TraceLayer::new_for_http())
}

async fn health(State(state): State<BrokerAppState>) -> impl IntoResponse {
    let public_monitoring = if matches!(
        state.join_verifier,
        BrokerJoinVerifier::PublicControlPlane(_)
    ) {
        Some(state.public_monitoring.snapshot().await)
    } else {
        None
    };
    let (status, payload) = state.join_verifier.health_response(public_monitoring);
    (status, Json(payload))
}

#[derive(Debug, Clone, serde::Serialize)]
struct ApiErrorBody {
    error: &'static str,
    message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
struct DeviceSessionClearResponse {
    cleared: bool,
}

async fn public_create_relay_enrollment_challenge(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    Json(input): Json<RelayEnrollmentChallengeRequest>,
) -> Result<Json<RelayEnrollmentChallengeResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "relay_enrollment_challenge").await?;
    let control_plane = require_public_control_plane(&state)?;
    control_plane
        .create_relay_enrollment_challenge(input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_complete_relay_enrollment(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    Json(input): Json<RelayEnrollmentCompleteRequest>,
) -> Result<Json<RelayEnrollmentResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "relay_enrollment_complete").await?;
    let control_plane = require_public_control_plane(&state)?;
    control_plane
        .complete_relay_enrollment(input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_issue_relay_ws_token(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<RelayWsTokenRequest>,
) -> Result<Json<RelayWsTokenResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "relay_ws_token").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    match control_plane.issue_relay_ws_token(bearer, input).await {
        Ok(response) => {
            state
                .public_monitoring
                .record_refresh_success(RefreshChainKind::RelayWsToken)
                .await;
            Ok(Json(response))
        }
        Err(error) => {
            state
                .public_monitoring
                .record_refresh_failure(RefreshChainKind::RelayWsToken, bearer, &error)
                .await;
            Err(public_api_error(error))
        }
    }
}

async fn public_issue_pairing_ws_token(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<PairingWsTokenRequest>,
) -> Result<Json<PairingWsTokenResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "pairing_ws_token").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .issue_pairing_ws_token(bearer, input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_issue_device_grant(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<DeviceGrantRequest>,
) -> Result<Json<DeviceGrantResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "device_grant").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .issue_device_grant(bearer, input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_issue_client_grant(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<ClientGrantRequest>,
) -> Result<Json<ClientGrantResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "client_grant").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .issue_client_grant(bearer, input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_list_client_relays(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
) -> Result<Json<ClientRelaysResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "client_relays").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = client_refresh_token(&headers)?;
    match control_plane.list_client_relays(bearer).await {
        Ok(response) => {
            state
                .public_monitoring
                .observe_chain_environment(format!("client:{}", response.client_id), &headers)
                .await;
            Ok(Json(response))
        }
        Err(error) => {
            state
                .public_monitoring
                .record_refresh_failure(RefreshChainKind::ClientIdentity, bearer, &error)
                .await;
            Err(public_api_error(error))
        }
    }
}

async fn public_issue_client_session(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<ClientSessionResponse>), (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "client_session").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::SET_COOKIE,
        build_client_session_cookie(bearer, request_uses_https(&headers, None))?,
    );
    control_plane
        .issue_client_session(bearer)
        .await
        .map(|response| (response_headers, Json(response)))
        .map_err(public_api_error)
}

async fn public_clear_client_session(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<DeviceSessionClearResponse>), (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "clear_client_session").await?;
    let _ = require_public_control_plane(&state)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::SET_COOKIE,
        clear_client_session_cookie(request_uses_https(&headers, None)),
    );
    Ok((
        response_headers,
        Json(DeviceSessionClearResponse { cleared: true }),
    ))
}

#[derive(Debug, Clone, Copy)]
enum ClientRefreshAuth<'a> {
    Cookie(&'a str),
    Bearer(&'a str),
}

impl<'a> ClientRefreshAuth<'a> {
    fn token(self) -> &'a str {
        match self {
            Self::Cookie(token) | Self::Bearer(token) => token,
        }
    }

    fn used_cookie(self) -> bool {
        matches!(self, Self::Cookie(_))
    }
}

async fn public_rotate_client_identity(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<ClientIdentityRotateResponse>), (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "rotate_client_identity").await?;
    let control_plane = require_public_control_plane(&state)?;
    let auth = client_refresh_auth(&headers)?;
    let secure = request_uses_https(&headers, None);
    let (client_id, refreshed_token) =
        match control_plane.rotate_client_identity(auth.token()).await {
            Ok(result) => result,
            Err(error) => {
                state
                    .public_monitoring
                    .record_refresh_failure(RefreshChainKind::ClientIdentity, auth.token(), &error)
                    .await;
                return Err(public_api_error(error));
            }
        };
    state
        .public_monitoring
        .observe_chain_environment(format!("client:{client_id}"), &headers)
        .await;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::SET_COOKIE,
        build_client_session_cookie(&refreshed_token, secure)?,
    );
    Ok((
        response_headers,
        Json(ClientIdentityRotateResponse {
            client_id,
            rotated: true,
            cookie_session: true,
            client_refresh_token: if auth.used_cookie() {
                None
            } else {
                Some(refreshed_token)
            },
        }),
    ))
}

async fn public_revoke_client_identity(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<ClientIdentityRevokeResponse>), (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "revoke_client_identity").await?;
    let control_plane = require_public_control_plane(&state)?;
    let auth = client_refresh_auth(&headers)?;
    let response = match control_plane.revoke_client_identity(auth.token()).await {
        Ok(response) => response,
        Err(error) => {
            state
                .public_monitoring
                .record_refresh_failure(RefreshChainKind::ClientIdentity, auth.token(), &error)
                .await;
            return Err(public_api_error(error));
        }
    };
    state
        .public_monitoring
        .observe_chain_environment(format!("client:{}", response.client_id), &headers)
        .await;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::SET_COOKIE,
        clear_client_session_cookie(request_uses_https(&headers, None)),
    );
    Ok((response_headers, Json(response)))
}

async fn public_issue_device_session(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<DeviceSessionResponse>), (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "device_session").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::SET_COOKIE,
        build_device_session_cookie(bearer, request_uses_https(&headers, None))?,
    );
    control_plane
        .issue_device_session(bearer)
        .await
        .map(|response| (response_headers, Json(response)))
        .map_err(public_api_error)
}

async fn public_clear_device_session(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<DeviceSessionClearResponse>), (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "clear_device_session").await?;
    let _ = require_public_control_plane(&state)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::SET_COOKIE,
        clear_device_session_cookie(request_uses_https(&headers, None)),
    );
    Ok((
        response_headers,
        Json(DeviceSessionClearResponse { cleared: true }),
    ))
}

async fn public_issue_device_ws_token(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<DeviceWsTokenResponse>), (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "device_ws_token").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = device_refresh_token(&headers)?;
    let mut response_headers = HeaderMap::new();
    if let Some(cookie) = device_session_cookie(&headers) {
        response_headers.insert(
            header::SET_COOKIE,
            build_device_session_cookie(cookie, request_uses_https(&headers, None))?,
        );
    }
    match control_plane.issue_device_ws_token(bearer).await {
        Ok(response) => {
            state
                .public_monitoring
                .record_refresh_success(RefreshChainKind::DeviceWsToken)
                .await;
            state
                .public_monitoring
                .observe_chain_environment(
                    format!("device:{}:{}", response.broker_room_id, response.device_id),
                    &headers,
                )
                .await;
            Ok((response_headers, Json(response)))
        }
        Err(error) => {
            state
                .public_monitoring
                .record_refresh_failure(RefreshChainKind::DeviceWsToken, bearer, &error)
                .await;
            Err(public_api_error(error))
        }
    }
}

async fn public_revoke_device_grant(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<DeviceGrantRevokeRequest>,
) -> Result<Json<DeviceGrantRevokeResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "revoke_device_grant").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .revoke_device_grant(bearer, &device_id, input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_revoke_other_device_grants(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<DeviceGrantBulkRevokeRequest>,
) -> Result<Json<DeviceGrantBulkRevokeResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "revoke_other_device_grants").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .revoke_other_device_grants(bearer, input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn websocket(
    ws: WebSocketUpgrade,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Path(channel_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ConnectQuery>,
    State(state): State<BrokerAppState>,
) -> impl IntoResponse {
    if let Err(error) = authorize_websocket_origin(&headers) {
        return error.into_response();
    }

    ws.on_upgrade(move |socket| handle_socket(state, socket, remote_addr, channel_id, query))
}

async fn handle_socket(
    state: BrokerAppState,
    socket: WebSocket,
    remote_addr: SocketAddr,
    channel_id: String,
    query: ConnectQuery,
) {
    if channel_id.trim().is_empty() {
        reject_socket(socket, "invalid_connection", "channel_id is required").await;
        return;
    }
    let Some(_connection_permit) = state.hardening.connection_tracker.try_acquire(
        remote_addr.ip(),
        state.hardening.config.max_connections_per_ip,
    ) else {
        reject_socket(
            socket,
            "rate_limited",
            "too many broker connections from this client",
        )
        .await;
        return;
    };
    if !state
        .hardening
        .rate_limiter
        .allow(
            format!("join:{}:{}", remote_addr.ip(), channel_id),
            state.hardening.config.join_rate_limit_per_minute,
        )
        .await
    {
        reject_socket(
            socket,
            "rate_limited",
            "broker join rate limit exceeded for this client",
        )
        .await;
        return;
    }

    let verified_join = match state.join_verifier.verify_connection(
        query.join_ticket.as_deref(),
        &channel_id,
        query.role,
    ) {
        Ok(verified_join) => verified_join,
        Err(message) => {
            debug!(
                remote_ip = %remote_addr.ip(),
                broker_room_id = %channel_id,
                role = ?query.role,
                reason = %scrub_sensitive_message(&message),
                "broker join rejected"
            );
            reject_socket(
                socket,
                "join_rejected",
                state.join_verifier.client_join_error_message(),
            )
            .await;
            return;
        }
    };

    let mut peer_id =
        trimmed_option_string(query.peer_id).or_else(|| verified_join.peer_id.clone());
    let join = loop {
        let candidate = peer_id
            .clone()
            .unwrap_or_else(|| generated_peer_id(query.role));
        if let Some(expected_peer_id) = verified_join.peer_id.as_deref() {
            if candidate != expected_peer_id {
                debug!(
                    remote_ip = %remote_addr.ip(),
                    broker_room_id = %channel_id,
                    role = ?query.role,
                    "broker join rejected because the requested peer_id did not match the verified ticket"
                );
                reject_socket(
                    socket,
                    "join_rejected",
                    state.join_verifier.client_join_error_message(),
                )
                .await;
                return;
            }
        }
        match state.broker.join(&channel_id, &candidate, query.role).await {
            Ok(join) => {
                peer_id = Some(candidate);
                break join;
            }
            Err(message) => {
                if peer_id.is_none() && message.contains("is already connected") {
                    continue;
                }
                debug!(
                    remote_ip = %remote_addr.ip(),
                    broker_room_id = %channel_id,
                    role = ?query.role,
                    reason = %scrub_sensitive_message(&message),
                    "broker join failed"
                );
                reject_socket(
                    socket,
                    "join_rejected",
                    state.join_verifier.client_join_error_message(),
                )
                .await;
                return;
            }
        }
    };
    let peer_id = peer_id.expect("broker should assign a peer id");

    let (mut sender, mut receiver) = socket.split();
    let welcome = ServerMessage::Welcome {
        channel_id: channel_id.clone(),
        peer_id: peer_id.clone(),
        peers: join.existing_peers,
    };

    if send_message(&mut sender, &welcome).await.is_err() {
        state.broker.leave(&channel_id, &peer_id).await;
        return;
    }

    let mut outbound = join.receiver;
    let idle_timeout = state.hardening.config.idle_timeout;
    let idle_deadline = Instant::now() + idle_timeout;
    let idle_sleep = tokio::time::sleep_until(idle_deadline);
    tokio::pin!(idle_sleep);

    loop {
        tokio::select! {
            outbound_message = outbound.recv() => {
                let Some(message) = outbound_message else {
                    break;
                };
                if send_message(&mut sender, &message).await.is_err() {
                    break;
                }
                idle_sleep.as_mut().reset(Instant::now() + idle_timeout);
            }
            _ = &mut idle_sleep => {
                let _ = send_message(
                    &mut sender,
                    &ServerMessage::Error {
                        code: "idle_timeout".to_string(),
                        message: "broker socket closed after being idle for too long".to_string(),
                    },
                )
                .await;
                break;
            }
            frame = receiver.next() => {
                let Some(frame) = frame else {
                    break;
                };
                idle_sleep.as_mut().reset(Instant::now() + idle_timeout);
                match frame {
                    Ok(Message::Text(text)) => {
                        if text.len() > state.hardening.config.max_text_frame_bytes {
                            let _ = send_message(
                                &mut sender,
                                &ServerMessage::Error {
                                    code: "frame_too_large".to_string(),
                                    message: format!(
                                        "client text frames must be {} bytes or smaller",
                                        state.hardening.config.max_text_frame_bytes
                                    ),
                                },
                            )
                            .await;
                            break;
                        }

                        let parsed = serde_json::from_str::<ClientMessage>(&text);
                        match parsed {
                            Ok(ClientMessage::Publish { payload }) => {
                                let payload_summary = summarize_published_payload(&payload);
                                if !state
                                    .hardening
                                    .rate_limiter
                                    .allow(
                                        format!("publish:{channel_id}:{peer_id}"),
                                        state.hardening.config.publish_rate_limit_per_minute,
                                    )
                                    .await
                                {
                                    warn!(
                                        channel_id,
                                        peer_id,
                                        frame_bytes = text.len(),
                                        payload = %payload_summary,
                                        "broker publish rate limit exceeded"
                                    );
                                    let _ = send_message(
                                        &mut sender,
                                        &ServerMessage::Error {
                                            code: "rate_limited".to_string(),
                                            message: "broker publish rate limit exceeded for this peer".to_string(),
                                        },
                                    )
                                    .await;
                                    break;
                                }
                                if let Err(error) =
                                    state.broker.publish(&channel_id, &peer_id, payload).await
                                {
                                    warn!(
                                        channel_id,
                                        peer_id,
                                        %error,
                                        payload = %payload_summary,
                                        "failed to publish message"
                                    );
                                }
                            }
                            Err(error) => {
                                debug!(channel_id, peer_id, %error, "dropping invalid client frame");
                            }
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(payload)) => {
                        if sender.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Pong(_)) => {}
                    Ok(Message::Binary(bytes)) => {
                        if bytes.len() > state.hardening.config.max_text_frame_bytes {
                            let _ = send_message(
                                &mut sender,
                                &ServerMessage::Error {
                                    code: "frame_too_large".to_string(),
                                    message: format!(
                                        "client binary frames must be {} bytes or smaller",
                                        state.hardening.config.max_text_frame_bytes
                                    ),
                                },
                            )
                            .await;
                            break;
                        }
                        debug!(channel_id, peer_id, "ignoring unexpected binary frame");
                    }
                    Err(error) => {
                        debug!(channel_id, peer_id, %error, "socket receive loop ended");
                        break;
                    }
                }
            }
        }
    }
    state.broker.leave(&channel_id, &peer_id).await;
}

async fn send_message(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &ServerMessage,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(message).expect("server messages should serialize");
    sender.send(Message::Text(payload)).await
}

async fn reject_socket(socket: WebSocket, code: &str, message: &str) {
    let (mut sender, _) = socket.split();
    let payload = serde_json::to_string(&ServerMessage::Error {
        code: code.to_string(),
        message: message.to_string(),
    })
    .expect("error message should serialize");
    let _ = sender.send(Message::Text(payload)).await;
    let _ = sender.close().await;
}

fn default_web_root() -> PathBuf {
    workspace_root().join("web")
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("workspace root should resolve")
}

fn generated_peer_id(role: protocol::PeerRole) -> String {
    let prefix = match role {
        protocol::PeerRole::Relay => "relay",
        protocol::PeerRole::Surface => "surface",
    };
    let suffix = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(12)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase();
    format!("{prefix}-{suffix}")
}

fn verify_self_hosted_join_ticket_for_connection(
    key: &JoinTicketKey,
    join_ticket: Option<&str>,
    broker_room_id: &str,
    role: protocol::PeerRole,
) -> Result<JoinTicketClaims, String> {
    verify_join_ticket_for_connection(key, join_ticket, broker_room_id, role)
}

fn verify_join_ticket_for_connection(
    key: &JoinTicketKey,
    join_ticket: Option<&str>,
    broker_room_id: &str,
    role: protocol::PeerRole,
) -> Result<JoinTicketClaims, String> {
    let join_ticket = join_ticket
        .map(str::trim)
        .filter(|ticket| !ticket.is_empty())
        .ok_or_else(|| "join_ticket is required".to_string())?;
    let claims = key.verify(join_ticket)?;
    if claims.channel_id != broker_room_id {
        return Err("join_ticket channel does not match this broker room".to_string());
    }
    if claims.role != role {
        return Err("join_ticket role does not match this connection".to_string());
    }
    match (role, claims.kind) {
        (protocol::PeerRole::Relay, JoinTicketKind::RelayJoin) => Ok(claims),
        (
            protocol::PeerRole::Surface,
            JoinTicketKind::PairingSurfaceJoin | JoinTicketKind::DeviceSurfaceJoin,
        ) => Ok(claims),
        (protocol::PeerRole::Relay, _) => Err("join_ticket kind is invalid for relay".to_string()),
        (protocol::PeerRole::Surface, _) => {
            Err("join_ticket kind is invalid for surface".to_string())
        }
    }
}

fn require_public_control_plane(
    state: &BrokerAppState,
) -> Result<PublicControlPlane, (StatusCode, Json<ApiErrorBody>)> {
    state.join_verifier.public_control_plane().ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiErrorBody {
                error: "not_found",
                message: "public control-plane endpoints are unavailable in this auth mode"
                    .to_string(),
            }),
        )
    })
}

fn device_refresh_token(headers: &HeaderMap) -> Result<&str, (StatusCode, Json<ApiErrorBody>)> {
    if let Some(cookie) = device_session_cookie(headers) {
        return Ok(cookie);
    }

    bearer_token(headers)
}

fn client_refresh_token(headers: &HeaderMap) -> Result<&str, (StatusCode, Json<ApiErrorBody>)> {
    client_refresh_auth(headers).map(ClientRefreshAuth::token)
}

fn client_refresh_auth(
    headers: &HeaderMap,
) -> Result<ClientRefreshAuth<'_>, (StatusCode, Json<ApiErrorBody>)> {
    if let Some(cookie) = client_session_cookie(headers) {
        return Ok(ClientRefreshAuth::Cookie(cookie));
    }

    bearer_token(headers).map(ClientRefreshAuth::Bearer)
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, (StatusCode, Json<ApiErrorBody>)> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ApiErrorBody {
                    error: "unauthorized",
                    message: "missing bearer token".to_string(),
                }),
            )
        })?;
    Ok(value)
}

fn device_session_cookie(headers: &HeaderMap) -> Option<&str> {
    named_cookie(headers, DEVICE_SESSION_COOKIE_NAME)
}

fn client_session_cookie(headers: &HeaderMap) -> Option<&str> {
    named_cookie(headers, CLIENT_SESSION_COOKIE_NAME)
}

fn named_cookie<'a>(headers: &'a HeaderMap, cookie_name: &str) -> Option<&'a str> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name.trim() == cookie_name {
            let cookie = value.trim();
            if !cookie.is_empty() {
                return Some(cookie);
            }
        }
    }
    None
}

fn build_device_session_cookie(
    refresh_token: &str,
    secure: bool,
) -> Result<HeaderValue, (StatusCode, Json<ApiErrorBody>)> {
    build_session_cookie(
        DEVICE_SESSION_COOKIE_NAME,
        refresh_token,
        "/api/public/device",
        secure,
        "device session cookie could not be created",
    )
}

fn clear_device_session_cookie(secure: bool) -> HeaderValue {
    clear_session_cookie(DEVICE_SESSION_COOKIE_NAME, "/api/public/device", secure)
}

fn build_client_session_cookie(
    refresh_token: &str,
    secure: bool,
) -> Result<HeaderValue, (StatusCode, Json<ApiErrorBody>)> {
    build_session_cookie(
        CLIENT_SESSION_COOKIE_NAME,
        refresh_token,
        "/api/public",
        secure,
        "client session cookie could not be created",
    )
}

fn clear_client_session_cookie(secure: bool) -> HeaderValue {
    clear_session_cookie(CLIENT_SESSION_COOKIE_NAME, "/api/public", secure)
}

fn build_session_cookie(
    cookie_name: &str,
    refresh_token: &str,
    path: &str,
    secure: bool,
    error_message: &str,
) -> Result<HeaderValue, (StatusCode, Json<ApiErrorBody>)> {
    HeaderValue::from_str(&format!(
        "{cookie_name}={}; HttpOnly; Path={path}; SameSite=Strict; Max-Age={DEVICE_SESSION_COOKIE_MAX_AGE_SECS}{}",
        refresh_token.trim(),
        if secure { "; Secure" } else { "" }
    ))
    .map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorBody {
                error: "bad_request",
                message: error_message.to_string(),
            }),
        )
    })
}

fn clear_session_cookie(cookie_name: &str, path: &str, secure: bool) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{cookie_name}=; HttpOnly; Path={path}; SameSite=Strict; Max-Age=0{}",
        if secure { "; Secure" } else { "" }
    ))
    .expect("session clear-cookie header should be valid")
}

fn public_api_error(message: String) -> (StatusCode, Json<ApiErrorBody>) {
    let status = if public_api_auth_failure(&message) {
        StatusCode::UNAUTHORIZED
    } else {
        StatusCode::BAD_REQUEST
    };
    let message = if status == StatusCode::UNAUTHORIZED {
        "request failed".to_string()
    } else {
        scrub_sensitive_message(&message)
    };
    (
        status,
        Json(ApiErrorBody {
            error: if status == StatusCode::UNAUTHORIZED {
                "unauthorized"
            } else {
                "bad_request"
            },
            message,
        }),
    )
}

fn public_api_auth_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("invalid")
        || lower.contains("does not match")
        || lower.contains("missing bearer token")
}

async fn enforce_public_api_rate_limit(
    state: &BrokerAppState,
    remote_addr: SocketAddr,
    route_name: &str,
) -> Result<(), (StatusCode, Json<ApiErrorBody>)> {
    if state
        .hardening
        .rate_limiter
        .allow(
            format!("public-api:{}:{route_name}", remote_addr.ip()),
            state.hardening.config.public_api_rate_limit_per_minute,
        )
        .await
    {
        return Ok(());
    }

    Err((
        StatusCode::TOO_MANY_REQUESTS,
        Json(ApiErrorBody {
            error: "rate_limited",
            message: "public broker control-plane rate limit exceeded".to_string(),
        }),
    ))
}

fn scrub_sensitive_message(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if [
        "pairing_secret",
        "refresh_token",
        "join_ticket",
        "ws_token",
        "authorization",
        "bearer ",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return "request failed".to_string();
    }
    message.to_string()
}

fn parse_u64_env(name: &str, default: u64) -> Result<u64, String> {
    match std::env::var(name) {
        Ok(value) => value
            .trim()
            .parse::<u64>()
            .map_err(|error| format!("{name} must be a positive integer: {error}")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid utf-8")),
    }
}

fn parse_usize_env(name: &str, default: usize) -> Result<usize, String> {
    match std::env::var(name) {
        Ok(value) => value
            .trim()
            .parse::<usize>()
            .map_err(|error| format!("{name} must be a positive integer: {error}")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid utf-8")),
    }
}

fn parse_bool_env(name: &str, default: bool) -> Result<bool, String> {
    match std::env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "" => Ok(default),
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => Err(format!(
                "{name} must be one of: 1, true, yes, on, 0, false, no, off"
            )),
        },
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid utf-8")),
    }
}

fn security_headers_from_env() -> Result<SecurityHeadersConfig, String> {
    SecurityHeadersConfig::from_parts(
        parse_bool_env(ENABLE_HSTS_ENV, false)?,
        parse_optional_string_env(CSP_CONNECT_SRC_ENV)?,
        parse_optional_string_env(HSTS_VALUE_ENV)?,
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
}

async fn with_security_headers(
    State(config): State<SecurityHeadersConfig>,
    request: Request,
    next: Next,
) -> Response {
    let is_https = request_uses_https(request.headers(), None);
    let mut response = next.run(request).await;
    apply_standard_security_headers(
        response.headers_mut(),
        &config.content_security_policy,
        &config.strict_transport_security,
        config.enable_hsts,
        is_https,
    );
    response
}

fn authorize_websocket_origin(headers: &HeaderMap) -> Result<(), StatusCode> {
    // TODO: Split websocket browser/native policies more explicitly. For now, only
    // reject requests that explicitly present a mismatched browser Origin.
    let Some(origin) = header_origin(headers, header::ORIGIN) else {
        return Ok(());
    };
    let Some(expected_origin) = request_origin(headers, None) else {
        return Err(StatusCode::FORBIDDEN);
    };
    if origin == expected_origin {
        Ok(())
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

fn request_environment(headers: &HeaderMap) -> Option<RequestEnvironment> {
    let origin = header_origin(headers, header::ORIGIN);
    let user_agent_hash = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let digest = sha256_hex(value);
            format!("ua:{}", &digest[..12])
        });
    if origin.is_none() && user_agent_hash.is_none() {
        return None;
    }
    Some(RequestEnvironment {
        origin,
        user_agent_hash,
    })
}

#[cfg(test)]
mod tests;
