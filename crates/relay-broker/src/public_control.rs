use std::{
    collections::{BTreeSet, HashMap},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
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
    sync::{Mutex, MutexGuard},
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
pub const PUBLIC_RELAY_WS_TTL_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_RELAY_WS_TTL_SECS";
pub const PUBLIC_DEVICE_WS_TTL_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS";
/// Grace window during which a rotated-away client/device refresh token keeps
/// authenticating. Every approval rotates these tokens, but the fresh token only
/// reaches the session that completes that pairing handshake — an already-paired
/// device that never sees it would otherwise be bricked by the very approval
/// meant to (re-)authorize it. Uses within the window slide the expiry forward;
/// explicit revocation still kills current and superseded tokens immediately.
pub const PUBLIC_ROTATION_GRACE_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_ROTATION_GRACE_SECS";

const DEFAULT_PUBLIC_RELAY_WS_TTL_SECS: u64 = 300;
const DEFAULT_PUBLIC_DEVICE_WS_TTL_SECS: u64 = 300;
const DEFAULT_PUBLIC_ROTATION_GRACE_SECS: u64 = 60 * 60 * 48;
/// Upper bound on retained superseded tokens per credential, so repeated
/// re-approvals cannot grow rows without bound (oldest entries drop first).
const MAX_SUPERSEDED_TOKENS: usize = 16;
const DEFAULT_RELAY_ENROLLMENT_CHALLENGE_TTL_SECS: u64 = 300;
const PUBLIC_CONTROL_STATE_VERSION: u32 = 2;

/// Stable prefix on the per-license device-cap error, so the HTTP layer can map
/// it to a machine-readable `device_limit_reached` code (and callers/UI can match
/// it) without fragile full-string comparisons.
pub const DEVICE_LIMIT_REACHED_ERROR_PREFIX: &str = "device limit reached";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayRegistrationConfig {
    pub relay_id: String,
    pub broker_room_id: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayWsTokenRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub relay_peer_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayEnrollmentCompleteRequest {
    pub relay_verify_key: String,
    pub challenge_id: String,
    pub challenge_signature: String,
    #[serde(default)]
    pub relay_label: Option<String>,
    /// License code the relay presents at enrollment. Required when the broker
    /// has `RELAY_BROKER_REQUIRE_LICENSE_CODE=1`; ignored otherwise.
    #[serde(default)]
    pub license_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayEnrollmentResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub relay_refresh_token: String,
    pub created_at: u64,
    #[serde(default)]
    pub relay_label: Option<String>,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientGrantResponse {
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
}

#[derive(Clone)]
enum PublicControlPersistence {
    InMemory,
    Json(PathBuf),
    Postgres {
        pool: PgPool,
        /// Reload the whole state from Postgres before every operation. Only
        /// needed when multiple broker instances share this database (so each
        /// sees the others' writes). Defaults to `false`: with a single instance
        /// (railway.toml `numReplicas = 1`) the in-memory state is authoritative,
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

/// Opaque snapshot of a relay registration captured before re-enrollment, so the
/// original credential can be restored if a later step (license redemption) fails.
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
/// noisiest relays surface first. License attribution is joined on separately by
/// the caller (the license table lives outside the control-plane store).
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
        let issuer_key = JoinTicketKey::from_secret(issuer_secret.as_bytes())?;
        let persistence = PublicControlPersistence::from_config(state_path, postgres_url).await?;
        if !persistence.has_persistent_state() && public_mode_requires_persistent_state() {
            return Err(format!(
                "{PUBLIC_STATE_PATH_ENV} or {PUBLIC_POSTGRES_URL_ENV} is required when {}=public and BIND_HOST is not loopback",
                crate::auth::BROKER_AUTH_MODE_ENV
            ));
        }
        let mut state = persistence.load().await?;
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
        let relay_label = request
            .relay_label
            .and_then(|label| trimmed_option_string(Some(label)))
            .filter(|label| !label.is_empty());
        let challenge_id = format!("rch-{}", random_token(24).to_ascii_lowercase());
        let challenge = format!("rc-{}", random_token(40).to_ascii_lowercase());
        let expires_at = unix_now().saturating_add(DEFAULT_RELAY_ENROLLMENT_CHALLENGE_TTL_SECS);
        self.inner.relay_enrollment_challenges.lock().await.insert(
            challenge_id.clone(),
            PendingRelayEnrollmentChallenge {
                relay_verify_key: relay_verify_key.clone(),
                challenge: challenge.clone(),
                relay_label,
                expires_at,
            },
        );
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
        let relay_label = request
            .relay_label
            .and_then(|label| trimmed_option_string(Some(label)))
            .filter(|label| !label.is_empty())
            .or(pending.relay_label);
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
                    if let Err(error) = self.inner.persistence.save(&mut store).await {
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
    /// the relay's original refresh credential if a later step (license redemption)
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
                if let Err(error) = self.inner.persistence.save(&mut store).await {
                    warn!(%error, "failed to persist relay registration restore");
                }
            }
            Err(error) => warn!(%error, "restore_relay_registration: failed to lock state"),
        }
    }

    pub async fn issue_relay_ws_token(
        &self,
        bearer_token: &str,
        request: RelayWsTokenRequest,
    ) -> Result<RelayWsTokenResponse, String> {
        let registration = self
            .authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)
            .await?;
        let expires_at = unix_now().saturating_add(self.inner.relay_ws_ttl_secs);
        Ok(RelayWsTokenResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            relay_ws_token: self.inner.issuer_key.mint(
                &JoinTicketClaims::relay_join_with_expiry(
                    &registration.broker_room_id,
                    &request.relay_peer_id,
                    Some(expires_at),
                ),
            )?,
            relay_ws_token_expires_at: expires_at,
        })
    }

    pub async fn issue_pairing_ws_token(
        &self,
        bearer_token: &str,
        request: PairingWsTokenRequest,
    ) -> Result<PairingWsTokenResponse, String> {
        let registration = self
            .authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)
            .await?;
        Ok(PairingWsTokenResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            pairing_join_ticket: self.inner.issuer_key.mint(
                &JoinTicketClaims::pairing_surface_join(
                    &registration.broker_room_id,
                    &request.pairing_id,
                    request.expires_at,
                ),
            )?,
            pairing_join_ticket_expires_at: request.expires_at,
        })
    }

    /// Authenticate a relay bearer against `(relay_id, broker_room_id)` with no
    /// side effects. Handlers call this before consulting license state so an
    /// unauthenticated caller cannot probe which relays have active / expired /
    /// revoked licenses — a bad bearer fails identically regardless of that state.
    pub async fn authenticate_relay_bearer(
        &self,
        bearer_token: &str,
        relay_id: &str,
        broker_room_id: &str,
    ) -> Result<(), String> {
        self.authenticate_relay(bearer_token, relay_id, broker_room_id)
            .await
            .map(|_| ())
    }

    /// Issue a device grant for a relay-authenticated request.
    ///
    /// `device_limit` is the per-license device cap resolved by the caller from
    /// the license tier (`None` = unlimited, e.g. licensing disabled). The cap is
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
                        "{DEVICE_LIMIT_REACHED_ERROR_PREFIX}: this license allows {limit} \
                         device(s); remove a device to add a new one"
                    ));
                }
            }
        }
        // A re-registration rotates the device refresh token; keep the replaced
        // token honored for the grace window so an already-paired device that
        // never receives this new credential is not bricked by the approval.
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
        self.inner.persistence.save(&mut store).await?;

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

    /// Test-only: seed a client→relay grant directly, bypassing enrollment, to
    /// simulate an orphaned grant (no registration, no device grant) — the state a
    /// dangling `client_relay_grant` leaves behind.
    #[cfg(test)]
    async fn seed_client_relay_grant_for_test(&self, relay_id: &str, client_id: &str) {
        let mut store = self.lock_state().await.expect("lock state");
        store.upsert_client_relay_grant(PersistedClientRelayGrant {
            client_id: client_id.to_string(),
            relay_id: relay_id.to_string(),
            broker_room_id: format!("room-{relay_id}"),
            device_id: format!("dev-{client_id}"),
            granted_at: 0,
            relay_label: None,
            device_label: None,
        });
        self.inner.persistence.save(&mut store).await.expect("save");
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
        let client_label = request
            .client_label
            .and_then(|label| trimmed_option_string(Some(label)))
            .filter(|label| !label.is_empty());
        let device_label = request
            .device_label
            .and_then(|label| trimmed_option_string(Some(label)))
            .filter(|label| !label.is_empty());
        let created_at = unix_now();
        let mut store = self.lock_state().await?;
        let (client_id, client_refresh_token) = store.issue_or_rotate_client_identity(
            &client_verify_key,
            client_label,
            created_at,
            self.inner.rotation_grace_secs,
        );
        store.upsert_client_relay_grant(PersistedClientRelayGrant {
            client_id: client_id.clone(),
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            device_id: request.device_id.clone(),
            granted_at: created_at,
            relay_label: registration.relay_label.clone(),
            device_label,
        });
        self.inner.persistence.save(&mut store).await?;
        Ok(ClientGrantResponse {
            client_id,
            client_refresh_token,
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            device_id: request.device_id,
            relay_label: registration.relay_label.clone(),
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
        let client = self.authenticate_client(bearer_token).await?;
        let mut store = self.lock_state().await?;
        let refreshed_token =
            store.rotate_client_identity(&client, unix_now(), self.inner.rotation_grace_secs);
        self.inner.persistence.save(&mut store).await?;
        Ok((client.client_id, refreshed_token))
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
            self.inner.persistence.save(&mut store).await?;
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

    /// Room-scoped ws-token: the resolved grant must belong to `expected_room`.
    /// The check happens BEFORE any side effect (grace-window slide, `last_seen`
    /// touch), so a mismatch — e.g. a legacy origin-wide cookie carrying a sibling
    /// relay's token — leaves all durable state untouched. The generic error keeps
    /// the endpoint from revealing which rooms exist.
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
            let mut store = self.lock_state().await?;
            let mut found = find_device_grant_for_token(&store, &token_hash, now);
            if found.is_none() && self.reload_state_on_miss(&mut store).await? {
                found = find_device_grant_for_token(&store, &token_hash, now);
            }
            let (primary_hash, grant) =
                found.ok_or_else(|| "device refresh token is invalid".to_string())?;
            if let Some(expected) = expected_room {
                if grant.broker_room_id != expected {
                    return Err("device refresh token is invalid".to_string());
                }
            }
            if primary_hash != token_hash {
                // Matched via a superseded token inside its grace window: slide
                // the window forward (throttled, best-effort).
                if let Some(live) = store.grants_by_hash.get_mut(&primary_hash) {
                    if bump_superseded_expiry(
                        &mut live.superseded,
                        &token_hash,
                        now,
                        self.inner.rotation_grace_secs,
                    ) {
                        if let Err(error) = self.inner.persistence.save(&mut store).await {
                            warn!(%error, "failed to persist device grace renewal; continuing");
                        }
                    }
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
            self.inner.persistence.save(&mut store).await?;
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
            self.inner.persistence.save(&mut store).await?;
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
        if self.inner.persistence.reload_before_use() {
            *store = self.inner.persistence.load().await?;
        }
        Ok(store)
    }

    /// A token miss against a shared backend may just mean this instance's
    /// memory is stale — reload the authoritative state once so the caller can
    /// retry the lookup before rejecting the credential. Returns whether a
    /// reload happened.
    async fn reload_state_on_miss(
        &self,
        store: &mut PublicControlStateStore,
    ) -> Result<bool, String> {
        if !self.inner.persistence.shared_backend() {
            return Ok(false);
        }
        *store = self.inner.persistence.load().await?;
        Ok(true)
    }

    async fn authenticate_relay(
        &self,
        bearer_token: &str,
        relay_id: &str,
        broker_room_id: &str,
    ) -> Result<PersistedRelayRegistration, String> {
        let mut store = self.lock_state().await?;
        let token_hash = sha256_hex(bearer_token.trim());
        let mut found = store.relay_registrations_by_hash.get(&token_hash).cloned();
        if found.is_none() && self.reload_state_on_miss(&mut store).await? {
            found = store.relay_registrations_by_hash.get(&token_hash).cloned();
        }
        let registration = found.ok_or_else(|| "relay refresh token is invalid".to_string())?;
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
        let mut store = self.lock_state().await?;
        let token_hash = sha256_hex(bearer_token.trim());
        let now = unix_now();
        let mut found = find_client_identity_for_token(&store, &token_hash, now);
        if found.is_none() && self.reload_state_on_miss(&mut store).await? {
            found = find_client_identity_for_token(&store, &token_hash, now);
        }
        let (primary_hash, identity) =
            found.ok_or_else(|| "client refresh token is invalid".to_string())?;
        if primary_hash != token_hash {
            // Matched via a superseded token inside its grace window: slide the
            // window forward (throttled) so an actively-used device keeps working
            // until it picks up a fresh credential. Best-effort persistence — a
            // failed write must not deny authentication.
            if let Some(live) = store.client_registrations_by_hash.get_mut(&primary_hash) {
                if bump_superseded_expiry(
                    &mut live.superseded,
                    &token_hash,
                    now,
                    self.inner.rotation_grace_secs,
                ) {
                    if let Err(error) = self.inner.persistence.save(&mut store).await {
                        warn!(%error, "failed to persist client grace renewal; continuing");
                    }
                }
            }
        }
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
        let mut store = self.lock_state().await?;
        let token_hash = sha256_hex(bearer_token.trim());
        let now = unix_now();
        let mut found = find_device_grant_for_token(&store, &token_hash, now);
        if found.is_none() && self.reload_state_on_miss(&mut store).await? {
            found = find_device_grant_for_token(&store, &token_hash, now);
        }
        let (primary_hash, grant) =
            found.ok_or_else(|| "device refresh token is invalid".to_string())?;
        // Verify the room BEFORE the grace-window bump below, so a wrong-room
        // request has zero side effects (it must not renew a superseded token's
        // grace and thereby extend a credential's validity).
        if let Some(expected) = expected_room {
            if grant.broker_room_id != expected {
                return Err("device refresh token is invalid".to_string());
            }
        }
        if primary_hash != token_hash {
            if let Some(live) = store.grants_by_hash.get_mut(&primary_hash) {
                if bump_superseded_expiry(
                    &mut live.superseded,
                    &token_hash,
                    now,
                    self.inner.rotation_grace_secs,
                ) {
                    if let Err(error) = self.inner.persistence.save(&mut store).await {
                        warn!(%error, "failed to persist device grace renewal; continuing");
                    }
                }
            }
        }
        Ok(grant)
    }

    pub async fn device_refresh_token_matches_room(
        &self,
        bearer_token: &str,
        expected_room: &str,
    ) -> Result<bool, String> {
        let mut store = self.lock_state().await?;
        let token_hash = sha256_hex(bearer_token.trim());
        let now = unix_now();
        let mut found = find_device_grant_for_token(&store, &token_hash, now);
        if found.is_none() && self.reload_state_on_miss(&mut store).await? {
            found = find_device_grant_for_token(&store, &token_hash, now);
        }
        Ok(found
            .map(|(_, grant)| grant.broker_room_id == expected_room)
            .unwrap_or(false))
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
        self.inner.persistence.save(&mut store).await?;
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
                info!(
                    backend = "postgres",
                    target = %redact_postgres_url(&url),
                    "public control-plane persistence: Postgres (connecting)"
                );
                let pool = PgPoolOptions::new()
                    .max_connections(5)
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
                Ok(Self::Postgres {
                    pool,
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
                last_saved,
                needs_reload,
                ..
            } => {
                let store = load_public_control_postgres(pool).await?;
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
                last_saved,
                needs_reload,
                ..
            } => {
                // Diff the live state against the last-persisted snapshot and write
                // only the rows that changed. Hold the snapshot lock across the
                // write so it advances atomically with the DB.
                let mut snapshot = last_saved.lock().await;
                match save_public_control_postgres(pool, &snapshot, state).await {
                    Ok(()) => {
                        *snapshot = state.clone();
                        Ok(())
                    }
                    Err(error) => match load_public_control_postgres(pool).await {
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
                    },
                }
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
            Self::Postgres { pool, .. } => {
                sqlx::query(
                    "UPDATE public_device_grants SET last_seen = $1 WHERE refresh_token_hash = $2",
                )
                .bind(u64_to_i64(last_seen, "last_seen")?)
                .bind(refresh_token_hash)
                .execute(pool)
                .await
                .map_err(|error| format!("failed to update device last_seen: {error}"))?;
                Ok(())
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
    /// count the per-license limit is compared against.
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
                entry.insert(PersistedRelayRegistration {
                    relay_id: registration.relay_id,
                    broker_room_id: registration.broker_room_id,
                    refresh_token_hash,
                    created_at: 0,
                    relay_label: None,
                    relay_verify_key: None,
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

async fn initialize_postgres_public_control_schema(pool: &PgPool) -> Result<(), String> {
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
    }
    Ok(())
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
            .map(|row| {
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
            })
            .collect::<Result<Vec<_>, String>>()?,
        client_registrations: client_rows
            .into_iter()
            .map(|row| {
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
            })
            .collect::<Result<Vec<_>, String>>()?,
        device_grants: device_rows
            .into_iter()
            .map(|row| {
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
            })
            .collect::<Result<Vec<_>, String>>()?,
        client_relay_grants: client_grant_rows
            .into_iter()
            .map(|row| {
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
            })
            .collect::<Result<Vec<_>, String>>()?,
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

    // ORDER MATTERS: delete every removed row across ALL tables FIRST, then upsert
    // added/changed rows. A credential rotation (relay re-enroll, client rotation,
    // device re-registration) changes the PK `refresh_token_hash` but keeps a
    // SECONDARY unique column (relay_id / broker_room_id / relay_verify_key /
    // client_id / client_verify_key / `(relay_id, broker_room_id, device_id)`). If
    // the new row were inserted before the old one is deleted, that insert would
    // collide with the surviving old row on the secondary unique index and abort
    // the whole transaction — wedging the control plane. Deleting up front makes
    // rotation a clean delete-then-insert.

    // --- Phase 1: DELETE rows present in the snapshot but gone from live state ---
    for hash in prev.relay_registrations_by_hash.keys() {
        if !next.relay_registrations_by_hash.contains_key(hash) {
            sqlx::query("DELETE FROM public_relay_registrations WHERE refresh_token_hash = $1")
                .bind(hash)
                .execute(&mut *tx)
                .await
                .map_err(|error| format!("failed to delete public_relay_registrations: {error}"))?;
        }
    }
    for hash in prev.client_registrations_by_hash.keys() {
        if !next.client_registrations_by_hash.contains_key(hash) {
            sqlx::query("DELETE FROM public_client_identities WHERE refresh_token_hash = $1")
                .bind(hash)
                .execute(&mut *tx)
                .await
                .map_err(|error| format!("failed to delete public_client_identities: {error}"))?;
        }
    }
    for hash in prev.grants_by_hash.keys() {
        if !next.grants_by_hash.contains_key(hash) {
            sqlx::query("DELETE FROM public_device_grants WHERE refresh_token_hash = $1")
                .bind(hash)
                .execute(&mut *tx)
                .await
                .map_err(|error| format!("failed to delete public_device_grants: {error}"))?;
        }
    }
    for (key, grant) in &prev.client_relay_grants_by_key {
        if !next.client_relay_grants_by_key.contains_key(key) {
            sqlx::query(
                "DELETE FROM public_client_relay_grants WHERE client_id = $1 AND relay_id = $2",
            )
            .bind(&grant.client_id)
            .bind(&grant.relay_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("failed to delete public_client_relay_grants: {error}"))?;
        }
    }

    // --- Phase 2: UPSERT rows that were added or changed ---
    // public_relay_registrations (PK: refresh_token_hash)
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
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("failed to upsert public_relay_registrations: {error}"))?;
        }
    }
    // public_client_identities (PK: refresh_token_hash)
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
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("failed to upsert public_client_identities: {error}"))?;
        }
    }
    // public_device_grants (PK: refresh_token_hash)
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
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("failed to upsert public_device_grants: {error}"))?;
        }
    }
    // public_client_relay_grants (PK: (client_id, relay_id))
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
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("failed to upsert public_client_relay_grants: {error}"))?;
        }
    }

    tx.commit()
        .await
        .map_err(|error| format!("failed to commit public control-plane transaction: {error}"))?;
    Ok(())
}

