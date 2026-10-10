mod relay_proofs;
pub(crate) use relay_proofs::verify_relay_control_signature;
use relay_proofs::{configured_ticket_origin, PendingRelayProofChallenge};
pub use relay_proofs::{
    relay_control_message, relay_control_operation, relay_control_request_sha256,
    relay_join_message, relay_ws_ticket_message,
};

#[cfg(test)]
mod test_support;
#[cfg(test)]
use test_support::{save_public_control_postgres_full_rebuild, SIMULATED_DATABASE_ERROR};

use std::{
    collections::{BTreeSet, HashMap},
    future::Future,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::{distributions::Alphanumeric, Rng};
use relay_util::{sha256_hex, trimmed_option_string};
use serde::{Deserialize, Serialize};
use sqlx::{
    postgres::{PgPoolOptions, PgRow},
    PgPool, Row,
};
use tokio::{
    fs,
    sync::{Mutex, MutexGuard, Semaphore},
    time::Instant,
};
use tracing::{info, warn};

use crate::join_ticket::{unix_now, JoinTicketClaims, JoinTicketKey};

pub const PUBLIC_ISSUER_SECRET_ENV: &str = "RELAY_BROKER_PUBLIC_ISSUER_SECRET";
pub const PUBLIC_RELAY_REGISTRATIONS_ENV: &str = "RELAY_BROKER_PUBLIC_RELAYS_JSON";
pub const PUBLIC_STATE_PATH_ENV: &str = "RELAY_BROKER_PUBLIC_STATE_PATH";
pub const PUBLIC_POSTGRES_URL_ENV: &str = "RELAY_BROKER_PUBLIC_POSTGRES_URL";
/// Opt back into reloading the whole control-plane state from Postgres before
/// every operation. Only needed for multi-instance deployments that share one
/// database; a single broker (the default) keeps the in-memory state as the
/// source of truth and skips the per-op reload for much lower latency.
pub const PUBLIC_POSTGRES_RELOAD_ENV: &str = "RELAY_BROKER_PUBLIC_POSTGRES_RELOAD_BEFORE_USE";
const PUBLIC_DB_MAX_CONNECTIONS_ENV: &str = "RELAY_BROKER_PUBLIC_DB_MAX_CONNECTIONS";
const PUBLIC_DB_ACQUIRE_TIMEOUT_ENV: &str = "RELAY_BROKER_PUBLIC_DB_ACQUIRE_TIMEOUT_MS";
const PUBLIC_DB_QUERY_TIMEOUT_ENV: &str = "RELAY_BROKER_PUBLIC_DB_QUERY_TIMEOUT_MS";
const PUBLIC_DB_CONCURRENCY_ENV: &str = "RELAY_BROKER_PUBLIC_DB_CONCURRENCY";
pub const PUBLIC_RELAY_WS_TTL_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_RELAY_WS_TTL_SECS";
pub const PUBLIC_DEVICE_WS_TTL_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS";
/// Pairing only delivers new credentials to the completing session, so other sessions need grace.
/// A fixed deadline bounds stolen old credentials; explicit revocation cuts access immediately.
pub const PUBLIC_ROTATION_GRACE_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_ROTATION_GRACE_SECS";
/// Operator-configured origin bound into relay websocket ticket proofs.
/// Request Host / forwarded headers are not a source for this value.
pub const PUBLIC_ORIGIN_ENV: &str = "RELAY_BROKER_PUBLIC_ORIGIN";
/// Used when `RELAY_BROKER_PUBLIC_ORIGIN` is unset or empty. Callers cannot
/// choose it. An explicit value that is not an http(s) host origin fails
/// broker startup instead of falling back to this string.
pub const DEFAULT_RELAY_WS_TICKET_ORIGIN: &str = "sealwire-broker";

const DEFAULT_PUBLIC_RELAY_WS_TTL_SECS: u64 = 300;
const DEFAULT_PUBLIC_DEVICE_WS_TTL_SECS: u64 = 300;
const DEFAULT_PUBLIC_ROTATION_GRACE_SECS: u64 = 60 * 60 * 48;
/// Upper bound on retained superseded tokens per credential, so repeated
/// re-approvals cannot grow rows without bound (oldest entries drop first).
const MAX_SUPERSEDED_TOKENS: usize = 16;
const DEFAULT_RELAY_ENROLLMENT_CHALLENGE_TTL_SECS: u64 = 300;
/// How long a client has to claim a credential the relay attested for it. The
/// hop is machine-to-machine (relay -> sealed pairing result -> device), so this
/// only has to cover transport, not a human deciding anything.
const DEFAULT_CLIENT_CLAIM_TTL_SECS: u64 = 300;
const DEFAULT_PUBLIC_DB_MAX_CONNECTIONS: u32 = 5;
const DEFAULT_PUBLIC_DB_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_PUBLIC_DB_QUERY_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_PUBLIC_DB_CONCURRENCY: usize = 8;
// Keep recovery capacity above the default API budget over a challenge's lifetime.
const MAX_PENDING_CREDENTIAL_REFRESHES: usize = 4096;
const MAX_PENDING_REFRESHES_PER_CLIENT: usize = 4;
/// Minimum gap between the end of one full reload and the start of the next.
const MISS_RELOAD_MIN_INTERVAL: Duration = Duration::from_secs(1);
/// The expression the superseded-token index covers; the probe must filter on exactly this.
const SUPERSEDED_JSONB: &str = "superseded_tokens::jsonb";
/// Server-side cap on the one-off index build, far past the pool's per-query timeout.
const SUPERSEDED_INDEX_BUILD_TIMEOUT_SECS: u64 = 600;
/// Labels are display text (the official relay sends at most 80 chars); longer is cut.
const MAX_LABEL_CHARS: usize = 128;
/// Caller-chosen ids that are held or stored; the official relay's are at most 48 bytes.
const MAX_ID_BYTES: usize = 128;
/// Above the ~3000 the default global API budget can create in one 300s TTL, so it only
/// binds if that budget is raised.
const MAX_PENDING_RELAY_ENROLLMENT_CHALLENGES: usize = 4096;
const DEFAULT_RELAY_WS_TICKET_CHALLENGE_TTL_SECS: u64 = 60;
const MAX_PENDING_RELAY_WS_TICKET_CHALLENGES: usize = 4096;
const MAX_PENDING_RELAY_CONTROL_CHALLENGES: usize = 4096;
pub const RELAY_CONTROL_CHALLENGE_HEADER: &str = "x-relay-control-challenge-id";
pub const RELAY_CONTROL_SIGNATURE_HEADER: &str = "x-relay-control-signature";
const MAX_TICKET_ORIGIN_BYTES: usize = 256;
/// Test-only: reads like a real driver error, including a word the HTTP layer maps to 401.
const RELOAD_FAILED_ERROR: &str = "public control-plane state reload failed; retry shortly";
const PROBE_FAILED_ERROR: &str = "public control-plane database unavailable; retry shortly";
/// The longest pairing window the official relay asks for (`MAX_PAIRING_TTL_SECS`).
const MAX_PAIRING_TICKET_TTL_SECS: u64 = 600;
const PUBLIC_CONTROL_STATE_VERSION: u32 = 2;

#[derive(Clone, Debug)]
struct PublicControlDbConfig {
    max_connections: u32,
    acquire_timeout: Duration,
    query_timeout: Duration,
    concurrency: usize,
}

impl Default for PublicControlDbConfig {
    fn default() -> Self {
        Self {
            max_connections: DEFAULT_PUBLIC_DB_MAX_CONNECTIONS,
            acquire_timeout: DEFAULT_PUBLIC_DB_ACQUIRE_TIMEOUT,
            query_timeout: DEFAULT_PUBLIC_DB_QUERY_TIMEOUT,
            concurrency: DEFAULT_PUBLIC_DB_CONCURRENCY,
        }
    }
}

impl PublicControlDbConfig {
    fn validate(self) -> Result<Self, String> {
        if self.max_connections == 0 || self.max_connections > 64 {
            return Err("public db max_connections must be in 1..=64".to_string());
        }
        if self.acquire_timeout.is_zero() || self.acquire_timeout > Duration::from_secs(60) {
            return Err("public db acquire_timeout must be in (0, 60]s".to_string());
        }
        if self.query_timeout.is_zero() || self.query_timeout > Duration::from_secs(60) {
            return Err("public db query_timeout must be in (0, 60]s".to_string());
        }
        if self.concurrency == 0 || self.concurrency > 128 {
            return Err("public db concurrency must be in 1..=128".to_string());
        }
        Ok(self)
    }

    fn from_env() -> Result<Self, String> {
        let mut cfg = Self::default();
        if let Ok(value) = std::env::var(PUBLIC_DB_MAX_CONNECTIONS_ENV) {
            cfg.max_connections = value
                .trim()
                .parse()
                .map_err(|_| format!("{PUBLIC_DB_MAX_CONNECTIONS_ENV} must be an integer"))?;
        }
        if let Ok(value) = std::env::var(PUBLIC_DB_ACQUIRE_TIMEOUT_ENV) {
            let millis: u64 = value
                .trim()
                .parse()
                .map_err(|_| format!("{PUBLIC_DB_ACQUIRE_TIMEOUT_ENV} must be an integer"))?;
            cfg.acquire_timeout = Duration::from_millis(millis);
        }
        if let Ok(value) = std::env::var(PUBLIC_DB_QUERY_TIMEOUT_ENV) {
            let millis: u64 = value
                .trim()
                .parse()
                .map_err(|_| format!("{PUBLIC_DB_QUERY_TIMEOUT_ENV} must be an integer"))?;
            cfg.query_timeout = Duration::from_millis(millis);
        }
        if let Ok(value) = std::env::var(PUBLIC_DB_CONCURRENCY_ENV) {
            cfg.concurrency = value
                .trim()
                .parse()
                .map_err(|_| format!("{PUBLIC_DB_CONCURRENCY_ENV} must be an integer"))?;
        }
        cfg.validate()
    }
}

#[derive(Clone)]
struct PublicControlDbGate {
    permits: Arc<Semaphore>,
    /// Caps work any caller can trigger at a quarter of `permits`.
    spare_permits: Arc<Semaphore>,
    query_timeout: Duration,
}

#[derive(Debug)]
enum PublicControlDbGateError {
    Busy,
    Timeout,
    Operation(String),
}

impl PublicControlDbGateError {
    fn into_message(self) -> String {
        match self {
            Self::Busy => "public control-plane database busy".to_string(),
            Self::Timeout => "public control-plane database query timed out".to_string(),
            Self::Operation(message) => message,
        }
    }
}

impl PublicControlDbGate {
    fn new(concurrency: usize, query_timeout: Duration) -> Result<Self, String> {
        if concurrency == 0 || concurrency > 128 {
            return Err("public db concurrency must be in 1..=128".to_string());
        }
        if query_timeout.is_zero() || query_timeout > Duration::from_secs(60) {
            return Err("public db query_timeout must be in (0, 60]s".to_string());
        }
        Ok(Self {
            permits: Arc::new(Semaphore::new(concurrency)),
            spare_permits: Arc::new(Semaphore::new((concurrency / 4).max(1))),
            query_timeout,
        })
    }

    /// For queries any caller can trigger, so a flood of them cannot starve the writes
    /// and reloads that share this gate.
    async fn run_spare<T, F>(&self, operation: F) -> Result<T, PublicControlDbGateError>
    where
        F: Future<Output = Result<T, String>>,
    {
        let _spare = self
            .spare_permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| PublicControlDbGateError::Busy)?;
        self.run(operation).await
    }

    async fn run<T, F>(&self, operation: F) -> Result<T, PublicControlDbGateError>
    where
        F: Future<Output = Result<T, String>>,
    {
        let _permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| PublicControlDbGateError::Busy)?;
        match tokio::time::timeout(self.query_timeout, operation).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(PublicControlDbGateError::Operation(error)),
            Err(_) => Err(PublicControlDbGateError::Timeout),
        }
    }
}

impl Default for PublicControlDbGate {
    fn default() -> Self {
        Self::new(
            DEFAULT_PUBLIC_DB_CONCURRENCY,
            DEFAULT_PUBLIC_DB_QUERY_TIMEOUT,
        )
        .expect("default public control-plane database gate is valid")
    }
}

#[cfg(test)]
#[path = "public_control/tests/public_control_db_gate_tests.rs"]
mod public_control_db_gate_tests;

