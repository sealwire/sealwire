pub mod auth;
pub mod blocklist;
pub mod events;
pub mod join_ticket;
pub mod licenses;
pub mod protocol;
pub mod public_control;
mod state;

pub use blocklist::{Blocklist, BANNED_IPS_POSTGRES_URL_ENV};
pub use events::{
    usage_event_sink_from_env, FileUsageEventSink, PostgresUsageEventSink, UsageEvent,
    UsageEventKind, UsageEventSink, USAGE_EVENTS_PATH_ENV, USAGE_EVENTS_POSTGRES_URL_ENV,
};
pub use state::BrokerState;

use std::path::PathBuf;
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use auth::BrokerAuthMode;
use axum::{
    extract::{
        connect_info::ConnectInfo,
        ws::{Message, WebSocket},
        Path, Query, Request, State, WebSocketUpgrade,
    },
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{sink::SinkExt, StreamExt};
use join_ticket::{JoinTicketClaims, JoinTicketKey, JoinTicketKind, JOIN_TICKET_SECRET_ENV};
use protocol::{
    ClientMessage, ConnectQuery, HealthResponse, PublicBrokerMonitoring, ServerMessage,
    BROKER_PROTOCOL_VERSION,
};
use public_control::{
    ClientGrantRequest, ClientGrantResponse, ClientIdentityRevokeResponse,
    ClientIdentityRotateResponse, ClientRelaysResponse, ClientSessionResponse,
    DeviceGrantBulkRevokeRequest, DeviceGrantBulkRevokeResponse, DeviceGrantRequest,
    DeviceGrantResponse, DeviceGrantRevokeRequest, DeviceGrantRevokeResponse,
    DeviceSessionResponse, DeviceWsTokenResponse, PairingWsTokenRequest, PairingWsTokenResponse,
    PublicControlPlane, RelayEnrollmentChallengeRequest, RelayEnrollmentChallengeResponse,
    RelayEnrollmentCompleteRequest, RelayEnrollmentResponse, RelayRegistrationSnapshot,
    RelayWsTokenRequest, RelayWsTokenResponse, DEVICE_LIMIT_REACHED_ERROR_PREFIX,
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
const DEVICE_SCOPED_SESSION_COOKIE_PATH: &str = "/api/public/device";
const DEVICE_SESSION_ROOM_MAX_BYTES: usize = 512;
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
const BROKER_WEB_ROOT_ENV: &str = "RELAY_BROKER_WEB_ROOT";

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
    let ban_guard = BanGuard::from_env().await;
    // RELAY_BROKER_REQUIRE_LICENSE_CODE is read once here and threaded through
    // independently of the store so we can fail closed when the store is None
    // but required=true (e.g. DB outage at startup).
    let license_required = licenses::license_required_from_env();
    let license_store = match licenses::LicenseStore::from_env().await {
        Ok(store) => store,
        Err(error) => {
            // Required but DB unavailable: log loudly, keep store=None.
            // Handlers see required=true + store=None and reject (fail closed).
            warn!(%error, "FATAL: license backend unavailable; enrollment will be rejected until fixed");
            None
        }
    };
    app_with_web_root_and_verifier_and_hardening_and_licenses(
        state,
        default_web_root(),
        join_verifier,
        hardening,
        security_headers,
        license_store,
        license_required, // may be true even when store=None (DB failure → fail closed)
        admin_token_from_env(),
    )
    .layer(middleware::from_fn_with_state(ban_guard, reject_banned_ips))
}

const TRUSTED_CLIENT_IP_HEADER_ENV: &str = "RELAY_BROKER_TRUSTED_CLIENT_IP_HEADER";

/// The blocklist plus how to find the real client IP. Behind a reverse proxy the
/// TCP socket IP is the proxy's, not the client's, so the operator opts in to a
/// trusted forwarded header the proxy sets (e.g. `cf-connecting-ip`, `x-real-ip`,
/// `x-forwarded-for`). When unset we use the socket IP — correct for direct
/// connections and local dev. We never trust a forwarded header unless it is
/// explicitly configured, so a client cannot fake its IP by default.
#[derive(Clone)]
struct BanGuard {
    blocklist: Blocklist,
    trusted_ip_header: Option<HeaderName>,
}

impl BanGuard {
    async fn from_env() -> Self {
        let blocklist = Blocklist::from_env().await;
        let trusted_ip_header =
            trimmed_option_string(std::env::var(TRUSTED_CLIENT_IP_HEADER_ENV).ok()).and_then(
                |name| match HeaderName::try_from(name.to_ascii_lowercase()) {
                    Ok(header) => Some(header),
                    Err(_) => {
                        warn!(header = %name, "invalid {TRUSTED_CLIENT_IP_HEADER_ENV}; using socket ip");
                        None
                    }
                },
            );
        Self {
            blocklist,
            trusted_ip_header,
        }
    }

    /// Resolve the client IP: the trusted forwarded header when configured,
    /// otherwise the TCP socket IP. For a multi-value header (e.g.
    /// `x-forwarded-for`) we take the rightmost entry — the one appended by the
    /// trusted proxy directly in front of the broker — so a client cannot spoof
    /// it by prepending values.
    fn client_ip(&self, headers: &HeaderMap, socket_ip: IpAddr) -> IpAddr {
        if let Some(name) = &self.trusted_ip_header {
            // Consider every field line of the header (a proxy may append a
            // second `X-Forwarded-For:` line instead of editing the first) and
            // take the last parseable address across all of them — the one the
            // trusted proxy directly in front of us appended. A client cannot
            // spoof it by prepending earlier values.
            if let Some(ip) = headers
                .get_all(name)
                .iter()
                .filter_map(|value| value.to_str().ok())
                .flat_map(|value| value.split(','))
                .filter_map(|entry| entry.trim().parse::<IpAddr>().ok())
                .last()
            {
                return ip;
            }
        }
        socket_ip
    }
}

/// Middleware that rejects any request from a banned IP with 403 before it can
/// reach the control-plane or WebSocket handlers. Fail-open: an empty/disabled
/// blocklist bans nothing.
async fn reject_banned_ips(
    State(guard): State<BanGuard>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    mut request: Request,
    next: Next,
) -> Response {
    let client_ip = guard.client_ip(request.headers(), remote_addr.ip());
    if client_ip != remote_addr.ip() {
        // Behind a trusted proxy the socket IP is the proxy's. Rewrite ConnectInfo
        // so every downstream per-IP check — this ban check plus the per-IP rate
        // limits, join limits, and connection tracker in the handlers — keys on
        // the real client IP instead of the shared proxy IP.
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(client_ip, remote_addr.port())));
    }
    if guard.blocklist.is_banned(client_ip) {
        debug!(%client_ip, "rejecting request from banned ip");
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    next.run(request).await
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
        "targeted_messages" => {
            let messages = payload
                .get("messages")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let inner_kinds = messages
                .iter()
                .filter_map(|message| {
                    message
                        .get("payload")
                        .and_then(|payload| payload.get("kind"))
                        .and_then(serde_json::Value::as_str)
                })
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "kind=targeted_messages target_count={} inner_kinds={}",
                messages.len(),
                if inner_kinds.is_empty() {
                    "-"
                } else {
                    inner_kinds.as_str()
                }
            )
        }
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
    license_store: Option<licenses::LicenseStore>,
    /// Whether `RELAY_BROKER_REQUIRE_LICENSE_CODE=1` was set. Tracked separately
    /// so handlers can reject when `required=true` but `license_store=None` (the
    /// store failed to connect — we must fail closed, not open).
    license_required: bool,
    /// Per-verify-key locks that serialize relay enrollment completion so that
    /// enroll + license-redeem is one atomic transition for a given identity.
    /// This prevents concurrent `/complete` calls for the same verify key from
    /// racing (where one request's rollback could delete a registration created
    /// by another). Keyed by relay verify key.
    enrollment_locks: Arc<StdMutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// Operator token for `/api/admin/stats` (see [`ADMIN_TOKEN_ENV`]). `None` =
    /// the admin endpoint is disabled and returns 404 (never reveals it exists).
    admin_token: Option<Arc<str>>,
}