/// Pre-optimization full wipe-and-rebuild save. Kept ONLY so the persistence
/// benchmark can measure the targeted diff-save against the old behavior; it is
/// not wired into any live code path.
#[cfg(test)]
async fn save_public_control_postgres_full_rebuild(
    pool: &PgPool,
    state: &PublicControlStateStore,
) -> Result<(), String> {
    let persisted = state.to_persisted();
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("failed to begin public control-plane transaction: {error}"))?;
    sqlx::query("DELETE FROM public_client_relay_grants")
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to clear public_client_relay_grants: {error}"))?;
    sqlx::query("DELETE FROM public_device_grants")
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to clear public_device_grants: {error}"))?;
    sqlx::query("DELETE FROM public_client_identities")
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to clear public_client_identities: {error}"))?;
    sqlx::query("DELETE FROM public_relay_registrations")
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to clear public_relay_registrations: {error}"))?;

    for registration in persisted.relay_registrations {
        sqlx::query(
            r#"
            INSERT INTO public_relay_registrations (
                refresh_token_hash, relay_id, broker_room_id, created_at, relay_label, relay_verify_key
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(registration.refresh_token_hash)
        .bind(registration.relay_id)
        .bind(registration.broker_room_id)
        .bind(u64_to_i64(registration.created_at, "created_at")?)
        .bind(registration.relay_label)
        .bind(registration.relay_verify_key)
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to insert public_relay_registrations: {error}"))?;
    }
    for client in persisted.client_registrations {
        sqlx::query(
            r#"
            INSERT INTO public_client_identities (
                refresh_token_hash, client_id, client_verify_key, created_at, client_label
            )
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(client.refresh_token_hash)
        .bind(client.client_id)
        .bind(client.client_verify_key)
        .bind(u64_to_i64(client.created_at, "created_at")?)
        .bind(client.client_label)
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to insert public_client_identities: {error}"))?;
    }
    for grant in persisted.device_grants {
        sqlx::query(
            r#"
            INSERT INTO public_device_grants (
                refresh_token_hash, relay_id, broker_room_id, device_id, created_at, last_seen
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(grant.refresh_token_hash)
        .bind(grant.relay_id)
        .bind(grant.broker_room_id)
        .bind(grant.device_id)
        .bind(u64_to_i64(grant.created_at, "created_at")?)
        .bind(grant.last_seen.and_then(|value| i64::try_from(value).ok()))
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to insert public_device_grants: {error}"))?;
    }
    for grant in persisted.client_relay_grants {
        sqlx::query(
            r#"
            INSERT INTO public_client_relay_grants (
                client_id, relay_id, broker_room_id, device_id, granted_at, relay_label, device_label
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(grant.client_id)
        .bind(grant.relay_id)
        .bind(grant.broker_room_id)
        .bind(grant.device_id)
        .bind(u64_to_i64(grant.granted_at, "granted_at")?)
        .bind(grant.relay_label)
        .bind(grant.device_label)
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to insert public_client_relay_grants: {error}"))?;
    }
    tx.commit()
        .await
        .map_err(|error| format!("failed to commit public control-plane transaction: {error}"))?;
    Ok(())
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
/// call. See device-limit-plan.md.
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

/// Build the superseded-token list for a credential rotation: keep the still
/// unexpired entries, add the token being rotated away with a fresh grace
/// deadline, and cap the list (oldest first out). A `grace_secs` of 0 disables
/// the grace window entirely (the new entry is already expired).
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

/// Sliding-window renewal: a successful use of a superseded token pushes its
/// expiry forward (throttled to at most one bump per half-window, so steady
/// use does not turn into a durable write per request). Returns whether the
/// entry changed and should be persisted.
fn bump_superseded_expiry(
    superseded: &mut [SupersededToken],
    token_hash: &str,
    now: u64,
    grace_secs: u64,
) -> bool {
    for token in superseded {
        if token.refresh_token_hash == token_hash && token.expires_at > now {
            let renewed = now.saturating_add(grace_secs);
            if token.expires_at < now.saturating_add(grace_secs / 2) && renewed > token.expires_at {
                token.expires_at = renewed;
                return true;
            }
            return false;
        }
    }
    false
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

fn validate_relay_verify_key(verify_key_b64: &str) -> Result<(), String> {
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
mod postgres_round_trip_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Live-Postgres round-trip: a relay registration written by one instance
    /// must survive a "restart" and load in a fresh instance against the same
    /// database. Closes the gap that the JSON path was the only backend with
    /// automated coverage.
    ///
    /// Env-gated so plain `cargo test` stays offline. Run ONLY against a
    /// DISPOSABLE database, serially (see the module-level SAFETY note):
    ///   RELAY_BROKER_TEST_POSTGRES_URL=postgres://user:pw@127.0.0.1:5433/throwaway \
    ///     cargo test -p relay-broker postgres_relay_registration -- --test-threads=1
    #[tokio::test]
    async fn postgres_relay_registration_persists_across_reload() {
        let Some(url) = trimmed_option_string(std::env::var("RELAY_BROKER_TEST_POSTGRES_URL").ok())
        else {
            eprintln!(
                "skipping postgres round-trip: set RELAY_BROKER_TEST_POSTGRES_URL to a live DB"
            );
            return;
        };

        let issuer = Some("test-issuer-secret".to_string());
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let verify_key = format!("test-verify-key-{unique}");

        // Plane A writes a relay registration -> exercises the Postgres SAVE path.
        let plane_a = PublicControlPlane::from_parts_with_postgres(
            issuer.clone(),
            None,
            None,
            Some(url.clone()),
            None,
            None,
        )
        .await
        .expect("plane A should connect to postgres");
        let enrolled = plane_a
            .issue_relay_registration_for_verify_key(&verify_key, Some("round-trip".to_string()))
            .await
            .expect("registration should save to postgres");

        // Plane B is a brand-new instance against the same DB; its constructor
        // load()s from Postgres -> exercises the LOAD path after a "restart".
        let plane_b = PublicControlPlane::from_parts_with_postgres(
            issuer,
            None,
            None,
            Some(url.clone()),
            None,
            None,
        )
        .await
        .expect("plane B should connect to postgres");

        let loaded = plane_b
            .inner
            .state
            .lock()
            .await
            .registration_for_verify_key(&verify_key)
            .expect("registration written by plane A must survive reload in plane B");

        // Row-scoped cleanup: a targeted DELETE of only THIS run's registration
        // before asserting, so failures still clean up without touching any other
        // rows in the (disposable) database.
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("aux pool");
        sqlx::query("DELETE FROM public_relay_registrations WHERE relay_id = $1")
            .bind(&enrolled.relay_id)
            .execute(&pool)
            .await
            .expect("cleanup relay registration");

        assert_eq!(loaded.relay_id, enrolled.relay_id);
        assert_eq!(loaded.broker_room_id, enrolled.broker_room_id);
        assert_eq!(loaded.relay_label.as_deref(), Some("round-trip"));
    }

    /// Live-Postgres round-trip for device grants: a grant (with `last_seen`) must
    /// survive reload, and a throttled ws-token refresh must bump `last_seen` via
    /// the targeted single-row UPDATE (`touch_device_last_seen`). Env-gated.
    ///
    /// DANGER: this test writes and deletes public-control rows (`issue_*` →
    /// targeted `save()`, plus row-scoped cleanup). Point `RELAY_BROKER_TEST_POSTGRES_URL`
    /// at a DISPOSABLE database ONLY, and run with `--test-threads=1`. Never point
    /// it at a shared or running broker's database — a concurrent writer's rows can
    /// be lost. Cleanup below is row-scoped (targeted DELETEs, not a whole-state
    /// save) to minimise blast radius.
    #[tokio::test]
    async fn postgres_device_grant_last_seen_round_trips_and_touches() {
        let Some(url) = trimmed_option_string(std::env::var("RELAY_BROKER_TEST_POSTGRES_URL").ok())
        else {
            eprintln!(
                "skipping postgres device-grant round-trip: set RELAY_BROKER_TEST_POSTGRES_URL"
            );
            return;
        };
        let issuer = Some("test-issuer-secret".to_string());
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let verify_key = format!("test-verify-key-devgrant-{unique}");
        let device_id = format!("device-{unique}");

        let plane_a = PublicControlPlane::from_parts_with_postgres(
            issuer.clone(),
            None,
            None,
            Some(url.clone()),
            None,
            None,
        )
        .await
        .expect("plane A should connect");
        let enrolled = plane_a
            .issue_relay_registration_for_verify_key(&verify_key, None)
            .await
            .expect("relay enroll");
        let grant = plane_a
            .issue_device_grant(
                &enrolled.relay_refresh_token,
                DeviceGrantRequest {
                    relay_id: enrolled.relay_id.clone(),
                    broker_room_id: enrolled.broker_room_id.clone(),
                    device_id: device_id.clone(),
                },
                Some(5),
            )
            .await
            .expect("device grant should save to postgres");

        // (1) A fresh instance loads the grant (with last_seen) from Postgres.
        let plane_b = PublicControlPlane::from_parts_with_postgres(
            issuer.clone(),
            None,
            None,
            Some(url.clone()),
            None,
            None,
        )
        .await
        .expect("plane B should connect");
        let reloaded_last_seen = {
            let guard = plane_b.inner.state.lock().await;
            guard
                .grants_by_hash
                .values()
                .find(|candidate| candidate.device_id == device_id)
                .map(|candidate| candidate.last_seen)
        };

        // (2) Age last_seen, then a ws-token refresh must bump it via the targeted
        // UPDATE (touch_device_last_seen), not the whole-state save. The throttle
        // decision reads the IN-MEMORY last_seen, so with reload-before-use off
        // (single-instance default) we must age the in-memory value — not just the
        // DB row — to simulate a device unseen for longer than the throttle window.
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("aux pool");
        sqlx::query("UPDATE public_device_grants SET last_seen = 1 WHERE device_id = $1")
            .bind(&device_id)
            .execute(&pool)
            .await
            .expect("age last_seen");
        {
            let mut store = plane_a.inner.state.lock().await;
            for grant in store.grants_by_hash.values_mut() {
                if grant.device_id == device_id {
                    grant.last_seen = Some(1); // epoch 1 = well past the throttle window
                }
            }
        }
        plane_a
            .issue_device_ws_token(&grant.device_refresh_token)
            .await
            .expect("ws-token refresh");
        let (bumped,): (Option<i64>,) =
            sqlx::query_as("SELECT last_seen FROM public_device_grants WHERE device_id = $1")
                .bind(&device_id)
                .fetch_one(&pool)
                .await
                .expect("read last_seen");

        // Row-scoped cleanup before asserting — targeted DELETEs so we only touch
        // THIS test's rows in the (disposable) database.
        sqlx::query("DELETE FROM public_device_grants WHERE relay_id = $1")
            .bind(&enrolled.relay_id)
            .execute(&pool)
            .await
            .expect("cleanup device grants");
        sqlx::query("DELETE FROM public_relay_registrations WHERE relay_id = $1")
            .bind(&enrolled.relay_id)
            .execute(&pool)
            .await
            .expect("cleanup relay registration");

        assert!(
            reloaded_last_seen
                .expect("device grant must survive reload")
                .is_some(),
            "last_seen (set at grant time) must persist across reload"
        );
        assert!(
            bumped.unwrap_or(0) > 1,
            "a ws-token refresh must bump last_seen via the targeted UPDATE, got {bumped:?}"
        );
    }
}

#[cfg(test)]
mod device_revoke_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    // Regression: a client_relay_grant with no matching device grant must still be
    // removed AND persisted by revoke_device_grant. The save guard previously only
    // checked the device-grant count, so an orphan client grant removal was dropped.
    #[tokio::test]
    async fn revoke_device_grant_persists_orphan_client_relay_grant_removal() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("agent-relay-revoke-{unique}.json"));
        let path_str = path.to_str().expect("temp path is utf8").to_string();
        let issuer = Some("revoke-test-issuer".to_string());

        let plane = PublicControlPlane::from_parts(
            issuer.clone(),
            None,
            Some(path_str.clone()),
            None,
            None,
        )
        .await
        .expect("plane should build");

        // Enroll a relay so we have a valid bearer token + relay_id/room.
        let enrolled = plane
            .issue_relay_registration_for_verify_key(&format!("vk-{unique}"), None)
            .await
            .expect("enroll should succeed");

        // Inject an ORPHAN client_relay_grant (no matching device grant), then persist.
        let device_id = "device-orphan";
        {
            let mut store = plane.lock_state().await.expect("lock");
            let grant = PersistedClientRelayGrant {
                client_id: "client-orphan".to_string(),
                relay_id: enrolled.relay_id.clone(),
                broker_room_id: enrolled.broker_room_id.clone(),
                device_id: device_id.to_string(),
                granted_at: 0,
                relay_label: None,
                device_label: None,
            };
            store.client_relay_grants_by_key.insert(
                client_relay_grant_key(&grant.client_id, &grant.relay_id),
                grant,
            );
            plane
                .inner
                .persistence
                .save(&mut store)
                .await
                .expect("seed save");
        }

        // Revoke the device: no device grant to remove, but the orphan client grant
        // must be removed AND persisted.
        plane
            .revoke_device_grant(
                &enrolled.relay_refresh_token,
                device_id,
                DeviceGrantRevokeRequest {
                    relay_id: enrolled.relay_id.clone(),
                    broker_room_id: enrolled.broker_room_id.clone(),
                },
            )
            .await
            .expect("revoke should succeed");

        // Reload from disk: the orphan grant must be gone (i.e. the removal persisted).
        let reloaded = PublicControlPlane::from_parts(issuer, None, Some(path_str), None, None)
            .await
            .expect("reload should build");
        let remaining = reloaded
            .lock_state()
            .await
            .expect("lock reloaded")
            .client_relay_grants_by_key
            .len();
        let _ = std::fs::remove_file(&path);

        assert_eq!(
            remaining, 0,
            "orphan client_relay_grant removal must be persisted"
        );
    }
}

#[cfg(test)]
mod device_limit_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    async fn in_memory_plane() -> PublicControlPlane {
        PublicControlPlane::from_parts(
            Some("device-limit-test-issuer".to_string()),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("in-memory plane should build")
    }

    fn grant_request(enrolled: &RelayEnrollmentResponse, device_id: &str) -> DeviceGrantRequest {
        DeviceGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: device_id.to_string(),
        }
    }

    async fn enroll(plane: &PublicControlPlane, tag: &str) -> RelayEnrollmentResponse {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        plane
            .issue_relay_registration_for_verify_key(&format!("vk-{tag}-{unique}"), None)
            .await
            .expect("enroll should succeed")
    }

    fn test_client_verify_key(seed: u8) -> String {
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        STANDARD.encode(signing_key.verifying_key().to_bytes())
    }

    fn client_grant_request(
        enrolled: &RelayEnrollmentResponse,
        device_id: &str,
        verify_key: &str,
    ) -> ClientGrantRequest {
        ClientGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: device_id.to_string(),
            client_verify_key: verify_key.to_string(),
            client_label: None,
            device_label: None,
        }
    }

    /// Approving a pairing rotates the client identity token; the fresh token is
    /// only delivered to the session that completes THAT pairing handshake. When a
    /// relay re-approves (duplicate tap, stale request, "re-authorizing" a device
    /// that seems broken), the already-paired phone never sees the new token — so
    /// its stored credential must keep authenticating for a grace window instead
    /// of getting bricked by the very action meant to restore its access.
    #[tokio::test]
    async fn reapprove_must_not_brick_previous_client_token() {
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "regrant-client").await;
        let bearer = &enrolled.relay_refresh_token;
        let verify_key = test_client_verify_key(21);

        let first = plane
            .issue_client_grant(
                bearer,
                client_grant_request(&enrolled, "phone-1", &verify_key),
            )
            .await
            .expect("first approve");
        // The phone holds `first.client_refresh_token`. The relay approves again;
        // the phone never receives the rotated credential.
        plane
            .issue_client_grant(
                bearer,
                client_grant_request(&enrolled, "phone-1", &verify_key),
            )
            .await
            .expect("re-approve");

        plane
            .issue_client_session(&first.client_refresh_token)
            .await
            .expect(
                "a client token superseded by a re-approve the client never received \
                 must keep authenticating within the rotation grace window",
            );
    }

    /// Same invariant for the device chain: re-issuing a grant for the same
    /// device_id rotates the device refresh token; the previous token must keep
    /// working within the grace window.
    #[tokio::test]
    async fn reapprove_must_not_brick_previous_device_token() {
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "regrant-device").await;
        let bearer = &enrolled.relay_refresh_token;

        let first = plane
            .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
            .await
            .expect("first approve");
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
            .await
            .expect("re-approve");

        plane
            .issue_device_session(&first.device_refresh_token)
            .await
            .expect(
                "a device token superseded by a re-approve the device never received \
                 must keep authenticating within the rotation grace window",
            );
    }

    /// A room-scoped ws-token must only authenticate against its OWN relay's room,
    /// and a mismatch must have zero side effects (no `last_seen` touch) — this is
    /// what keeps a legacy/sibling token from silently refreshing the wrong relay.
    #[tokio::test]
    async fn issue_device_ws_token_scoped_verifies_room_without_side_effects() {
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "scoped-room").await;
        let bearer = &enrolled.relay_refresh_token;
        let grant = plane
            .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
            .await
            .expect("device grant");
        let room = &enrolled.broker_room_id;

        let ok = plane
            .issue_device_ws_token_scoped(&grant.device_refresh_token, room)
            .await
            .expect("matching room must authenticate");
        assert_eq!(&ok.broker_room_id, room);

        {
            let mut store = plane.inner.state.lock().await;
            for grant in store.grants_by_hash.values_mut() {
                if grant.device_id == "phone-1" {
                    grant.last_seen = Some(0);
                }
            }
        }
        let before = last_seen_for(&plane, "phone-1").await;
        let err = plane
            .issue_device_ws_token_scoped(&grant.device_refresh_token, "room-someone-else")
            .await
            .expect_err("mismatched room must be rejected");
        assert_eq!(err, "device refresh token is invalid");
        assert_eq!(
            last_seen_for(&plane, "phone-1").await,
            before,
            "a rejected room mismatch must not touch last_seen"
        );
    }

    /// The scoped establish (session) path must also verify the room BEFORE the
    /// grace-window renewal, so a wrong-room request using a superseded token can't
    /// silently extend that token's validity.
    #[tokio::test]
    async fn issue_device_session_scoped_room_mismatch_does_not_renew_grace() {
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "scoped-session-grace").await;
        let bearer = &enrolled.relay_refresh_token;
        let first = plane
            .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
            .await
            .expect("first grant");
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
            .await
            .expect("re-grant supersedes the first token");

        // Pin the superseded token's grace expiry to a known value.
        let pinned = unix_now().saturating_add(3600);
        {
            let mut store = plane.inner.state.lock().await;
            for grant in store.grants_by_hash.values_mut() {
                for token in &mut grant.superseded {
                    token.expires_at = pinned;
                }
            }
        }

        let err = plane
            .issue_device_session_scoped(&first.device_refresh_token, "room-not-mine")
            .await
            .expect_err("wrong-room establish must be rejected");
        assert_eq!(err, "device refresh token is invalid");

        let after = {
            let store = plane.inner.state.lock().await;
            store
                .grants_by_hash
                .values()
                .flat_map(|grant| grant.superseded.iter())
                .map(|token| token.expires_at)
                .max()
        };
        assert_eq!(
            after,
            Some(pinned),
            "a wrong-room establish must not renew the grace window"
        );
    }

    /// The grace window is a window, not immortality: once a superseded token's
    /// expiry passes, it must be rejected.
    #[tokio::test]
    async fn superseded_token_expires_after_grace_window() {
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "grace-expiry").await;
        let bearer = &enrolled.relay_refresh_token;

        let first = plane
            .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
            .await
            .expect("first approve");
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
            .await
            .expect("re-approve");
        {
            let mut store = plane.inner.state.lock().await;
            for grant in store.grants_by_hash.values_mut() {
                for token in &mut grant.superseded {
                    token.expires_at = 0;
                }
            }
        }

        plane
            .issue_device_session(&first.device_refresh_token)
            .await
            .expect_err("an expired superseded token must be rejected");
    }

    /// Explicit revocation is the immediate-cutoff path: it must kill the
    /// current token AND every superseded token in the same stroke.
    #[tokio::test]
    async fn revoke_kills_superseded_tokens_immediately() {
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "grace-revoke").await;
        let bearer = &enrolled.relay_refresh_token;
        let verify_key = test_client_verify_key(23);

        let first = plane
            .issue_client_grant(
                bearer,
                client_grant_request(&enrolled, "phone-1", &verify_key),
            )
            .await
            .expect("first approve");
        let second = plane
            .issue_client_grant(
                bearer,
                client_grant_request(&enrolled, "phone-1", &verify_key),
            )
            .await
            .expect("re-approve");

        plane
            .revoke_client_identity(&second.client_refresh_token)
            .await
            .expect("revoke with the current token");

        plane
            .issue_client_session(&first.client_refresh_token)
            .await
            .expect_err("a superseded token must not survive an explicit revoke");
        plane
            .issue_client_session(&second.client_refresh_token)
            .await
            .expect_err("the revoked current token must be rejected");
    }

    #[tokio::test]
    async fn device_grant_rejected_once_limit_reached() {
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "cap").await;
        let bearer = &enrolled.relay_refresh_token;
        let limit = Some(2);

        for i in 1..=2 {
            plane
                .issue_device_grant(
                    bearer,
                    grant_request(&enrolled, &format!("device-{i}")),
                    limit,
                )
                .await
                .unwrap_or_else(|error| panic!("device {i} under the cap should succeed: {error}"));
        }
        let error = plane
            .issue_device_grant(bearer, grant_request(&enrolled, "device-3"), limit)
            .await
            .expect_err("the third device must be rejected at the cap");
        assert!(
            error.contains("device limit"),
            "expected a device-limit error, got: {error}"
        );
    }

    #[tokio::test]
    async fn admin_stats_counts_devices_per_relay_sorted() {
        let plane = in_memory_plane().await;

        // Busy relay: 3 devices.
        let busy = enroll(&plane, "busy").await;
        for device in ["d1", "d2", "d3"] {
            plane
                .issue_device_grant(
                    &busy.relay_refresh_token,
                    grant_request(&busy, device),
                    None,
                )
                .await
                .expect("busy grant");
        }
        // Re-granting an existing device must NOT inflate the count.
        plane
            .issue_device_grant(&busy.relay_refresh_token, grant_request(&busy, "d1"), None)
            .await
            .expect("regrant");

        // Quiet relay: 1 device.
        let quiet = enroll(&plane, "quiet").await;
        plane
            .issue_device_grant(
                &quiet.relay_refresh_token,
                grant_request(&quiet, "only"),
                None,
            )
            .await
            .expect("quiet grant");

        let stats = plane.admin_stats(10).await.expect("admin_stats");

        assert_eq!(stats.totals.relays, 2, "two relays are registered");
        assert_eq!(stats.totals.devices, 4, "3 + 1 device grants total");
        assert_eq!(stats.relays.len(), 2);
        // Busiest relay first.
        assert_eq!(stats.relays[0].relay_id, busy.relay_id);
        assert_eq!(stats.relays[0].device_count, 3, "dedupe keeps it at 3");
        assert_eq!(stats.relays[1].relay_id, quiet.relay_id);
        assert_eq!(stats.relays[1].device_count, 1);
    }

    #[tokio::test]
    async fn admin_stats_includes_client_only_orphan_relays() {
        // Regression: a relay with a dangling client_relay_grant but NO registration
        // and NO device grant must still surface (and count in totals), or the abuse
        // signal for orphaned grants is silently dropped.
        let plane = in_memory_plane().await;
        plane
            .seed_client_relay_grant_for_test("orphan-relay", "client-1")
            .await;

        let stats = plane.admin_stats(10).await.expect("admin_stats");
        assert_eq!(stats.totals.relays, 1, "the orphan relay must be counted");
        let row = stats
            .relays
            .iter()
            .find(|r| r.relay_id == "orphan-relay")
            .expect("orphan relay should appear in the rows");
        assert_eq!(row.device_count, 0, "it has no device grants");
        assert_eq!(row.client_count, 1, "its client grant is surfaced");
    }

    #[tokio::test]
    async fn admin_stats_top_n_caps_rows() {
        let plane = in_memory_plane().await;
        for tag in ["a", "b", "c"] {
            let relay = enroll(&plane, tag).await;
            plane
                .issue_device_grant(&relay.relay_refresh_token, grant_request(&relay, "d"), None)
                .await
                .expect("grant");
        }
        let stats = plane.admin_stats(2).await.expect("admin_stats");
        assert_eq!(stats.totals.relays, 3, "totals count all relays");
        assert_eq!(stats.relays.len(), 2, "but only top_n rows are returned");
    }

    #[tokio::test]
    async fn regrant_existing_device_at_limit_succeeds() {
        // Re-registering an EXISTING device_id while at the cap must succeed:
        // the same-device dedupe frees its slot before the count check runs.
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "regrant").await;
        let bearer = &enrolled.relay_refresh_token;
        let limit = Some(2);

        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "device-a"), limit)
            .await
            .expect("device-a");
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "device-b"), limit)
            .await
            .expect("device-b");
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "device-a"), limit)
            .await
            .expect("re-granting an existing device at the cap should succeed");
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "device-c"), limit)
            .await
            .expect_err("a genuinely new third device is still rejected");
    }

    #[tokio::test]
    async fn no_limit_means_unlimited() {
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "unlimited").await;
        let bearer = &enrolled.relay_refresh_token;
        for i in 0..5 {
            plane
                .issue_device_grant(bearer, grant_request(&enrolled, &format!("d-{i}")), None)
                .await
                .expect("with no cap, every grant should succeed");
        }
    }

    #[tokio::test]
    async fn downgrade_grandfathers_existing_devices_but_blocks_new_ones() {
        // Seed 3 devices with no cap (pre-downgrade state), then apply limit 2.
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "grandfather").await;
        let bearer = &enrolled.relay_refresh_token;
        for device in ["g1", "g2", "g3"] {
            plane
                .issue_device_grant(bearer, grant_request(&enrolled, device), None)
                .await
                .unwrap_or_else(|error| panic!("seed {device}: {error}"));
        }

        let limit = Some(2); // downgraded cap, already exceeded (3 > 2)

        // Re-registering an EXISTING device is grandfathered: no net seat, allowed
        // even while over-limit.
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "g1"), limit)
            .await
            .expect("re-registering an existing device must be allowed over-limit");

        // A genuinely new device is rejected...
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "g4"), limit)
            .await
            .expect_err("a new device over the cap must be rejected");

        // ...and that rejection must NOT have dropped any existing grant.
        let count = plane
            .lock_state()
            .await
            .expect("lock")
            .count_device_grants_for_relay(&enrolled.relay_id);
        assert_eq!(
            count, 3,
            "grandfathered grants must survive a re-register and a rejected new grant"
        );
    }

    #[tokio::test]
    async fn revoking_a_device_frees_a_slot() {
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "revoke").await;
        let bearer = &enrolled.relay_refresh_token;
        let limit = Some(2);

        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "d1"), limit)
            .await
            .expect("d1");
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "d2"), limit)
            .await
            .expect("d2");
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "d3"), limit)
            .await
            .expect_err("at the cap");

        plane
            .revoke_device_grant(
                bearer,
                "d1",
                DeviceGrantRevokeRequest {
                    relay_id: enrolled.relay_id.clone(),
                    broker_room_id: enrolled.broker_room_id.clone(),
                },
            )
            .await
            .expect("revoke d1");

        plane
            .issue_device_grant(bearer, grant_request(&enrolled, "d3"), limit)
            .await
            .expect("revoking a device frees a slot for a new one");
    }

    #[test]
    fn should_touch_last_seen_respects_throttle() {
        assert!(
            should_touch_last_seen(None, 100),
            "never-recorded always touches"
        );
        assert!(
            !should_touch_last_seen(Some(100), 100 + LAST_SEEN_THROTTLE_SECS - 1),
            "within the throttle window it must NOT touch"
        );
        assert!(
            should_touch_last_seen(Some(100), 100 + LAST_SEEN_THROTTLE_SECS),
            "at/after the throttle window it must touch"
        );
    }

    async fn last_seen_for(plane: &PublicControlPlane, device_id: &str) -> Option<u64> {
        plane
            .lock_state()
            .await
            .expect("lock")
            .grants_by_hash
            .values()
            .find(|grant| grant.device_id == device_id)
            .and_then(|grant| grant.last_seen)
    }

    #[tokio::test]
    async fn last_seen_is_set_on_grant_and_throttled_on_refresh() {
        let plane = in_memory_plane().await;
        let enrolled = enroll(&plane, "lastseen").await;
        let issued = plane
            .issue_device_grant(
                &enrolled.relay_refresh_token,
                grant_request(&enrolled, "dev"),
                None,
            )
            .await
            .expect("grant");

        let at_grant = last_seen_for(&plane, "dev").await;
        assert!(at_grant.is_some(), "last_seen must be set at grant time");

        // Refresh immediately: still inside the throttle window → unchanged.
        plane
            .issue_device_ws_token(&issued.device_refresh_token)
            .await
            .expect("refresh within window");
        assert_eq!(
            last_seen_for(&plane, "dev").await,
            at_grant,
            "a refresh inside the throttle window must not bump last_seen"
        );

        // Age last_seen far into the past, then refresh → it must bump forward.
        {
            let mut store = plane.lock_state().await.expect("lock");
            for grant in store.grants_by_hash.values_mut() {
                if grant.device_id == "dev" {
                    grant.last_seen = Some(1); // epoch 1 = well past the throttle window
                }
            }
        }
        plane
            .issue_device_ws_token(&issued.device_refresh_token)
            .await
            .expect("refresh after window");
        let bumped = last_seen_for(&plane, "dev")
            .await
            .expect("last_seen still present");
        assert!(
            bumped > 1,
            "a refresh after the throttle window must bump last_seen; got {bumped}"
        );
    }
}

