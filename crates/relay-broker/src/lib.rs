pub mod access;
pub mod auth;
pub mod blocklist;
pub mod events;
pub mod join_ticket;
pub mod licenses;
pub mod protocol;
pub mod public_control;
mod state;

pub use access::{
    AccessDenial, AccessDenialCode, AccessOperation, AccessRequestContext, BrokerAccessStrategy,
    DeviceAccessDecision, EnrollmentBindDecision, LicenseStoreAccessAdapter, OpenAccessStrategy,
    UnavailableAccessStrategy,
};
pub use auth::BrokerAuthMode;
pub use blocklist::{Blocklist, BANNED_IPS_POSTGRES_URL_ENV};
pub use events::{
    usage_event_sink_from_env, FileUsageEventSink, PostgresUsageEventSink, UsageEvent,
    UsageEventKind, UsageEventSink, USAGE_EVENTS_PATH_ENV, USAGE_EVENTS_POSTGRES_URL_ENV,
};
pub use public_control::PUBLIC_ISSUER_SECRET_ENV;
pub use state::BrokerState;

use std::path::PathBuf;
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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
    AccessReleaseRequest, AccessReleaseResponse, ClientClaimRequest, ClientClaimResponse,
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
/// Publish allowance for a surface peer: a browser tab sending user-driven actions.
const DEFAULT_PUBLISH_RATE_LIMIT_PER_MINUTE: usize = 240;
/// Publish allowance for a relay peer, which is first-party and not traffic-shaped by
/// this limiter.
///
/// Derived from what a relay can legitimately emit rather than guessed. Transcript
/// deltas drain on a 100ms timer and publish one frame each, up to
/// `MAX_DELTAS_PER_DRAIN = 50` per drain — 500 a second — and every watched thread
/// streams at once, so a busy relay is nowhere near a surface's 4-a-second budget.
///
/// Going over is silent: the broker drops the frame and keeps the socket open. A
/// dropped transcript delta the client can repair (it notices the gap and refetches);
/// a dropped chunk it cannot, and costs a full action timeout. So for a relay this
/// limit is a runaway backstop, not a shaper — it must sit above the SUM of what real
/// traffic produces, not merely above its largest component: deltas at 500/s, a chunked
/// reply at 20/s, and snapshots at 2/s together already exceed the delta bound alone.
/// Surfaces, which are the actual abuse surface, keep the tight budget above.
///
/// Crossing it is no longer silent: the relay treats a dropped publish as fatal and
/// reconnects. So this number decides how often that costs a reconnect — set it below
/// real traffic and the relay will flap, because the broker's window is keyed by peer
/// and does not reset when the relay reconnects into it.
///
/// What it does NOT bound is bytes — see [`DEFAULT_RELAY_PUBLISH_BYTES_PER_MINUTE`] for
/// the budget that does. The two are complementary: this one stops a peer spinning on
/// tiny frames, that one stops a peer moving gigabytes in a handful of large ones.
const DEFAULT_RELAY_PUBLISH_RATE_LIMIT_PER_MINUTE: usize = 36_000;

/// Byte allowance for a surface peer, per minute.
///
/// A surface's frame budget already caps it at 240 frames of at most 64KiB, i.e. ~15MiB
/// a minute. This sits below that so the byte dimension is a real constraint rather than
/// arithmetic that can never bind, and far above what a surface actually sends: user
/// actions and pairing envelopes are single-digit KiB.
const DEFAULT_PUBLISH_BYTES_PER_MINUTE: usize = 8 * 1024 * 1024;
/// Burst allowance for a surface peer — see [`DEFAULT_RELAY_PUBLISH_BURST_BYTES`].
const DEFAULT_PUBLISH_BURST_BYTES: usize = 2 * 1024 * 1024;

/// Byte allowance for a relay peer, per minute. The bandwidth counterpart to
/// [`DEFAULT_RELAY_PUBLISH_RATE_LIMIT_PER_MINUTE`], and like it a runaway backstop
/// rather than a shaper.
///
/// Derived from what a relay legitimately emits, not guessed — and bounded at the **wire**,
/// because that is what this budget charges.
///
/// The dominant stream is a chunked action reply. Do **not** size it from
/// `REMOTE_ACTION_RESULT_CHUNK_TARGET_CHARS` (32KiB): that is a *payload* target, and the
/// frame carrying it is bigger — an encrypted chunk still costs one base64 expansion over
/// its ciphertext. Two revisions of this constant were sized off the payload target and
/// understated real traffic.
///
/// The robust bound ignores the encoding entirely: the relay's chunk builders shrink the
/// chunk until `frame_bytes_for_payload(..) <= MAX_BROKER_TEXT_FRAME_BYTES`, so a chunk
/// frame **cannot exceed the frame cap**, whatever encoding layers sit inside it. That
/// makes the ceiling `max_text_frame_bytes` x the publish cadence:
///
/// - chunked reply: 64KiB every `REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS`
///   (50ms) → 20/s → **75MiB/min**, an upper bound rather than an estimate
/// - transcript deltas drain on a 100ms timer, `MAX_DELTAS_PER_DRAIN = 50` a drain
/// - session snapshots at ~2/s
///
/// **The 20/s rests on the relay pacing across train *boundaries*, not just within a
/// train.** It did not, once: a finished train left the next one's first chunk due
/// immediately, so back-to-back replies went out at 40/s and this ceiling was half the
/// truth. `relay-server`'s `pacing_holds_across_train_boundaries` is what keeps it honest.
///
/// So a busy relay tops out near 75MiB a minute on the chunk train alone. This is ~6.8x
/// that. Two tests pin it: `the_default_relay_byte_budget_sits_well_above_real_traffic`
/// here, computed from this broker's own frame cap, and — authoritatively —
/// `this_relays_publish_cadence_stays_inside_the_brokers_byte_budget` in `relay-server`,
/// which reads the *real* cadence constant so speeding the relay up fails the build rather
/// than silently eating the margin.
///
/// The headroom is the point: being refused is **not** backpressure for a relay —
/// `relay-server`'s `rate_limited` arm ends the session and resyncs — so a budget set near
/// real traffic is a reconnect loop, and each reconnect resyncs a full snapshot and spends
/// *more* bandwidth than it saved. Set this above what real traffic can reach; it exists to
/// bound a runaway, and 512MiB/min is still ~4.4x tighter than the 2.2GiB/min the frame
/// allowance alone permits.
///
/// `0` disables the byte budget entirely — an escape hatch if it ever misfires in
/// production, since the failure mode is a flapping relay rather than a slow one.
///
/// `pub` so relay-server can assert its own publish cadence against it — the two crates
/// have to agree, and the authoritative check lives where the real cadence constants are.
pub const DEFAULT_RELAY_PUBLISH_BYTES_PER_MINUTE: usize = 512 * 1024 * 1024;
/// Burst allowance for a relay peer: how much it may publish back-to-back after being
/// idle, independent of the per-minute rate.
///
/// A rate alone would refuse the first large reply after a quiet period, which is exactly
/// when one is most likely (a surface opens a tab and asks for a workspace diff). 16MiB
/// swallows a ~4MiB diff whole with room to spare.
const DEFAULT_RELAY_PUBLISH_BURST_BYTES: usize = 16 * 1024 * 1024;

/// Egress in a single minute, measured **after** fan-out, above which the broker warns.
///
/// Observation only — crossing it never refuses a frame. Refusing on a *global* condition
/// would punish a peer for its neighbours' traffic, and for a relay that means a session
/// teardown whose resync adds egress: the control would amplify the overload it fired on.
/// So this counts and warns, and the number it produces is what a future enforcement
/// decision should be based on.
const GLOBAL_EGRESS_WARN_BYTES_PER_MINUTE: u64 = 2 * 1024 * 1024 * 1024;