/// Stable prefix on the per-relay device-cap error, so the HTTP layer can map
/// it to a machine-readable `device_limit_reached` code (and callers/UI can match
/// it) without fragile full-string comparisons.
pub const DEVICE_LIMIT_REACHED_ERROR_PREFIX: &str = "device limit reached";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayRegistrationConfig {
    pub relay_id: String,
    pub broker_room_id: String,
    pub refresh_token: String,
    /// Enrolled Ed25519 verify key. Absent means relay websocket tickets are refused.
    #[serde(default)]
    pub relay_verify_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayWsTokenChallengeRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub relay_peer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayWsTokenChallengeResponse {
    pub challenge_id: String,
    pub challenge: String,
    pub relay_id: String,
    pub broker_room_id: String,
    pub relay_peer_id: String,
    pub broker_origin: String,
    pub refresh_token_hash: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayWsTokenRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub relay_peer_id: String,
    pub challenge_id: String,
    pub challenge_signature: String,
}

/// Fresh proof request for a privileged relay-refresh operation.
/// `operation` is `METHOD path` (the revoke path includes the device id).
/// `request_sha256` is the hex sha256 of the exact JSON body that will be posted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayControlChallengeRequest {
    pub operation: String,
    pub relay_id: String,
    pub broker_room_id: String,
    pub request_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayControlChallengeResponse {
    pub challenge_id: String,
    pub challenge: String,
    pub operation: String,
    pub relay_id: String,
    pub broker_room_id: String,
    pub broker_origin: String,
    pub refresh_token_hash: String,
    pub request_sha256: String,
    pub expires_at: u64,
}

/// Authenticated request to tear down relay access (release binding + revoke registration).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessReleaseRequest {
    pub relay_id: String,
    pub broker_room_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessReleaseResponse {
    pub released: bool,
}

/// Opaque authenticated relay identity used for same-identity lifecycle locking.
#[derive(Debug, Clone)]
pub struct AuthenticatedRelayIdentity {
    pub relay_id: String,
    pub broker_room_id: String,
    /// Same-identity lock key shared with enrollment (verify key when present).
    pub lifecycle_lock_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayWsTokenResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub relay_ws_token: String,
    pub relay_ws_token_expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayEnrollmentChallengeRequest {
    pub relay_verify_key: String,
    #[serde(default)]
    pub relay_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayEnrollmentChallengeResponse {
    pub relay_verify_key: String,
    pub challenge_id: String,
    pub challenge: String,
    pub expires_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
// Strict schema is deliberate: removed credential field names (e.g. the old
// `license_code` alias) must fail closed rather than silently degrade to
// anonymous enrollment when an access strategy requires a token.
#[serde(deny_unknown_fields)]
pub struct RelayEnrollmentCompleteRequest {
    pub relay_verify_key: String,
    pub challenge_id: String,
    pub challenge_signature: String,
    #[serde(default)]
    pub relay_label: Option<String>,
    /// Cloud access / enrollment credential the relay presents at enrollment.
    /// Required when the broker enforces access tokens; ignored otherwise.
    /// Legacy wire name `license_code` is rejected as an unknown field.
    #[serde(default)]
    pub enrollment_token: Option<String>,
}

impl std::fmt::Debug for RelayEnrollmentCompleteRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayEnrollmentCompleteRequest")
            .field("relay_verify_key", &self.relay_verify_key)
            .field("challenge_id", &self.challenge_id)
            .field("challenge_signature", &"<redacted>")
            .field("relay_label", &self.relay_label)
            .field(
                "enrollment_token",
                &self.enrollment_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct RelayEnrollmentResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub relay_refresh_token: String,
    pub created_at: u64,
    #[serde(default)]
    pub relay_label: Option<String>,
}

impl std::fmt::Debug for RelayEnrollmentResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayEnrollmentResponse")
            .field("relay_id", &self.relay_id)
            .field("broker_room_id", &self.broker_room_id)
            .field("relay_refresh_token", &"<redacted>")
            .field("created_at", &self.created_at)
            .field("relay_label", &self.relay_label)
            .finish()
    }
}

#[cfg(test)]
#[path = "public_control/tests/enrollment_response_debug_tests.rs"]
mod enrollment_response_debug_tests;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingWsTokenRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub pairing_id: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingWsTokenResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub pairing_join_ticket: String,
    pub pairing_join_ticket_expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientGrantRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub device_id: String,
    pub client_verify_key: String,
    #[serde(default)]
    pub client_label: Option<String>,
    #[serde(default)]
    pub device_label: Option<String>,
}

/// What a relay gets back for attesting a client key.
///
/// Deliberately carries **no client credential**. The relay is only allowed to
/// say "this key may reach me"; the client itself proves possession of the key
/// against `/api/public/client/claim` and receives the token directly. That
/// split is the whole point — see `a_relay_must_not_mint_a_credential_for_another_relays_client`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientGrantResponse {
    /// Opaque handle the client presents when claiming. Safe to forward to the
    /// device: on its own it authorises nothing without a signature.
    pub claim_id: String,
    /// Broker-chosen nonce the client signs over.
    pub claim_nonce: String,
    pub claim_expires_at: u64,
    pub relay_id: String,
    pub broker_room_id: String,
    pub device_id: String,
    #[serde(default)]
    pub relay_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientClaimRequest {
    pub claim_id: String,
    /// Signature over `agent-relay:client-claim:{claim_id}:{nonce}:{relay_id}:{client_verify_key}`
    /// by the private half of the attested client key.
    pub claim_signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientClaimResponse {
    pub client_id: String,
    pub client_refresh_token: String,
    pub relay_id: String,
    pub broker_room_id: String,
    pub device_id: String,
    #[serde(default)]
    pub relay_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientRelayEntry {
    pub relay_id: String,
    pub broker_room_id: String,
    pub device_id: String,
    pub granted_at: u64,
    #[serde(default)]
    pub relay_label: Option<String>,
    #[serde(default)]
    pub device_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientRelaysResponse {
    pub client_id: String,
    pub relays: Vec<ClientRelayEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub device_id: String,
    pub device_refresh_token: String,
    pub device_ws_token: String,
    pub device_ws_token_expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceWsTokenResponse {
    pub broker_room_id: String,
    pub device_id: String,
    pub device_ws_token: String,
    pub device_ws_token_expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceSessionResponse {
    pub broker_room_id: String,
    pub device_id: String,
    pub cookie_session: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionResponse {
    pub client_id: String,
    pub cookie_session: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialRefreshChallengeRequest {
    pub client_id: String,
    pub broker_room_id: Option<String>,
    pub device_id: Option<String>,
    pub nonce: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialRefreshChallengeResponse {
    pub broker_origin: String,
    pub challenge_id: String,
    pub nonce: String,
    pub client_id: String,
    pub broker_room_id: Option<String>,
    pub device_id: Option<String>,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialRefreshRequest {
    pub challenge_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialRefreshResponse {
    pub client_id: String,
    pub cookie_session: bool,
    pub device: Option<DeviceWsTokenResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientIdentityRotateResponse {
    pub client_id: String,
    pub rotated: bool,
    pub cookie_session: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_refresh_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientIdentityRevokeResponse {
    pub client_id: String,
    pub revoked: bool,
    pub revoked_identity_count: usize,
    pub revoked_grant_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantRevokeRequest {
    pub relay_id: String,
    pub broker_room_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantRevokeResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub device_id: String,
    pub revoked: bool,
    pub revoked_grant_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantBulkRevokeRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub keep_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantBulkRevokeResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub kept_device_id: String,
    pub revoked_device_ids: Vec<String>,
    pub revoked_count: usize,
}

#[derive(Clone)]
pub struct PublicControlPlane {
    inner: Arc<PublicControlPlaneInner>,
}

struct PublicControlPlaneInner {
    issuer_key: JoinTicketKey,
    relay_ws_ttl_secs: u64,
    device_ws_ttl_secs: u64,
    rotation_grace_secs: u64,
    persistence: PublicControlPersistence,
    state: Mutex<PublicControlStateStore>,
    relay_enrollment_challenges: Mutex<HashMap<String, PendingRelayEnrollmentChallenge>>,
    relay_ws_ticket_challenges: Mutex<HashMap<String, PendingRelayProofChallenge>>,
    relay_control_challenges: Mutex<HashMap<String, PendingRelayProofChallenge>>,
    ticket_origin: String,
    relay_ws_ticket_challenge_ttl_secs: u64,
    pending_client_claims: Mutex<HashMap<String, PendingClientClaim>>,
    pending_credential_refreshes: Mutex<HashMap<String, PendingCredentialRefresh>>,
    last_full_load: std::sync::Mutex<Option<FullLoad>>,
    miss_reload_min_interval: Duration,
    /// Test-only: treat the JSON file as shared so a second plane on the same
    /// path can stand in for another broker instance.
    #[cfg(test)]
    force_shared_backend: bool,
    #[cfg(test)]
    force_probe_hit: bool,
    /// Test-only: each probe waits for one permit, so a test can act while it is parked.
    #[cfg(test)]
    probe_release: Option<Arc<Semaphore>>,
    #[cfg(test)]
    force_reload_before_use: bool,
    #[cfg(test)]
    full_load_count: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    probe_count: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    load_delay: Duration,
    #[cfg(test)]
    persistence_down: AtomicBool,
    /// Test-only: (start, finish) of every full load.
    #[cfg(test)]
    load_log: std::sync::Mutex<Vec<(Instant, Instant)>>,
    /// Test-only: next N persistence saves fail after mutating memory so callers
    /// can exercise definite-failure restore / retry paths.
    #[cfg(test)]
    save_fail_remaining: std::sync::atomic::AtomicU64,
    /// Test-only: next N revokes simulate shared save+reload failure (memory
    /// stays as intended next / often target-cleared, but outcome is unknown).
    #[cfg(test)]
    reload_uncertain_fail_remaining: std::sync::atomic::AtomicU64,
    /// Test-only: optional pause at the start of registration-chain revoke so
    /// concurrent joins can seat while registration still exists.
    #[cfg(test)]
    cleanup_pause: std::sync::Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
}

#[derive(Clone, Copy)]
struct FullLoad {
    started: Instant,
    finished: Instant,
    succeeded: bool,
}

#[derive(Clone, Copy)]
enum CredentialKind {
    Relay,
    Device,
    Client,
    ClientId,
}

#[derive(Clone)]
enum PublicControlPersistence {
    InMemory,
    Json(PathBuf),
    Postgres {
        pool: PgPool,
        gate: PublicControlDbGate,
        /// Reload the whole state from Postgres before every operation. Only
        /// needed when multiple broker instances share this database (so each
        /// sees the others' writes). Defaults to `false`: with a single instance
        /// (self-host railway example `numReplicas = 1`) the in-memory state is authoritative,
        /// and reloading every op is pure latency. Re-enable via
        /// `RELAY_BROKER_PUBLIC_POSTGRES_RELOAD_BEFORE_USE=1` before scaling out.
        reload_before_use: bool,
        /// Snapshot of what is currently persisted. `save()` diffs the live state
        /// against this and writes only the rows that actually changed (targeted
        /// upsert/delete) instead of wiping and rebuilding every table. Shared
        /// across clones (same DB) and kept in sync by `load()` and `save()`.
        last_saved: Arc<Mutex<PublicControlStateStore>>,
        /// Set when a save failed AND the reconciling reload also failed, so the
        /// true DB outcome is unknown. Forces the next `lock_state()` to reload and
        /// repair (even with `reload_before_use` off); cleared by a successful load.
        needs_reload: Arc<AtomicBool>,
    },
}

#[derive(Debug, Clone)]
struct PendingRelayEnrollmentChallenge {
    relay_verify_key: String,
    challenge: String,
    relay_label: Option<String>,
    expires_at: u64,
}

/// A relay's attestation that `client_verify_key` may reach it, held until the
/// client proves possession of that key.
///
/// Nothing is written to durable state while a claim is pending: no identity,
/// no grant row. That is what stops a hostile relay from inserting itself into
/// someone's relay directory just by naming their public key.
#[derive(Debug, Clone)]
struct PendingClientClaim {
    relay_id: String,
    broker_room_id: String,
    device_id: String,
    client_verify_key: String,
    client_label: Option<String>,
    device_label: Option<String>,
    relay_label: Option<String>,
    nonce: String,
    expires_at: u64,
}

struct PendingCredentialRefresh {
    challenge: CredentialRefreshChallengeResponse,
    client_verify_key: String,
    request_nonce: String,
}

/// Opaque snapshot of a relay registration captured before re-enrollment, so the
/// original credential can be restored if a later step (access bind) fails.
pub struct RelayRegistrationSnapshot(PersistedRelayRegistration);

impl RelayRegistrationSnapshot {
    /// The relay_id of the snapshotted registration.
    pub fn relay_id(&self) -> &str {
        &self.0.relay_id
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct PersistedRelayRegistration {
    relay_id: String,
    broker_room_id: String,
    refresh_token_hash: String,
    created_at: u64,
    #[serde(default)]
    relay_label: Option<String>,
    #[serde(default)]
    relay_verify_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedPublicControlState {
    // TODO: Keeping public control-plane persistence in a single JSON file is
    // fine for early testing and single-broker deployments, but it will not
    // scale cleanly to multiple broker instances. Move this state to a shared
    // database before we support multi-broker/public HA deployments.
    schema_version: u32,
    #[serde(default)]
    relay_registrations: Vec<PersistedRelayRegistration>,
    #[serde(default)]
    client_registrations: Vec<PersistedClientIdentity>,
    #[serde(default)]
    device_grants: Vec<PersistedDeviceGrant>,
    #[serde(default)]
    client_relay_grants: Vec<PersistedClientRelayGrant>,
}

/// A refresh token hash that was rotated away but stays valid until
/// `expires_at` (see [`PUBLIC_ROTATION_GRACE_SECS_ENV`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct SupersededToken {
    refresh_token_hash: String,
    expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct PersistedDeviceGrant {
    relay_id: String,
    broker_room_id: String,
    device_id: String,
    refresh_token_hash: String,
    created_at: u64,
    /// Last time this device was seen active (ws-token refresh), updated at most
    /// once per `LAST_SEEN_THROTTLE_SECS`. `None` = never observed since the
    /// column was added. Serde-default keeps pre-existing JSON state loadable.
    /// Durably tracked only on the Postgres backend (see `touch_device_last_seen`).
    #[serde(default)]
    last_seen: Option<u64>,
    /// Rotated-away refresh tokens still inside the rotation grace window.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    superseded: Vec<SupersededToken>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct PersistedClientIdentity {
    client_id: String,
    client_verify_key: String,
    refresh_token_hash: String,
    created_at: u64,
    #[serde(default)]
    client_label: Option<String>,
    /// Rotated-away refresh tokens still inside the rotation grace window.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    superseded: Vec<SupersededToken>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct PersistedClientRelayGrant {
    client_id: String,
    relay_id: String,
    broker_room_id: String,
    device_id: String,
    granted_at: u64,
    #[serde(default)]
    relay_label: Option<String>,
    #[serde(default)]
    device_label: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq)]
struct PublicControlStateStore {
    relay_registrations_by_hash: HashMap<String, PersistedRelayRegistration>,
    client_registrations_by_hash: HashMap<String, PersistedClientIdentity>,
    grants_by_hash: HashMap<String, PersistedDeviceGrant>,
    client_relay_grants_by_key: HashMap<String, PersistedClientRelayGrant>,
}

/// Aggregate control-plane counts for the operator `/api/admin/stats` endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct AdminTotals {
    /// Distinct relays that either have a registration or hold device grants.
    pub relays: u64,
    /// Total device grants across all relays.
    pub devices: u64,
    /// Total registered client identities.
    pub clients: u64,
}

/// Per-relay device/client counts, sorted by `device_count` descending so the
/// noisiest relays surface first.
#[derive(Debug, Clone, Serialize)]
pub struct AdminRelayStat {
    pub relay_id: String,
    pub broker_room_id: String,
    pub relay_label: Option<String>,
    pub device_count: u64,
    pub client_count: u64,
    /// Most recent `last_seen` across this relay's devices, if any.
    pub last_seen: Option<u64>,
}

/// Snapshot returned by [`PublicControlPlane::admin_stats`].
#[derive(Debug, Clone, Serialize)]
pub struct AdminStats {
    pub totals: AdminTotals,
    pub relays: Vec<AdminRelayStat>,
}

impl PublicControlPlane {
    pub async fn from_env() -> Result<Self, String> {
        Self::from_parts_with_postgres(
            std::env::var(PUBLIC_ISSUER_SECRET_ENV).ok(),
            std::env::var(PUBLIC_RELAY_REGISTRATIONS_ENV).ok(),
            std::env::var(PUBLIC_STATE_PATH_ENV).ok(),
            std::env::var(PUBLIC_POSTGRES_URL_ENV).ok(),
            std::env::var(PUBLIC_RELAY_WS_TTL_SECS_ENV).ok(),
            std::env::var(PUBLIC_DEVICE_WS_TTL_SECS_ENV).ok(),
        )
        .await
    }

    pub async fn from_parts(
        issuer_secret: Option<String>,
        relay_registrations_json: Option<String>,
        state_path: Option<String>,
        relay_ws_ttl_secs: Option<String>,
        device_ws_ttl_secs: Option<String>,
    ) -> Result<Self, String> {
        Self::from_parts_with_postgres(
            issuer_secret,
            relay_registrations_json,
            state_path,
            None,
            relay_ws_ttl_secs,
            device_ws_ttl_secs,
        )
        .await
    }

    pub async fn from_parts_with_postgres(
        issuer_secret: Option<String>,
        relay_registrations_json: Option<String>,
        state_path: Option<String>,
        postgres_url: Option<String>,
        relay_ws_ttl_secs: Option<String>,
        device_ws_ttl_secs: Option<String>,
    ) -> Result<Self, String> {
        let issuer_secret = trimmed_option_string(issuer_secret).ok_or_else(|| {
            format!("{PUBLIC_ISSUER_SECRET_ENV} is required in public broker auth mode")
        })?;
        let issuer_key = JoinTicketKey::from_secret(issuer_secret.as_bytes())
            .map_err(|error| format!("{PUBLIC_ISSUER_SECRET_ENV}: {error}"))?;
        let persistence = PublicControlPersistence::from_config(state_path, postgres_url).await?;
        if !persistence.has_persistent_state() && public_mode_requires_persistent_state() {
            return Err(format!(
                "{PUBLIC_STATE_PATH_ENV} or {PUBLIC_POSTGRES_URL_ENV} is required when {}=public and BIND_HOST is not loopback",
                crate::auth::BROKER_AUTH_MODE_ENV
            ));
        }
        let load_started = Instant::now();
        let mut state = persistence.load().await?;
        let initial_load = FullLoad {
            started: load_started,
            finished: Instant::now(),
            succeeded: true,
        };
        let seeded =
            state.seed_relay_registrations(parse_relay_registrations(relay_registrations_json)?);
        if seeded {
            persistence.save(&mut state).await?;
        }

        Ok(Self {
            inner: Arc::new(PublicControlPlaneInner {
                issuer_key,
                relay_ws_ttl_secs: parse_optional_u64(
                    PUBLIC_RELAY_WS_TTL_SECS_ENV,
                    relay_ws_ttl_secs,
                )?
                .unwrap_or(DEFAULT_PUBLIC_RELAY_WS_TTL_SECS),
                device_ws_ttl_secs: parse_optional_u64(
                    PUBLIC_DEVICE_WS_TTL_SECS_ENV,
                    device_ws_ttl_secs,
                )?
                .unwrap_or(DEFAULT_PUBLIC_DEVICE_WS_TTL_SECS),
                rotation_grace_secs: parse_optional_u64(
                    PUBLIC_ROTATION_GRACE_SECS_ENV,
                    std::env::var(PUBLIC_ROTATION_GRACE_SECS_ENV).ok(),
                )?
                .unwrap_or(DEFAULT_PUBLIC_ROTATION_GRACE_SECS),
                persistence,
                state: Mutex::new(state),
                relay_enrollment_challenges: Mutex::new(HashMap::new()),
                relay_ws_ticket_challenges: Mutex::new(HashMap::new()),
                relay_control_challenges: Mutex::new(HashMap::new()),
                ticket_origin: configured_ticket_origin()?,
                relay_ws_ticket_challenge_ttl_secs: DEFAULT_RELAY_WS_TICKET_CHALLENGE_TTL_SECS,
                pending_client_claims: Mutex::new(HashMap::new()),
                pending_credential_refreshes: Mutex::new(HashMap::new()),
                last_full_load: std::sync::Mutex::new(Some(initial_load)),
                miss_reload_min_interval: MISS_RELOAD_MIN_INTERVAL,
                #[cfg(test)]
                force_shared_backend: false,
                #[cfg(test)]
                force_probe_hit: false,
                #[cfg(test)]
                probe_release: None,
                #[cfg(test)]
                force_reload_before_use: false,
                #[cfg(test)]
                full_load_count: std::sync::atomic::AtomicU64::new(0),
                #[cfg(test)]
                probe_count: std::sync::atomic::AtomicU64::new(0),
                #[cfg(test)]
                load_delay: Duration::ZERO,
                #[cfg(test)]
                persistence_down: AtomicBool::new(false),
                #[cfg(test)]
                load_log: std::sync::Mutex::new(Vec::new()),
                #[cfg(test)]
                save_fail_remaining: std::sync::atomic::AtomicU64::new(0),
                #[cfg(test)]
                reload_uncertain_fail_remaining: std::sync::atomic::AtomicU64::new(0),
                #[cfg(test)]
                cleanup_pause: std::sync::Mutex::new(None),
            }),
        })
    }

    pub fn issuer_key(&self) -> &JoinTicketKey {
        &self.inner.issuer_key
    }

    pub fn has_persistent_state(&self) -> bool {
        self.inner.persistence.has_persistent_state()
    }

    pub fn health_message(&self) -> Option<String> {
        if self.has_persistent_state() {
            return None;
        }

        Some(format!(
            "public broker device grants are in-memory only; set {PUBLIC_STATE_PATH_ENV} or {PUBLIC_POSTGRES_URL_ENV} before exposing this broker outside localhost"
        ))
    }

    pub async fn create_relay_enrollment_challenge(
        &self,
        request: RelayEnrollmentChallengeRequest,
    ) -> Result<RelayEnrollmentChallengeResponse, String> {
        self.prune_expired_relay_enrollment_challenges().await;

        let relay_verify_key = trimmed_option_string(Some(request.relay_verify_key))
            .ok_or_else(|| "relay verify key is required".to_string())?;
        validate_relay_verify_key(&relay_verify_key)?;
        let relay_label = compact_label(request.relay_label);
        let challenge_id = format!("rch-{}", random_token(24).to_ascii_lowercase());
        let challenge = format!("rc-{}", random_token(40).to_ascii_lowercase());
        let now = unix_now();
        let expires_at = now.saturating_add(DEFAULT_RELAY_ENROLLMENT_CHALLENGE_TTL_SECS);
        {
            let mut challenges = self.inner.relay_enrollment_challenges.lock().await;
            challenges.retain(|_, challenge| challenge.expires_at > now);
            if challenges.len() >= MAX_PENDING_RELAY_ENROLLMENT_CHALLENGES {
                return Err("too many pending relay enrollments; retry shortly".to_string());
            }
            challenges.insert(
                challenge_id.clone(),
                PendingRelayEnrollmentChallenge {
                    relay_verify_key: relay_verify_key.clone(),
                    challenge: challenge.clone(),
                    relay_label,
                    expires_at,
                },
            );
        }
        Ok(RelayEnrollmentChallengeResponse {
            relay_verify_key,
            challenge_id,
            challenge,
            expires_at,
        })
    }

    pub async fn complete_relay_enrollment(
        &self,
        request: RelayEnrollmentCompleteRequest,
    ) -> Result<RelayEnrollmentResponse, String> {
        self.prune_expired_relay_enrollment_challenges().await;

        let relay_verify_key = trimmed_option_string(Some(request.relay_verify_key))
            .ok_or_else(|| "relay verify key is required".to_string())?;
        validate_relay_verify_key(&relay_verify_key)?;
        let challenge_id = trimmed_option_string(Some(request.challenge_id))
            .ok_or_else(|| "relay enrollment challenge id is required".to_string())?;
        let challenge_signature = trimmed_option_string(Some(request.challenge_signature))
            .ok_or_else(|| "relay enrollment challenge signature is required".to_string())?;

        let pending = {
            let mut challenges = self.inner.relay_enrollment_challenges.lock().await;
            challenges
                .remove(&challenge_id)
                .ok_or_else(|| "relay enrollment challenge is invalid".to_string())?
        };
        if pending.expires_at <= unix_now() {
            return Err("relay enrollment challenge has expired".to_string());
        }
        if pending.relay_verify_key != relay_verify_key {
            return Err("relay enrollment verify key does not match challenge".to_string());
        }
        verify_relay_enrollment_challenge_signature(
            &relay_verify_key,
            &challenge_id,
            &pending.challenge,
            &challenge_signature,
        )?;
        let relay_label = compact_label(request.relay_label).or(pending.relay_label);
        self.issue_relay_registration_for_verify_key(&relay_verify_key, relay_label)
            .await
    }

    /// Remove the relay registration that was created with the given refresh token.
    ///
    /// Keyed by the token's SHA-256 hash so rollback only deletes the exact
    /// registration this enrollment created. If a concurrent enrollment has since
    /// replaced this registration with a new token, the hash lookup misses and
    /// rollback is a safe no-op — avoiding the relay_id-based data-loss race where
    /// one request's rollback could delete a registration created by another.
    pub async fn rollback_relay_enrollment_by_token(&self, relay_refresh_token: &str) {
        let token_hash = sha256_hex(relay_refresh_token);
        match self.lock_state().await {
            Ok(mut store) => {
                if store
                    .relay_registrations_by_hash
                    .remove(&token_hash)
                    .is_some()
                {
                    if let Err(error) = self.persist(&mut store).await {
                        warn!(%error, "failed to persist relay enrollment rollback");
                    }
                }
                // If the token wasn't found (concurrent enrollment already replaced this
                // registration), this is an intentional no-op — log at debug only.
            }
            Err(error) => {
                warn!(%error, "rollback_relay_enrollment_by_token: failed to lock state")
            }
        }
    }

    /// Capture the current registration for `verify_key`, if any, without modifying
    /// state. The returned opaque snapshot lets the caller [`restore_relay_registration`]
    /// the relay's original refresh credential if a later step (access bind)
    /// fails after `complete_relay_enrollment` replaced it with a new token.
    pub async fn snapshot_relay_registration(
        &self,
        verify_key: &str,
    ) -> Option<RelayRegistrationSnapshot> {
        self.lock_state()
            .await
            .ok()?
            .registration_for_verify_key(verify_key)
            .map(RelayRegistrationSnapshot)
    }

    /// Restore a previously-captured registration, undoing the replacement that
    /// `complete_relay_enrollment` performed. Removes whatever registration currently
    /// exists for the same verify key (the failed re-enrollment's new token) and
    /// re-inserts the original, so the relay's originally-cached refresh token keeps
    /// working. Caller must hold the per-identity enrollment lock so no concurrent
    /// enrollment observes the intermediate state.
    pub async fn restore_relay_registration(&self, snapshot: RelayRegistrationSnapshot) {
        let registration = snapshot.0;
        match self.lock_state().await {
            Ok(mut store) => {
                if let Some(vk) = registration.relay_verify_key.clone() {
                    store.remove_relay_registration_by_verify_key(&vk);
                }
                store
                    .relay_registrations_by_hash
                    .insert(registration.refresh_token_hash.clone(), registration);
                if let Err(error) = self.persist(&mut store).await {
                    warn!(%error, "failed to persist relay registration restore");
                }
            }
            Err(error) => warn!(%error, "restore_relay_registration: failed to lock state"),
        }
    }

    /// Mint for a relay the caller has already authenticated, leaving room for a per-relay
    /// budget between the two. The relay picks the expiry, so it is capped here.
    pub(crate) fn mint_pairing_ws_token(
        &self,
        relay: &AuthenticatedRelayIdentity,
        request: &PairingWsTokenRequest,
    ) -> Result<PairingWsTokenResponse, String> {
        let now = unix_now();
        if request.expires_at <= now {
            return Err("pairing expires_at is already past".to_string());
        }
        let expires_at = request
            .expires_at
            .min(now.saturating_add(MAX_PAIRING_TICKET_TTL_SECS));
        Ok(PairingWsTokenResponse {
            relay_id: relay.relay_id.clone(),
            broker_room_id: relay.broker_room_id.clone(),
            pairing_join_ticket: self.inner.issuer_key.mint(
                &JoinTicketClaims::pairing_surface_join(
                    &relay.broker_room_id,
                    &request.pairing_id,
                    expires_at,
                ),
            )?,
            pairing_join_ticket_expires_at: expires_at,
        })
    }

    /// Authenticate a relay bearer against `(relay_id, broker_room_id)` with no
    /// side effects. Handlers call this before consulting access policy so an
    /// unauthenticated caller cannot probe which relays have active / released
    /// access — a bad bearer fails identically regardless of that state.
    pub async fn authenticate_relay_bearer(
        &self,
        bearer_token: &str,
        relay_id: &str,
        broker_room_id: &str,
    ) -> Result<(), String> {
        self.authenticate_relay_access(bearer_token, relay_id, broker_room_id)
            .await
            .map(|_| ())
    }

    /// Authenticate and return the opaque same-identity lifecycle lock key.
    pub async fn authenticate_relay_access(
        &self,
        bearer_token: &str,
        relay_id: &str,
        broker_room_id: &str,
    ) -> Result<AuthenticatedRelayIdentity, String> {
        let registration = self
            .authenticate_relay(bearer_token, relay_id, broker_room_id)
            .await?;
        let lifecycle_lock_key = registration
            .relay_verify_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("relay:{}", registration.relay_id));
        Ok(AuthenticatedRelayIdentity {
            relay_id: registration.relay_id,
            broker_room_id: registration.broker_room_id,
            lifecycle_lock_key,
        })
    }

    pub fn ticket_origin(&self) -> &str {
        &self.inner.ticket_origin
    }

    /// Enrolled verify key for a room. Callers must not accept a key supplied
    /// by the joining socket.
    pub async fn enrolled_verify_key_for_room(
        &self,
        broker_room_id: &str,
    ) -> Result<String, String> {
        let store = self
            .lock_state()
            .await
            .map_err(|_| "relay registration could not be read".to_string())?;
        let registration = store
            .relay_registrations_by_hash
            .values()
            .find(|registration| registration.broker_room_id == broker_room_id)
            .ok_or_else(|| "relay registration was not found".to_string())?;
        enrolled_relay_verify_key(registration)
    }

    /// Look up the relay id currently registered for `broker_room_id`, if any.
    /// Used after join-ticket verification so socket access checks bind to the
    /// authenticated registration rather than a caller-chosen victim id.
    pub async fn relay_id_for_broker_room(&self, broker_room_id: &str) -> Option<String> {
        let store = self.lock_state().await.ok()?;
        store
            .relay_registrations_by_hash
            .values()
            .find(|registration| registration.broker_room_id == broker_room_id)
            .map(|registration| registration.relay_id.clone())
    }

    /// After a successful access-strategy release: drop the authenticated relay
    /// registration and every device/client grant scoped to that room. On a
    /// definite persistence failure, restores in-memory state from the pre-mutation
    /// snapshot. Shared Postgres backends keep their own reconciliation in `save`.
    ///
    /// Reload-unknown (save and reconciling reload both failed) always returns
    /// Err even when in-memory looks target-cleared. When a shared save fails but
    /// a successful reload shows this relay's registration and all scoped grants
    /// are already absent, cleanup is treated as effective success. If target
    /// state remains after a successful reconcile, returns a safe unavailable
    /// diagnostic so a still-valid bearer can retry. Sockets are closed by the
    /// caller either way. Errors are safe to map to typed unavailable HTTP bodies
    /// (no path/SQL leakage).
    pub async fn revoke_relay_registration_chain(
        &self,
        bearer_token: &str,
        relay_id: &str,
        broker_room_id: &str,
    ) -> Result<(), String> {
        #[cfg(test)]
        if let Some(hook) = self
            .inner
            .cleanup_pause
            .lock()
            .expect("cleanup pause lock")
            .take()
        {
            hook();
        }

        let mut store = self.lock_state().await?;
        let token_hash = sha256_hex(bearer_token.trim());
        let registration = store
            .relay_registrations_by_hash
            .get(&token_hash)
            .cloned()
            .ok_or_else(|| "relay refresh token is invalid".to_string())?;
        if registration.relay_id != relay_id {
            return Err("relay refresh token does not match relay_id".to_string());
        }
        if registration.broker_room_id != broker_room_id {
            return Err("relay refresh token does not match broker_room_id".to_string());
        }
        let snapshot = store.clone();
        store.relay_registrations_by_hash.remove(&token_hash);
        store
            .relay_registrations_by_hash
            .retain(|_, reg| !(reg.relay_id == relay_id && reg.broker_room_id == broker_room_id));
        store.remove_device_grants(relay_id, Some(broker_room_id), None);
        store.remove_client_relay_grants(relay_id, Some(broker_room_id), None);

        #[cfg(test)]
        if self
            .inner
            .reload_uncertain_fail_remaining
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |n| n.checked_sub(1),
            )
            .is_ok()
        {
            // Leave memory as intended next (target cleared) but report unknown
            // durable outcome — same shape as Postgres save+reload failure.
            return shared_release_cleanup_after_save_error(
                true,
                target_access_fully_cleared(&store, relay_id, broker_room_id),
            );
        }

        #[cfg(test)]
        if self
            .inner
            .save_fail_remaining
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |n| n.checked_sub(1),
            )
            .is_ok()
        {
            *store = snapshot;
            return Err(sanitize_persistence_error(
                "public control-plane persistence failed (local restore)".to_string(),
            ));
        }

        match self.persist(&mut store).await {
            Ok(()) => Ok(()),
            Err(error) => {
                // Definite local rollback for non-shared backends.
                if !self.inner.persistence.shared_backend() {
                    *store = snapshot;
                    return Err(sanitize_persistence_error(error));
                }
                // Shared backend: check reload-unknown FIRST. When both save and
                // reconciling reload failed, memory still holds the intended next
                // (often target-absent) but durable outcome is unknown — never
                // claim success. Only after a successful reconcile (needs_reload
                // false) may target-absent count as effective success.
                let _ = error; // raw backend text never leaves this function
                shared_release_cleanup_after_save_error(
                    self.inner.persistence.reload_forced(),
                    target_access_fully_cleared(&store, relay_id, broker_room_id),
                )
            }
        }
    }

    /// Issue a device grant for a relay-authenticated request.
    ///
    /// `device_limit` is the numeric device cap resolved by the caller's access
    /// strategy (`None` = unlimited). The cap is
    /// enforced only for NET-NEW devices, and BEFORE any state mutation, so:
    ///   - re-registering an existing `device_id` always succeeds (it adds no
    ///     seat, and stays allowed even when already over-limit after a downgrade —
    ///     the grandfather policy), and
    ///   - a rejected grant never drops an existing grant (no remove-then-reject).
    pub async fn issue_device_grant(
        &self,
        bearer_token: &str,
        request: DeviceGrantRequest,
        device_limit: Option<u32>,
    ) -> Result<DeviceGrantResponse, String> {
        let registration = self
            .authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)
            .await?;
        check_id_length("device_id", &request.device_id)?;
        let refresh_token = format!("dref-{}", random_token(40).to_ascii_lowercase());
        let refresh_token_hash = sha256_hex(&refresh_token);
        let created_at = unix_now();

        let mut store = self.lock_state().await?;
        // Cap check happens first and only for genuinely new devices; a
        // re-registration of an existing device is a replace, not a new seat.
        let already_registered = store.has_device_grant(&registration.relay_id, &request.device_id);
        if !already_registered {
            if let Some(limit) = device_limit {
                let current = store.count_device_grants_for_relay(&registration.relay_id);
                if current as u64 >= u64::from(limit) {
                    return Err(format!(
                        "{DEVICE_LIMIT_REACHED_ERROR_PREFIX}: this relay allows {limit} \
                         device(s); remove a device to add a new one"
                    ));
                }
            }
        }
        // Grace lets an already-paired device keep connecting temporarily if it missed
        // the new credential; usage must not extend the replaced token's lifetime.
        let superseded = store
            .grants_by_hash
            .values()
            .find(|grant| {
                grant.relay_id == registration.relay_id && grant.device_id == request.device_id
            })
            .map(|previous| {
                carry_superseded(
                    &previous.superseded,
                    previous.refresh_token_hash.clone(),
                    created_at,
                    self.inner.rotation_grace_secs,
                )
            })
            .unwrap_or_default();
        store.remove_device_grants(&registration.relay_id, None, Some(&request.device_id));
        store.grants_by_hash.insert(
            refresh_token_hash.clone(),
            PersistedDeviceGrant {
                relay_id: registration.relay_id.clone(),
                broker_room_id: registration.broker_room_id.clone(),
                device_id: request.device_id.clone(),
                refresh_token_hash,
                created_at,
                last_seen: Some(created_at),
                superseded,
            },
        );
        self.persist(&mut store).await?;

        let issued =
            self.issue_device_ws_token_for_registration(&registration, &request.device_id)?;
        Ok(DeviceGrantResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            device_id: request.device_id,
            device_refresh_token: refresh_token,
            device_ws_token: issued.device_ws_token,
            device_ws_token_expires_at: issued.device_ws_token_expires_at,
        })
    }

    /// Aggregate per-relay device/client counts for the operator stats endpoint.
    /// Read-only. `top_n` caps the returned relay rows (0 = unlimited); the busiest
    /// relays (by device count) are kept.
    pub async fn admin_stats(&self, top_n: usize) -> Result<AdminStats, String> {
        let store = self.lock_state().await?;

        // Device counts + freshest last_seen per relay.
        let mut device_counts: HashMap<&str, u64> = HashMap::new();
        let mut last_seen: HashMap<&str, u64> = HashMap::new();
        for grant in store.grants_by_hash.values() {
            *device_counts.entry(grant.relay_id.as_str()).or_default() += 1;
            if let Some(seen) = grant.last_seen {
                let entry = last_seen.entry(grant.relay_id.as_str()).or_default();
                if seen > *entry {
                    *entry = seen;
                }
            }
        }

        // Distinct client identities granted to each relay.
        let mut clients_per_relay: HashMap<&str, BTreeSet<&str>> = HashMap::new();
        for grant in store.client_relay_grants_by_key.values() {
            clients_per_relay
                .entry(grant.relay_id.as_str())
                .or_default()
                .insert(grant.client_id.as_str());
        }

        // Registration lookup (label + room). One relay_id → one registration.
        let registrations: HashMap<&str, &PersistedRelayRegistration> = store
            .relay_registrations_by_hash
            .values()
            .map(|reg| (reg.relay_id.as_str(), reg))
            .collect();

        // The relay set is the union of registered relays and any relay that holds
        // device OR client grants — so an orphaned-grant relay (registration gone,
        // grants linger) still surfaces, which is exactly the abuse case to spot.
        // Omitting any grant class here would silently undercount `totals.relays`.
        let mut relay_ids: BTreeSet<&str> = BTreeSet::new();
        relay_ids.extend(registrations.keys().copied());
        relay_ids.extend(device_counts.keys().copied());
        relay_ids.extend(clients_per_relay.keys().copied());

        let mut rows: Vec<AdminRelayStat> = relay_ids
            .into_iter()
            .map(|relay_id| {
                let registration = registrations.get(relay_id);
                AdminRelayStat {
                    relay_id: relay_id.to_string(),
                    broker_room_id: registration
                        .map(|reg| reg.broker_room_id.clone())
                        .unwrap_or_default(),
                    relay_label: registration.and_then(|reg| reg.relay_label.clone()),
                    device_count: device_counts.get(relay_id).copied().unwrap_or(0),
                    client_count: clients_per_relay
                        .get(relay_id)
                        .map(|clients| clients.len() as u64)
                        .unwrap_or(0),
                    last_seen: last_seen.get(relay_id).copied(),
                }
            })
            .collect();

        let totals = AdminTotals {
            relays: rows.len() as u64,
            devices: store.grants_by_hash.len() as u64,
            clients: store.client_registrations_by_hash.len() as u64,
        };

        // Busiest first (device_count desc, then client_count desc), then a stable
        // relay_id tiebreak so the output is deterministic.
        rows.sort_by(|a, b| {
            b.device_count
                .cmp(&a.device_count)
                .then(b.client_count.cmp(&a.client_count))
                .then(a.relay_id.cmp(&b.relay_id))
        });
        if top_n > 0 {
            rows.truncate(top_n);
        }

        Ok(AdminStats {
            totals,
            relays: rows,
        })
    }

    pub async fn issue_client_grant(
        &self,
        bearer_token: &str,
        request: ClientGrantRequest,
    ) -> Result<ClientGrantResponse, String> {
        let registration = self
            .authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)
            .await?;
        let client_verify_key = trimmed_option_string(Some(request.client_verify_key))
            .ok_or_else(|| "client verify key is required".to_string())?;
        validate_relay_verify_key(&client_verify_key)?;
        check_id_length("device_id", &request.device_id)?;
        let client_label = compact_label(request.client_label);
        let device_label = compact_label(request.device_label);
        // Nothing durable is written here. The relay is only attesting that this
        // key may reach it; until the key's owner signs, there is no identity to
        // rotate and no grant row to enumerate. Writing either at this point is
        // what let any relay speak for any client it could name.
        let claim_id = format!("ccl-{}", random_token(24).to_ascii_lowercase());
        let nonce = format!("cn-{}", random_token(40).to_ascii_lowercase());
        let expires_at = unix_now().saturating_add(DEFAULT_CLIENT_CLAIM_TTL_SECS);
        {
            // One unredeemed claim per relay bounds the map by relay count, and a
            // relay asking again can only cancel its own pairing, never another's.
            let mut pending = self.inner.pending_client_claims.lock().await;
            let now = unix_now();
            let mut cancelled = false;
            pending.retain(|_, claim| {
                let live = claim.expires_at > now;
                if claim.relay_id == registration.relay_id {
                    cancelled |= live;
                    return false;
                }
                live
            });
            if cancelled {
                warn!(
                    relay_id = %registration.relay_id,
                    "new client claim cancelled this relay's unredeemed one"
                );
            }
            pending.insert(
                claim_id.clone(),
                PendingClientClaim {
                    relay_id: registration.relay_id.clone(),
                    broker_room_id: registration.broker_room_id.clone(),
                    device_id: request.device_id.clone(),
                    client_verify_key,
                    client_label,
                    device_label,
                    relay_label: registration.relay_label.clone(),
                    nonce: nonce.clone(),
                    expires_at,
                },
            );
        }

        Ok(ClientGrantResponse {
            claim_id,
            claim_nonce: nonce,
            claim_expires_at: expires_at,
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            device_id: request.device_id,
            relay_label: registration.relay_label.clone(),
        })
    }

    /// Exchange a relay's attestation for a client credential, on proof that the
    /// caller holds the private half of the attested key.
    ///
    /// Unauthenticated by design: the signature *is* the authentication, and it
    /// is the client's, not the relay's. The token is returned straight to the
    /// browser over TLS and never transits a relay.
    pub async fn claim_client_identity(
        &self,
        request: ClientClaimRequest,
    ) -> Result<ClientClaimResponse, String> {
        let claim_id = trimmed_option_string(Some(request.claim_id))
            .ok_or_else(|| "client claim id is required".to_string())?;
        let claim_signature = trimmed_option_string(Some(request.claim_signature))
            .ok_or_else(|| "client claim signature is required".to_string())?;

        // Removed up front so a claim reference is single-use: a replay finds
        // nothing, whether or not the signature checks out.
        let pending = {
            let mut claims = self.inner.pending_client_claims.lock().await;
            let now = unix_now();
            claims.retain(|_, claim| claim.expires_at > now);
            claims
                .remove(&claim_id)
                .ok_or_else(|| "client claim is invalid".to_string())?
        };
        if pending.expires_at <= unix_now() {
            return Err("client claim has expired".to_string());
        }
        verify_client_claim_signature(
            &pending.client_verify_key,
            &claim_id,
            &pending.nonce,
            &pending.relay_id,
            &claim_signature,
        )?;

        let created_at = unix_now();
        let mut store = self.lock_state().await?;
        let (client_id, client_refresh_token) = store.issue_or_rotate_client_identity(
            &pending.client_verify_key,
            pending.client_label,
            created_at,
            self.inner.rotation_grace_secs,
        );
        store.upsert_client_relay_grant(PersistedClientRelayGrant {
            client_id: client_id.clone(),
            relay_id: pending.relay_id.clone(),
            broker_room_id: pending.broker_room_id.clone(),
            device_id: pending.device_id.clone(),
            granted_at: created_at,
            relay_label: pending.relay_label.clone(),
            device_label: pending.device_label,
        });
        self.persist(&mut store).await?;

        Ok(ClientClaimResponse {
            client_id,
            client_refresh_token,
            relay_id: pending.relay_id,
            broker_room_id: pending.broker_room_id,
            device_id: pending.device_id,
            relay_label: pending.relay_label,
        })
    }

    pub async fn list_client_relays(
        &self,
        bearer_token: &str,
    ) -> Result<ClientRelaysResponse, String> {
        let client = self.authenticate_client(bearer_token).await?;
        let store = self.lock_state().await?;
        let mut relays = store.client_relays(&client.client_id);
        relays.sort_by(|left, right| {
            right
                .granted_at
                .cmp(&left.granted_at)
                .then_with(|| left.relay_id.cmp(&right.relay_id))
        });
        Ok(ClientRelaysResponse {
            client_id: client.client_id,
            relays,
        })
    }

    pub async fn issue_device_session(
        &self,
        bearer_token: &str,
    ) -> Result<DeviceSessionResponse, String> {
        self.issue_device_session_inner(bearer_token, None).await
    }

    /// Room-scoped establish: the resolved grant must belong to `expected_room`,
    /// otherwise the token is rejected with the generic invalid-token error.
    pub async fn issue_device_session_scoped(
        &self,
        bearer_token: &str,
        expected_room: &str,
    ) -> Result<DeviceSessionResponse, String> {
        self.issue_device_session_inner(bearer_token, Some(expected_room))
            .await
    }

    async fn issue_device_session_inner(
        &self,
        bearer_token: &str,
        expected_room: Option<&str>,
    ) -> Result<DeviceSessionResponse, String> {
        // The room check lives inside `_scoped` (before the grace-window bump), so
        // a wrong-room establish is fully side-effect-free.
        let grant = self
            .device_grant_from_refresh_token_scoped(bearer_token, expected_room)
            .await?;
        Ok(DeviceSessionResponse {
            broker_room_id: grant.broker_room_id,
            device_id: grant.device_id,
            cookie_session: true,
        })
    }

    pub async fn issue_client_session(
        &self,
        bearer_token: &str,
    ) -> Result<ClientSessionResponse, String> {
        let client = self.authenticate_client(bearer_token).await?;
        Ok(ClientSessionResponse {
            client_id: client.client_id,
            cookie_session: true,
        })
    }

    pub async fn rotate_client_identity(
        &self,
        bearer_token: &str,
    ) -> Result<(String, String), String> {
        let token_hash = sha256_hex(bearer_token.trim());
        let now = unix_now();
        let Some((mut store, (primary_hash, client))) = self
            .find_credential(CredentialKind::Client, &token_hash, |store| {
                find_client_identity_for_token(store, &token_hash, now)
            })
            .await?
        else {
            return Err("client refresh token is invalid".to_string());
        };
        // Otherwise a stolen old token could exchange itself into indefinite access.
        if primary_hash != token_hash {
            return Err("client refresh token is invalid; signing proof required".to_string());
        }
        let refreshed_token =
            store.rotate_client_identity(&client, unix_now(), self.inner.rotation_grace_secs);
        self.persist(&mut store).await?;
        Ok((client.client_id, refreshed_token))
    }

    pub async fn create_credential_refresh_challenge(
        &self,
        request: CredentialRefreshChallengeRequest,
        broker_origin: &str,
    ) -> Result<CredentialRefreshChallengeResponse, String> {
        check_id_length("client_id", &request.client_id)?;
        check_id_length("nonce", &request.nonce)?;
        if request.nonce.is_empty() {
            return Err("credential refresh is invalid".to_string());
        }
        if let Some(room) = &request.broker_room_id {
            check_id_length("broker_room_id", room)?;
        }
        let Some((store, client)) = self
            .find_credential(CredentialKind::ClientId, &request.client_id, |store| {
                store.client_identity_for_id(&request.client_id)
            })
            .await?
        else {
            return Err("credential refresh is invalid".to_string());
        };
        // Pairing metadata and challenge capacity belong only to the key holder.
        let signature =
            decode_base64_array::<64>(&request.signature, "credential refresh is invalid")?;
        parse_relay_verifying_key(&client.client_verify_key)?
            .verify(
                credential_refresh_init_message(&request, broker_origin).as_bytes(),
                &Signature::from_bytes(&signature),
            )
            .map_err(|_| "credential refresh is invalid".to_string())?;
        let device_id = request
            .broker_room_id
            .as_deref()
            .map(|room| {
                refresh_device_for_client(&store, &client.client_id, room)
                    .map(|(device, _)| device.device_id)
            })
            .transpose()?;
        if request.device_id.is_some() && request.device_id != device_id {
            return Err("credential refresh is invalid".to_string());
        }
        drop(store);
        let now = unix_now();
        let challenge = CredentialRefreshChallengeResponse {
            broker_origin: broker_origin.to_string(),
            challenge_id: format!("crf-{}", random_token(24).to_ascii_lowercase()),
            nonce: random_token(40),
            client_id: client.client_id,
            broker_room_id: request.broker_room_id,
            device_id,
            expires_at: now.saturating_add(DEFAULT_CLIENT_CLAIM_TTL_SECS),
        };
        let mut pending = self.inner.pending_credential_refreshes.lock().await;
        pending.retain(|_, entry| entry.challenge.expires_at > now);
        let client_pending: Vec<_> = pending
            .values()
            .filter(|entry| entry.challenge.client_id == challenge.client_id)
            .collect();
        if let Some(existing) = client_pending.iter().find(|entry| {
            entry.request_nonce == request.nonce
                && entry.challenge.broker_origin == broker_origin
                && entry.challenge.broker_room_id == challenge.broker_room_id
        }) {
            return Ok(existing.challenge.clone());
        }
        if client_pending.len() >= MAX_PENDING_REFRESHES_PER_CLIENT {
            return Err(
                "too many pending credential refreshes for this client; retry shortly".to_string(),
            );
        }
        if pending.len() >= MAX_PENDING_CREDENTIAL_REFRESHES {
            return Err("too many pending credential refreshes; retry shortly".to_string());
        }
        pending.insert(
            challenge.challenge_id.clone(),
            PendingCredentialRefresh {
                challenge: challenge.clone(),
                client_verify_key: client.client_verify_key,
                request_nonce: request.nonce,
            },
        );
        Ok(challenge)
    }

    pub async fn refresh_credentials(
        &self,
        request: CredentialRefreshRequest,
        broker_origin: &str,
    ) -> Result<(CredentialRefreshResponse, String, Option<String>), String> {
        let now = unix_now();
        let pending = {
            let mut pending = self.inner.pending_credential_refreshes.lock().await;
            pending.retain(|_, entry| entry.challenge.expires_at > now);
            // A restart or another broker can lose a challenge without revoking its client.
            pending.remove(&request.challenge_id).ok_or_else(|| {
                "credential refresh challenge is unavailable; request a new challenge".to_string()
            })?
        };
        let challenge = pending.challenge;
        if challenge.broker_origin != broker_origin {
            return Err("credential refresh is invalid".to_string());
        }
        let signature =
            decode_base64_array::<64>(&request.signature, "credential refresh is invalid")?;
        parse_relay_verifying_key(&pending.client_verify_key)?
            .verify(
                credential_refresh_message(&challenge).as_bytes(),
                &Signature::from_bytes(&signature),
            )
            .map_err(|_| "credential refresh is invalid".to_string())?;

        let mut store = self.lock_state().await?;
        // Check live authorization after the signature, so a pending challenge cannot undo a revoke.
        if self.miss_may_be_stale() {
            *store = self.load_full_state().await?;
        }
        let client = store
            .client_identity_for_id(&challenge.client_id)
            .filter(|client| client.client_verify_key == pending.client_verify_key)
            .ok_or_else(|| "credential refresh is invalid".to_string())?;
        let device = challenge
            .broker_room_id
            .as_deref()
            .map(|room| {
                let (device, registration) =
                    refresh_device_for_client(&store, &client.client_id, room)?;
                if Some(&device.device_id) != challenge.device_id.as_ref() {
                    return Err("credential refresh is invalid".to_string());
                }
                let ws =
                    self.issue_device_ws_token_for_registration(&registration, &device.device_id)?;
                Ok((device, ws))
            })
            .transpose()?;
        let client_token =
            store.rotate_client_identity(&client, now, self.inner.rotation_grace_secs);
        let (device_token, device_ws) = if let Some((mut device, ws)) = device {
            let token = format!("dref-{}", random_token(40).to_ascii_lowercase());
            device.superseded = carry_superseded(
                &device.superseded,
                device.refresh_token_hash.clone(),
                now,
                self.inner.rotation_grace_secs,
            );
            store.grants_by_hash.remove(&device.refresh_token_hash);
            device.refresh_token_hash = sha256_hex(&token);
            device.created_at = now;
            device.last_seen = Some(now);
            store
                .grants_by_hash
                .insert(device.refresh_token_hash.clone(), device);
            (Some(token), Some(ws))
        } else {
            (None, None)
        };
        self.persist(&mut store).await?;
        Ok((
            CredentialRefreshResponse {
                client_id: client.client_id,
                cookie_session: true,
                device: device_ws,
            },
            client_token,
            device_token,
        ))
    }

    pub async fn revoke_client_identity(
        &self,
        bearer_token: &str,
    ) -> Result<ClientIdentityRevokeResponse, String> {
        let client = self.authenticate_client(bearer_token).await?;
        let mut store = self.lock_state().await?;
        let revoked_identity_count = store.remove_client_identity_by_client_id(&client.client_id);
        let revoked_grant_count = store.remove_client_relay_grants_by_client_id(&client.client_id);
        if revoked_identity_count > 0 || revoked_grant_count > 0 {
            self.persist(&mut store).await?;
        }
        Ok(ClientIdentityRevokeResponse {
            client_id: client.client_id,
            revoked: revoked_identity_count > 0,
            revoked_identity_count,
            revoked_grant_count,
        })
    }

    pub async fn issue_device_ws_token(
        &self,
        bearer_token: &str,
    ) -> Result<DeviceWsTokenResponse, String> {
        self.issue_device_ws_token_inner(bearer_token, None).await
    }

    /// A sibling room's credential must not affect this room's state.
    /// The generic error keeps the endpoint from revealing which rooms exist.
    pub async fn issue_device_ws_token_scoped(
        &self,
        bearer_token: &str,
        expected_room: &str,
    ) -> Result<DeviceWsTokenResponse, String> {
        self.issue_device_ws_token_inner(bearer_token, Some(expected_room))
            .await
    }

    async fn issue_device_ws_token_inner(
        &self,
        bearer_token: &str,
        expected_room: Option<&str>,
    ) -> Result<DeviceWsTokenResponse, String> {
        let now = unix_now();
        let token_hash = sha256_hex(bearer_token.trim());
        let grant = {
            let Some((mut store, (primary_hash, grant))) = self
                .find_credential(CredentialKind::Device, &token_hash, |store| {
                    find_device_grant_for_token(store, &token_hash, now)
                })
                .await?
            else {
                return Err("device refresh token is invalid".to_string());
            };
            if let Some(expected) = expected_room {
                if grant.broker_room_id != expected {
                    return Err("device refresh token is invalid".to_string());
                }
            }
            // Throttled activity marker: at most one durable write per device per
            // LAST_SEEN_THROTTLE_SECS, via a targeted single-row UPDATE that stays
            // off the diff-based save() path entirely (this is the hottest write).
            if should_touch_last_seen(grant.last_seen, now) {
                if let Some(entry) = store.grants_by_hash.get_mut(&primary_hash) {
                    entry.last_seen = Some(now);
                }
                // Best-effort advisory marker: a failed write must NOT deny the
                // token refresh. Log and continue (on Postgres the next reload
                // discards the in-memory bump, so it simply retries next time).
                if let Err(error) = self
                    .inner
                    .persistence
                    .touch_device_last_seen(&primary_hash, now)
                    .await
                {
                    warn!(%error, "failed to persist device last_seen; continuing");
                }
            }
            grant
        };
        let registration = PersistedRelayRegistration {
            relay_id: grant.relay_id,
            broker_room_id: grant.broker_room_id,
            refresh_token_hash: String::new(),
            created_at: grant.created_at,
            relay_label: None,
            relay_verify_key: None,
        };
        self.issue_device_ws_token_for_registration(&registration, &grant.device_id)
    }

    pub async fn revoke_device_grant(
        &self,
        bearer_token: &str,
        device_id: &str,
        request: DeviceGrantRevokeRequest,
    ) -> Result<DeviceGrantRevokeResponse, String> {
        let registration = self
            .authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)
            .await?;
        let mut store = self.lock_state().await?;
        let revoked_grant_count = store.remove_device_grants(
            &registration.relay_id,
            Some(&registration.broker_room_id),
            Some(device_id),
        );
        let revoked_client_grant_count = store.remove_client_relay_grants(
            &registration.relay_id,
            Some(&registration.broker_room_id),
            Some(device_id),
        );
        // Persist if EITHER removal happened, so an orphan client_relay_grant
        // (no matching device grant) is still cleaned up durably.
        if revoked_grant_count > 0 || revoked_client_grant_count > 0 {
            self.persist(&mut store).await?;
        }
        Ok(DeviceGrantRevokeResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            device_id: device_id.to_string(),
            revoked: revoked_grant_count > 0,
            revoked_grant_count,
        })
    }

    pub async fn revoke_other_device_grants(
        &self,
        bearer_token: &str,
        request: DeviceGrantBulkRevokeRequest,
    ) -> Result<DeviceGrantBulkRevokeResponse, String> {
        let registration = self
            .authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)
            .await?;
        let mut store = self.lock_state().await?;
        let revoked_device_ids = store.remove_all_other_device_grants(
            &registration.relay_id,
            &registration.broker_room_id,
            &request.keep_device_id,
        );
        store.remove_all_other_client_relay_grants(
            &registration.relay_id,
            &registration.broker_room_id,
            &request.keep_device_id,
        );
        if !revoked_device_ids.is_empty() {
            self.persist(&mut store).await?;
        }
        Ok(DeviceGrantBulkRevokeResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            kept_device_id: request.keep_device_id,
            revoked_count: revoked_device_ids.len(),
            revoked_device_ids,
        })
    }

    async fn lock_state(&self) -> Result<MutexGuard<'_, PublicControlStateStore>, String> {
        let mut store = self.inner.state.lock().await;
        if self.reload_before_use() {
            // Memory cannot be served here, but retrying a failing load on every request
            // would hold this lock and hit the database for the whole outage.
            let last = *self.last_full_load();
            if last.is_some_and(|load| {
                !load.succeeded
                    && load.finished + self.inner.miss_reload_min_interval > Instant::now()
            }) {
                return Err(RELOAD_FAILED_ERROR.to_string());
            }
            *store = self.load_full_state().await?;
        }
        Ok(store)
    }

    /// Driver text can say "invalid", and the HTTP layer maps that to a terminal 401.
    async fn persist(&self, store: &mut PublicControlStateStore) -> Result<(), String> {
        self.persist_raw(store).await.map_err(|error| {
            warn!(%error, "public control-plane save failed");
            sanitize_persistence_error(error)
        })
    }

    async fn persist_raw(&self, store: &mut PublicControlStateStore) -> Result<(), String> {
        #[cfg(test)]
        if self.inner.persistence_down.load(Ordering::SeqCst) {
            return Err(SIMULATED_DATABASE_ERROR.to_string());
        }
        self.inner.persistence.save(store).await
    }

    fn reload_before_use(&self) -> bool {
        #[cfg(test)]
        if self.inner.force_reload_before_use {
            return true;
        }
        self.inner.persistence.reload_before_use()
    }

    async fn load_full_state(&self) -> Result<PublicControlStateStore, String> {
        let started = Instant::now();
        #[cfg(test)]
        self.inner.full_load_count.fetch_add(1, Ordering::SeqCst);
        let loaded = self.persistence_load().await;
        *self.last_full_load() = Some(FullLoad {
            started,
            finished: Instant::now(),
            succeeded: loaded.is_ok(),
        });
        // Same reason as the probe: raw driver text must not reach the client.
        loaded.map_err(|error| {
            warn!(%error, "public control-plane reload failed");
            RELOAD_FAILED_ERROR.to_string()
        })
    }

    async fn persistence_load(&self) -> Result<PublicControlStateStore, String> {
        #[cfg(test)]
        {
            let started = Instant::now();
            tokio::time::sleep(self.inner.load_delay).await;
            let loaded = if self.inner.persistence_down.load(Ordering::SeqCst) {
                Err(SIMULATED_DATABASE_ERROR.to_string())
            } else {
                self.inner.persistence.load().await
            };
            self.inner
                .load_log
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((started, Instant::now()));
            loaded
        }
        #[cfg(not(test))]
        self.inner.persistence.load().await
    }

    fn last_full_load(&self) -> std::sync::MutexGuard<'_, Option<FullLoad>> {
        self.inner
            .last_full_load
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// On a shared backend a miss may only mean this instance is behind, so only a probe
    /// made after the miss, or a load begun after a positive probe, can call a token absent.
    /// A confirmed hash is in memory after one reload, so each live hash buys at most one.
    async fn find_credential<T>(
        &self,
        kind: CredentialKind,
        token_hash: &str,
        lookup: impl Fn(&PublicControlStateStore) -> Option<T>,
    ) -> Result<Option<(MutexGuard<'_, PublicControlStateStore>, T)>, String> {
        let store = self.lock_state().await?;
        if let Some(found) = lookup(&store) {
            return Ok(Some((store, found)));
        }
        if !self.miss_may_be_stale() {
            return Ok(None);
        }
        drop(store);
        if !self.probe_credential(kind, token_hash).await? {
            return Ok(None);
        }
        let observed = Instant::now();
        loop {
            let mut store = self.lock_state().await?;
            if let Some(found) = lookup(&store) {
                return Ok(Some((store, found)));
            }
            let last = *self.last_full_load();
            if let Some(load) = last {
                if load.started >= observed {
                    // Read the table after the probe saw the token, so it is gone since.
                    return if load.succeeded {
                        Ok(None)
                    } else {
                        Err(RELOAD_FAILED_ERROR.to_string())
                    };
                }
                let ready_at = load.finished + self.inner.miss_reload_min_interval;
                if ready_at > Instant::now() {
                    drop(store);
                    tokio::time::sleep_until(ready_at).await;
                    continue;
                }
            }
            *store = self.load_full_state().await?;
            let found = lookup(&store);
            return Ok(found.map(|found| (store, found)));
        }
    }

    /// Driver text can say "invalid", which the HTTP layer would turn into a terminal 401.
    async fn probe_credential(
        &self,
        kind: CredentialKind,
        token_hash: &str,
    ) -> Result<bool, String> {
        self.probe_credential_raw(kind, token_hash)
            .await
            .map_err(|error| {
                warn!(%error, "public control-plane credential probe failed");
                PROBE_FAILED_ERROR.to_string()
            })
    }

    async fn probe_credential_raw(
        &self,
        kind: CredentialKind,
        token_hash: &str,
    ) -> Result<bool, String> {
        #[cfg(test)]
        {
            self.inner.probe_count.fetch_add(1, Ordering::SeqCst);
            if let Some(release) = &self.inner.probe_release {
                release.acquire().await.expect("probe release").forget();
            }
            if self.inner.force_probe_hit {
                return Ok(true);
            }
            if self.inner.persistence_down.load(Ordering::SeqCst) {
                return Err(SIMULATED_DATABASE_ERROR.to_string());
            }
        }
        self.inner
            .persistence
            .credential_exists(kind, token_hash, unix_now())
            .await
    }

    fn miss_may_be_stale(&self) -> bool {
        #[cfg(test)]
        if self.inner.force_shared_backend {
            return true;
        }
        self.inner.persistence.shared_backend()
    }

    async fn authenticate_relay(
        &self,
        bearer_token: &str,
        relay_id: &str,
        broker_room_id: &str,
    ) -> Result<PersistedRelayRegistration, String> {
        let token_hash = sha256_hex(bearer_token.trim());
        let registration = self
            .find_credential(CredentialKind::Relay, &token_hash, |store| {
                store.relay_registrations_by_hash.get(&token_hash).cloned()
            })
            .await?
            .map(|(_store, registration)| registration)
            .ok_or_else(|| "relay refresh token is invalid".to_string())?;
        if registration.relay_id != relay_id {
            return Err("relay refresh token does not match relay_id".to_string());
        }
        if registration.broker_room_id != broker_room_id {
            return Err("relay refresh token does not match broker_room_id".to_string());
        }
        Ok(registration)
    }

    async fn authenticate_client(
        &self,
        bearer_token: &str,
    ) -> Result<PersistedClientIdentity, String> {
        let token_hash = sha256_hex(bearer_token.trim());
        let now = unix_now();
        let Some((_store, (_, identity))) = self
            .find_credential(CredentialKind::Client, &token_hash, |store| {
                find_client_identity_for_token(store, &token_hash, now)
            })
            .await?
        else {
            return Err("client refresh token is invalid".to_string());
        };
        Ok(identity)
    }

    fn issue_device_ws_token_for_registration(
        &self,
        registration: &PersistedRelayRegistration,
        device_id: &str,
    ) -> Result<DeviceWsTokenResponse, String> {
        let expires_at = unix_now().saturating_add(self.inner.device_ws_ttl_secs);
        Ok(DeviceWsTokenResponse {
            broker_room_id: registration.broker_room_id.clone(),
            device_id: device_id.to_string(),
            device_ws_token: self
                .inner
                .issuer_key
                .mint(&JoinTicketClaims::device_surface_join(
                    &registration.broker_room_id,
                    device_id,
                    Some(expires_at),
                ))?,
            device_ws_token_expires_at: expires_at,
        })
    }

    async fn device_grant_from_refresh_token_scoped(
        &self,
        bearer_token: &str,
        expected_room: Option<&str>,
    ) -> Result<PersistedDeviceGrant, String> {
        let token_hash = sha256_hex(bearer_token.trim());
        let now = unix_now();
        let Some((_store, (_, grant))) = self
            .find_credential(CredentialKind::Device, &token_hash, |store| {
                find_device_grant_for_token(store, &token_hash, now)
            })
            .await?
        else {
            return Err("device refresh token is invalid".to_string());
        };
        if let Some(expected) = expected_room {
            if grant.broker_room_id != expected {
                return Err("device refresh token is invalid".to_string());
            }
        }
        Ok(grant)
    }

    pub async fn device_refresh_token_matches_room(
        &self,
        bearer_token: &str,
        expected_room: &str,
    ) -> Result<bool, String> {
        let token_hash = sha256_hex(bearer_token.trim());
        let now = unix_now();
        Ok(self
            .find_credential(CredentialKind::Device, &token_hash, |store| {
                find_device_grant_for_token(store, &token_hash, now)
            })
            .await?
            .is_some_and(|(_store, (_, grant))| grant.broker_room_id == expected_room))
    }

    async fn issue_relay_registration_for_verify_key(
        &self,
        relay_verify_key: &str,
        relay_label: Option<String>,
    ) -> Result<RelayEnrollmentResponse, String> {
        let created_at = unix_now();
        let mut store = self.lock_state().await?;
        let (relay_id, broker_room_id) =
            if let Some(existing) = store.registration_for_verify_key(relay_verify_key) {
                let relay_id = existing.relay_id.clone();
                let broker_room_id = existing.broker_room_id.clone();
                store.remove_relay_registration_by_verify_key(relay_verify_key);
                (relay_id, broker_room_id)
            } else {
                let (relay_id, broker_room_id) = store.issue_new_relay_ids();
                (relay_id, broker_room_id)
            };
        let relay_refresh_token = format!("rref-{}", random_token(40).to_ascii_lowercase());
        let refresh_token_hash = sha256_hex(&relay_refresh_token);
        let registration = PersistedRelayRegistration {
            relay_id: relay_id.clone(),
            broker_room_id: broker_room_id.clone(),
            refresh_token_hash: refresh_token_hash.clone(),
            created_at,
            relay_label: relay_label.clone(),
            relay_verify_key: Some(relay_verify_key.to_string()),
        };
        store
            .relay_registrations_by_hash
            .insert(refresh_token_hash, registration);
        self.persist(&mut store).await?;
        Ok(RelayEnrollmentResponse {
            relay_id,
            broker_room_id,
            relay_refresh_token,
            created_at,
            relay_label,
        })
    }

    async fn prune_expired_relay_enrollment_challenges(&self) {
        let now = unix_now();
        self.inner
            .relay_enrollment_challenges
            .lock()
            .await
            .retain(|_, challenge| challenge.expires_at > now);
    }
}

impl PublicControlPersistence {
    async fn from_config(
        state_path: Option<String>,
        postgres_url: Option<String>,
    ) -> Result<Self, String> {
        let state_path = trimmed_option_string(state_path).map(PathBuf::from);
        let postgres_url = trimmed_option_string(postgres_url);
        match (state_path, postgres_url) {
            (Some(_), Some(_)) => Err(format!(
                "set only one of {PUBLIC_STATE_PATH_ENV} or {PUBLIC_POSTGRES_URL_ENV}"
            )),
            (Some(path), None) => {
                info!(
                    backend = "json",
                    path = %path.display(),
                    "public control-plane persistence: JSON file"
                );
                Ok(Self::Json(path))
            }
            (None, Some(url)) => {
                let db_cfg = PublicControlDbConfig::from_env()?;
                info!(
                    backend = "postgres",
                    target = %redact_postgres_url(&url),
                    "public control-plane persistence: Postgres (connecting)"
                );
                let query_timeout_ms = db_cfg.query_timeout.as_millis();
                let pool = PgPoolOptions::new()
                    .max_connections(db_cfg.max_connections)
                    .acquire_timeout(db_cfg.acquire_timeout)
                    .after_connect(move |connection, _metadata| {
                        Box::pin(async move {
                            sqlx::query(&format!("SET statement_timeout = {query_timeout_ms}"))
                                .execute(connection)
                                .await?;
                            Ok(())
                        })
                    })
                    .connect(&url)
                    .await
                    .map_err(|error| {
                        format!("failed to connect to {PUBLIC_POSTGRES_URL_ENV}: {error}")
                    })?;
                initialize_postgres_public_control_schema(&pool).await?;
                info!(
                    backend = "postgres",
                    target = %redact_postgres_url(&url),
                    "public control-plane persistence: Postgres schema ready"
                );
                let reload_before_use = std::env::var(PUBLIC_POSTGRES_RELOAD_ENV)
                    .ok()
                    .map(|value| {
                        let value = value.trim();
                        value == "1" || value.eq_ignore_ascii_case("true")
                    })
                    .unwrap_or(false);
                if reload_before_use {
                    info!("public control-plane: reload-before-use ON (multi-instance mode)");
                }
                let gate = PublicControlDbGate::new(db_cfg.concurrency, db_cfg.query_timeout)?;
                Ok(Self::Postgres {
                    pool,
                    gate,
                    reload_before_use,
                    last_saved: Arc::new(Mutex::new(PublicControlStateStore::default())),
                    needs_reload: Arc::new(AtomicBool::new(false)),
                })
            }
            (None, None) => {
                warn!(
                    "public control-plane persistence: in-memory only (set {PUBLIC_STATE_PATH_ENV} or {PUBLIC_POSTGRES_URL_ENV} to persist)"
                );
                Ok(Self::InMemory)
            }
        }
    }

    fn has_persistent_state(&self) -> bool {
        !matches!(self, Self::InMemory)
    }

    async fn load(&self) -> Result<PublicControlStateStore, String> {
        match self {
            Self::InMemory => Ok(PublicControlStateStore::default()),
            Self::Json(path) => load_public_control_json(path).await,
            Self::Postgres {
                pool,
                gate,
                last_saved,
                needs_reload,
                ..
            } => {
                let store = gate
                    .run(load_public_control_postgres(pool))
                    .await
                    .map_err(PublicControlDbGateError::into_message)?;
                // Snapshot mirrors exactly what is in the DB right now, so the
                // next save() diffs against reality (not an empty baseline).
                *last_saved.lock().await = store.clone();
                // A successful reload reconciled memory with the DB, clearing any
                // pending "state indeterminate" marker set by a failed save.
                needs_reload.store(false, Ordering::SeqCst);
                Ok(store)
            }
        }
    }

    /// Persist the live `state` (the intended `next`). Takes `&mut` so the failure
    /// path can reconcile memory with the database.
    ///
    /// On a save error the outcome is not necessarily a rollback: a COMMIT failure
    /// is AMBIGUOUS — Postgres may have durably committed `next` even though the
    /// client got an error (connection dropped after COMMIT, before the ack). So we
    /// re-read the authoritative DB state and decide from what actually persisted:
    ///   - DB == `next`  → the commit landed → return `Ok(())` so the caller
    ///     delivers the freshly-issued credential (it was NOT stranded);
    ///   - DB == `prev`  → definite rollback → restore memory, return the error;
    ///   - DB == neither → indeterminate → reconcile memory to the DB, return error;
    ///   - reload fails  → outcome unknown → force a repair-reload on the next op.
    async fn save(&self, state: &mut PublicControlStateStore) -> Result<(), String> {
        match self {
            Self::InMemory => Ok(()),
            Self::Json(path) => save_public_control_json(path, state).await,
            Self::Postgres {
                pool,
                gate,
                last_saved,
                needs_reload,
                ..
            } => {
                // Diff the live state against the last-persisted snapshot and write
                // only the rows that changed. Hold the snapshot lock across the
                // write so it advances atomically with the DB.
                let mut snapshot = last_saved.lock().await;
                match gate
                    .run(save_public_control_postgres(pool, &snapshot, state))
                    .await
                {
                    Ok(()) => {
                        *snapshot = state.clone();
                        Ok(())
                    }
                    // Admission failed before a DB operation began, so the durable
                    // state is still the last snapshot and no reconciliation query
                    // is necessary. Restore memory immediately and fail fast.
                    Err(PublicControlDbGateError::Busy) => {
                        *state = snapshot.clone();
                        Err(PublicControlDbGateError::Busy.into_message())
                    }
                    Err(gate_error) => {
                        let error = gate_error.into_message();
                        match gate.run(load_public_control_postgres(pool)).await {
                            Ok(reconciled) => {
                                match classify_save_reconciliation(&reconciled, &snapshot, state) {
                                    SaveReconciliation::Committed => {
                                        // The intended write is durably in the DB — the
                                        // commit actually landed despite the error. Treat
                                        // as success so the caller returns the credential
                                        // instead of stranding it. `state` already == next.
                                        *snapshot = reconciled;
                                        Ok(())
                                    }
                                    SaveReconciliation::RolledBack => {
                                        // Definite rollback: the DB still holds `prev`.
                                        // Restore memory and surface the error; the old
                                        // credential stays valid and the op can be retried.
                                        *state = reconciled;
                                        Err(error)
                                    }
                                    SaveReconciliation::Indeterminate => {
                                        // The DB matches neither `prev` nor `next` (e.g. an
                                        // external writer). Reconcile memory to the DB truth
                                        // and surface the error; don't claim issuance won.
                                        *state = reconciled.clone();
                                        *snapshot = reconciled;
                                        Err(error)
                                    }
                                }
                            }
                            Err(reload_error) => {
                                let reload_error = reload_error.into_message();
                                // Can't reach the DB to determine the outcome. Force the
                                // next operation to reload (repairing state once the DB is
                                // reachable) and surface both errors — never silently claim
                                // success or a specific state here.
                                needs_reload.store(true, Ordering::SeqCst);
                                warn!(
                                    %error,
                                    %reload_error,
                                    "public control-plane save failed and the reconciling \
                                     reload also failed; forcing a reload on the next \
                                     operation (state indeterminate until then)"
                                );
                                Err(error)
                            }
                        }
                    }
                }
            }
        }
    }

    /// Index lookups only (primary key, plus the GIN index over superseded hashes), so a
    /// stranger's bearer costs a probe, not a reload.
    async fn credential_exists(
        &self,
        kind: CredentialKind,
        token_hash: &str,
        now: u64,
    ) -> Result<bool, String> {
        match self {
            Self::InMemory => Ok(false),
            // Process-exclusive, so only reached when a test treats the file as shared.
            Self::Json(path) => Ok(load_public_control_json(path)
                .await?
                .has_credential(kind, token_hash, now)),
            Self::Postgres { pool, gate, .. } => {
                let table = match kind {
                    CredentialKind::Relay => "public_relay_registrations",
                    CredentialKind::Device => "public_device_grants",
                    CredentialKind::Client | CredentialKind::ClientId => "public_client_identities",
                };
                let query = match kind {
                    CredentialKind::Relay => format!(
                        "SELECT EXISTS (SELECT 1 FROM {table} WHERE refresh_token_hash = $1)"
                    ),
                    CredentialKind::ClientId => {
                        format!("SELECT EXISTS (SELECT 1 FROM {table} WHERE client_id = $1)")
                    }
                    CredentialKind::Device | CredentialKind::Client => superseded_probe_sql(table),
                };
                let superseded =
                    serde_json::json!([{ "refresh_token_hash": token_hash }]).to_string();
                let now = u64_to_i64(now, "now")?;
                gate.run_spare(async {
                    let probe = sqlx::query_scalar::<_, bool>(&query).bind(token_hash);
                    let probe = match kind {
                        CredentialKind::Relay | CredentialKind::ClientId => probe,
                        CredentialKind::Device | CredentialKind::Client => {
                            probe.bind(&superseded).bind(now)
                        }
                    };
                    probe.fetch_one(pool).await.map_err(|error| {
                        warn!(%error, "public control-plane credential probe failed");
                        "public control-plane database unavailable".to_string()
                    })
                })
                .await
                .map_err(PublicControlDbGateError::into_message)
            }
        }
    }

    fn reload_before_use(&self) -> bool {
        match self {
            Self::Postgres {
                reload_before_use,
                needs_reload,
                ..
            } => *reload_before_use || needs_reload.load(Ordering::SeqCst),
            _ => false,
        }
    }

    /// Whether a token lookup miss may be caused by this instance's in-memory
    /// state trailing a shared authoritative backend (rolling-deploy overlap, a
    /// second replica, a commit that outran the snapshot) — i.e. whether a
    /// one-shot reload-and-retry is meaningful. Only Postgres is shared; the
    /// JSON/in-memory backends are process-exclusive, so memory is never behind.
    fn shared_backend(&self) -> bool {
        matches!(self, Self::Postgres { .. })
    }

    /// True when a prior save failed and the reconciling reload also failed, so
    /// the next operation must repair from the database before trusting memory.
    fn reload_forced(&self) -> bool {
        match self {
            Self::Postgres { needs_reload, .. } => needs_reload.load(Ordering::SeqCst),
            _ => false,
        }
    }

    /// Persist a single device grant's `last_seen` with a targeted O(1) UPDATE,
    /// deliberately avoiding the whole-state `save()` (which wipes and rebuilds
    /// every table). This is a Postgres-only, best-effort activity marker: for
    /// the in-memory / JSON backends the caller's in-memory update is authoritative
    /// and nothing more is written.
    async fn touch_device_last_seen(
        &self,
        refresh_token_hash: &str,
        last_seen: u64,
    ) -> Result<(), String> {
        match self {
            Self::InMemory | Self::Json(_) => Ok(()),
            Self::Postgres { pool, gate, .. } => {
                gate.run(async {
                    sqlx::query(
                        "UPDATE public_device_grants SET last_seen = $1 WHERE refresh_token_hash = $2",
                    )
                    .bind(u64_to_i64(last_seen, "last_seen")?)
                    .bind(refresh_token_hash)
                    .execute(pool)
                    .await
                    .map_err(|error| format!("failed to update device last_seen: {error}"))?;
                    Ok(())
                })
                .await
                .map_err(PublicControlDbGateError::into_message)
            }
        }
    }
}

impl PublicControlStateStore {
    fn from_persisted(persisted: PersistedPublicControlState) -> Result<Self, String> {
        if persisted.schema_version != PUBLIC_CONTROL_STATE_VERSION {
            return Err(format!(
                "unsupported public control-plane state schema {}",
                persisted.schema_version
            ));
        }
        Ok(Self {
            relay_registrations_by_hash: persisted
                .relay_registrations
                .into_iter()
                .map(|registration| (registration.refresh_token_hash.clone(), registration))
                .collect(),
            client_registrations_by_hash: persisted
                .client_registrations
                .into_iter()
                .map(|registration| (registration.refresh_token_hash.clone(), registration))
                .collect(),
            grants_by_hash: persisted
                .device_grants
                .into_iter()
                .map(|grant| (grant.refresh_token_hash.clone(), grant))
                .collect(),
            client_relay_grants_by_key: persisted
                .client_relay_grants
                .into_iter()
                .map(|grant| {
                    (
                        client_relay_grant_key(&grant.client_id, &grant.relay_id),
                        grant,
                    )
                })
                .collect(),
        })
    }

    fn to_persisted(&self) -> PersistedPublicControlState {
        PersistedPublicControlState {
            schema_version: PUBLIC_CONTROL_STATE_VERSION,
            relay_registrations: self.relay_registrations_by_hash.values().cloned().collect(),
            client_registrations: self
                .client_registrations_by_hash
                .values()
                .cloned()
                .collect(),
            device_grants: self.grants_by_hash.values().cloned().collect(),
            client_relay_grants: self.client_relay_grants_by_key.values().cloned().collect(),
        }
    }

    /// Count device grants currently bound to `relay_id`. One grant row == one
    /// registered device (device_id is deduped on issue), so this is the seat
    /// count the numeric device limit is compared against.
    /// Mirrors the Postgres probe, and the lookup: primary, or superseded and unexpired.
    fn has_credential(&self, kind: CredentialKind, token_hash: &str, now: u64) -> bool {
        let superseded = |list: &[SupersededToken]| {
            list.iter()
                .any(|token| token.refresh_token_hash == token_hash && token.expires_at > now)
        };
        match kind {
            CredentialKind::Relay => self.relay_registrations_by_hash.contains_key(token_hash),
            CredentialKind::Device => {
                self.grants_by_hash.contains_key(token_hash)
                    || self
                        .grants_by_hash
                        .values()
                        .any(|grant| superseded(&grant.superseded))
            }
            CredentialKind::Client => {
                self.client_registrations_by_hash.contains_key(token_hash)
                    || self
                        .client_registrations_by_hash
                        .values()
                        .any(|client| superseded(&client.superseded))
            }
            CredentialKind::ClientId => self.client_identity_for_id(token_hash).is_some(),
        }
    }

    fn count_device_grants_for_relay(&self, relay_id: &str) -> usize {
        self.grants_by_hash
            .values()
            .filter(|grant| grant.relay_id == relay_id)
            .count()
    }

    /// Whether a device grant already exists for `(relay_id, device_id)`. Used to
    /// exempt re-registrations from the cap (they replace a seat, never add one).
    fn has_device_grant(&self, relay_id: &str, device_id: &str) -> bool {
        self.grants_by_hash
            .values()
            .any(|grant| grant.relay_id == relay_id && grant.device_id == device_id)
    }

    fn remove_device_grants(
        &mut self,
        relay_id: &str,
        broker_room_id: Option<&str>,
        device_id: Option<&str>,
    ) -> usize {
        remove_matching_entries(&mut self.grants_by_hash, |grant| {
            matches_optional_relay_target(
                grant.relay_id.as_str(),
                grant.broker_room_id.as_str(),
                grant.device_id.as_str(),
                relay_id,
                broker_room_id,
                device_id,
            )
        })
    }

    fn remove_client_relay_grants(
        &mut self,
        relay_id: &str,
        broker_room_id: Option<&str>,
        device_id: Option<&str>,
    ) -> usize {
        remove_matching_entries(&mut self.client_relay_grants_by_key, |grant| {
            matches_optional_relay_target(
                grant.relay_id.as_str(),
                grant.broker_room_id.as_str(),
                grant.device_id.as_str(),
                relay_id,
                broker_room_id,
                device_id,
            )
        })
    }

    fn remove_client_relay_grants_by_client_id(&mut self, client_id: &str) -> usize {
        remove_matching_entries(&mut self.client_relay_grants_by_key, |grant| {
            grant.client_id == client_id
        })
    }

    fn remove_all_other_device_grants(
        &mut self,
        relay_id: &str,
        broker_room_id: &str,
        keep_device_id: &str,
    ) -> Vec<String> {
        collect_removed_device_ids(&mut self.grants_by_hash, |grant| {
            (grant.relay_id == relay_id
                && grant.broker_room_id == broker_room_id
                && grant.device_id != keep_device_id)
                .then(|| grant.device_id.as_str())
        })
    }

    fn remove_all_other_client_relay_grants(
        &mut self,
        relay_id: &str,
        broker_room_id: &str,
        keep_device_id: &str,
    ) -> Vec<String> {
        collect_removed_device_ids(&mut self.client_relay_grants_by_key, |grant| {
            (grant.relay_id == relay_id
                && grant.broker_room_id == broker_room_id
                && grant.device_id != keep_device_id)
                .then(|| grant.device_id.as_str())
        })
    }

    fn issue_or_rotate_client_identity(
        &mut self,
        client_verify_key: &str,
        client_label: Option<String>,
        created_at: u64,
        grace_secs: u64,
    ) -> (String, String) {
        let (client_id, carried_label, superseded) =
            if let Some(existing) = self.client_identity_for_verify_key(client_verify_key) {
                let client_id = existing.client_id.clone();
                self.remove_client_identity_by_client_id(&client_id);
                let superseded = carry_superseded(
                    &existing.superseded,
                    existing.refresh_token_hash.clone(),
                    created_at,
                    grace_secs,
                );
                (client_id, existing.client_label.clone(), superseded)
            } else {
                (issue_client_id(client_verify_key), None, Vec::new())
            };
        let client_refresh_token = format!("cref-{}", random_token(40).to_ascii_lowercase());
        let refresh_token_hash = sha256_hex(&client_refresh_token);
        self.client_registrations_by_hash.insert(
            refresh_token_hash.clone(),
            PersistedClientIdentity {
                client_id: client_id.clone(),
                client_verify_key: client_verify_key.to_string(),
                refresh_token_hash,
                created_at,
                client_label: client_label.or(carried_label),
                superseded,
            },
        );
        (client_id, client_refresh_token)
    }

    fn rotate_client_identity(
        &mut self,
        client: &PersistedClientIdentity,
        now: u64,
        grace_secs: u64,
    ) -> String {
        // Collect grace entries from the LIVE rows (not the caller's clone), so a
        // rotation chains correctly even if the row changed since authentication.
        let mut superseded: Vec<SupersededToken> = Vec::new();
        for registration in self
            .client_registrations_by_hash
            .values()
            .filter(|registration| registration.client_id == client.client_id)
        {
            superseded = carry_superseded(
                &[registration.superseded.clone(), superseded].concat(),
                registration.refresh_token_hash.clone(),
                now,
                grace_secs,
            );
        }
        self.remove_client_identity_by_client_id(&client.client_id);
        let client_refresh_token = format!("cref-{}", random_token(40).to_ascii_lowercase());
        let refresh_token_hash = sha256_hex(&client_refresh_token);
        self.client_registrations_by_hash.insert(
            refresh_token_hash.clone(),
            PersistedClientIdentity {
                client_id: client.client_id.clone(),
                client_verify_key: client.client_verify_key.clone(),
                refresh_token_hash,
                created_at: client.created_at,
                client_label: client.client_label.clone(),
                superseded,
            },
        );
        client_refresh_token
    }

    fn upsert_client_relay_grant(&mut self, grant: PersistedClientRelayGrant) {
        self.client_relay_grants_by_key.insert(
            client_relay_grant_key(&grant.client_id, &grant.relay_id),
            grant,
        );
    }

    fn client_relays(&self, client_id: &str) -> Vec<ClientRelayEntry> {
        self.client_relay_grants_by_key
            .values()
            .filter(|grant| grant.client_id == client_id)
            .map(|grant| ClientRelayEntry {
                relay_id: grant.relay_id.clone(),
                broker_room_id: grant.broker_room_id.clone(),
                device_id: grant.device_id.clone(),
                granted_at: grant.granted_at,
                relay_label: grant.relay_label.clone(),
                device_label: grant.device_label.clone(),
            })
            .collect()
    }

    fn seed_relay_registrations(&mut self, registrations: Vec<RelayRegistrationConfig>) -> bool {
        let mut seeded = false;
        for registration in registrations {
            let refresh_token_hash = sha256_hex(&registration.refresh_token);
            if let std::collections::hash_map::Entry::Vacant(entry) = self
                .relay_registrations_by_hash
                .entry(refresh_token_hash.clone())
            {
                let relay_verify_key = registration
                    .relay_verify_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|key| !key.is_empty())
                    .map(str::to_string);
                entry.insert(PersistedRelayRegistration {
                    relay_id: registration.relay_id,
                    broker_room_id: registration.broker_room_id,
                    refresh_token_hash,
                    created_at: 0,
                    relay_label: None,
                    relay_verify_key,
                });
                seeded = true;
            }
        }
        seeded
    }

    fn issue_new_relay_ids(&self) -> (String, String) {
        loop {
            let relay_id = format!("relay-{}", random_token(12).to_ascii_lowercase());
            let broker_room_id = format!("room-{}", random_token(12).to_ascii_lowercase());
            if self
                .relay_registrations_by_hash
                .values()
                .any(|registration| {
                    registration.relay_id == relay_id
                        || registration.broker_room_id == broker_room_id
                })
            {
                continue;
            }
            return (relay_id, broker_room_id);
        }
    }

    fn registration_for_verify_key(
        &self,
        relay_verify_key: &str,
    ) -> Option<PersistedRelayRegistration> {
        self.relay_registrations_by_hash
            .values()
            .find(|registration| {
                registration
                    .relay_verify_key
                    .as_deref()
                    .is_some_and(|value| value == relay_verify_key)
            })
            .cloned()
    }

    fn client_identity_for_verify_key(
        &self,
        client_verify_key: &str,
    ) -> Option<PersistedClientIdentity> {
        self.client_registrations_by_hash
            .values()
            .find(|registration| registration.client_verify_key == client_verify_key)
            .cloned()
    }

    fn client_identity_for_id(&self, client_id: &str) -> Option<PersistedClientIdentity> {
        self.client_registrations_by_hash
            .values()
            .find(|client| client.client_id == client_id)
            .cloned()
    }

    fn remove_relay_registration_by_verify_key(&mut self, relay_verify_key: &str) -> usize {
        let mut removed = 0;
        self.relay_registrations_by_hash.retain(|_, registration| {
            let matches = registration
                .relay_verify_key
                .as_deref()
                .is_some_and(|value| value == relay_verify_key);
            if matches {
                removed += 1;
            }
            !matches
        });
        removed
    }

    fn remove_client_identity_by_client_id(&mut self, client_id: &str) -> usize {
        let mut removed = 0;
        self.client_registrations_by_hash.retain(|_, registration| {
            let matches = registration.client_id == client_id;
            if matches {
                removed += 1;
            }
            !matches
        });
        removed
    }
}

async fn load_public_control_json(path: &Path) -> Result<PublicControlStateStore, String> {
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PublicControlStateStore::default())
        }
        Err(error) => {
            return Err(format!(
                "failed to read public control-plane state {}: {error}",
                path.display()
            ))
        }
    };
    let persisted: PersistedPublicControlState =
        serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "failed to decode public control-plane state {}: {error}",
                path.display()
            )
        })?;
    PublicControlStateStore::from_persisted(persisted)
        .map_err(|error| format!("{} in public control-plane state {}", error, path.display()))
}