/// Operator bearer token that gates `/api/admin/stats`. Keep it independent of any
/// user credential and only reachable on a trusted network / behind your proxy.
/// Unset = the admin endpoint is disabled entirely.
pub const ADMIN_TOKEN_ENV: &str = "RELAY_BROKER_ADMIN_TOKEN";

/// Read and trim the operator admin token from the environment (`None` when unset
/// or blank → admin endpoint disabled).
fn admin_token_from_env() -> Option<Arc<str>> {
    trimmed_option_string(std::env::var(ADMIN_TOKEN_ENV).ok())
        .map(|token| Arc::from(token.as_str()))
}

/// Bound on the enrollment-lock map: when it grows past this, unused locks
/// (strong_count == 1, i.e. only the map holds them) are evicted. Evicting an
/// idle lock is safe — a later request for that key just recreates it.
const ENROLLMENT_LOCK_MAP_CAP: usize = 4096;

#[derive(Clone)]
enum BrokerJoinVerifier {
    SelfHosted(JoinTicketKey),
    PublicControlPlane(PublicControlPlane),
    Misconfigured(String),
}

#[derive(Debug)]
struct VerifiedBrokerJoin {
    peer_id: Option<String>,
    device_id: Option<String>,
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
                device_id: claims.device_id,
            }),
            Self::PublicControlPlane(control_plane) => verify_join_ticket_for_connection(
                control_plane.issuer_key(),
                join_ticket,
                broker_room_id,
                role,
            )
            .map(|claims| VerifiedBrokerJoin {
                peer_id: claims.peer_id,
                device_id: claims.device_id,
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

// Licensing-free convenience wrapper used by the test harness. `app()` uses the
// `_and_licenses` variant directly.
#[cfg(test)]
fn app_with_web_root_and_verifier_and_hardening(
    state: BrokerState,
    web_root: PathBuf,
    join_verifier: BrokerJoinVerifier,
    hardening_config: BrokerHardeningConfig,
    security_headers: SecurityHeadersConfig,
) -> Router {
    app_with_web_root_and_verifier_and_hardening_and_licenses(
        state,
        web_root,
        join_verifier,
        hardening_config,
        security_headers,
        None,
        false, // no license store → licensing disabled, no enforcement
        None,  // no admin token → /api/admin/stats not mounted
    )
}

// `license_required` is passed separately from `license_store` so the production
// path in `app()` can keep `license_required=true` even when `license_store` is
// `None` due to a DB failure at startup (fail closed, not open). Test callers
// should derive `license_required` from the store's `.required` field.
fn app_with_web_root_and_verifier_and_hardening_and_licenses(
    state: BrokerState,
    web_root: PathBuf,
    join_verifier: BrokerJoinVerifier,
    hardening_config: BrokerHardeningConfig,
    security_headers: SecurityHeadersConfig,
    license_store: Option<licenses::LicenseStore>,
    license_required: bool,
    admin_token: Option<Arc<str>>,
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
    let mut router = Router::new()
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
        // Per-relay (room-scoped) device sessions. The room in the path scopes the
        // cookie to a single relay so forgetting/switching one relay never touches
        // another on the same broker. The legacy routes above stay for old clients
        // and are what a legacy cookie upgrades away from on first use.
        .route(
            "/api/public/device/:room/session",
            post(public_issue_device_session_scoped).delete(public_clear_device_session_scoped),
        )
        .route(
            "/api/public/device/:room/ws-token",
            post(public_issue_device_ws_token_scoped),
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
        .route_service(
            "/apple-touch-icon.png",
            ServeFile::new(web_root.join("apple-touch-icon.png")),
        )
        .route_service(
            "/icon-192.png",
            ServeFile::new(web_root.join("icon-192.png")),
        )
        .route_service(
            "/icon-512.png",
            ServeFile::new(web_root.join("icon-512.png")),
        )
        .route_service(
            "/icon-512-maskable.png",
            ServeFile::new(web_root.join("icon-512-maskable.png")),
        )
        .route_service("/", ServeFile::new(web_root.join("remote.html")))
        .nest_service("/static", ServeDir::new(web_root));

    // Mount the operator stats endpoint ONLY when a token is configured, so a
    // disabled deployment is indistinguishable from any other unmounted path
    // (the router's generic 404) rather than replying with a telltale body.
    if admin_token.is_some() {
        router = router.route("/api/admin/stats", get(admin_stats));
    }

    router
        .with_state(BrokerAppState {
            broker: state,
            join_verifier,
            hardening: BrokerHardeningState {
                config: hardening_config,
                rate_limiter: SlidingWindowRateLimiter::default(),
                connection_tracker: ActiveConnectionTracker::default(),
            },
            public_monitoring: PublicMonitoringState::default(),
            license_store,
            license_required,
            enrollment_locks: Arc::new(StdMutex::new(HashMap::new())),
            admin_token,
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

/// Default number of relay rows returned by `/api/admin/stats` when `?top=` is
/// omitted. Busiest relays (by device count) come first.
const ADMIN_STATS_DEFAULT_TOP: usize = 100;

#[derive(Debug, serde::Deserialize)]
struct AdminStatsQuery {
    /// Cap on the number of relay rows returned. `0` = unlimited.
    top: Option<usize>,
}

#[derive(Debug, serde::Serialize)]
struct AdminRelayRow {
    relay_id: String,
    broker_room_id: String,
    relay_label: Option<String>,
    device_count: u64,
    client_count: u64,
    last_seen: Option<u64>,
    /// License attribution (code/tier/revoked/…), present when a license store is
    /// configured and the relay has a bound license.
    #[serde(skip_serializing_if = "Option::is_none")]
    license: Option<licenses::LicenseSummary>,
}

#[derive(Debug, serde::Serialize)]
struct AdminStatsResponse {
    generated_at: u64,
    totals: public_control::AdminTotals,
    relays: Vec<AdminRelayRow>,
}

/// Outcome of checking an operator admin request's bearer token.
#[derive(Debug, PartialEq, Eq)]
enum AdminAuthOutcome {
    /// No admin token configured → the endpoint is disabled (respond 404).
    Disabled,
    /// A token was required but the presented one was missing/wrong (respond 401).
    Unauthorized,
    /// The presented token matched the configured one.
    Authorized,
}

/// Decide an admin request's fate from the configured vs. presented token. Pure so
/// the auth policy is unit-testable without constructing HTTP state.
fn admin_auth_outcome(configured: Option<&str>, presented: Option<&str>) -> AdminAuthOutcome {
    let Some(configured) = configured else {
        return AdminAuthOutcome::Disabled;
    };
    match presented {
        Some(token) if constant_time_eq(token.as_bytes(), configured.as_bytes()) => {
            AdminAuthOutcome::Authorized
        }
        _ => AdminAuthOutcome::Unauthorized,
    }
}

/// Constant-time byte comparison so token verification does not leak the token via
/// early-exit timing. Length still short-circuits (token length is not secret).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Operator stats: per-relay device/client counts (busiest first) with license
/// attribution, so a spammy relay can be traced to its code and revoked. Gated by
/// [`ADMIN_TOKEN_ENV`]; disabled (404) when no token is configured.
async fn admin_stats(
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Query(query): Query<AdminStatsQuery>,
) -> Result<Json<AdminStatsResponse>, (StatusCode, Json<ApiErrorBody>)> {
    // Authorize before touching any state. A disabled endpoint 404s (so its
    // existence is not revealed); a bad/missing token 401s.
    let presented = bearer_token(&headers).ok();
    match admin_auth_outcome(state.admin_token.as_deref(), presented) {
        AdminAuthOutcome::Authorized => {}
        AdminAuthOutcome::Disabled => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ApiErrorBody {
                    error: "not_found",
                    message: "admin endpoint is disabled".to_string(),
                }),
            ));
        }
        AdminAuthOutcome::Unauthorized => {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(ApiErrorBody {
                    error: "unauthorized",
                    message: "invalid or missing admin token".to_string(),
                }),
            ));
        }
    }

    let control_plane = require_public_control_plane(&state)?;
    let top = query.top.unwrap_or(ADMIN_STATS_DEFAULT_TOP);
    let stats = control_plane
        .admin_stats(top)
        .await
        .map_err(public_api_error)?;

    // Enrich with license attribution when a license store is configured.
    let relay_ids: Vec<String> = stats.relays.iter().map(|r| r.relay_id.clone()).collect();
    let mut licenses_by_relay = if let Some(store) = &state.license_store {
        store
            .license_summaries_for_relays(&relay_ids)
            .await
            .map_err(public_api_error)?
    } else {
        HashMap::new()
    };

    let relays = stats
        .relays
        .into_iter()
        .map(|relay| {
            let license = licenses_by_relay.remove(&relay.relay_id);
            AdminRelayRow {
                relay_id: relay.relay_id,
                broker_room_id: relay.broker_room_id,
                relay_label: relay.relay_label,
                device_count: relay.device_count,
                client_count: relay.client_count,
                last_seen: relay.last_seen,
                license,
            }
        })
        .collect();

    Ok(Json(AdminStatsResponse {
        generated_at: unix_now_secs(),
        totals: stats.totals,
        relays,
    }))
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

/// Get (or create) the per-verify-key enrollment lock. Evicts idle locks when the
/// map grows past a cap so a stream of distinct keys can't grow it without bound.
fn acquire_enrollment_lock(state: &BrokerAppState, verify_key: &str) -> Arc<Mutex<()>> {
    let mut map = state
        .enrollment_locks
        .lock()
        .expect("enrollment lock map should not be poisoned");
    if map.len() > ENROLLMENT_LOCK_MAP_CAP {
        // Only removes locks nobody currently holds/awaits (strong_count == 1).
        map.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    map.entry(verify_key.to_string()).or_default().clone()
}

async fn public_complete_relay_enrollment(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    Json(input): Json<RelayEnrollmentCompleteRequest>,
) -> Result<Json<RelayEnrollmentResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "relay_enrollment_complete").await?;

    let license_code = trimmed_option_string(input.license_code.clone());

    // --- License pre-flight (before touching the control-plane) ---
    //
    // F1: fail closed when required but store unavailable (DB outage at startup).
    if state.license_required && state.license_store.is_none() {
        return Err(public_api_error(
            "license service unavailable; try again later".to_string(),
        ));
    }

    // Serialize enroll + license-redeem per identity: two `/complete` calls for
    // the same verify key must not interleave, or one request's rollback could
    // delete a registration created by the other. Held for the whole operation.
    let verify_key = trimmed_option_string(Some(input.relay_verify_key.clone()));
    let enrollment_lock = verify_key
        .as_deref()
        .map(|vk| acquire_enrollment_lock(&state, vk));
    let _enrollment_guard = match &enrollment_lock {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };

    let control_plane = require_public_control_plane(&state)?;

    // Snapshot any existing registration for this verify key. Because we hold the
    // per-identity lock this is a consistent view, and the snapshot lets us restore
    // the relay's original refresh credential if re-licensing fails after enrollment
    // replaced its token. Used to:
    // (a) detect same-code re-enrollment after cache loss (Renewal path),
    // (b) identify the relay_id whose expired/revoked binding to clear, and
    // (c) restore the previous credential on redeem failure (else new relay → delete).
    let previous_registration: Option<RelayRegistrationSnapshot> = match &verify_key {
        Some(vk) => control_plane.snapshot_relay_registration(vk).await,
        None => None,
    };
    let existing_relay_id = previous_registration
        .as_ref()
        .map(|snap| snap.relay_id().to_string());

    // Validate the license code BEFORE enrollment so a bad code never causes a
    // registration to be persisted. Also handles re-enrollment (F2): if the code
    // is already bound to this relay_id, return Renewal and skip redeem.
    let enrollment_action = if let Some(store) = &state.license_store {
        match license_code.as_deref() {
            Some(code) => Some(
                store
                    .validate_code_or_reenroll(code, existing_relay_id.as_deref())
                    .await
                    .map_err(|msg| public_api_error(msg))?,
            ),
            None if state.license_required => {
                return Err(public_api_error("license_code is required".to_string()));
            }
            None => None,
        }
    } else {
        None
    };

    // Enrollment — persists (or re-persists) the relay registration.
    let response = control_plane
        .complete_relay_enrollment(input)
        .await
        .map_err(|msg| public_api_error(msg))?;

    // Bind the license code to the relay_id, unless this is a Renewal (same relay
    // re-enrolling with the same code after cache loss — binding already exists).
    if let (Some(store), Some(code), Some(action)) = (
        &state.license_store,
        license_code.as_deref(),
        &enrollment_action,
    ) {
        if *action == licenses::LicenseEnrollmentAction::Fresh {
            // Clear any expired/revoked binding for this relay so the UNIQUE
            // constraint doesn't block re-licensing after expiry/revocation.
            if let Some(ref existing_id) = existing_relay_id {
                let _ = store
                    .clear_expired_or_revoked_binding(existing_id, code)
                    .await;
            }
            if let Err(msg) = store.redeem(code, &response.relay_id).await {
                // Enrollment already replaced the relay's registration (new refresh
                // token). On redeem failure we must not leave the relay with a token
                // the client never received:
                //   - existing relay (had a registration): restore its previous
                //     registration so the client's originally-cached token still works.
                //   - brand-new relay (no prior registration): delete what we created,
                //     keyed by this request's refresh token (safe no-op if replaced).
                // Both are safe because we hold the per-identity enrollment lock.
                match previous_registration {
                    Some(previous) => {
                        control_plane.restore_relay_registration(previous).await;
                    }
                    None => {
                        control_plane
                            .rollback_relay_enrollment_by_token(&response.relay_refresh_token)
                            .await;
                    }
                }
                return Err(public_api_error(msg));
            }
        }
    }

    Ok(Json(response))
}