/// Bucket count past which [`ByteRateLimiter::charge`] prunes settled entries, so the map
/// does not grow without bound across churning peers. Amortised: pruning is O(n) but only
/// runs once the map is already large.
const BYTE_BUCKET_PRUNE_THRESHOLD: usize = 1_024;
const DEFAULT_MAX_CONNECTIONS_PER_IP: usize = 24;
const DEFAULT_MAX_TEXT_FRAME_BYTES: usize = 64 * 1024;
/// Floor under [`BrokerHardeningConfig::max_text_frame_bytes`].
///
/// relay-server fits every chunk against a **fixed** `MAX_BROKER_TEXT_FRAME_BYTES` compiled
/// into its binary; it never learns what this broker was configured with. A cap below that
/// therefore does not shrink relay frames, it rejects them — and the broker closes the
/// socket on `frame_too_large`, so the relay reconnects, replays the same cached result and
/// fails identically. One hardening knob would make large replies permanently
/// undeliverable.
///
/// `pub` so relay-server can assert its own fixed size still fits (see
/// `this_relays_frame_size_fits_the_brokers_guaranteed_minimum`).
pub const MIN_MAX_TEXT_FRAME_BYTES: usize = 64 * 1024;
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 120;
const DEVICE_SESSION_COOKIE_NAME: &str = "agent_relay_device_session";
const DEVICE_SCOPED_SESSION_COOKIE_PATH: &str = "/api/public/device";
const DEVICE_SESSION_ROOM_MAX_BYTES: usize = 512;
const CLIENT_SESSION_COOKIE_NAME: &str = "agent_relay_client_session";
const DEVICE_SESSION_COOKIE_MAX_AGE_SECS: u64 = 60 * 60 * 24 * 400;
const PUBLIC_API_RATE_LIMIT_ENV: &str = "RELAY_BROKER_PUBLIC_API_RATE_LIMIT_PER_MINUTE";
const JOIN_RATE_LIMIT_ENV: &str = "RELAY_BROKER_JOIN_RATE_LIMIT_PER_MINUTE";
const PUBLISH_RATE_LIMIT_ENV: &str = "RELAY_BROKER_PUBLISH_RATE_LIMIT_PER_MINUTE";
const RELAY_PUBLISH_RATE_LIMIT_ENV: &str = "RELAY_BROKER_RELAY_PUBLISH_RATE_LIMIT_PER_MINUTE";
const PUBLISH_BYTES_ENV: &str = "RELAY_BROKER_PUBLISH_BYTES_PER_MINUTE";
const RELAY_PUBLISH_BYTES_ENV: &str = "RELAY_BROKER_RELAY_PUBLISH_BYTES_PER_MINUTE";
const PUBLISH_BURST_BYTES_ENV: &str = "RELAY_BROKER_PUBLISH_BURST_BYTES";
const RELAY_PUBLISH_BURST_BYTES_ENV: &str = "RELAY_BROKER_RELAY_PUBLISH_BURST_BYTES";
const MAX_CONNECTIONS_PER_IP_ENV: &str = "RELAY_BROKER_MAX_CONNECTIONS_PER_IP";
const MAX_TEXT_FRAME_BYTES_ENV: &str = "RELAY_BROKER_MAX_TEXT_FRAME_BYTES";
const IDLE_TIMEOUT_SECS_ENV: &str = "RELAY_BROKER_IDLE_TIMEOUT_SECS";
const CSP_CONNECT_SRC_ENV: &str = "RELAY_BROKER_CSP_CONNECT_SRC";
const ENABLE_HSTS_ENV: &str = "RELAY_BROKER_ENABLE_HSTS";
const HSTS_VALUE_ENV: &str = "RELAY_BROKER_HSTS_VALUE";
const BROKER_WEB_ROOT_ENV: &str = "RELAY_BROKER_WEB_ROOT";

pub async fn app(state: BrokerState) -> Router {
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
    let access =
        LicenseStoreAccessAdapter::from_public_env(license_store.clone(), license_required);
    app_with_access_strategy_parts(
        state,
        default_web_root(),
        BrokerJoinVerifier::from_env().await,
        BrokerHardeningConfig::from_env().unwrap_or_else(|error| {
            warn!(%error, "invalid broker hardening config; using safe defaults");
            BrokerHardeningConfig::default()
        }),
        security_headers_from_env().unwrap_or_else(|error| {
            warn!(%error, "invalid broker security header config; HSTS will stay disabled");
            SecurityHeadersConfig::default()
        }),
        access,
        // Admin attribution still reads the temporary license store directly.
        license_store,
        admin_token_from_env(),
    )
    .layer(middleware::from_fn_with_state(ban_guard, reject_banned_ips))
}

/// Build the broker HTTP app with a caller-injected access strategy.
///
/// Private deployments use this to supply their access policy without the public
/// broker knowing product tiers. The standard [`app`] entry builds the temporary
/// license adapter (or open/fail-closed defaults) from environment instead.
///
/// This entry follows the same auth-mode defaults as [`app`] (including
/// self-hosted). Deployments that must never listen without a validated public
/// control plane should use [`app_with_access_strategy_required_public`] or
/// [`app_with_access_strategy_and_public_control`] instead.
pub async fn app_with_access_strategy(
    state: BrokerState,
    access: Arc<dyn BrokerAccessStrategy>,
) -> Router {
    let ban_guard = BanGuard::from_env().await;
    app_with_access_strategy_parts(
        state,
        default_web_root(),
        BrokerJoinVerifier::from_env().await,
        BrokerHardeningConfig::from_env().unwrap_or_else(|error| {
            warn!(%error, "invalid broker hardening config; using safe defaults");
            BrokerHardeningConfig::default()
        }),
        security_headers_from_env().unwrap_or_else(|error| {
            warn!(%error, "invalid broker security header config; HSTS will stay disabled");
            SecurityHeadersConfig::default()
        }),
        access,
        None,
        admin_token_from_env(),
    )
    .layer(middleware::from_fn_with_state(ban_guard, reject_banned_ips))
}

/// Build a broker app that requires a successfully constructed public control
/// plane. Fails closed (no router) when auth mode is not `public` or when
/// issuer/persistence config cannot build a control plane.
///
/// Prefer resolving the plane once with [`required_public_control_plane_from_env`]
/// and passing it to [`app_with_access_strategy_and_public_control`] when startup
/// must validate public control before other I/O.
///
/// Open/self-host callers must keep using [`app_with_access_strategy`].
pub async fn app_with_access_strategy_required_public(
    state: BrokerState,
    access: Arc<dyn BrokerAccessStrategy>,
) -> Result<Router, String> {
    let control_plane = required_public_control_plane_from_env().await?;
    Ok(app_with_access_strategy_and_public_control(state, access, control_plane).await)
}

/// Build a broker app from an already-validated [`PublicControlPlane`].
/// Product-neutral: no license/tier wording. Does not re-read auth env.
pub async fn app_with_access_strategy_and_public_control(
    state: BrokerState,
    access: Arc<dyn BrokerAccessStrategy>,
    control_plane: PublicControlPlane,
) -> Router {
    let ban_guard = BanGuard::from_env().await;
    app_with_access_strategy_parts(
        state,
        default_web_root(),
        BrokerJoinVerifier::PublicControlPlane(control_plane),
        BrokerHardeningConfig::from_env().unwrap_or_else(|error| {
            warn!(%error, "invalid broker hardening config; using safe defaults");
            BrokerHardeningConfig::default()
        }),
        security_headers_from_env().unwrap_or_else(|error| {
            warn!(%error, "invalid broker security header config; HSTS will stay disabled");
            SecurityHeadersConfig::default()
        }),
        access,
        None,
        admin_token_from_env(),
    )
    .layer(middleware::from_fn_with_state(ban_guard, reject_banned_ips))
}