async fn save_public_control_json(
    path: &Path,
    state: &PublicControlStateStore,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let payload = serde_json::to_vec_pretty(&state.to_persisted())
        .map_err(|error| format!("failed to encode public control-plane state: {error}"))?;
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, payload)
        .await
        .map_err(|error| format!("failed to write {}: {error}", temp_path.display()))?;
    fs::rename(&temp_path, path)
        .await
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    Ok(())
}

/// Redact credentials from a Postgres URL for logging. Keeps only the portion
/// after the first `@` (host/port/db/params) so `user:password` never reaches
/// the logs. URLs without credentials are returned unchanged (nothing secret).
fn redact_postgres_url(url: &str) -> String {
    match url.split_once('@') {
        Some((_credentials, host_and_rest)) => host_and_rest.to_string(),
        None => url.to_string(),
    }
}

/// Public cleanup errors must never carry filesystem paths or SQL/backend text.
/// Keep a short redacted class for operator diagnostics (logged via
/// `AccessDenial::with_internal`); HTTP clients only see typed unavailable.
fn sanitize_persistence_error(error: String) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("reload-uncertain") || lower.contains("needs_reload") {
        "public control-plane persistence failed (reload-uncertain)".to_string()
    } else if lower.contains("target still present") {
        "public control-plane persistence failed (target still present)".to_string()
    } else if lower.contains("local restore") {
        "public control-plane persistence failed (local restore)".to_string()
    } else if lower.contains("indeterminate") {
        "public control-plane persistence failed (indeterminate)".to_string()
    } else {
        "public control-plane persistence failed".to_string()
    }
}