async fn public_issue_relay_ws_token(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<RelayWsTokenRequest>,
) -> Result<Json<RelayWsTokenResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "relay_ws_token").await?;

    // Authenticate first so an unauthenticated caller cannot probe relay IDs to
    // learn which relays have active/expired/revoked licenses (F3).
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    match control_plane
        .issue_relay_ws_token(bearer, input.clone())
        .await
    {
        Ok(response) => {
            // License check after successful authentication: deny the token if the
            // relay's license has expired or been revoked, or if the store is
            // required but unavailable (fail closed).
            if state.license_required {
                match &state.license_store {
                    None => {
                        return Err(public_api_error(
                            "license service unavailable; try again later".to_string(),
                        ));
                    }
                    Some(store) => {
                        store
                            .check_relay_access(&response.relay_id)
                            .await
                            .map_err(|msg| public_api_error(msg))?;
                    }
                }
            }
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
    // Authenticate the relay BEFORE consulting license state, so an unauthenticated
    // caller cannot probe which relays have active/expired/revoked licenses (the
    // license lookup below returns a distinguishable 400 vs. the auth 401).
    control_plane
        .authenticate_relay_bearer(bearer, &input.relay_id, &input.broker_room_id)
        .await
        .map_err(public_api_error)?;
    // Resolve the per-license device cap (and gate on license validity). `None` =
    // uncapped (licensing disabled, or no cap set for this license).
    let device_limit = resolve_device_limit(&state, &input.relay_id).await?;
    control_plane
        .issue_device_grant(bearer, input, device_limit)
        .await
        .map(Json)
        .map_err(device_grant_error)
}

/// Map a device-grant error. The per-license cap becomes a machine-readable
/// `device_limit_reached` (403) so the relay and UI can distinguish it from a
/// generic failure and show "remove a device"; everything else uses the standard
/// mapping.
fn device_grant_error(error: String) -> (StatusCode, Json<ApiErrorBody>) {
    if error.starts_with(DEVICE_LIMIT_REACHED_ERROR_PREFIX) {
        return (
            StatusCode::FORBIDDEN,
            Json(ApiErrorBody {
                error: "device_limit_reached",
                message: error,
            }),
        );
    }
    public_api_error(error)
}

/// Authorize a device grant against the relay's license and resolve its cap.
///
/// - Licensing disabled → `None` (uncapped; self-hosted/trusted mode).
/// - Licensing required but the store is unavailable → fail CLOSED with an error,
///   matching the ws-token / enrollment posture (else "DB down" would silently
///   grant unlimited devices).
/// - Licensing required → the relay's license must be present, unexpired, and
///   unrevoked (`check_relay_access`); otherwise the grant is denied. This closes
///   the gap where a relay with no valid/bound license resolved to "unlimited",
///   and disambiguates "no license row" from "license with a NULL limit".
/// - Passing that gate → the license's configured limit (`None` = unlimited).
async fn resolve_device_limit(
    state: &BrokerAppState,
    relay_id: &str,
) -> Result<Option<u32>, (StatusCode, Json<ApiErrorBody>)> {
    if !state.license_required {
        return Ok(None);
    }
    let Some(store) = &state.license_store else {
        return Err(public_api_error(
            "license service unavailable; try again later".to_string(),
        ));
    };
    // Gate first: a relay without a valid, bound license may not add devices.
    store
        .check_relay_access(relay_id)
        .await
        .map_err(public_api_error)?;
    store
        .device_limit_for_relay(relay_id)
        .await
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

async fn public_issue_device_session_scoped(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    Path(room): Path<String>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<DeviceSessionResponse>), (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "device_session").await?;
    let control_plane = require_public_control_plane(&state)?;
    validate_room_id(&room)?;
    let bearer = bearer_token(&headers)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::SET_COOKIE,
        build_device_session_cookie_for_room(&room, bearer, request_uses_https(&headers, None))?,
    );
    control_plane
        .issue_device_session_scoped(bearer, &room)
        .await
        .map(|response| (response_headers, Json(response)))
        .map_err(public_api_error)
}