/// Fail closed unless auth mode is explicitly `public` (no I/O).
pub fn require_public_auth_mode_from_env() -> Result<(), String> {
    match BrokerAuthMode::from_env()? {
        BrokerAuthMode::PublicControlPlane => Ok(()),
        BrokerAuthMode::SelfHostedSharedSecret => Err(
            "public control plane is required (set RELAY_BROKER_AUTH_MODE=public with a valid issuer/persistence config)"
                .to_string(),
        ),
    }
}

/// Resolve a public control plane for deployments that must not fall back to
/// self-host/open join verification. Product-neutral: no license/tier wording.
pub async fn required_public_control_plane_from_env() -> Result<PublicControlPlane, String> {
    require_public_auth_mode_from_env()?;
    PublicControlPlane::from_env()
        .await
        .map_err(|error| format!("public control plane is required but invalid: {error}"))
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
    /// Injected access policy (open / fail-closed / license adapter / private).
    access: Arc<dyn BrokerAccessStrategy>,
    /// Temporary: license store kept for admin attribution enrichment only.
    /// Gate decisions go through [`Self::access`]. Round 2 can drop this.
    license_store: Option<licenses::LicenseStore>,
    /// Per-verify-key locks that serialize relay enrollment completion so that
    /// enroll + access-bind is one atomic transition for a given identity.
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
    kind: JoinTicketKind,
    peer_id: Option<String>,
    device_id: Option<String>,
    pairing_id: Option<String>,
}

#[derive(Clone)]
struct BrokerHardeningState {
    config: BrokerHardeningConfig,
    rate_limiter: SlidingWindowRateLimiter,
    byte_limiter: ByteRateLimiter,
    publish_metrics: PublishMetrics,
    connection_tracker: ActiveConnectionTracker,
}

#[derive(Clone, Debug)]
struct BrokerHardeningConfig {
    public_api_rate_limit_per_minute: usize,
    join_rate_limit_per_minute: usize,
    publish_rate_limit_per_minute: usize,
    relay_publish_rate_limit_per_minute: usize,
    publish_bytes_per_minute: usize,
    relay_publish_bytes_per_minute: usize,
    publish_burst_bytes: usize,
    relay_publish_burst_bytes: usize,
    max_connections_per_ip: usize,
    max_text_frame_bytes: usize,
    idle_timeout: Duration,
}

/// A peer's byte allowance: a sustained rate plus an independent burst.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ByteBudget {
    bytes_per_minute: usize,
    burst_bytes: usize,
}

impl ByteBudget {
    /// `0` bytes/minute switches the budget off (see
    /// [`DEFAULT_RELAY_PUBLISH_BYTES_PER_MINUTE`]).
    fn is_disabled(self) -> bool {
        self.bytes_per_minute == 0
    }

    fn bytes_per_second(self) -> f64 {
        self.bytes_per_minute as f64 / RATE_LIMIT_WINDOW_SECS as f64
    }
}

#[derive(Clone, Default)]
struct SlidingWindowRateLimiter {
    buckets: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
}

/// Per-peer token bucket over published **bytes**.
///
/// Keyed the same way as [`SlidingWindowRateLimiter`] — `(channel, peer)` on shared broker
/// state rather than on the connection — so a reconnect resumes the same bucket. That is
/// load-bearing, not incidental: a relay that gets refused reconnects automatically, so a
/// per-connection bucket would reset itself precisely when it is doing its job.
#[derive(Clone, Default)]
struct ByteRateLimiter {
    buckets: Arc<Mutex<HashMap<String, ByteBucket>>>,
}

struct ByteBucket {
    /// Bytes currently available to spend.
    tokens: f64,
    last_refill: Instant,
    /// When this bucket will have refilled to its burst ceiling. A bucket at or past
    /// this instant is indistinguishable from a brand new one, so it is safe to prune.
    /// Stored per bucket rather than recomputed, because one map holds peers of
    /// different roles and therefore different budgets.
    full_at: Instant,
}

/// Counters behind the publish allowances, so an operator can see the limits working
/// (or misfiring) instead of inferring it from logs.
///
/// Deliberately a **blocking** mutex, not the async one: egress is recorded on every
/// outbound frame, and the critical section is a handful of integer adds. An async lock
/// there would put an await point — and so a possible yield — on the socket write path,
/// which on this broker is the path a heartbeat ping shares. Anything that can delay a
/// ping is a session-killer. The lock is never held across an await.
#[derive(Clone, Default)]
struct PublishMetrics {
    inner: Arc<StdMutex<PublishMetricsInner>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
struct PublishMetricsSnapshot {
    /// Frames refused by the frame-count allowance.
    frame_limit_exceeded: u64,
    /// Frames refused by the byte allowance.
    byte_limit_exceeded: u64,
    /// Inbound bytes accepted for publishing.
    published_bytes: u64,
    /// `ServerMessage` bytes written to client sockets — welcomes, presence, messages and
    /// errors, including the error sent to a rejected join.
    ///
    /// Exact within that scope, and inherently after fan-out: each recipient's own write is
    /// counted where its real serialized length is known. The scope deliberately excludes
    /// WebSocket **control** frames (ping/pong), which carry no application payload and are
    /// a fixed few bytes; this counts what the broker was asked to deliver, not raw socket
    /// throughput.
    egress_bytes: u64,
    /// Highest egress observed in any single completed minute.
    peak_egress_bytes_per_minute: u64,
    /// Minutes whose egress crossed [`GLOBAL_EGRESS_WARN_BYTES_PER_MINUTE`].
    global_egress_warnings: u64,
}

#[derive(Default)]
struct PublishMetricsInner {
    snapshot: PublishMetricsSnapshot,
    egress_window_bytes: u64,
    egress_window_started: Option<Instant>,
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
            relay_publish_rate_limit_per_minute: DEFAULT_RELAY_PUBLISH_RATE_LIMIT_PER_MINUTE,
            publish_bytes_per_minute: DEFAULT_PUBLISH_BYTES_PER_MINUTE,
            relay_publish_bytes_per_minute: DEFAULT_RELAY_PUBLISH_BYTES_PER_MINUTE,
            publish_burst_bytes: DEFAULT_PUBLISH_BURST_BYTES,
            relay_publish_burst_bytes: DEFAULT_RELAY_PUBLISH_BURST_BYTES,
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
            relay_publish_rate_limit_per_minute: relay_publish_rate_limit_from_env()?,
            publish_bytes_per_minute: parse_usize_env(
                PUBLISH_BYTES_ENV,
                DEFAULT_PUBLISH_BYTES_PER_MINUTE,
            )?,
            relay_publish_bytes_per_minute: relay_publish_bytes_from_env()?,
            publish_burst_bytes: parse_usize_env(
                PUBLISH_BURST_BYTES_ENV,
                DEFAULT_PUBLISH_BURST_BYTES,
            )?,
            relay_publish_burst_bytes: relay_publish_burst_bytes_from_env()?,
            max_connections_per_ip: parse_usize_env(
                MAX_CONNECTIONS_PER_IP_ENV,
                DEFAULT_MAX_CONNECTIONS_PER_IP,
            )?,
            max_text_frame_bytes: {
                let configured =
                    parse_usize_env(MAX_TEXT_FRAME_BYTES_ENV, DEFAULT_MAX_TEXT_FRAME_BYTES)?;
                if configured < MIN_MAX_TEXT_FRAME_BYTES {
                    warn!(
                        configured,
                        effective = MIN_MAX_TEXT_FRAME_BYTES,
                        "{MAX_TEXT_FRAME_BYTES_ENV} is below the size a relay is compiled to \
                         emit; raising it. A smaller cap does not shrink relay frames, it \
                         rejects them, and the reconnect replays the same reply."
                    );
                }
                configured
            },
            idle_timeout: Duration::from_secs(parse_u64_env(
                IDLE_TIMEOUT_SECS_ENV,
                DEFAULT_IDLE_TIMEOUT_SECS,
            )?),
        })
    }
}