/// Decide release cleanup after a shared (Postgres) save error.
///
/// `reload_forced` means save *and* reconciling reload failed — durable outcome
/// unknown even if in-memory looks target-cleared. That must stay Err so the
/// next op is forced to reload; never report released=true for that case.
/// When reload succeeded (`reload_forced` false), target-absent is effective Ok.
fn shared_release_cleanup_after_save_error(
    reload_forced: bool,
    target_cleared: bool,
) -> Result<(), String> {
    if reload_forced {
        return Err("public control-plane persistence failed (reload-uncertain)".to_string());
    }
    if target_cleared {
        return Ok(());
    }
    Err("public control-plane persistence failed (target still present)".to_string())
}

/// Release cleanup is effective when this relay/room has no registration and no
/// scoped device/client grants, even if unrelated control-plane rows differ.
fn target_access_fully_cleared(
    store: &PublicControlStateStore,
    relay_id: &str,
    broker_room_id: &str,
) -> bool {
    let registration_present = store
        .relay_registrations_by_hash
        .values()
        .any(|reg| reg.relay_id == relay_id && reg.broker_room_id == broker_room_id);
    if registration_present {
        return false;
    }
    let device_present = store
        .grants_by_hash
        .values()
        .any(|g| g.relay_id == relay_id && g.broker_room_id == broker_room_id);
    if device_present {
        return false;
    }
    !store
        .client_relay_grants_by_key
        .values()
        .any(|g| g.relay_id == relay_id && g.broker_room_id == broker_room_id)
}