/// Correctness + performance coverage for the single-instance Postgres
/// optimization: targeted diff-save (`save_public_control_postgres`) and the
/// reload-before-use skip. Env-gated on `RELAY_BROKER_TEST_POSTGRES_URL` and,
/// like the other pg tests, MUST run against a DISPOSABLE database with
/// `--test-threads=1` (these helpers DELETE every public-control row).
#[cfg(test)]
mod postgres_persistence_opt_tests {
    use super::*;
    use std::time::Instant;

    fn relay_reg(hash: &str, label: Option<&str>) -> PersistedRelayRegistration {
        PersistedRelayRegistration {
            relay_id: format!("relay-{hash}"),
            broker_room_id: format!("room-{hash}"),
            refresh_token_hash: hash.to_string(),
            created_at: 100,
            relay_label: label.map(|s| s.to_string()),
            relay_verify_key: Some(format!("vk-{hash}")),
        }
    }
    fn client_ident(hash: &str) -> PersistedClientIdentity {
        PersistedClientIdentity {
            client_id: format!("client-{hash}"),
            client_verify_key: format!("cvk-{hash}"),
            refresh_token_hash: hash.to_string(),
            created_at: 300,
            client_label: None,
            superseded: Vec::new(),
        }
    }
    fn device_grant(hash: &str, last_seen: Option<u64>) -> PersistedDeviceGrant {
        PersistedDeviceGrant {
            relay_id: format!("relay-{hash}"),
            broker_room_id: format!("room-{hash}"),
            device_id: format!("dev-{hash}"),
            refresh_token_hash: hash.to_string(),
            created_at: 200,
            last_seen,
            superseded: Vec::new(),
        }
    }
    fn client_relay_grant(client_id: &str, relay_id: &str) -> PersistedClientRelayGrant {
        PersistedClientRelayGrant {
            client_id: client_id.to_string(),
            relay_id: relay_id.to_string(),
            broker_room_id: format!("room-{relay_id}"),
            device_id: format!("dev-{client_id}"),
            granted_at: 400,
            relay_label: None,
            device_label: None,
        }
    }
    fn store_from(
        regs: Vec<PersistedRelayRegistration>,
        clients: Vec<PersistedClientIdentity>,
        grants: Vec<PersistedDeviceGrant>,
        crg: Vec<PersistedClientRelayGrant>,
    ) -> PublicControlStateStore {
        let mut s = PublicControlStateStore::default();
        for r in regs {
            s.relay_registrations_by_hash
                .insert(r.refresh_token_hash.clone(), r);
        }
        for c in clients {
            s.client_registrations_by_hash
                .insert(c.refresh_token_hash.clone(), c);
        }
        for g in grants {
            s.grants_by_hash.insert(g.refresh_token_hash.clone(), g);
        }
        for g in crg {
            s.client_relay_grants_by_key
                .insert(client_relay_grant_key(&g.client_id, &g.relay_id), g);
        }
        s
    }
    async fn truncate_all(pool: &PgPool) {
        for table in [
            "public_client_relay_grants",
            "public_device_grants",
            "public_client_identities",
            "public_relay_registrations",
        ] {
            sqlx::query(&format!("DELETE FROM {table}"))
                .execute(pool)
                .await
                .expect("truncate table");
        }
    }
    async fn connect_and_init(url: &str) -> PgPool {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(url)
            .await
            .expect("connect test postgres");
        initialize_postgres_public_control_schema(&pool)
            .await
            .expect("init schema");
        pool
    }
    fn test_url() -> Option<String> {
        trimmed_option_string(std::env::var("RELAY_BROKER_TEST_POSTGRES_URL").ok())
    }

