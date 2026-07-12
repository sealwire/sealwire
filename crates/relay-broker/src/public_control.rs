use std::{
    collections::{BTreeSet, HashMap},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
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
use tracing::warn;

use crate::join_ticket::{unix_now, JoinTicketClaims, JoinTicketKey};

pub const PUBLIC_ISSUER_SECRET_ENV: &str = "RELAY_BROKER_PUBLIC_ISSUER_SECRET";
pub const PUBLIC_RELAY_REGISTRATIONS_ENV: &str = "RELAY_BROKER_PUBLIC_RELAYS_JSON";
pub const PUBLIC_STATE_PATH_ENV: &str = "RELAY_BROKER_PUBLIC_STATE_PATH";
pub const PUBLIC_POSTGRES_URL_ENV: &str = "RELAY_BROKER_PUBLIC_POSTGRES_URL";
pub const PUBLIC_RELAY_WS_TTL_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_RELAY_WS_TTL_SECS";
pub const PUBLIC_DEVICE_WS_TTL_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS";

const DEFAULT_PUBLIC_RELAY_WS_TTL_SECS: u64 = 300;
const DEFAULT_PUBLIC_DEVICE_WS_TTL_SECS: u64 = 300;
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
    persistence: PublicControlPersistence,
    state: Mutex<PublicControlStateStore>,
    relay_enrollment_challenges: Mutex<HashMap<String, PendingRelayEnrollmentChallenge>>,
}

#[derive(Clone)]
enum PublicControlPersistence {
    InMemory,
    Json(PathBuf),
    Postgres(PgPool),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedClientIdentity {
    client_id: String,
    client_verify_key: String,
    refresh_token_hash: String,
    created_at: u64,
    #[serde(default)]
    client_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Default)]