#[cfg(test)]
#[path = "public_control/tests/release_cleanup_helpers.rs"]
mod release_cleanup_helpers;

async fn initialize_postgres_public_control_schema(pool: &PgPool) -> Result<(), String> {
    initialize_postgres_control_version(pool).await?;
    create_postgres_control_tables(pool).await?;
    // Additive columns for the rotation grace window (JSON-encoded
    // Vec<SupersededToken>; NULL/absent = empty). ADD COLUMN IF NOT EXISTS keeps
    // pre-existing deployments loadable without a schema-version bump.
    for table in ["public_client_identities", "public_device_grants"] {
        sqlx::query(&format!(
            "ALTER TABLE {table} ADD COLUMN IF NOT EXISTS superseded_tokens TEXT"
        ))
        .execute(pool)
        .await
        .map_err(|error| format!("failed to add superseded_tokens to {table}: {error}"))?;
        ensure_superseded_index(pool, table).await?;
    }
    Ok(())
}

async fn initialize_postgres_control_version(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS public_control_schema (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            schema_version INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("failed to create public_control_schema: {error}"))?;
    sqlx::query(
        r#"
        INSERT INTO public_control_schema (singleton, schema_version)
        VALUES (TRUE, $1)
        ON CONFLICT (singleton) DO NOTHING
        "#,
    )
    .bind(PUBLIC_CONTROL_STATE_VERSION as i32)
    .execute(pool)
    .await
    .map_err(|error| format!("failed to initialize public_control_schema: {error}"))?;
    let schema_version: i32 =
        sqlx::query("SELECT schema_version FROM public_control_schema WHERE singleton = TRUE")
            .fetch_one(pool)
            .await
            .map_err(|error| format!("failed to inspect public_control_schema: {error}"))?
            .try_get("schema_version")
            .map_err(|error| format!("failed to read public_control_schema version: {error}"))?;
    if schema_version != PUBLIC_CONTROL_STATE_VERSION as i32 {
        return Err(format!(
            "unsupported Postgres public control-plane schema {schema_version}"
        ));
    }
    Ok(())
}