async fn public_clear_device_session_scoped(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    Path(room): Path<String>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<DeviceSessionClearResponse>), (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "clear_device_session").await?;
    let control_plane = require_public_control_plane(&state)?;
    validate_room_id(&room)?;
    let secure = request_uses_https(&headers, None);
    let mut response_headers = HeaderMap::new();
    response_headers.append(
        header::SET_COOKIE,
        clear_device_session_cookie_for_room(&room, secure),
    );
    if let Some(legacy) = device_session_cookie(&headers) {
        match control_plane
            .device_refresh_token_matches_room(legacy, &room)
            .await
        {
            Ok(true) => {
                response_headers.append(header::SET_COOKIE, clear_device_session_cookie(secure));
            }
            Ok(false) => {}
            Err(error) => {
                warn!(
                    %error,
                    room = %room,
                    "failed to match legacy device session cookie during scoped clear; clearing scoped cookie only"
                );
            }
        }
    }
    Ok((
        response_headers,
        Json(DeviceSessionClearResponse { cleared: true }),
    ))
}

async fn public_issue_device_ws_token_scoped(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    Path(room): Path<String>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<DeviceWsTokenResponse>), (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "device_ws_token").await?;
    let control_plane = require_public_control_plane(&state)?;
    validate_room_id(&room)?;
    let (source, bearer) = device_refresh_token_scoped(&headers, &room)?;
    let secure = request_uses_https(&headers, None);
    match control_plane
        .issue_device_ws_token_scoped(bearer, &room)
        .await
    {
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
            // Refresh (slide) this relay's per-room cookie. `append` (not `insert`)
            // so the optional legacy-clear below is a second Set-Cookie, not an
            // overwrite.
            let mut response_headers = HeaderMap::new();
            response_headers.append(
                header::SET_COOKIE,
                build_device_session_cookie_for_room(&room, bearer, secure)?,
            );
            if matches!(source, DeviceTokenSource::Legacy) {
                // Upgrade-on-use: this device authenticated via the old origin-wide
                // cookie. We just set its per-room replacement, so delete the legacy
                // one. (Only reached when the legacy token's grant matches `room`.)
                response_headers.append(header::SET_COOKIE, clear_device_session_cookie(secure));
            }
            Ok((response_headers, Json(response)))
        }
        Err(error) => {
            state
                .public_monitoring
                .record_refresh_failure(RefreshChainKind::DeviceWsToken, bearer, &error)
                .await;
            // No Set-Cookie on failure: a room mismatch must NOT clear the legacy
            // cookie, since a sibling relay may still need it to migrate.
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
        match state
            .broker
            .join(
                &channel_id,
                &candidate,
                query.role,
                verified_join.device_id.clone(),
            )
            .await
        {
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
        protocol_version: BROKER_PROTOCOL_VERSION,
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
                            Ok(ClientMessage::Publish { protocol_version, payload }) => {
                                if protocol_version != BROKER_PROTOCOL_VERSION {
                                    let _ = send_message(
                                        &mut sender,
                                        &ServerMessage::Error {
                                            code: "unsupported_protocol_version".to_string(),
                                            message: format!(
                                                "unsupported broker protocol_version {protocol_version}; supported version is {BROKER_PROTOCOL_VERSION}"
                                            ),
                                        },
                                    )
                                    .await;
                                    break;
                                }
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
                                    continue;
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
                                debug!(channel_id, peer_id, %error, "rejecting invalid client frame");
                                let _ = send_message(
                                    &mut sender,
                                    &ServerMessage::Error {
                                        code: "invalid_client_frame".to_string(),
                                        message: format!("invalid broker client frame: {error}"),
                                    },
                                )
                                .await;
                                break;
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
    if let Some(web_root) = std::env::var(BROKER_WEB_ROOT_ENV)
        .ok()
        .and_then(|value| trimmed_option_string(Some(value)))
    {
        return PathBuf::from(web_root);
    }

    let container_web_root = PathBuf::from("/app/web");
    if container_web_root.join("remote.html").exists() {
        return container_web_root;
    }

    workspace_root()
        .map(|root| root.join("web"))
        .unwrap_or_else(|| PathBuf::from("web"))
}

fn workspace_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .ok()
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

/// Where a room-scoped device request's credential came from. `Legacy` triggers
/// the upgrade-on-use path (replace the old origin-wide cookie with a per-room one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeviceTokenSource {
    PerRoom,
    Bearer,
    Legacy,
}

/// Resolve the device refresh token for a room-scoped request, preferring an
/// explicit bearer, then the per-room cookie, then the legacy origin-wide cookie
/// (for not-yet-migrated devices). The `room`-scoped ws-token handler then
/// verifies the resolved grant actually belongs to `room`.
fn device_refresh_token_scoped<'a>(
    headers: &'a HeaderMap,
    room: &str,
) -> Result<(DeviceTokenSource, &'a str), (StatusCode, Json<ApiErrorBody>)> {
    // An explicit Authorization bearer wins over any cookie: the client only sends
    // one when it deliberately wants that token used (the establish-failed fallback
    // during pairing), and a stale per-room cookie must not mask it. In normal
    // cookie-mode operation no bearer is sent, so the per-room cookie is used.
    if let Ok(bearer) = bearer_token(headers) {
        return Ok((DeviceTokenSource::Bearer, bearer));
    }
    if let Some(cookie) = device_session_cookie_for_room(headers, room) {
        return Ok((DeviceTokenSource::PerRoom, cookie));
    }
    if let Some(cookie) = device_session_cookie(headers) {
        return Ok((DeviceTokenSource::Legacy, cookie));
    }
    Err((
        StatusCode::UNAUTHORIZED,
        Json(ApiErrorBody {
            error: "unauthorized",
            message: "missing bearer token".to_string(),
        }),
    ))
}