    /// The diff-save must apply adds, in-place updates, AND deletes so a reload
    /// reproduces the live state exactly — this is the regression guard that the
    /// switch away from wipe-and-rebuild did not silently drop or stale any row.
    #[tokio::test]
    async fn postgres_targeted_save_applies_add_update_delete() {
        let Some(url) = test_url() else {
            eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
            return;
        };
        let pool = connect_and_init(&url).await;
        truncate_all(&pool).await;

        // (1) ADD from empty.
        let empty = PublicControlStateStore::default();
        let v1 = store_from(
            vec![relay_reg("r1", Some("first"))],
            vec![client_ident("c1")],
            vec![device_grant("g1", Some(7))],
            vec![client_relay_grant("client-c1", "relay-r1")],
        );
        save_public_control_postgres(&pool, &empty, &v1)
            .await
            .expect("save v1");
        let loaded1 = load_public_control_postgres(&pool).await.expect("load v1");
        assert_eq!(
            loaded1.relay_registrations_by_hash, v1.relay_registrations_by_hash,
            "add relay registration"
        );
        assert_eq!(
            loaded1.client_registrations_by_hash, v1.client_registrations_by_hash,
            "add client identity"
        );
        assert_eq!(
            loaded1.grants_by_hash, v1.grants_by_hash,
            "add device grant"
        );
        assert_eq!(
            loaded1.client_relay_grants_by_key, v1.client_relay_grants_by_key,
            "add client-relay grant"
        );

        // (2) One save carrying an add/update/delete for EVERY table:
        //   relay:        in-place label update (r1)
        //   client:       in-place label update (c1)
        //   device grant: delete g1 + add g2
        //   client-relay: delete the only grant
        let updated_client = PersistedClientIdentity {
            client_label: Some("renamed-client".to_string()),
            ..client_ident("c1")
        };
        let v2 = store_from(
            vec![relay_reg("r1", Some("renamed"))],
            vec![updated_client],
            vec![device_grant("g2", None)],
            vec![], // client-relay grant removed
        );
        save_public_control_postgres(&pool, &v1, &v2)
            .await
            .expect("save v2");
        let loaded2 = load_public_control_postgres(&pool).await.expect("load v2");
        assert_eq!(
            loaded2.relay_registrations_by_hash, v2.relay_registrations_by_hash,
            "in-place relay label update must persist"
        );
        assert_eq!(
            loaded2.client_registrations_by_hash, v2.client_registrations_by_hash,
            "in-place client label update must persist"
        );
        assert!(
            !loaded2.grants_by_hash.contains_key("g1"),
            "removed device grant must be deleted, not left stale"
        );
        assert_eq!(
            loaded2.grants_by_hash, v2.grants_by_hash,
            "delete g1 + add g2 must both persist"
        );
        assert!(
            loaded2.client_relay_grants_by_key.is_empty(),
            "removed client-relay grant must be deleted"
        );

        truncate_all(&pool).await;
    }