async fn create_postgres_control_tables(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS public_relay_registrations (
            refresh_token_hash TEXT PRIMARY KEY,
            relay_id TEXT NOT NULL UNIQUE,
            broker_room_id TEXT NOT NULL UNIQUE,
            created_at BIGINT NOT NULL,
            relay_label TEXT,
            relay_verify_key TEXT UNIQUE
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("failed to create public_relay_registrations: {error}"))?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS public_client_identities (
            refresh_token_hash TEXT PRIMARY KEY,
            client_id TEXT NOT NULL UNIQUE,
            client_verify_key TEXT NOT NULL UNIQUE,
            created_at BIGINT NOT NULL,
            client_label TEXT
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("failed to create public_client_identities: {error}"))?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS public_device_grants (
            refresh_token_hash TEXT PRIMARY KEY,
            relay_id TEXT NOT NULL,
            broker_room_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            created_at BIGINT NOT NULL,
            last_seen BIGINT,
            UNIQUE (relay_id, broker_room_id, device_id)
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("failed to create public_device_grants: {error}"))?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS public_client_relay_grants (
            client_id TEXT NOT NULL,
            relay_id TEXT NOT NULL,
            broker_room_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            granted_at BIGINT NOT NULL,
            relay_label TEXT,
            device_label TEXT,
            PRIMARY KEY (client_id, relay_id)
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("failed to create public_client_relay_grants: {error}"))?;
    Ok(())
}