impl BrokerHardeningConfig {
    /// The frame allowance for `role`.
    fn frame_limit(&self, role: protocol::PeerRole) -> usize {
        match role {
            protocol::PeerRole::Relay => self.relay_publish_rate_limit_per_minute,
            protocol::PeerRole::Surface => self.publish_rate_limit_per_minute,
        }
    }

    /// The largest client frame the broker will accept.
    ///
    /// Never below [`MIN_MAX_TEXT_FRAME_BYTES`]: a relay cannot negotiate this value, so a
    /// smaller one rejects frames it is compiled to produce rather than making it produce
    /// smaller ones. Raised rather than refused at startup, matching the publish burst
    /// floor — a misconfigured limit should throttle, never brick.
    fn max_text_frame_bytes(&self) -> usize {
        self.max_text_frame_bytes.max(MIN_MAX_TEXT_FRAME_BYTES)
    }

    /// The byte allowance for `role`.
    ///
    /// The burst floor is not cosmetic: a burst below `max_text_frame_bytes` would refuse
    /// frames the broker's own frame cap accepts, and refuse them *forever*, since the
    /// bucket can never hold enough to pay for one. A misconfigured burst would brick
    /// publishing rather than throttle it, so it is raised to the frame cap instead.
    fn byte_budget(&self, role: protocol::PeerRole) -> ByteBudget {
        let (bytes_per_minute, burst_bytes) = match role {
            protocol::PeerRole::Relay => (
                self.relay_publish_bytes_per_minute,
                self.relay_publish_burst_bytes,
            ),
            protocol::PeerRole::Surface => {
                (self.publish_bytes_per_minute, self.publish_burst_bytes)
            }
        };
        ByteBudget {
            bytes_per_minute,
            burst_bytes: burst_bytes.max(self.max_text_frame_bytes()),
        }
    }
}

impl ByteRateLimiter {
    /// Spend `cost` bytes from `key`'s bucket, returning whether the peer could afford it.
    ///
    /// A refused charge deducts nothing, so a peer that is over budget is not pushed
    /// further under by retrying.
    async fn charge(&self, key: String, cost: usize, budget: ByteBudget) -> bool {
        if budget.is_disabled() {
            return true;
        }
        let now = Instant::now();
        let burst = budget.burst_bytes as f64;
        let per_second = budget.bytes_per_second();

        let mut buckets = self.buckets.lock().await;
        // Prune settled buckets before inserting, so a churn of one-frame peers cannot
        // grow the map without bound. Only buckets that have refilled to full are
        // dropped: those carry no state a fresh bucket would not also have.
        if buckets.len() > BYTE_BUCKET_PRUNE_THRESHOLD {
            buckets.retain(|_, bucket| bucket.full_at > now);
        }

        let bucket = buckets.entry(key).or_insert(ByteBucket {
            tokens: burst,
            last_refill: now,
            full_at: now,
        });

        let elapsed = now
            .saturating_duration_since(bucket.last_refill)
            .as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * per_second).min(burst);
        bucket.last_refill = now;

        let affordable = bucket.tokens >= cost as f64;
        if affordable {
            bucket.tokens -= cost as f64;
        }

        // Refresh the prune deadline from the (possibly reduced) balance either way, so a
        // bucket that keeps being refused stays resident rather than being pruned into a
        // free reset.
        let deficit = (burst - bucket.tokens).max(0.0);
        let seconds_to_full = if per_second > 0.0 {
            deficit / per_second
        } else {
            0.0
        };
        bucket.full_at = now + Duration::from_secs_f64(seconds_to_full.min(u32::MAX as f64));

        affordable
    }
}

impl PublishMetrics {
    fn lock(&self) -> std::sync::MutexGuard<'_, PublishMetricsInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn record_frame_limited(&self) {
        self.lock().snapshot.frame_limit_exceeded += 1;
    }

    fn record_byte_limited(&self) {
        self.lock().snapshot.byte_limit_exceeded += 1;
    }

    fn record_published(&self, bytes: usize) {
        self.lock().snapshot.published_bytes += bytes as u64;
    }

    /// Record bytes actually written to a peer socket, into the one-minute observation
    /// window.
    ///
    /// Called once per outbound frame, from the one place that knows the real serialized
    /// length. That is what makes this figure exact rather than modelled: fan-out is
    /// counted because each recipient's own write is counted, and a frame that was never
    /// sent is never counted.
    ///
    /// Never refuses anything — see [`GLOBAL_EGRESS_WARN_BYTES_PER_MINUTE`] for why the
    /// global view is deliberately observation-only.
    fn record_egress(&self, bytes: u64) {
        let now = Instant::now();
        let mut inner = self.lock();
        inner.snapshot.egress_bytes += bytes;
        inner.close_elapsed_window(now);
        inner.egress_window_bytes += bytes;
    }

    /// Read the counters, closing an elapsed window first.
    ///
    /// Closing on read is what makes a burst-then-silence minute observable at all: if the
    /// window only rolled when the next frame arrived, the loudest minute an operator
    /// could have — a spike followed by nothing — would never reach the peak or the
    /// warning counter.
    fn snapshot(&self) -> PublishMetricsSnapshot {
        let now = Instant::now();
        let mut inner = self.lock();
        inner.close_elapsed_window(now);
        inner.snapshot
    }
}

impl PublishMetricsInner {
    /// Fold the current window into the peak and warning counters once a full minute has
    /// passed, then start a fresh one. A no-op while the minute is still running.
    fn close_elapsed_window(&mut self, now: Instant) {
        let started = *self.egress_window_started.get_or_insert(now);
        if now.saturating_duration_since(started).as_secs() < RATE_LIMIT_WINDOW_SECS {
            return;
        }
        let completed = self.egress_window_bytes;
        self.snapshot.peak_egress_bytes_per_minute =
            self.snapshot.peak_egress_bytes_per_minute.max(completed);
        if completed > GLOBAL_EGRESS_WARN_BYTES_PER_MINUTE {
            self.snapshot.global_egress_warnings += 1;
            warn!(
                egress_bytes = completed,
                warn_threshold = GLOBAL_EGRESS_WARN_BYTES_PER_MINUTE,
                "broker egress crossed the warning threshold in the last minute; \
                 this is observed, not enforced"
            );
        }
        self.egress_window_bytes = 0;
        self.egress_window_started = Some(now);
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
                kind: claims.kind,
                peer_id: claims.peer_id,
                device_id: claims.device_id,
                pairing_id: claims.pairing_id,
            }),
            Self::PublicControlPlane(control_plane) => verify_join_ticket_for_connection(
                control_plane.issuer_key(),
                join_ticket,
                broker_room_id,
                role,
            )
            .map(|claims| VerifiedBrokerJoin {
                kind: claims.kind,
                peer_id: claims.peer_id,
                device_id: claims.device_id,
                pairing_id: claims.pairing_id,
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
// access-strategy builder directly.
#[cfg(test)]
fn app_with_web_root_and_verifier_and_hardening(
    state: BrokerState,
    web_root: PathBuf,
    join_verifier: BrokerJoinVerifier,
    hardening_config: BrokerHardeningConfig,
    security_headers: SecurityHeadersConfig,
) -> Router {
    app_with_access_strategy_parts(
        state,
        web_root,
        join_verifier,
        hardening_config,
        security_headers,
        Arc::new(OpenAccessStrategy),
        None,
        None, // no admin token → /api/admin/stats not mounted
    )
}

// Test helper: wraps a license store in the temporary adapter so existing
// callers keep passing store + required while gates go through the seam.
#[cfg(test)]
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
    let access =
        LicenseStoreAccessAdapter::from_public_env(license_store.clone(), license_required);
    app_with_access_strategy_parts(
        state,
        web_root,
        join_verifier,
        hardening_config,
        security_headers,
        access,
        license_store,
        admin_token,
    )
}

fn app_with_access_strategy_parts(
    state: BrokerState,
    web_root: PathBuf,
    join_verifier: BrokerJoinVerifier,
    hardening_config: BrokerHardeningConfig,
    security_headers: SecurityHeadersConfig,
    access: Arc<dyn BrokerAccessStrategy>,
    license_store: Option<licenses::LicenseStore>,
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
            "/api/public/relay/access/release",
            post(public_release_relay_access),
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
        .route(
            "/api/public/client/claim",
            post(public_claim_client_identity),
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
                byte_limiter: ByteRateLimiter::default(),
                publish_metrics: PublishMetrics::default(),
                connection_tracker: ActiveConnectionTracker::default(),
            },
            public_monitoring: PublicMonitoringState::default(),
            access,
            license_store,
            enrollment_locks: Arc::new(StdMutex::new(HashMap::new())),
            admin_token,
        })
        .layer(middleware::from_fn_with_state(
            security_headers,
            with_security_headers,
        ))
        .layer(middleware::from_fn(with_cache_headers))
        .layer(TraceLayer::new_for_http())
}