    /// Credential rotation (relay re-enroll, client rotation, device re-registration)
    /// changes the PK `refresh_token_hash` while KEEPING a secondary UNIQUE column
    /// (relay_id / broker_room_id / relay_verify_key / client_id / client_verify_key /
    /// `(relay_id, broker_room_id, device_id)`). The diff-save must delete the old row
    /// BEFORE inserting the new one, or the insert collides with the surviving old row
    /// on that secondary unique index and the whole transaction aborts — wedging the
    /// control plane. This is the regression guard for that ordering.
    #[tokio::test]
    async fn postgres_targeted_save_handles_credential_rotation() {
        let Some(url) = test_url() else {
            eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
            return;
        };
        let pool = connect_and_init(&url).await;
        truncate_all(&pool).await;

        // Seed one row per rotating table.
        let v1 = store_from(
            vec![relay_reg("rot1", Some("v1"))],
            vec![client_ident("rotc1")],
            vec![device_grant("rotg1", Some(1))],
            vec![],
        );
        save_public_control_postgres(&pool, &PublicControlStateStore::default(), &v1)
            .await
            .expect("seed rotation baseline");

        // Rotate the PK (refresh_token_hash) while every secondary UNIQUE column
        // stays identical — exactly what re-enrollment / rotation / re-grant do.
        let mut rotated_relay = relay_reg("rot1", Some("v2"));
        rotated_relay.refresh_token_hash = "rot1-NEW".to_string();
        let mut rotated_client = client_ident("rotc1");
        rotated_client.refresh_token_hash = "rotc1-NEW".to_string();
        let mut rotated_grant = device_grant("rotg1", Some(2));
        rotated_grant.refresh_token_hash = "rotg1-NEW".to_string();
        let v2 = store_from(
            vec![rotated_relay],
            vec![rotated_client],
            vec![rotated_grant],
            vec![],
        );

        save_public_control_postgres(&pool, &v1, &v2)
            .await
            .expect("rotation must not violate secondary unique constraints");

        let loaded = load_public_control_postgres(&pool).await.expect("load");
        assert_eq!(
            loaded.relay_registrations_by_hash.len(),
            1,
            "old relay row must be gone, only the rotated one remains"
        );
        assert!(loaded.relay_registrations_by_hash.contains_key("rot1-NEW"));
        assert!(loaded
            .client_registrations_by_hash
            .contains_key("rotc1-NEW"));
        assert!(loaded.grants_by_hash.contains_key("rotg1-NEW"));
        assert!(!loaded.relay_registrations_by_hash.contains_key("rot1"));

        truncate_all(&pool).await;
    }