/// The credential probe needs this index or every unknown bearer scans the table, so
/// startup stops without it. Built concurrently so a live instance's writes carry on.
async fn ensure_superseded_index(pool: &PgPool, table: &str) -> Result<(), String> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|error| format!("failed to check {table}_superseded_idx: {error}"))?;
    let outcome = build_superseded_index(&mut conn, table).await;
    // The build lifts this session's statement timeout; never hand it back to the pool.
    let _ = conn.close().await;
    outcome
}

async fn build_superseded_index(conn: &mut sqlx::PgConnection, table: &str) -> Result<(), String> {
    use sqlx::Executor as _;
    match superseded_index_step(table, superseded_index_valid(conn, table).await?) {
        SupersededIndexStep::Ready => return Ok(()),
        SupersededIndexStep::Refuse(message) => return Err(message),
        SupersededIndexStep::Build => {}
    }
    info!(table, "building the superseded-token index concurrently");
    conn.execute(
        format!("SET statement_timeout = '{SUPERSEDED_INDEX_BUILD_TIMEOUT_SECS}s'").as_str(),
    )
    .await
    .map_err(|error| format!("failed to lift the timeout for {table}_superseded_idx: {error}"))?;
    if let Err(error) = conn.execute(superseded_index_sql(table).as_str()).await {
        return Err(format!(
            "{error}; {}",
            superseded_index_instructions(table, "could not be built")
        ));
    }
    match superseded_index_valid(conn, table).await? {
        Some(true) => Ok(()),
        _ => Err(superseded_index_instructions(
            table,
            "is not valid after building",
        )),
    }
}

async fn superseded_index_valid(
    conn: &mut sqlx::PgConnection,
    table: &str,
) -> Result<Option<bool>, String> {
    sqlx::query_scalar::<_, bool>(
        "SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid \
         WHERE c.relname = $1 AND pg_table_is_visible(c.oid)",
    )
    .bind(format!("{table}_superseded_idx"))
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| format!("failed to check {table}_superseded_idx: {error}"))
}

enum SupersededIndexStep {
    Ready,
    Build,
    Refuse(String),
}

fn superseded_index_step(table: &str, valid: Option<bool>) -> SupersededIndexStep {
    match valid {
        Some(true) => SupersededIndexStep::Ready,
        None => SupersededIndexStep::Build,
        // Left by a failed or still-running concurrent build. Dropping it here could kill
        // another instance's build, so the operator decides.
        Some(false) => SupersededIndexStep::Refuse(superseded_index_instructions(
            table,
            "exists but is not valid",
        )),
    }
}

fn superseded_index_instructions(table: &str, problem: &str) -> String {
    format!(
        "public control-plane index {table}_superseded_idx {problem}; credential probes need it \
         to avoid scanning {table}. With no other broker starting, run \
         `DROP INDEX CONCURRENTLY IF EXISTS {table}_superseded_idx;` then `{};` and restart",
        superseded_index_sql(table)
    )
}

fn superseded_index_sql(table: &str) -> String {
    format!(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS {table}_superseded_idx ON {table} \
         USING GIN (({SUPERSEDED_JSONB}) jsonb_path_ops)"
    )
}

/// Containment narrows to the one row holding the hash via the index; only that row's
/// entries (at most `MAX_SUPERSEDED_TOKENS`) are expanded to check expiry. The candidates
/// are materialized because inside EXISTS a generic plan costs for the first match and
/// picks a table scan; costed as a full fetch, the index wins.
fn superseded_probe_sql(table: &str) -> String {
    format!(
        "WITH candidates AS MATERIALIZED (SELECT {SUPERSEDED_JSONB} AS superseded FROM {table} \
         WHERE {SUPERSEDED_JSONB} @> $2::jsonb) \
         SELECT EXISTS (SELECT 1 FROM {table} WHERE refresh_token_hash = $1) \
         OR EXISTS (SELECT 1 FROM candidates, jsonb_array_elements(candidates.superseded) AS entry \
         WHERE entry->>'refresh_token_hash' = $1 AND (entry->>'expires_at')::numeric > $3)"
    )
}

fn encode_superseded(superseded: &[SupersededToken]) -> Result<Option<String>, String> {
    if superseded.is_empty() {
        return Ok(None);
    }
    serde_json::to_string(superseded)
        .map(Some)
        .map_err(|error| format!("failed to encode superseded tokens: {error}"))
}

fn decode_superseded(raw: Option<String>) -> Result<Vec<SupersededToken>, String> {
    match raw {
        None => Ok(Vec::new()),
        Some(raw) => serde_json::from_str(&raw)
            .map_err(|error| format!("failed to decode superseded tokens: {error}")),
    }
}

async fn load_public_control_postgres(pool: &PgPool) -> Result<PublicControlStateStore, String> {
    let relay_rows = sqlx::query(
        r#"
        SELECT relay_id, broker_room_id, refresh_token_hash, created_at, relay_label, relay_verify_key
        FROM public_relay_registrations
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("failed to load public_relay_registrations: {error}"))?;
    let client_rows = sqlx::query(
        r#"
        SELECT client_id, client_verify_key, refresh_token_hash, created_at, client_label,
               superseded_tokens
        FROM public_client_identities
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("failed to load public_client_identities: {error}"))?;
    let device_rows = sqlx::query(
        r#"
        SELECT relay_id, broker_room_id, device_id, refresh_token_hash, created_at, last_seen,
               superseded_tokens
        FROM public_device_grants
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("failed to load public_device_grants: {error}"))?;
    let client_grant_rows = sqlx::query(
        r#"
        SELECT client_id, relay_id, broker_room_id, device_id, granted_at, relay_label, device_label
        FROM public_client_relay_grants
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("failed to load public_client_relay_grants: {error}"))?;

    PublicControlStateStore::from_persisted(PersistedPublicControlState {
        schema_version: PUBLIC_CONTROL_STATE_VERSION,
        relay_registrations: relay_rows
            .into_iter()
            .map(decode_relay_registration)
            .collect::<Result<Vec<_>, String>>()?,
        client_registrations: client_rows
            .into_iter()
            .map(decode_client_identity)
            .collect::<Result<Vec<_>, String>>()?,
        device_grants: device_rows
            .into_iter()
            .map(decode_device_grant)
            .collect::<Result<Vec<_>, String>>()?,
        client_relay_grants: client_grant_rows
            .into_iter()
            .map(decode_client_relay_grant)
            .collect::<Result<Vec<_>, String>>()?,
    })
}

fn decode_relay_registration(row: PgRow) -> Result<PersistedRelayRegistration, String> {
    Ok(PersistedRelayRegistration {
        relay_id: row.try_get("relay_id").map_err(postgres_decode_error)?,
        broker_room_id: row
            .try_get("broker_room_id")
            .map_err(postgres_decode_error)?,
        refresh_token_hash: row
            .try_get("refresh_token_hash")
            .map_err(postgres_decode_error)?,
        created_at: row_i64_to_u64(&row, "created_at")?,
        relay_label: row.try_get("relay_label").map_err(postgres_decode_error)?,
        relay_verify_key: row
            .try_get("relay_verify_key")
            .map_err(postgres_decode_error)?,
    })
}

fn decode_client_identity(row: PgRow) -> Result<PersistedClientIdentity, String> {
    Ok(PersistedClientIdentity {
        client_id: row.try_get("client_id").map_err(postgres_decode_error)?,
        client_verify_key: row
            .try_get("client_verify_key")
            .map_err(postgres_decode_error)?,
        refresh_token_hash: row
            .try_get("refresh_token_hash")
            .map_err(postgres_decode_error)?,
        created_at: row_i64_to_u64(&row, "created_at")?,
        client_label: row.try_get("client_label").map_err(postgres_decode_error)?,
        superseded: decode_superseded(
            row.try_get("superseded_tokens")
                .map_err(postgres_decode_error)?,
        )?,
    })
}

fn decode_device_grant(row: PgRow) -> Result<PersistedDeviceGrant, String> {
    Ok(PersistedDeviceGrant {
        relay_id: row.try_get("relay_id").map_err(postgres_decode_error)?,
        broker_room_id: row
            .try_get("broker_room_id")
            .map_err(postgres_decode_error)?,
        device_id: row.try_get("device_id").map_err(postgres_decode_error)?,
        refresh_token_hash: row
            .try_get("refresh_token_hash")
            .map_err(postgres_decode_error)?,
        created_at: row_i64_to_u64(&row, "created_at")?,
        last_seen: row
            .try_get::<Option<i64>, _>("last_seen")
            .map_err(postgres_decode_error)?
            .and_then(|value| u64::try_from(value).ok()),
        superseded: decode_superseded(
            row.try_get("superseded_tokens")
                .map_err(postgres_decode_error)?,
        )?,
    })
}

fn decode_client_relay_grant(row: PgRow) -> Result<PersistedClientRelayGrant, String> {
    Ok(PersistedClientRelayGrant {
        client_id: row.try_get("client_id").map_err(postgres_decode_error)?,
        relay_id: row.try_get("relay_id").map_err(postgres_decode_error)?,
        broker_room_id: row
            .try_get("broker_room_id")
            .map_err(postgres_decode_error)?,
        device_id: row.try_get("device_id").map_err(postgres_decode_error)?,
        granted_at: row_i64_to_u64(&row, "granted_at")?,
        relay_label: row.try_get("relay_label").map_err(postgres_decode_error)?,
        device_label: row.try_get("device_label").map_err(postgres_decode_error)?,
    })
}

/// What the reconciling reload proved about a save whose client-side result was an
/// error (which, for a COMMIT failure, is ambiguous).
#[derive(Debug, PartialEq, Eq)]
enum SaveReconciliation {
    /// DB matches the intended `next`: the commit actually landed (lost ack) — the
    /// save should be reported as success so the caller delivers the credential.
    Committed,
    /// DB matches the prior snapshot `prev`: the transaction rolled back.
    RolledBack,
    /// DB matches neither (e.g. a concurrent external writer): outcome unknown.
    Indeterminate,
}

/// Decide a failed save's true outcome from the reloaded DB state. `next` is
/// checked first so a no-op save (`prev == next`) counts as committed.
fn classify_save_reconciliation(
    reconciled: &PublicControlStateStore,
    prev: &PublicControlStateStore,
    next: &PublicControlStateStore,
) -> SaveReconciliation {
    if reconciled == next {
        SaveReconciliation::Committed
    } else if reconciled == prev {
        SaveReconciliation::RolledBack
    } else {
        SaveReconciliation::Indeterminate
    }
}

/// Persist the delta between the last-saved snapshot (`prev`) and the live state
/// (`next`) using targeted upserts/deletes inside one transaction. Only rows that
/// were added or changed are upserted; only rows that were removed are deleted.
/// End state is identical to a full rebuild, but the cost is O(changed rows), not
/// O(total rows) — approving one device becomes a couple of statements instead of
/// wiping and re-inserting every table.
async fn save_public_control_postgres(
    pool: &PgPool,
    prev: &PublicControlStateStore,
    next: &PublicControlStateStore,
) -> Result<(), String> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("failed to begin public control-plane transaction: {error}"))?;

    // Rotations reuse unique identity columns, so all deletes must precede all upserts.
    // Conditional deletes prevent a stale broker from restoring revoked credentials.
    delete_removed_public_control_rows(&mut tx, prev, next).await?;
    upsert_relay_registrations(&mut tx, prev, next).await?;
    upsert_client_identities(&mut tx, prev, next).await?;
    upsert_device_grants(&mut tx, prev, next).await?;
    upsert_client_relay_grants(&mut tx, prev, next).await?;

    tx.commit()
        .await
        .map_err(|error| format!("failed to commit public control-plane transaction: {error}"))?;
    Ok(())
}

async fn delete_removed_public_control_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    prev: &PublicControlStateStore,
    next: &PublicControlStateStore,
) -> Result<(), String> {
    for hash in prev.relay_registrations_by_hash.keys() {
        if !next.relay_registrations_by_hash.contains_key(hash) {
            let deleted =
                sqlx::query("DELETE FROM public_relay_registrations WHERE refresh_token_hash = $1")
                    .bind(hash)
                    .execute(&mut **tx)
                    .await
                    .map_err(|error| {
                        format!("failed to delete public_relay_registrations: {error}")
                    })?;
            require_deleted_credential(deleted.rows_affected())?;
        }
    }
    for hash in prev.client_registrations_by_hash.keys() {
        if !next.client_registrations_by_hash.contains_key(hash) {
            let deleted =
                sqlx::query("DELETE FROM public_client_identities WHERE refresh_token_hash = $1")
                    .bind(hash)
                    .execute(&mut **tx)
                    .await
                    .map_err(|error| {
                        format!("failed to delete public_client_identities: {error}")
                    })?;
            require_deleted_credential(deleted.rows_affected())?;
        }
    }
    for hash in prev.grants_by_hash.keys() {
        if !next.grants_by_hash.contains_key(hash) {
            let deleted =
                sqlx::query("DELETE FROM public_device_grants WHERE refresh_token_hash = $1")
                    .bind(hash)
                    .execute(&mut **tx)
                    .await
                    .map_err(|error| format!("failed to delete public_device_grants: {error}"))?;
            require_deleted_credential(deleted.rows_affected())?;
        }
    }
    for (key, grant) in &prev.client_relay_grants_by_key {
        if !next.client_relay_grants_by_key.contains_key(key) {
            sqlx::query(
                "DELETE FROM public_client_relay_grants WHERE client_id = $1 AND relay_id = $2",
            )
            .bind(&grant.client_id)
            .bind(&grant.relay_id)
            .execute(&mut **tx)
            .await
            .map_err(|error| format!("failed to delete public_client_relay_grants: {error}"))?;
        }
    }
    Ok(())
}