/// Cache policy for the broker's HTTP surface (the remote/PWA UI plus the
/// control-plane API). Without this the HTML shell is served with no
/// `Cache-Control`, so browsers heuristically cache `remote.html` — which pins
/// them to the OLD content-hashed asset filenames it references, so a rebuilt
/// bundle never loads even though the broker has already redeployed (a
/// fresh/incognito profile has no cached entry, so it always looks fine — which
/// is what made this hard to notice). Mirrors `cache_control_for` in
/// `relay-server/src/main.rs`, hardened for the broker's authenticated API:
///
/// - `/api/*` is `no-store` on every status. These responses are client-specific
///   and often cookie-authenticated (e.g. `GET /api/public/relays` returns a
///   per-client relay directory). With no `Cache-Control`, a browser or shared
///   intermediary is free to store and reuse them, risking stale data or
///   cross-client disclosure. `no-store` also covers error bodies. It's a
///   security invariant, so `with_cache_headers` FORCES it — no `/api/` handler
///   can weaken it to a cacheable policy.
/// - Content-hashed bundles under `/static/assets/` are immutable; the HTML shell,
///   `sw.js`, and every other non-hashed static file always revalidate
///   (`no-cache`). This applies to a `200` AND to the `304 Not Modified` a
///   conditional request produces — RFC 9110 §15.4.5 requires the 304 to carry
///   the same `Cache-Control` the 200 would, and tower-http's ServeDir/ServeFile
///   emit 304s without one.
/// - Any other non-success static response (a `404` for a missing asset, a `5xx`)
///   is `no-store`: never `immutable` (a year-long negative cache) and never bare
///   (RFC 9110 §15.5.5 lets a bare 404 be heuristically negative-cached).
fn cache_control_for(path: &str, status: StatusCode) -> Option<&'static str> {
    if path.starts_with("/api/") {
        return Some("no-store");
    }
    // A conditional request revalidates to `304 Not Modified`; treat it exactly
    // like the success it stands in for so the policy survives revalidation.
    let cacheable = status.is_success() || status == StatusCode::NOT_MODIFIED;
    if !cacheable {
        return Some("no-store");
    }
    if path.starts_with("/static/assets/") {
        Some("public, max-age=31536000, immutable")
    } else {
        Some("no-cache")
    }
}

async fn with_cache_headers(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    if let Some(value) = cache_control_for(&path, response.status()) {
        let value = HeaderValue::from_static(value);
        if path.starts_with("/api/") {
            // Security invariant: force `no-store` so no `/api/` handler can leave
            // client-specific data cacheable, even by mistake.
            response.headers_mut().insert(header::CACHE_CONTROL, value);
        } else {
            // Static surface: leave a handler's own `Cache-Control` intact.
            response
                .headers_mut()
                .entry(header::CACHE_CONTROL)
                .or_insert(value);
        }
    }
    response
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
    /// Optional retry hint (seconds), used for access/rate-limit denials.
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_secs: Option<u64>,
    /// Set only on access-release when strategy release succeeded but public
    /// registration cleanup failed (reload-unknown / persistence). Clients use
    /// this to distinguish post-strategy cleanup failure from pre-strategy 503.
    #[serde(skip_serializing_if = "Option::is_none")]
    access_released: Option<bool>,
}

impl ApiErrorBody {
    fn new(error: &'static str, message: impl Into<String>) -> Self {
        Self {
            error,
            message: message.into(),
            retry_after_secs: None,
            access_released: None,
        }
    }