    /// Rotation exercised through the real `PublicControlPlane` save path (not just
    /// the low-level diff helper): re-enrolling the same relay verify key rotates the
    /// refresh token but keeps relay_id/room/verify_key, which must persist.
    #[tokio::test]
    async fn postgres_relay_reenrollment_through_save_path_persists() {
        let Some(url) = test_url() else {
            eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
            return;
        };
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let verify_key = format!("reenroll-vk-{unique}");

        let plane = PublicControlPlane::from_parts_with_postgres(
            Some("test-issuer-secret".to_string()),
            None,
            None,
            Some(url.clone()),
            None,
            None,
        )
        .await
        .expect("plane connects");

        let first = plane
            .issue_relay_registration_for_verify_key(&verify_key, Some("first".to_string()))
            .await
            .expect("initial enroll");
        // Second enroll with the SAME verify key = re-enrollment: rotates the refresh
        // token, keeps relay_id/room. With insert-before-delete this aborted on the
        // relay_verify_key / relay_id unique index.
        let second = plane
            .issue_relay_registration_for_verify_key(&verify_key, Some("second".to_string()))
            .await
            .expect("re-enrollment must succeed through the save path");
        assert_eq!(second.relay_id, first.relay_id, "re-enroll keeps relay_id");

        // Fresh instance loads from Postgres → the rotated registration survived.
        let plane_b = PublicControlPlane::from_parts_with_postgres(
            Some("test-issuer-secret".to_string()),
            None,
            None,
            Some(url.clone()),
            None,
            None,
        )
        .await
        .expect("plane B connects");
        let loaded = plane_b
            .inner
            .state
            .lock()
            .await
            .registration_for_verify_key(&verify_key)
            .expect("rotated registration must survive reload");
        assert_eq!(loaded.relay_id, second.relay_id);

        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("aux pool");
        sqlx::query("DELETE FROM public_relay_registrations WHERE relay_id = $1")
            .bind(&second.relay_id)
            .execute(&pool)
            .await
            .expect("cleanup");
    }