/// Validate a room id coming from the request URL. Static registrations accept
/// arbitrary non-empty broker_room_id values, so the scoped endpoint must not
/// narrow support to a cookie-name-safe subset. The raw room is only used for the
/// control-plane lookup; cookie names are derived from `sha256(room)` and use a
/// fixed path, so slashes, dots, and other static ids do not degrade to the
/// origin-wide legacy cookie.
fn validate_room_id(room: &str) -> Result<(), (StatusCode, Json<ApiErrorBody>)> {
    let ok = !room.is_empty()
        && room.len() <= DEVICE_SESSION_ROOM_MAX_BYTES
        && !room.chars().any(char::is_control);
    if ok {
        Ok(())
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            Json(ApiErrorBody {
                error: "bad_request",
                message: "invalid room".to_string(),
            }),
        ))
    }
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

/// Per-room device cookie name. A distinct name (not just a distinct Path)
/// avoids same-name collisions in `named_cookie` during the legacy→per-room
/// migration window. The room is hashed so every non-empty static broker_room_id
/// can remain scoped without embedding raw path/header-sensitive text in the
/// cookie name.
fn device_session_cookie_name(room: &str) -> String {
    format!("{DEVICE_SESSION_COOKIE_NAME}_{}", sha256_hex(room))
}

/// Per-room device cookies use a fixed path and room-derived names. Browsers may
/// send multiple room cookies on sibling device endpoints, but `named_cookie`
/// selects only the hash-derived name for the requested room.
fn device_session_path() -> &'static str {
    DEVICE_SCOPED_SESSION_COOKIE_PATH
}

fn build_device_session_cookie_for_room(
    room: &str,
    refresh_token: &str,
    secure: bool,
) -> Result<HeaderValue, (StatusCode, Json<ApiErrorBody>)> {
    build_session_cookie(
        &device_session_cookie_name(room),
        refresh_token,
        device_session_path(),
        secure,
        "device session cookie could not be created",
    )
}

fn clear_device_session_cookie_for_room(room: &str, secure: bool) -> HeaderValue {
    clear_session_cookie(
        &device_session_cookie_name(room),
        device_session_path(),
        secure,
    )
}

fn device_session_cookie_for_room<'a>(headers: &'a HeaderMap, room: &str) -> Option<&'a str> {
    named_cookie(headers, &device_session_cookie_name(room))
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