    fn with_access_released(mut self, released: bool) -> Self {
        self.access_released = Some(released);
        self
    }
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
    /// Publish-allowance counters: how often each limit fired, and how much traffic
    /// actually moved. `peak_egress_bytes_per_minute` is the number to watch before
    /// deciding whether the global egress view should ever become enforcing.
    publish_limits: PublishMetricsSnapshot,
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
                Json(ApiErrorBody::new(
                    "not_found",
                    "admin endpoint is disabled".to_string(),
                )),
            ));
        }
        AdminAuthOutcome::Unauthorized => {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(ApiErrorBody::new(
                    "unauthorized",
                    "invalid or missing admin token".to_string(),
                )),
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
        publish_limits: state.hardening.publish_metrics.snapshot(),
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

    let enrollment_token = trimmed_option_string(input.enrollment_token.clone());

    // Serialize enroll + access-bind per identity: two `/complete` calls for
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
    // the relay's original refresh credential if binding fails after enrollment
    // replaced its token. Used to:
    // (a) detect same-token re-enrollment after cache loss (AlreadyBound path),
    // (b) identify the relay_id whose expired/revoked binding to clear, and
    // (c) restore the previous credential on bind failure (else new relay → delete).
    let previous_registration: Option<RelayRegistrationSnapshot> = match &verify_key {
        Some(vk) => control_plane.snapshot_relay_registration(vk).await,
        None => None,
    };
    let existing_relay_id = previous_registration
        .as_ref()
        .map(|snap| snap.relay_id().to_string());

    // Authorize via the injected access strategy BEFORE enrollment so a denied
    // token never causes a registration to be persisted.
    let access_ctx =
        AccessRequestContext::new(remote_addr.ip(), AccessOperation::EnrollmentComplete);
    let bind_decision = state
        .access
        .authorize_enrollment(
            &access_ctx,
            enrollment_token.as_deref(),
            existing_relay_id.as_deref(),
        )
        .await
        .map_err(access_denial_error)?;

    // Enrollment — persists (or re-persists) the relay registration.
    let response = control_plane
        .complete_relay_enrollment(input)
        .await
        .map_err(|msg| public_api_error(msg))?;

    // Bind after enrollment when the strategy asked for a fresh bind step.
    if bind_decision == EnrollmentBindDecision::Bind {
        let Some(token) = enrollment_token.as_deref() else {
            // Strategy asked to bind but no token was presented — treat as a
            // programming error in the strategy and roll back enrollment.
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
            return Err(access_denial_error(AccessDenial::internal().with_internal(
                "access strategy requested bind without an enrollment token",
            )));
        };
        if let Err(denial) = state
            .access
            .bind_enrollment(
                &access_ctx,
                token,
                &response.relay_id,
                existing_relay_id.as_deref(),
            )
            .await
        {
            // Enrollment already replaced the relay's registration (new refresh
            // token). On bind failure we must not leave the relay with a token
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
            return Err(access_denial_error(denial));
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
            // Access check after successful authentication: deny the token when
            // the injected strategy refuses the relay lease (expired/revoked
            // access, fail-closed backend, or a custom deny policy).
            let access_ctx =
                AccessRequestContext::new(remote_addr.ip(), AccessOperation::RelayLease);
            state
                .access
                .authorize_relay(&access_ctx, &response.relay_id)
                .await
                .map_err(access_denial_error)?;
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

/// Tear down authenticated relay access: strategy release first, then public
/// registration/grant cleanup, then always force-close room sockets.
///
/// Ordering: rate limit → auth → same-identity lifecycle lock → re-auth →
/// `release_access` → attempt revoke/cleanup → **always** `force_close_room` →
/// return the cleanup result. Strategy denial preserves registration and live
/// sockets.
///
/// Cleanup failure returns typed unavailable. Sockets are closed either way so a
/// seated peer cannot outlive a successful strategy release. When cleanup fails
/// after a successful reload/reconcile that already removed this relay's
/// registration and scoped grants, cleanup is treated as effective success.
/// When the durable outcome is reload-unknown, the HTTP body stays a generic
/// unavailable; clients may retry the same bearer, and an Unauthorized after an
/// earlier authenticated 503 can be treated as already released (Round 3B will
/// document the client contract). Internal logs keep a redacted diagnostic.
async fn public_release_relay_access(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<AccessReleaseRequest>,
) -> Result<Json<AccessReleaseResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "relay_access_release").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;

    // Discover the opaque same-identity lock key before taking the lock.
    let first_auth = control_plane
        .authenticate_relay_access(bearer, &input.relay_id, &input.broker_room_id)
        .await
        .map_err(public_api_error)?;
    let enrollment_lock = acquire_enrollment_lock(&state, &first_auth.lifecycle_lock_key);
    let _lifecycle_guard = enrollment_lock.lock().await;

    // Re-authenticate under the lock so concurrent re-enrollment cannot rotate
    // the bearer between auth and cleanup.
    let auth = control_plane
        .authenticate_relay_access(bearer, &input.relay_id, &input.broker_room_id)
        .await
        .map_err(public_api_error)?;
    debug_assert_eq!(auth.relay_id, input.relay_id);
    debug_assert_eq!(auth.broker_room_id, input.broker_room_id);

    let access_ctx = AccessRequestContext::new(remote_addr.ip(), AccessOperation::AccessRelease);
    state
        .access
        .release_access(&access_ctx, &input.relay_id)
        .await
        .map_err(access_denial_error)?;

    // Cleanup first so a join that seats while registration still exists is
    // caught by the final force-close; a join after successful cleanup fails
    // room registration lookup.
    let cleanup_result = control_plane
        .revoke_relay_registration_chain(bearer, &input.relay_id, &input.broker_room_id)
        .await;

    let _ = state
        .broker
        .force_close_room(
            &input.broker_room_id,
            "access_released",
            "relay access was released",
        )
        .await;

    match cleanup_result {
        Ok(()) => Ok(Json(AccessReleaseResponse { released: true })),
        Err(error) => {
            // Strategy release already succeeded and sockets are closed. Signal
            // that phase so clients can commit a pending-release marker and
            // later treat matching 401 as already-released — without treating
            // a pre-strategy 503 the same way.
            let (status, Json(mut body)) =
                access_denial_error(AccessDenial::unavailable().with_internal(error));
            body = body.with_access_released(true);
            Err((status, Json(body)))
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
    // Authenticate the relay BEFORE consulting access policy, so an unauthenticated
    // caller cannot probe which relays are allowed/denied (the access lookup below
    // returns a distinguishable status vs. the auth 401).
    control_plane
        .authenticate_relay_bearer(bearer, &input.relay_id, &input.broker_room_id)
        .await
        .map_err(public_api_error)?;
    // Authorize the device grant and resolve any cap. `None` = uncapped.
    let access_ctx = AccessRequestContext::new(remote_addr.ip(), AccessOperation::DeviceGrant);
    let device_limit = state
        .access
        .authorize_device(&access_ctx, &input.relay_id)
        .await
        .map_err(access_denial_error)?
        .device_limit;
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
            Json(ApiErrorBody::new("device_limit_reached", error)),
        );
    }
    public_api_error(error)
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

/// Redeem a relay's attestation for a client credential.
///
/// Intentionally takes no bearer: the Ed25519 signature in the body *is* the
/// authentication, and it belongs to the client, not to the relay that
/// attested it. Rate-limited like the rest of the public control plane so the
/// unauthenticated shape cannot be used to grind at claim ids.
async fn public_claim_client_identity(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    Json(input): Json<ClientClaimRequest>,
) -> Result<Json<ClientClaimResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "client_claim").await?;
    let control_plane = require_public_control_plane(&state)?;
    control_plane
        .claim_client_identity(input)
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
        reject_socket(
            &state.hardening.publish_metrics,
            socket,
            "invalid_connection",
            "channel_id is required",
        )
        .await;
        return;
    }
    let Some(_connection_permit) = state.hardening.connection_tracker.try_acquire(
        remote_addr.ip(),
        state.hardening.config.max_connections_per_ip,
    ) else {
        reject_socket(
            &state.hardening.publish_metrics,
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
            &state.hardening.publish_metrics,
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
                &state.hardening.publish_metrics,
                socket,
                "join_rejected",
                state.join_verifier.client_join_error_message(),
            )
            .await;
            return;
        }
    };

    // Capture the access epoch before the async policy check so a concurrent
    // access release (which bumps the epoch even for an empty room) cannot let
    // this join seat afterward.
    let access_epoch = state.broker.access_epoch().await;

    // After ticket verification, consult access policy before seating. Public
    // control-plane rooms resolve to their registered relay_id so tickets cannot
    // target a victim. Self-host / open mode has no registration table — strategy
    // still runs with the room id as a neutral key (OpenAccess allows;
    // Unavailable fails closed). Missing registration in public mode fails closed.
    if let Err(reason) =
        authorize_verified_join_access(&state, remote_addr.ip(), &channel_id, &verified_join).await
    {
        debug!(
            remote_ip = %remote_addr.ip(),
            broker_room_id = %channel_id,
            role = ?query.role,
            reason = %reason,
            "broker join rejected by access strategy"
        );
        reject_socket(
            &state.hardening.publish_metrics,
            socket,
            "join_rejected",
            state.join_verifier.client_join_error_message(),
        )
        .await;
        return;
    }

    // Only a ticket that PINS a peer_id (a relay join) may have it echoed back in
    // the query — the equality check below then validates the match. A surface
    // ticket pins nothing, so honoring the query parameter let a surface name
    // itself after the relay and take that slot; and because the relay's own
    // ticket pins its id, the regenerate-on-collision retry below never fires for
    // it, so the relay was locked out of its own room until the squatter dropped
    // the socket. Surfaces get a broker-assigned id instead, which is what the
    // remote client already reads back out of `Welcome`.
    let mut peer_id = if verified_join.peer_id.is_some() {
        trimmed_option_string(query.peer_id).or_else(|| verified_join.peer_id.clone())
    } else {
        None
    };
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
                    &state.hardening.publish_metrics,
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
            .join_if_access_epoch(
                &channel_id,
                &candidate,
                query.role,
                verified_join.device_id.clone(),
                verified_join.pairing_id.clone(),
                access_epoch,
            )
            .await
        {
            Ok(join) => {
                peer_id = Some(candidate);
                break join;
            }
            Err(message) => {
                if message.contains("access epoch changed") {
                    debug!(
                        remote_ip = %remote_addr.ip(),
                        broker_room_id = %channel_id,
                        role = ?query.role,
                        "broker join rejected because access was released during authorization"
                    );
                    reject_socket(
                        &state.hardening.publish_metrics,
                        socket,
                        "join_rejected",
                        state.join_verifier.client_join_error_message(),
                    )
                    .await;
                    return;
                }
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
                    &state.hardening.publish_metrics,
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
    // Resolved once, from the verified ticket rather than the assigned peer_id, so
    // reconnecting cannot hand this connection a fresh allowance.
    let publish_identity = publish_limit_identity(&verified_join, &peer_id);
    let connection_id = join.connection_id;

    let (mut sender, mut receiver) = socket.split();
    let welcome = ServerMessage::Welcome {
        protocol_version: BROKER_PROTOCOL_VERSION,
        channel_id: channel_id.clone(),
        peer_id: peer_id.clone(),
        peers: join.existing_peers,
    };

    if send_message(&state.hardening.publish_metrics, &mut sender, &welcome)
        .await
        .is_err()
    {
        state
            .broker
            .leave_connection(&channel_id, &peer_id, connection_id)
            .await;
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
                if send_message(&state.hardening.publish_metrics, &mut sender, &message).await.is_err() {
                    break;
                }
                idle_sleep.as_mut().reset(Instant::now() + idle_timeout);
            }
            _ = &mut idle_sleep => {
                let _ = send_message(
                    &state.hardening.publish_metrics,
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
                        if text.len() > state.hardening.config.max_text_frame_bytes() {
                            let _ = send_message(
                                &state.hardening.publish_metrics,
                                &mut sender,
                                &ServerMessage::Error {
                                    code: "frame_too_large".to_string(),
                                    message: format!(
                                        "client text frames must be {} bytes or smaller",
                                        state.hardening.config.max_text_frame_bytes()
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
                                        &state.hardening.publish_metrics,
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
                                let frame_bytes = text.len();
                                if !state
                                    .hardening
                                    .rate_limiter
                                    .allow(
                                        format!("publish:{channel_id}:{publish_identity}"),
                                        state.hardening.config.frame_limit(query.role),
                                    )
                                    .await
                                {
                                    state.hardening.publish_metrics.record_frame_limited();
                                    warn!(
                                        channel_id,
                                        peer_id,
                                        frame_bytes,
                                        payload = %payload_summary,
                                        "broker publish rate limit exceeded"
                                    );
                                    let _ = send_message(
                                        &state.hardening.publish_metrics,
                                        &mut sender,
                                        &ServerMessage::Error {
                                            code: "rate_limited".to_string(),
                                            message: "broker publish rate limit exceeded for this peer".to_string(),
                                        },
                                    )
                                    .await;
                                    continue;
                                }
                                // Charged on the raw frame, so a peer pays for what it
                                // actually puts on the wire rather than for a count that
                                // says nothing about size.
                                let byte_budget = state.hardening.config.byte_budget(query.role);
                                if !state
                                    .hardening
                                    .byte_limiter
                                    .charge(
                                        format!("publish-bytes:{channel_id}:{publish_identity}"),
                                        frame_bytes,
                                        byte_budget,
                                    )
                                    .await
                                {
                                    state.hardening.publish_metrics.record_byte_limited();
                                    warn!(
                                        channel_id,
                                        peer_id,
                                        frame_bytes,
                                        bytes_per_minute = byte_budget.bytes_per_minute,
                                        burst_bytes = byte_budget.burst_bytes,
                                        payload = %payload_summary,
                                        "broker publish byte limit exceeded"
                                    );
                                    let _ = send_message(
                                        &state.hardening.publish_metrics,
                                        &mut sender,
                                        &ServerMessage::Error {
                                            code: "rate_limited".to_string(),
                                            message: "broker publish byte limit exceeded for this peer".to_string(),
                                        },
                                    )
                                    .await;
                                    continue;
                                }
                                match state
                                    .broker
                                    .publish_connection(
                                        &channel_id,
                                        &peer_id,
                                        connection_id,
                                        payload,
                                    )
                                    .await
                                {
                                    Ok(()) => {
                                        // Inbound only. The egress this fans out to is
                                        // counted per recipient in `send_message`, where
                                        // the real serialized length is known.
                                        state
                                            .hardening
                                            .publish_metrics
                                            .record_published(frame_bytes);
                                    }
                                    Err(error) => {
                                        warn!(
                                            channel_id,
                                            peer_id,
                                            %error,
                                            payload = %payload_summary,
                                            "failed to publish message"
                                        );
                                        if error.contains("connection has been replaced") {
                                            break;
                                        }
                                    }
                                }
                            }
                            Err(error) => {
                                debug!(channel_id, peer_id, %error, "rejecting invalid client frame");
                                let _ = send_message(
                                    &state.hardening.publish_metrics,
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
                        if bytes.len() > state.hardening.config.max_text_frame_bytes() {
                            let _ = send_message(
                                &state.hardening.publish_metrics,
                                &mut sender,
                                &ServerMessage::Error {
                                    code: "frame_too_large".to_string(),
                                    message: format!(
                                        "client binary frames must be {} bytes or smaller",
                                        state.hardening.config.max_text_frame_bytes()
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
    state
        .broker
        .leave_connection(&channel_id, &peer_id, connection_id)
        .await;
}

/// Write one frame to a peer socket, accounting its exact serialized length as egress.
///
/// This is the only place a `ServerMessage` becomes bytes, which makes it the only place
/// egress can be known rather than modelled. Counting here is also free: the
/// serialization already had to happen. An earlier revision estimated egress at publish
/// time from a fan-out count and the inbound frame size, which silently assumed every
/// target of a `targeted_messages` wrapper got a similar-sized payload — one large
/// delivered payload beside one tiny undelivered one reported half the true figure.
///
/// Only a successful write counts: a frame the socket rejected never left.
async fn send_message(
    metrics: &PublishMetrics,
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &ServerMessage,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(message).expect("server messages should serialize");
    let bytes = payload.len() as u64;
    let result = sender.send(Message::Text(payload)).await;
    if result.is_ok() {
        metrics.record_egress(bytes);
    }
    result
}

async fn reject_socket(metrics: &PublishMetrics, socket: WebSocket, code: &str, message: &str) {
    let (mut sender, _) = socket.split();
    let payload = serde_json::to_string(&ServerMessage::Error {
        code: code.to_string(),
        message: message.to_string(),
    })
    .expect("error message should serialize");
    let bytes = payload.len() as u64;
    // Counted like any other `ServerMessage`. A rejection frame is small, but leaving it
    // out would make `egress_bytes` mean "egress except the one path an abusive client
    // can drive hardest" — a rejected join is exactly what a flood produces.
    if sender.send(Message::Text(payload)).await.is_ok() {
        metrics.record_egress(bytes);
    }
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

/// The identity a publish allowance is keyed on — deliberately **not** the `peer_id`.
///
/// A surface's `peer_id` is minted fresh by the broker on every join (see
/// [`generated_peer_id`]; a surface ticket pins nothing), so a budget keyed on it resets
/// every time the peer reconnects. That makes the limit advisory for exactly the peers it
/// is aimed at: at the default 40 joins/minute one credential could draw ~10 fresh bursts
/// a minute, and concurrent sockets multiply it again.
///
/// The join ticket's `device_id`/`pairing_id` are authenticated and survive a reconnect,
/// which is what a budget needs. Ticket validation guarantees a surface carries exactly
/// one of them, so the `peer_id` fallback is unreachable for a validated surface join; it
/// exists so an unauthenticated path can never silently become unkeyed.
///
/// A relay's ticket pins its `peer_id` and forbids both other ids, so relays fall through
/// to that and keep the identity they already had.
///
/// Consequence worth knowing: two tabs on the same device now share one budget. That is
/// the intended reading of "per peer" — the credential is the peer, not the socket.
fn publish_limit_identity(verified: &VerifiedBrokerJoin, peer_id: &str) -> String {
    if let Some(device_id) = verified.device_id.as_deref() {
        return format!("device:{device_id}");
    }
    if let Some(pairing_id) = verified.pairing_id.as_deref() {
        return format!("pairing:{pairing_id}");
    }
    format!("peer:{peer_id}")
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
            Json(ApiErrorBody::new(
                "not_found",
                "public control-plane endpoints are unavailable in this auth mode".to_string(),
            )),
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
        Json(ApiErrorBody::new(
            "unauthorized",
            "missing bearer token".to_string(),
        )),
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
            Json(ApiErrorBody::new("bad_request", "invalid room".to_string())),
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
                Json(ApiErrorBody::new(
                    "unauthorized",
                    "missing bearer token".to_string(),
                )),
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
            Json(ApiErrorBody::new("bad_request", error_message.to_string())),
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
        Json(ApiErrorBody::new(
            if status == StatusCode::UNAUTHORIZED {
                "unauthorized"
            } else {
                "bad_request"
            },
            message,
        )),
    )
}

/// Map a typed access denial to the public HTTP error body. Internal causes are
/// logged here and never copied into the response.
fn access_denial_error(denial: AccessDenial) -> (StatusCode, Json<ApiErrorBody>) {
    denial.log_internal();
    let mut body = ApiErrorBody::new(denial.public_error_code(), denial.public_message());
    body.retry_after_secs = denial.retry_after_secs();
    (denial.http_status(), Json(body))
}

/// Post-ticket access gate for websocket joins. Never logs tickets or tokens.
async fn authorize_verified_join_access(
    state: &BrokerAppState,
    remote_ip: IpAddr,
    broker_room_id: &str,
    verified: &VerifiedBrokerJoin,
) -> Result<(), &'static str> {
    let relay_id = match state.join_verifier.public_control_plane() {
        Some(control_plane) => match control_plane.relay_id_for_broker_room(broker_room_id).await {
            Some(relay_id) => relay_id,
            // Public mode requires a live registration for the room. Released /
            // never-enrolled rooms fail closed even if the HMAC ticket is still
            // within its short TTL.
            None => return Err("broker room has no active relay registration"),
        },
        // Self-host shared-secret mode: no registration table. Use the room id as
        // a neutral key so OpenAccess still allows and Unavailable still denies.
        None => broker_room_id.to_string(),
    };

    match verified.kind {
        JoinTicketKind::RelayJoin => {
            let ctx = AccessRequestContext::new(remote_ip, AccessOperation::RelaySocketJoin);
            state
                .access
                .authorize_relay(&ctx, &relay_id)
                .await
                .map_err(|denial| {
                    denial.log_internal();
                    "relay access denied for socket join"
                })?;
        }
        JoinTicketKind::DeviceSurfaceJoin | JoinTicketKind::PairingSurfaceJoin => {
            let ctx = AccessRequestContext::new(remote_ip, AccessOperation::DeviceSocketJoin);
            state
                .access
                .authorize_device(&ctx, &relay_id)
                .await
                .map_err(|denial| {
                    denial.log_internal();
                    "device access denied for socket join"
                })?;
        }
    }
    Ok(())
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
        Json(ApiErrorBody::new(
            "rate_limited",
            "public broker control-plane rate limit exceeded".to_string(),
        )),
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

/// The relay's publish allowance, with a migration path.
///
/// Before relays and surfaces had separate budgets, `RELAY_BROKER_PUBLISH_RATE_LIMIT_PER_MINUTE`
/// governed every peer. An operator who deliberately tightened it would otherwise find
/// relays silently promoted to the far larger relay default on upgrade — a hardening
/// setting quietly weakening itself is the wrong way round. So an explicitly configured
/// generic limit keeps governing relays too, until the operator opts into the split by
/// setting the relay-specific variable.
fn relay_publish_rate_limit_from_env() -> Result<usize, String> {
    resolve_relay_publish_rate_limit(
        std::env::var(RELAY_PUBLISH_RATE_LIMIT_ENV).ok().as_deref(),
        std::env::var(PUBLISH_RATE_LIMIT_ENV).ok().as_deref(),
    )
}

/// Split out from the environment so the migration rule can be tested without mutating
/// process-wide state that the concurrent server tests also read.
fn resolve_relay_publish_rate_limit(
    relay_setting: Option<&str>,
    generic_setting: Option<&str>,
) -> Result<usize, String> {
    let parse = |name: &str, value: &str| {
        value
            .trim()
            .parse::<usize>()
            .map_err(|error| format!("{name} must be a positive integer: {error}"))
    };
    match (relay_setting, generic_setting) {
        (Some(relay), _) => parse(RELAY_PUBLISH_RATE_LIMIT_ENV, relay),
        (None, Some(generic)) => parse(PUBLISH_RATE_LIMIT_ENV, generic),
        (None, None) => Ok(DEFAULT_RELAY_PUBLISH_RATE_LIMIT_PER_MINUTE),
    }
}

/// The relay's byte allowance, following the same migration rule as its frame allowance.
///
/// The byte variables are new, so no deployment can already have set them — but an
/// operator who tightens the generic byte budget means it, and leaving relays at a default
/// 32x larger would read as the setting being ignored. Same shape as the frame rule, so
/// there is one thing to learn rather than two.
fn relay_publish_bytes_from_env() -> Result<usize, String> {
    resolve_relay_byte_setting(
        std::env::var(RELAY_PUBLISH_BYTES_ENV).ok().as_deref(),
        std::env::var(PUBLISH_BYTES_ENV).ok().as_deref(),
        RELAY_PUBLISH_BYTES_ENV,
        PUBLISH_BYTES_ENV,
        DEFAULT_RELAY_PUBLISH_BYTES_PER_MINUTE,
    )
}

fn relay_publish_burst_bytes_from_env() -> Result<usize, String> {
    resolve_relay_byte_setting(
        std::env::var(RELAY_PUBLISH_BURST_BYTES_ENV).ok().as_deref(),
        std::env::var(PUBLISH_BURST_BYTES_ENV).ok().as_deref(),
        RELAY_PUBLISH_BURST_BYTES_ENV,
        PUBLISH_BURST_BYTES_ENV,
        DEFAULT_RELAY_PUBLISH_BURST_BYTES,
    )
}

/// Split out from the environment so the migration rule can be tested without mutating
/// process-wide state that the concurrent server tests also read.
fn resolve_relay_byte_setting(
    relay_setting: Option<&str>,
    generic_setting: Option<&str>,
    relay_name: &str,
    generic_name: &str,
    default: usize,
) -> Result<usize, String> {
    let parse = |name: &str, value: &str| {
        value
            .trim()
            .parse::<usize>()
            .map_err(|error| format!("{name} must be a non-negative integer: {error}"))
    };
    match (relay_setting, generic_setting) {
        (Some(relay), _) => parse(relay_name, relay),
        (None, Some(generic)) => parse(generic_name, generic),
        (None, None) => Ok(default),
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