    /// Build a store that fails the save via a transaction-local constraint
    /// violation: a second registration reuses relay_id `relay-A`, so its upsert
    /// hits the `relay_id` UNIQUE index and the transaction aborts WITHOUT dropping
    /// the table (so the DB stays inspectable). Contains the original A row too.
    fn store_that_violates_relay_id_unique() -> PublicControlStateStore {
        let mut bad = store_from(vec![relay_reg("A", Some("orig"))], vec![], vec![], vec![]);
        let mut dup = relay_reg("A", Some("orig")); // same relay_id = relay-A
        dup.refresh_token_hash = "DUP".to_string();
        bad.relay_registrations_by_hash
            .insert("DUP".to_string(), dup);
        bad
    }

    /// Pre-commit failure (definite rollback): a save that aborts mid-transaction
    /// must leave BOTH the DB and memory at the original credential A — memory must
    /// never run ahead of the database.
    #[tokio::test]
    async fn postgres_save_failure_reconciles_memory_with_db() {
        let Some(url) = test_url() else {
            eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
            return;
        };
        let pool = connect_and_init(&url).await;
        truncate_all(&pool).await;

        let persistence = PublicControlPersistence::Postgres {
            pool: pool.clone(),
            reload_before_use: false,
            last_saved: std::sync::Arc::new(tokio::sync::Mutex::new(
                PublicControlStateStore::default(),
            )),
            needs_reload: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };

        // Persist the original credential A.
        let mut store = store_from(vec![relay_reg("A", Some("orig"))], vec![], vec![], vec![]);
        persistence.save(&mut store).await.expect("initial save");

        // A save that violates the relay_id UNIQUE index aborts pre-commit.
        let mut bad = store_that_violates_relay_id_unique();
        assert!(
            persistence.save(&mut bad).await.is_err(),
            "duplicate relay_id must fail the save"
        );

        // Memory: only A, the un-persisted DUP is gone.
        assert!(bad.relay_registrations_by_hash.contains_key("A"));
        assert!(
            !bad.relay_registrations_by_hash.contains_key("DUP"),
            "the un-persisted row must not survive in memory"
        );

        // DB: also still exactly A (transaction rolled back cleanly).
        let db_hashes: Vec<String> = sqlx::query_scalar(
            "SELECT refresh_token_hash FROM public_relay_registrations ORDER BY refresh_token_hash",
        )
        .fetch_all(&pool)
        .await
        .expect("read db");
        assert_eq!(db_hashes, vec!["A".to_string()], "DB must remain at A");

        truncate_all(&pool).await;
    }

    /// AMBIGUOUS commit failure: Postgres may durably commit `next` even though the
    /// client sees a save error (connection dropped after COMMIT, before the ack).
    /// We simulate the resulting state — the DB has moved ahead of the last snapshot
    /// — then trigger a failed save, and assert the failure handler reconciles memory
    /// to the ACTUAL DB state instead of blindly restoring the stale snapshot (which
    /// would drop the durably-committed row). Red→green guard for the ambiguous fix:
    /// restoring the snapshot yields {A} and fails the `contains_key("B")` assert.
    #[tokio::test]
    async fn postgres_ambiguous_save_failure_reconciles_to_db_truth() {
        let Some(url) = test_url() else {
            eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
            return;
        };
        let pool = connect_and_init(&url).await;
        truncate_all(&pool).await;

        let persistence = PublicControlPersistence::Postgres {
            pool: pool.clone(),
            reload_before_use: false,
            last_saved: std::sync::Arc::new(tokio::sync::Mutex::new(
                PublicControlStateStore::default(),
            )),
            needs_reload: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };

        // Snapshot = {A}.
        let mut store = store_from(vec![relay_reg("A", Some("orig"))], vec![], vec![], vec![]);
        persistence.save(&mut store).await.expect("initial save");

        // Out of band, the DB gains B — standing in for a committed-but-unacked row.
        // The DB is now {A, B} while the in-memory snapshot is still {A}.
        sqlx::query(
            "INSERT INTO public_relay_registrations \
             (refresh_token_hash, relay_id, broker_room_id, created_at, relay_verify_key) \
             VALUES ('B', 'relay-B', 'room-B', 1, 'vk-B')",
        )
        .execute(&pool)
        .await
        .expect("inject committed row B");

        // A save that fails (duplicate relay_id) leaves the DB at {A, B}.
        let mut bad = store_that_violates_relay_id_unique();
        assert!(
            persistence.save(&mut bad).await.is_err(),
            "duplicate relay_id must fail the save"
        );

        // Memory must reconcile to the ACTUAL DB state {A, B}, NOT the stale snapshot
        // {A}. Restoring the snapshot would drop the durably-committed B.
        assert!(
            bad.relay_registrations_by_hash.contains_key("A"),
            "A present"
        );
        assert!(
            bad.relay_registrations_by_hash.contains_key("B"),
            "failure handling must reload the DB truth (B), not restore the stale snapshot"
        );
        assert!(
            !bad.relay_registrations_by_hash.contains_key("DUP"),
            "the un-persisted DUP must not survive"
        );

        truncate_all(&pool).await;
    }

    /// The decision that turns a failed-but-committed save into `Ok` (so the caller
    /// delivers the credential) vs `Err`. Pure, no DB. This is the guard for "when
    /// the reconciled DB holds the intended rotation B, save() reports success".
    #[test]
    fn classify_save_reconciliation_maps_db_truth_to_outcome() {
        let a = store_from(vec![relay_reg("A", None)], vec![], vec![], vec![]);
        let b = store_from(vec![relay_reg("B", None)], vec![], vec![], vec![]);
        let c = store_from(vec![relay_reg("C", None)], vec![], vec![], vec![]);
        // prev = A, next = B.
        // DB == next(B): the commit landed → Committed → save() returns Ok, B delivered.
        assert_eq!(
            classify_save_reconciliation(&b, &a, &b),
            SaveReconciliation::Committed
        );
        // DB == prev(A): rolled back → RolledBack → save() returns Err, A still valid.
        assert_eq!(
            classify_save_reconciliation(&a, &a, &b),
            SaveReconciliation::RolledBack
        );
        // DB == neither → Indeterminate → save() returns Err, memory follows the DB.
        assert_eq!(
            classify_save_reconciliation(&c, &a, &b),
            SaveReconciliation::Indeterminate
        );
    }

    /// When a save fails AND the reconciling reload also fails (DB unreachable), the
    /// outcome is unknown: save() must surface the error AND arm a forced reload so
    /// the next reachable operation repairs memory (rather than silently trusting a
    /// possibly-stale snapshot with reload-before-use off).
    #[tokio::test]
    async fn postgres_save_and_reload_both_failing_arms_forced_reload() {
        let Some(url) = test_url() else {
            eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
            return;
        };
        let pool = connect_and_init(&url).await;
        truncate_all(&pool).await;

        let persistence = PublicControlPersistence::Postgres {
            pool: pool.clone(),
            reload_before_use: false,
            last_saved: std::sync::Arc::new(tokio::sync::Mutex::new(
                PublicControlStateStore::default(),
            )),
            needs_reload: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };

        let mut store = store_from(vec![relay_reg("A", Some("orig"))], vec![], vec![], vec![]);
        persistence.save(&mut store).await.expect("initial save");

        // Drop every table so BOTH the save and the reconciling reload fail.
        for table in [
            "public_client_relay_grants",
            "public_device_grants",
            "public_client_identities",
            "public_relay_registrations",
        ] {
            sqlx::query(&format!("DROP TABLE {table}"))
                .execute(&pool)
                .await
                .expect("drop table");
        }

        let mut next = store_from(vec![relay_reg("B", Some("new"))], vec![], vec![], vec![]);
        assert!(
            persistence.save(&mut next).await.is_err(),
            "save must fail with all tables dropped"
        );
        // The reload could not determine the outcome → a forced reload must be armed.
        if let PublicControlPersistence::Postgres { needs_reload, .. } = &persistence {
            assert!(
                needs_reload.load(std::sync::atomic::Ordering::SeqCst),
                "an indeterminate save failure must arm a forced reload"
            );
        } else {
            panic!("expected a Postgres persistence");
        }

        // cleanup: recreate the tables on the disposable DB.
        initialize_postgres_public_control_schema(&pool)
            .await
            .expect("recreate tables");
        truncate_all(&pool).await;
    }