async fn upsert_relay_registrations(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    prev: &PublicControlStateStore,
    next: &PublicControlStateStore,
) -> Result<(), String> {
    for (hash, reg) in &next.relay_registrations_by_hash {
        if prev.relay_registrations_by_hash.get(hash) != Some(reg) {
            sqlx::query(
                r#"
                INSERT INTO public_relay_registrations (
                    refresh_token_hash, relay_id, broker_room_id, created_at, relay_label, relay_verify_key
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (refresh_token_hash) DO UPDATE SET
                    relay_id = EXCLUDED.relay_id,
                    broker_room_id = EXCLUDED.broker_room_id,
                    created_at = EXCLUDED.created_at,
                    relay_label = EXCLUDED.relay_label,
                    relay_verify_key = EXCLUDED.relay_verify_key
                "#,
            )
            .bind(&reg.refresh_token_hash)
            .bind(&reg.relay_id)
            .bind(&reg.broker_room_id)
            .bind(u64_to_i64(reg.created_at, "created_at")?)
            .bind(&reg.relay_label)
            .bind(&reg.relay_verify_key)
            .execute(&mut **tx)
            .await
            .map_err(|error| format!("failed to upsert public_relay_registrations: {error}"))?;
        }
    }
    Ok(())
}

async fn upsert_client_identities(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    prev: &PublicControlStateStore,
    next: &PublicControlStateStore,
) -> Result<(), String> {
    for (hash, client) in &next.client_registrations_by_hash {
        if prev.client_registrations_by_hash.get(hash) != Some(client) {
            sqlx::query(
                r#"
                INSERT INTO public_client_identities (
                    refresh_token_hash, client_id, client_verify_key, created_at, client_label,
                    superseded_tokens
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (refresh_token_hash) DO UPDATE SET
                    client_id = EXCLUDED.client_id,
                    client_verify_key = EXCLUDED.client_verify_key,
                    created_at = EXCLUDED.created_at,
                    client_label = EXCLUDED.client_label,
                    superseded_tokens = EXCLUDED.superseded_tokens
                "#,
            )
            .bind(&client.refresh_token_hash)
            .bind(&client.client_id)
            .bind(&client.client_verify_key)
            .bind(u64_to_i64(client.created_at, "created_at")?)
            .bind(&client.client_label)
            .bind(encode_superseded(&client.superseded)?)
            .execute(&mut **tx)
            .await
            .map_err(|error| format!("failed to upsert public_client_identities: {error}"))?;
        }
    }
    Ok(())
}

async fn upsert_device_grants(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    prev: &PublicControlStateStore,
    next: &PublicControlStateStore,
) -> Result<(), String> {
    for (hash, grant) in &next.grants_by_hash {
        if prev.grants_by_hash.get(hash) != Some(grant) {
            sqlx::query(
                r#"
                INSERT INTO public_device_grants (
                    refresh_token_hash, relay_id, broker_room_id, device_id, created_at, last_seen,
                    superseded_tokens
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (refresh_token_hash) DO UPDATE SET
                    relay_id = EXCLUDED.relay_id,
                    broker_room_id = EXCLUDED.broker_room_id,
                    device_id = EXCLUDED.device_id,
                    created_at = EXCLUDED.created_at,
                    last_seen = EXCLUDED.last_seen,
                    superseded_tokens = EXCLUDED.superseded_tokens
                "#,
            )
            .bind(&grant.refresh_token_hash)
            .bind(&grant.relay_id)
            .bind(&grant.broker_room_id)
            .bind(&grant.device_id)
            .bind(u64_to_i64(grant.created_at, "created_at")?)
            .bind(grant.last_seen.and_then(|value| i64::try_from(value).ok()))
            .bind(encode_superseded(&grant.superseded)?)
            .execute(&mut **tx)
            .await
            .map_err(|error| format!("failed to upsert public_device_grants: {error}"))?;
        }
    }
    Ok(())
}

async fn upsert_client_relay_grants(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    prev: &PublicControlStateStore,
    next: &PublicControlStateStore,
) -> Result<(), String> {
    for (key, grant) in &next.client_relay_grants_by_key {
        if prev.client_relay_grants_by_key.get(key) != Some(grant) {
            sqlx::query(
                r#"
                INSERT INTO public_client_relay_grants (
                    client_id, relay_id, broker_room_id, device_id, granted_at, relay_label, device_label
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (client_id, relay_id) DO UPDATE SET
                    broker_room_id = EXCLUDED.broker_room_id,
                    device_id = EXCLUDED.device_id,
                    granted_at = EXCLUDED.granted_at,
                    relay_label = EXCLUDED.relay_label,
                    device_label = EXCLUDED.device_label
                "#,
            )
            .bind(&grant.client_id)
            .bind(&grant.relay_id)
            .bind(&grant.broker_room_id)
            .bind(&grant.device_id)
            .bind(u64_to_i64(grant.granted_at, "granted_at")?)
            .bind(&grant.relay_label)
            .bind(&grant.device_label)
            .execute(&mut **tx)
            .await
            .map_err(|error| format!("failed to upsert public_client_relay_grants: {error}"))?;
        }
    }
    Ok(())
}

fn require_deleted_credential(rows: u64) -> Result<(), String> {
    if rows == 1 {
        Ok(())
    } else {
        Err("public control-plane credential changed before save; retry".to_string())
    }
}

fn parse_relay_registrations(
    value: Option<String>,
) -> Result<Vec<RelayRegistrationConfig>, String> {
    let Some(raw) = trimmed_option_string(value) else {
        return Ok(Vec::new());
    };
    let parsed: Vec<RelayRegistrationConfig> = serde_json::from_str(&raw)
        .map_err(|error| format!("{PUBLIC_RELAY_REGISTRATIONS_ENV} must be valid JSON: {error}"))?;
    for registration in &parsed {
        if registration.relay_id.trim().is_empty() {
            return Err(format!(
                "{PUBLIC_RELAY_REGISTRATIONS_ENV} entries must include relay_id"
            ));
        }
        if registration.broker_room_id.trim().is_empty() {
            return Err(format!(
                "{PUBLIC_RELAY_REGISTRATIONS_ENV} entries must include broker_room_id"
            ));
        }
        if registration.refresh_token.trim().is_empty() {
            return Err(format!(
                "{PUBLIC_RELAY_REGISTRATIONS_ENV} entries must include refresh_token"
            ));
        }
        if let Some(verify_key) = registration
            .relay_verify_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
        {
            validate_relay_verify_key(verify_key)
                .map_err(|error| format!("{PUBLIC_RELAY_REGISTRATIONS_ENV}: {error}"))?;
        }
    }
    Ok(parsed)
}

/// Resolve a client identity from a presented token hash: exact match on the
/// current token, or a superseded token still inside its grace window. Returns
/// the row's primary hash (map key) alongside the identity so callers can tell
/// which case matched and address the live row.
fn find_client_identity_for_token(
    store: &PublicControlStateStore,
    token_hash: &str,
    now: u64,
) -> Option<(String, PersistedClientIdentity)> {
    if let Some(identity) = store.client_registrations_by_hash.get(token_hash) {
        return Some((token_hash.to_string(), identity.clone()));
    }
    store
        .client_registrations_by_hash
        .iter()
        .find(|(_, identity)| {
            identity
                .superseded
                .iter()
                .any(|token| token.refresh_token_hash == token_hash && token.expires_at > now)
        })
        .map(|(hash, identity)| (hash.clone(), identity.clone()))
}

/// Device-grant twin of [`find_client_identity_for_token`].
fn find_device_grant_for_token(
    store: &PublicControlStateStore,
    token_hash: &str,
    now: u64,
) -> Option<(String, PersistedDeviceGrant)> {
    if let Some(grant) = store.grants_by_hash.get(token_hash) {
        return Some((token_hash.to_string(), grant.clone()));
    }
    store
        .grants_by_hash
        .iter()
        .find(|(_, grant)| {
            grant
                .superseded
                .iter()
                .any(|token| token.refresh_token_hash == token_hash && token.expires_at > now)
        })
        .map(|(hash, grant)| (hash.clone(), grant.clone()))
}

fn refresh_device_for_client(
    store: &PublicControlStateStore,
    client_id: &str,
    room: &str,
) -> Result<(PersistedDeviceGrant, PersistedRelayRegistration), String> {
    let client_grant = store
        .client_relay_grants_by_key
        .values()
        .find(|grant| grant.client_id == client_id && grant.broker_room_id == room)
        .ok_or_else(|| "credential refresh is invalid".to_string())?;
    let device = store
        .grants_by_hash
        .values()
        .find(|grant| {
            grant.relay_id == client_grant.relay_id
                && grant.broker_room_id == room
                && grant.device_id == client_grant.device_id
        })
        .ok_or_else(|| "credential refresh is invalid".to_string())?;
    let registration = store
        .relay_registrations_by_hash
        .values()
        .find(|registration| {
            registration.relay_id == client_grant.relay_id && registration.broker_room_id == room
        })
        .ok_or_else(|| "credential refresh is invalid".to_string())?;
    Ok((device.clone(), registration.clone()))
}

fn credential_refresh_message(challenge: &CredentialRefreshChallengeResponse) -> String {
    format!(
        "agent-relay:credential-refresh:{}:{}:{}:{}:{}:{}",
        challenge.broker_origin,
        challenge.challenge_id,
        challenge.nonce,
        challenge.client_id,
        challenge.broker_room_id.as_deref().unwrap_or_default(),
        challenge.device_id.as_deref().unwrap_or_default(),
    )
}

fn credential_refresh_init_message(
    request: &CredentialRefreshChallengeRequest,
    origin: &str,
) -> String {
    format!(
        "agent-relay:credential-refresh-init:{origin}:{}:{}:{}:{}",
        request.client_id,
        request.broker_room_id.as_deref().unwrap_or_default(),
        request.device_id.as_deref().unwrap_or_default(),
        request.nonce,
    )
}

fn remove_matching_entries<T>(
    entries: &mut HashMap<String, T>,
    mut matches: impl FnMut(&T) -> bool,
) -> usize {
    let mut removed = 0;
    entries.retain(|_, entry| {
        let should_remove = matches(entry);
        if should_remove {
            removed += 1;
        }
        !should_remove
    });
    removed
}

fn collect_removed_device_ids<T>(
    entries: &mut HashMap<String, T>,
    mut removed_device_id: impl FnMut(&T) -> Option<&str>,
) -> Vec<String> {
    let mut device_ids = BTreeSet::new();
    entries.retain(|_, entry| match removed_device_id(entry) {
        Some(device_id) => {
            device_ids.insert(device_id.to_string());
            false
        }
        None => true,
    });
    device_ids.into_iter().collect()
}

fn matches_optional_relay_target(
    actual_relay_id: &str,
    actual_broker_room_id: &str,
    actual_device_id: &str,
    relay_id: &str,
    broker_room_id: Option<&str>,
    device_id: Option<&str>,
) -> bool {
    actual_relay_id == relay_id
        && broker_room_id
            .map(|value| value == actual_broker_room_id)
            .unwrap_or(true)
        && device_id
            .map(|value| value == actual_device_id)
            .unwrap_or(true)
}

/// Throttle window for persisting device `last_seen`: refresh it at most once per
/// hour so the frequent ws-token refresh (~every 5 min) does not write on every
/// call.
const LAST_SEEN_THROTTLE_SECS: u64 = 3600;

/// Whether a device's `last_seen` should be refreshed to `now`. A never-recorded
/// value (`None`) always refreshes; otherwise only after the throttle window.
fn should_touch_last_seen(last_seen: Option<u64>, now: u64) -> bool {
    match last_seen {
        None => true,
        Some(previous) => now.saturating_sub(previous) >= LAST_SEEN_THROTTLE_SECS,
    }
}

fn row_i64_to_u64(row: &PgRow, column: &str) -> Result<u64, String> {
    let value = row
        .try_get::<i64, _>(column)
        .map_err(postgres_decode_error)?;
    u64::try_from(value).map_err(|_| format!("Postgres column {column} is negative"))
}

fn u64_to_i64(value: u64, column: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("value for {column} exceeds Postgres BIGINT"))
}

fn postgres_decode_error(error: sqlx::Error) -> String {
    format!("failed to decode Postgres public control-plane row: {error}")
}

fn parse_optional_u64(name: &str, value: Option<String>) -> Result<Option<u64>, String> {
    let Some(value) = trimmed_option_string(value) else {
        return Ok(None);
    };
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| format!("{name} must be a positive integer: {error}"))
}

fn random_token(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn client_relay_grant_key(client_id: &str, relay_id: &str) -> String {
    format!("{client_id}:{relay_id}")
}

/// Preserve each earlier replacement's deadline so later rotations cannot extend old access.
/// Bound the retained list to keep repeated approvals from growing stored rows indefinitely.
fn carry_superseded(
    previous: &[SupersededToken],
    rotated_hash: String,
    now: u64,
    grace_secs: u64,
) -> Vec<SupersededToken> {
    let mut kept: Vec<SupersededToken> = previous
        .iter()
        .filter(|token| token.expires_at > now && token.refresh_token_hash != rotated_hash)
        .cloned()
        .collect();
    kept.push(SupersededToken {
        refresh_token_hash: rotated_hash,
        expires_at: now.saturating_add(grace_secs),
    });
    if kept.len() > MAX_SUPERSEDED_TOKENS {
        let excess = kept.len() - MAX_SUPERSEDED_TOKENS;
        kept.drain(..excess);
    }
    kept
}

fn issue_client_id(client_verify_key: &str) -> String {
    let digest = sha256_hex(client_verify_key);
    format!("client-{}", &digest[..16])
}

fn public_mode_requires_persistent_state() -> bool {
    std::env::var("BIND_HOST")
        .ok()
        .and_then(|value| value.parse::<IpAddr>().ok())
        .map(|addr| !addr.is_loopback())
        .unwrap_or(false)
}

fn compact_label(label: Option<String>) -> Option<String> {
    let label = trimmed_option_string(label)?;
    Some(label.chars().take(MAX_LABEL_CHARS).collect())
}

fn check_id_length(name: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_ID_BYTES {
        return Err(format!("{name} is too long"));
    }
    Ok(())
}

pub(crate) fn validate_relay_verify_key(verify_key_b64: &str) -> Result<(), String> {
    parse_relay_verifying_key(verify_key_b64).map(|_| ())
}

fn verify_relay_enrollment_challenge_signature(
    verify_key_b64: &str,
    challenge_id: &str,
    challenge: &str,
    signature_b64: &str,
) -> Result<(), String> {
    let signature_bytes =
        decode_base64_array::<64>(signature_b64, "relay enrollment signature is invalid")?;
    let verify_key = parse_relay_verifying_key(verify_key_b64)?;
    let signature = Signature::from_bytes(&signature_bytes);
    verify_key
        .verify(
            relay_enrollment_challenge_message(challenge_id, challenge).as_bytes(),
            &signature,
        )
        .map_err(|_| "relay enrollment signature is invalid".to_string())
}

fn parse_relay_verifying_key(verify_key_b64: &str) -> Result<VerifyingKey, String> {
    let verify_key_bytes =
        decode_base64_array::<32>(verify_key_b64, "relay verify key is invalid")?;
    VerifyingKey::from_bytes(&verify_key_bytes)
        .map_err(|_| "relay verify key is invalid".to_string())
}

fn decode_base64_array<const N: usize>(
    value: &str,
    invalid_message: &str,
) -> Result<[u8; N], String> {
    STANDARD
        .decode(value)
        .map_err(|_| invalid_message.to_string())?
        .try_into()
        .map_err(|_| invalid_message.to_string())
}

fn relay_enrollment_challenge_message(challenge_id: &str, challenge: &str) -> String {
    format!("agent-relay:relay-enroll:{challenge_id}:{challenge}")
}

fn enrolled_relay_verify_key(registration: &PersistedRelayRegistration) -> Result<String, String> {
    let Some(verify_key) = registration
        .relay_verify_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    else {
        return Err("relay registration has no enrolled verify key".to_string());
    };
    validate_relay_verify_key(verify_key)?;
    Ok(verify_key.to_string())
}

/// Domain-separated and bound to the relay: a signature harvested from one
/// relay's pairing cannot be replayed to claim against a different one.
pub fn client_claim_message(claim_id: &str, nonce: &str, relay_id: &str) -> String {
    format!("agent-relay:client-claim:{claim_id}:{nonce}:{relay_id}")
}

fn verify_client_claim_signature(
    client_verify_key_b64: &str,
    claim_id: &str,
    nonce: &str,
    relay_id: &str,
    signature_b64: &str,
) -> Result<(), String> {
    let signature_bytes =
        decode_base64_array::<64>(signature_b64, "client claim signature is invalid")?;
    let verify_key = parse_relay_verifying_key(client_verify_key_b64)
        .map_err(|_| "client claim signature is invalid".to_string())?;
    let signature = Signature::from_bytes(&signature_bytes);
    verify_key
        .verify(
            client_claim_message(claim_id, nonce, relay_id).as_bytes(),
            &signature,
        )
        .map_err(|_| "client claim signature is invalid".to_string())
}

/// Live-Postgres round-trip tests.
///
/// SAFETY / ISOLATION: these tests write and delete public-control rows and some
/// truncate whole tables in setup/teardown. They are therefore destructive to any
/// concurrent writer. `RELAY_BROKER_TEST_POSTGRES_URL` MUST reference a DISPOSABLE
/// database — never a shared or running broker's DB — and the suite MUST run with
/// `--test-threads=1` (also avoids a concurrent `CREATE TABLE IF NOT EXISTS` race
/// on `pg_type_typname_nsp_index`). Example:
///   RELAY_BROKER_TEST_POSTGRES_URL=postgres://user:pw@127.0.0.1:5433/throwaway \
///     cargo test -p relay-broker postgres -- --test-threads=1
#[cfg(test)]
#[path = "public_control/tests/postgres_round_trip_tests.rs"]
mod postgres_round_trip_tests;

#[cfg(test)]
#[path = "public_control/tests/device_revoke_tests.rs"]
mod device_revoke_tests;

#[cfg(test)]
#[path = "public_control/tests/device_limit_tests.rs"]
mod device_limit_tests;

/// Correctness + performance coverage for the single-instance Postgres
/// optimization: targeted diff-save (`save_public_control_postgres`) and the
/// reload-before-use skip. Env-gated on `RELAY_BROKER_TEST_POSTGRES_URL` and,
/// like the other pg tests, MUST run against a DISPOSABLE database with
/// `--test-threads=1` (these helpers DELETE every public-control row).
#[cfg(test)]
#[path = "public_control/tests/postgres_persistence_opt_tests.rs"]
mod postgres_persistence_opt_tests;

#[cfg(test)]
#[path = "public_control/tests/superseded_index_tests.rs"]
mod superseded_index_tests;

#[cfg(test)]
#[path = "public_control/tests/anonymous_input_tests.rs"]
mod anonymous_input_tests;

#[cfg(test)]
#[path = "public_control/tests/miss_reload_tests.rs"]
mod miss_reload_tests;

#[cfg(test)]
#[path = "public_control/tests/relay_proofs.rs"]
mod relay_proof_tests;