struct PublicControlStateStore {
    relay_registrations_by_hash: HashMap<String, PersistedRelayRegistration>,
    client_registrations_by_hash: HashMap<String, PersistedClientIdentity>,
    grants_by_hash: HashMap<String, PersistedDeviceGrant>,
    client_relay_grants_by_key: HashMap<String, PersistedClientRelayGrant>,
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
            persistence.save(&state).await?;
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
                    if let Err(error) = self.inner.persistence.save(&store).await {
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
                if let Err(error) = self.inner.persistence.save(&store).await {
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
            },
        );
        self.inner.persistence.save(&store).await?;

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
        let (client_id, client_refresh_token) =
            store.issue_or_rotate_client_identity(&client_verify_key, client_label, created_at);
        store.upsert_client_relay_grant(PersistedClientRelayGrant {
            client_id: client_id.clone(),
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            device_id: request.device_id.clone(),
            granted_at: created_at,
            relay_label: registration.relay_label.clone(),
            device_label,
        });
        self.inner.persistence.save(&store).await?;
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
        let grant = self.device_grant_from_refresh_token(bearer_token).await?;
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
        let refreshed_token = store.rotate_client_identity(&client);
        self.inner.persistence.save(&store).await?;
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
            self.inner.persistence.save(&store).await?;
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
        let now = unix_now();
        let token_hash = sha256_hex(bearer_token.trim());
        let grant = {
            let mut store = self.lock_state().await?;
            let grant = store
                .grants_by_hash
                .get(&token_hash)
                .cloned()
                .ok_or_else(|| "device refresh token is invalid".to_string())?;
            // Throttled activity marker: at most one durable write per device per
            // LAST_SEEN_THROTTLE_SECS, via a targeted single-row UPDATE (never the
            // whole-state save, which rewrites every table).
            if should_touch_last_seen(grant.last_seen, now) {
                if let Some(entry) = store.grants_by_hash.get_mut(&token_hash) {
                    entry.last_seen = Some(now);
                }
                // Best-effort advisory marker: a failed write must NOT deny the
                // token refresh. Log and continue (on Postgres the next reload
                // discards the in-memory bump, so it simply retries next time).
                if let Err(error) = self
                    .inner
                    .persistence
                    .touch_device_last_seen(&token_hash, now)
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
            self.inner.persistence.save(&store).await?;
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
            self.inner.persistence.save(&store).await?;
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

    async fn authenticate_relay(
        &self,
        bearer_token: &str,
        relay_id: &str,
        broker_room_id: &str,
    ) -> Result<PersistedRelayRegistration, String> {
        let store = self.lock_state().await?;
        let registration = clone_entry_from_bearer_token(
            &store.relay_registrations_by_hash,
            bearer_token,
            "relay refresh token is invalid",
        )?;
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
        let store = self.lock_state().await?;
        clone_entry_from_bearer_token(
            &store.client_registrations_by_hash,
            bearer_token,
            "client refresh token is invalid",
        )
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

    async fn device_grant_from_refresh_token(
        &self,
        bearer_token: &str,
    ) -> Result<PersistedDeviceGrant, String> {
        let store = self.lock_state().await?;
        clone_entry_from_bearer_token(
            &store.grants_by_hash,
            bearer_token,
            "device refresh token is invalid",
        )
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
        self.inner.persistence.save(&store).await?;
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
            (Some(path), None) => Ok(Self::Json(path)),
            (None, Some(url)) => {
                let pool = PgPoolOptions::new()
                    .max_connections(5)
                    .connect(&url)
                    .await
                    .map_err(|error| {
                        format!("failed to connect to {PUBLIC_POSTGRES_URL_ENV}: {error}")
                    })?;
                initialize_postgres_public_control_schema(&pool).await?;
                Ok(Self::Postgres(pool))
            }
            (None, None) => Ok(Self::InMemory),
        }
    }

    fn has_persistent_state(&self) -> bool {
        !matches!(self, Self::InMemory)
    }

    async fn load(&self) -> Result<PublicControlStateStore, String> {
        match self {
            Self::InMemory => Ok(PublicControlStateStore::default()),
            Self::Json(path) => load_public_control_json(path).await,
            Self::Postgres(pool) => load_public_control_postgres(pool).await,
        }
    }

    async fn save(&self, state: &PublicControlStateStore) -> Result<(), String> {
        match self {
            Self::InMemory => Ok(()),
            Self::Json(path) => save_public_control_json(path, state).await,
            Self::Postgres(pool) => save_public_control_postgres(pool, state).await,
        }
    }

    fn reload_before_use(&self) -> bool {
        matches!(self, Self::Postgres(_))
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
            Self::Postgres(pool) => {
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
    ) -> (String, String) {
        let (client_id, carried_label) =
            if let Some(existing) = self.client_identity_for_verify_key(client_verify_key) {
                let client_id = existing.client_id.clone();
                self.remove_client_identity_by_client_id(&client_id);
                (client_id, existing.client_label.clone())
            } else {
                (issue_client_id(client_verify_key), None)
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
            },
        );
        (client_id, client_refresh_token)
    }

    fn rotate_client_identity(&mut self, client: &PersistedClientIdentity) -> String {
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
    Ok(())
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
        SELECT client_id, client_verify_key, refresh_token_hash, created_at, client_label
        FROM public_client_identities
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("failed to load public_client_identities: {error}"))?;
    let device_rows = sqlx::query(
        r#"
        SELECT relay_id, broker_room_id, device_id, refresh_token_hash, created_at, last_seen
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

async fn save_public_control_postgres(
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

fn clone_entry_from_bearer_token<T: Clone>(
    entries: &HashMap<String, T>,
    bearer_token: &str,
    invalid_message: &str,
) -> Result<T, String> {
    let token_hash = sha256_hex(bearer_token.trim());
    entries
        .get(&token_hash)
        .cloned()
        .ok_or_else(|| invalid_message.to_string())
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
/// SAFETY / ISOLATION: these tests write through the whole-state save path
/// (`save_public_control_postgres` DELETEs and rebuilds every public-control
/// table from the test instance's snapshot). They are therefore destructive to
/// any concurrent writer. `RELAY_BROKER_TEST_POSTGRES_URL` MUST reference a
/// DISPOSABLE database — never a shared or running broker's DB — and the suite
/// MUST run with `--test-threads=1` (also avoids a concurrent `CREATE TABLE IF
/// NOT EXISTS` race on `pg_type_typname_nsp_index`). Example:
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
        // (never the whole-state save, which rebuilds every table and could drop
        // an unrelated writer's rows) before asserting, so failures still clean up.
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
    /// DANGER: this test exercises the whole-state save path (`issue_*` → `save()`
    /// rebuilds every public-control table). Point `RELAY_BROKER_TEST_POSTGRES_URL`
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

        // (2) Age last_seen in the DB, then a ws-token refresh must bump it via the
        // targeted UPDATE (touch_device_last_seen), not the whole-state save.
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
        // THIS test's rows (never the whole-state save, which would rebuild every
        // table from this instance's snapshot and could drop unrelated rows).
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
                .save(&store)
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