    /// Build a Postgres-backed plane with an EMPTY in-memory state — models a serving
    /// broker whose in-memory map does not (yet) know about a client identity that IS
    /// durably persisted in Postgres. Real ways to reach this on a "single instance":
    /// a rotation committed by the other container during a rolling-deploy window, a
    /// second replica, or a committed-but-unacked rotation whose row is in the DB.
    /// `reload_before_use` picks the two production modes.
    fn postgres_plane(pool: PgPool, reload_before_use: bool) -> PublicControlPlane {
        PublicControlPlane {
            inner: Arc::new(PublicControlPlaneInner {
                issuer_key: JoinTicketKey::from_secret(b"client-lockout-repro-issuer")
                    .expect("issuer key"),
                relay_ws_ttl_secs: DEFAULT_PUBLIC_RELAY_WS_TTL_SECS,
                device_ws_ttl_secs: DEFAULT_PUBLIC_DEVICE_WS_TTL_SECS,
                rotation_grace_secs: DEFAULT_PUBLIC_ROTATION_GRACE_SECS,
                persistence: PublicControlPersistence::Postgres {
                    pool,
                    reload_before_use,
                    last_saved: Arc::new(Mutex::new(PublicControlStateStore::default())),
                    needs_reload: Arc::new(AtomicBool::new(false)),
                },
                state: Mutex::new(PublicControlStateStore::default()),
                relay_enrollment_challenges: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Insert a client identity straight into Postgres (bypassing the in-memory
    /// state), returning nothing — the caller keeps the plaintext token the "client"
    /// now holds. Stands in for a rotation whose row is durably in the DB.
    async fn inject_client_identity_into_db(pool: &PgPool, client_id: &str, token: &str) {
        sqlx::query(
            "INSERT INTO public_client_identities \
             (refresh_token_hash, client_id, client_verify_key, created_at, client_label) \
             VALUES ($1, $2, $3, 300, NULL)",
        )
        .bind(sha256_hex(token))
        .bind(client_id)
        .bind(format!("cvk-{client_id}"))
        .execute(pool)
        .await
        .expect("inject client identity row");
    }

    /// RED — reproduces the production client-side lockout. A client holds a refresh
    /// token whose identity is DURABLY in Postgres, but the serving broker's in-memory
    /// state does not have it (rolling-deploy window / concurrent writer /
    /// committed-but-unacked). With the single-instance default
    /// (`reload_before_use = false`) the broker consults ONLY its stale in-memory map,
    /// so a token that IS valid in the database is rejected as
    /// "client refresh token is invalid" — exactly the repeated
    /// `invalid refresh token was reused chain=client_identity` seen right after an
    /// approval. INVARIANT: a durably-persisted client token must authenticate.
    /// This assertion currently FAILS (the bug); it is the regression guard for the fix.
    #[tokio::test]
    async fn client_token_in_db_but_not_in_memory_is_rejected_without_reload() {
        let Some(url) = test_url() else {
            eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
            return;
        };
        let pool = connect_and_init(&url).await;
        truncate_all(&pool).await;

        let token = "cref-lockout-repro-token";
        inject_client_identity_into_db(&pool, "client-lockout", token).await;

        let plane = postgres_plane(pool.clone(), false);
        let result = plane.issue_client_session(token).await;

        truncate_all(&pool).await;

        assert!(
            result.is_ok(),
            "a client refresh token durably persisted in Postgres must authenticate, \
             but the single-instance default (reload_before_use=false) rejected it: {result:?}"
        );
    }

    /// GREEN mitigation — turning `reload_before_use` ON (env
    /// `RELAY_BROKER_PUBLIC_POSTGRES_RELOAD_BEFORE_USE=1`) makes the broker reload the
    /// authoritative DB state before authenticating, so the SAME durably-persisted
    /// token that the default rejects is now accepted. Confirms the env-var stopgap
    /// covers the "DB has it, memory doesn't" class (deploy window / concurrent writer /
    /// committed-but-unacked). It does NOT cover a token that is genuinely gone from the
    /// DB (the rotation-protocol lockout / follow-up A) — that needs a grace period.
    #[tokio::test]
    async fn client_token_in_db_authenticates_with_reload_before_use() {
        let Some(url) = test_url() else {
            eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
            return;
        };
        let pool = connect_and_init(&url).await;
        truncate_all(&pool).await;

        let token = "cref-lockout-repro-token";
        inject_client_identity_into_db(&pool, "client-lockout", token).await;

        let plane = postgres_plane(pool.clone(), true);
        let session = plane.issue_client_session(token).await;

        truncate_all(&pool).await;

        let session =
            session.expect("reload-before-use must consult the DB and accept the persisted token");
        assert_eq!(session.client_id, "client-lockout");
    }

    /// Not a pass/fail test — prints timings so we can compare JSON vs Postgres
    /// (full-rebuild vs targeted) and the reload-before-use cost. `#[ignore]` so
    /// normal runs skip it; run with:
    ///   RELAY_BROKER_TEST_POSTGRES_URL=postgres://sealwire:dev@127.0.0.1:5433/sealwire_test \
    ///     cargo test -p relay-broker bench_persistence_backends -- --ignored --nocapture --test-threads=1
    #[tokio::test]
    #[ignore = "perf benchmark; needs RELAY_BROKER_TEST_POSTGRES_URL; run with --ignored --nocapture"]
    async fn bench_persistence_backends() {
        let Some(url) = test_url() else {
            eprintln!("skipping benchmark: set RELAY_BROKER_TEST_POSTGRES_URL");
            return;
        };
        let pool = connect_and_init(&url).await;

        const N: usize = 200; // baseline rows in each of two tables
        const M: u32 = 20; // timed iterations

        let mut base = PublicControlStateStore::default();
        for i in 0..N {
            let h = format!("seed-{i}");
            base.relay_registrations_by_hash
                .insert(h.clone(), relay_reg(&h, Some("seed")));
            let g = format!("seed-grant-{i}");
            base.grants_by_hash
                .insert(g.clone(), device_grant(&g, Some(1)));
        }

        // SAVE — full rebuild: every save re-writes all rows.
        truncate_all(&pool).await;
        save_public_control_postgres_full_rebuild(&pool, &base)
            .await
            .expect("seed for full-rebuild");
        let t_full = {
            let start = Instant::now();
            for i in 0..M {
                let mut s = base.clone();
                let h = format!("extra-full-{i}");
                s.grants_by_hash.insert(h.clone(), device_grant(&h, None));
                save_public_control_postgres_full_rebuild(&pool, &s)
                    .await
                    .expect("full save");
            }
            start.elapsed() / M
        };

        // SAVE — targeted: every save writes only the one new grant.
        truncate_all(&pool).await;
        save_public_control_postgres_full_rebuild(&pool, &base)
            .await
            .expect("seed for targeted");
        let t_targeted = {
            let mut prev = base.clone();
            let start = Instant::now();
            for i in 0..M {
                let mut next = prev.clone();
                let h = format!("extra-tgt-{i}");
                next.grants_by_hash
                    .insert(h.clone(), device_grant(&h, None));
                save_public_control_postgres(&pool, &prev, &next)
                    .await
                    .expect("targeted save");
                prev = next;
            }
            start.elapsed() / M
        };

        // SAVE — JSON baseline: whole-file write.
        let json_path =
            std::env::temp_dir().join(format!("bench-public-control-{}.json", std::process::id()));
        save_public_control_json(&json_path, &base)
            .await
            .expect("seed json");
        let t_json_save = {
            let start = Instant::now();
            for i in 0..M {
                let mut s = base.clone();
                let h = format!("extra-json-{i}");
                s.grants_by_hash.insert(h.clone(), device_grant(&h, None));
                save_public_control_json(&json_path, &s)
                    .await
                    .expect("json save");
            }
            start.elapsed() / M
        };

        // READ — PG full reload (the per-op cost reload_before_use pays) vs JSON file read.
        truncate_all(&pool).await;
        save_public_control_postgres_full_rebuild(&pool, &base)
            .await
            .expect("seed for read");
        let t_pg_reload = {
            let start = Instant::now();
            for _ in 0..M {
                load_public_control_postgres(&pool)
                    .await
                    .expect("pg reload");
            }
            start.elapsed() / M
        };
        let t_json_read = {
            let start = Instant::now();
            for _ in 0..M {
                load_public_control_json(&json_path)
                    .await
                    .expect("json read");
            }
            start.elapsed() / M
        };

        let _ = tokio::fs::remove_file(&json_path).await;
        truncate_all(&pool).await;

        eprintln!(
            "\n=== persistence benchmark (N={N} rows x2 tables, M={M} iters, LOCAL pg = ~0 network RTT) ==="
        );
        eprintln!("SAVE one mutation @ {N} baseline rows:");
        eprintln!("  PG full-rebuild (old): {t_full:?}/op");
        eprintln!("  PG targeted     (new): {t_targeted:?}/op");
        eprintln!("  JSON file            : {t_json_save:?}/op");
        eprintln!("READ whole state @ {N} baseline rows:");
        eprintln!("  PG full reload (reload_before_use=ON): {t_pg_reload:?}/op");
        eprintln!("  JSON file read                       : {t_json_read:?}/op");
        eprintln!("  in-memory (reload_before_use=OFF)    : ~0 (no I/O at all)");
        eprintln!(
            "NOTE: Railway adds network RTT per round-trip. full-rebuild does O(rows) round-trips \
             and reload does O(1) SELECTs returning all rows; targeted save + reload-off do far \
             fewer, which is the win you feel over the wire.\n"
        );
    }
}
