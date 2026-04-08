use std::{
    collections::HashMap,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::{distributions::Alphanumeric, Rng};
use relay_util::trimmed_option_string;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{fs, sync::Mutex};

use crate::join_ticket::{unix_now, JoinTicketClaims, JoinTicketKey};

pub const PUBLIC_ISSUER_SECRET_ENV: &str = "RELAY_BROKER_PUBLIC_ISSUER_SECRET";
pub const PUBLIC_RELAY_REGISTRATIONS_ENV: &str = "RELAY_BROKER_PUBLIC_RELAYS_JSON";
pub const PUBLIC_STATE_PATH_ENV: &str = "RELAY_BROKER_PUBLIC_STATE_PATH";
pub const PUBLIC_RELAY_WS_TTL_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_RELAY_WS_TTL_SECS";
pub const PUBLIC_DEVICE_WS_TTL_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS";

const DEFAULT_PUBLIC_RELAY_WS_TTL_SECS: u64 = 300;
const DEFAULT_PUBLIC_DEVICE_WS_TTL_SECS: u64 = 300;
const DEFAULT_RELAY_ENROLLMENT_CHALLENGE_TTL_SECS: u64 = 300;
const PUBLIC_CONTROL_STATE_VERSION: u32 = 2;

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
    state_path: Option<PathBuf>,
    state: Mutex<PublicControlStateStore>,
    relay_enrollment_challenges: Mutex<HashMap<String, PendingRelayEnrollmentChallenge>>,
}

#[derive(Debug, Clone)]
struct PendingRelayEnrollmentChallenge {
    relay_verify_key: String,
    challenge: String,
    relay_label: Option<String>,
    expires_at: u64,
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
        Self::from_parts(
            std::env::var(PUBLIC_ISSUER_SECRET_ENV).ok(),
            std::env::var(PUBLIC_RELAY_REGISTRATIONS_ENV).ok(),
            std::env::var(PUBLIC_STATE_PATH_ENV).ok(),
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
        let issuer_secret = trimmed_option_string(issuer_secret).ok_or_else(|| {
            format!("{PUBLIC_ISSUER_SECRET_ENV} is required in public broker auth mode")
        })?;
        let issuer_key = JoinTicketKey::from_secret(issuer_secret.as_bytes())?;
        let state_path = trimmed_option_string(state_path).map(PathBuf::from);
        if state_path.is_none() && public_mode_requires_persistent_state() {
            return Err(format!(
                "{PUBLIC_STATE_PATH_ENV} is required when {}=public and BIND_HOST is not loopback",
                crate::auth::BROKER_AUTH_MODE_ENV
            ));
        }
        let mut state = PublicControlStateStore::load(state_path.as_deref()).await?;
        state.seed_relay_registrations(parse_relay_registrations(relay_registrations_json)?);

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
                state_path,
                state: Mutex::new(state),
                relay_enrollment_challenges: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub fn issuer_key(&self) -> &JoinTicketKey {
        &self.inner.issuer_key
    }

    pub fn has_persistent_state(&self) -> bool {
        self.inner.state_path.is_some()
    }

    pub fn health_message(&self) -> Option<String> {
        if self.has_persistent_state() {
            return None;
        }

        Some(format!(
            "public broker device grants are in-memory only; set {PUBLIC_STATE_PATH_ENV} before exposing this broker outside localhost"
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

    pub async fn issue_device_grant(
        &self,
        bearer_token: &str,
        request: DeviceGrantRequest,
    ) -> Result<DeviceGrantResponse, String> {
        let registration = self
            .authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)
            .await?;
        let refresh_token = format!("dref-{}", random_token(40).to_ascii_lowercase());
        let refresh_token_hash = sha256_hex(&refresh_token);
        let created_at = unix_now();

        let mut store = self.inner.state.lock().await;
        store.remove_device_grants(&registration.relay_id, None, Some(&request.device_id));
        store.grants_by_hash.insert(
            refresh_token_hash.clone(),
            PersistedDeviceGrant {
                relay_id: registration.relay_id.clone(),
                broker_room_id: registration.broker_room_id.clone(),
                device_id: request.device_id.clone(),
                refresh_token_hash,
                created_at,
            },
        );
        store.save(self.inner.state_path.as_deref()).await?;

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
        let mut store = self.inner.state.lock().await;
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
        store.save(self.inner.state_path.as_deref()).await?;
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
        let store = self.inner.state.lock().await;
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
        let mut store = self.inner.state.lock().await;
        let refreshed_token = store.rotate_client_identity(&client);
        store.save(self.inner.state_path.as_deref()).await?;
        Ok((client.client_id, refreshed_token))
    }

    pub async fn revoke_client_identity(
        &self,
        bearer_token: &str,
    ) -> Result<ClientIdentityRevokeResponse, String> {
        let client = self.authenticate_client(bearer_token).await?;
        let mut store = self.inner.state.lock().await;
        let revoked_identity_count = store.remove_client_identity_by_client_id(&client.client_id);
        let revoked_grant_count = store.remove_client_relay_grants_by_client_id(&client.client_id);
        if revoked_identity_count > 0 || revoked_grant_count > 0 {
            store.save(self.inner.state_path.as_deref()).await?;
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
        let grant = self.device_grant_from_refresh_token(bearer_token).await?;
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
        let mut store = self.inner.state.lock().await;
        let revoked_grant_count = store.remove_device_grants(
            &registration.relay_id,
            Some(&registration.broker_room_id),
            Some(device_id),
        );
        store.remove_client_relay_grants(
            &registration.relay_id,
            Some(&registration.broker_room_id),
            Some(device_id),
        );
        if revoked_grant_count > 0 {
            store.save(self.inner.state_path.as_deref()).await?;
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
        let mut store = self.inner.state.lock().await;
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
            store.save(self.inner.state_path.as_deref()).await?;
        }
        Ok(DeviceGrantBulkRevokeResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            kept_device_id: request.keep_device_id,
            revoked_count: revoked_device_ids.len(),
            revoked_device_ids,
        })
    }

    async fn authenticate_relay(
        &self,
        bearer_token: &str,
        relay_id: &str,
        broker_room_id: &str,
    ) -> Result<PersistedRelayRegistration, String> {
        let token_hash = sha256_hex(bearer_token.trim());
        let store = self.inner.state.lock().await;
        let registration = store
            .relay_registrations_by_hash
            .get(&token_hash)
            .ok_or_else(|| "relay refresh token is invalid".to_string())?;
        if registration.relay_id != relay_id {
            return Err("relay refresh token does not match relay_id".to_string());
        }
        if registration.broker_room_id != broker_room_id {
            return Err("relay refresh token does not match broker_room_id".to_string());
        }
        Ok(registration.clone())
    }

    async fn authenticate_client(
        &self,
        bearer_token: &str,
    ) -> Result<PersistedClientIdentity, String> {
        let token_hash = sha256_hex(bearer_token.trim());
        let store = self.inner.state.lock().await;
        store
            .client_registrations_by_hash
            .get(&token_hash)
            .cloned()
            .ok_or_else(|| "client refresh token is invalid".to_string())
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
        let token_hash = sha256_hex(bearer_token.trim());
        let store = self.inner.state.lock().await;
        store
            .grants_by_hash
            .get(&token_hash)
            .cloned()
            .ok_or_else(|| "device refresh token is invalid".to_string())
    }

    async fn issue_relay_registration_for_verify_key(
        &self,
        relay_verify_key: &str,
        relay_label: Option<String>,
    ) -> Result<RelayEnrollmentResponse, String> {
        let created_at = unix_now();
        let mut store = self.inner.state.lock().await;
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
        store.save(self.inner.state_path.as_deref()).await?;
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

impl PublicControlStateStore {
    async fn load(path: Option<&Path>) -> Result<Self, String> {
        let Some(path) = path else {
            return Ok(Self::default());
        };
        let bytes = match fs::read(path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
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
        if persisted.schema_version != PUBLIC_CONTROL_STATE_VERSION {
            return Err(format!(
                "unsupported public control-plane state schema {} in {}",
                persisted.schema_version,
                path.display()
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

    async fn save(&self, path: Option<&Path>) -> Result<(), String> {
        let Some(path) = path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        let payload = serde_json::to_vec_pretty(&PersistedPublicControlState {
            schema_version: PUBLIC_CONTROL_STATE_VERSION,
            relay_registrations: self.relay_registrations_by_hash.values().cloned().collect(),
            client_registrations: self
                .client_registrations_by_hash
                .values()
                .cloned()
                .collect(),
            device_grants: self.grants_by_hash.values().cloned().collect(),
            client_relay_grants: self.client_relay_grants_by_key.values().cloned().collect(),
        })
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

    fn remove_device_grants(
        &mut self,
        relay_id: &str,
        broker_room_id: Option<&str>,
        device_id: Option<&str>,
    ) -> usize {
        let mut removed = 0;
        self.grants_by_hash.retain(|_, grant| {
            let matches = grant.relay_id == relay_id
                && broker_room_id
                    .map(|value| value == grant.broker_room_id)
                    .unwrap_or(true)
                && device_id
                    .map(|value| value == grant.device_id)
                    .unwrap_or(true);
            if matches {
                removed += 1;
            }
            !matches
        });
        removed
    }

    fn remove_client_relay_grants(
        &mut self,
        relay_id: &str,
        broker_room_id: Option<&str>,
        device_id: Option<&str>,
    ) -> usize {
        let mut removed = 0;
        self.client_relay_grants_by_key.retain(|_, grant| {
            let matches = grant.relay_id == relay_id
                && broker_room_id
                    .map(|value| value == grant.broker_room_id)
                    .unwrap_or(true)
                && device_id
                    .map(|value| value == grant.device_id)
                    .unwrap_or(true);
            if matches {
                removed += 1;
            }
            !matches
        });
        removed
    }

    fn remove_client_relay_grants_by_client_id(&mut self, client_id: &str) -> usize {
        let mut removed = 0;
        self.client_relay_grants_by_key.retain(|_, grant| {
            let matches = grant.client_id == client_id;
            if matches {
                removed += 1;
            }
            !matches
        });
        removed
    }

    fn remove_all_other_device_grants(
        &mut self,
        relay_id: &str,
        broker_room_id: &str,
        keep_device_id: &str,
    ) -> Vec<String> {
        let mut revoked_device_ids = Vec::new();
        self.grants_by_hash.retain(|_, grant| {
            let revoke = grant.relay_id == relay_id
                && grant.broker_room_id == broker_room_id
                && grant.device_id != keep_device_id;
            if revoke && !revoked_device_ids.iter().any(|id| id == &grant.device_id) {
                revoked_device_ids.push(grant.device_id.clone());
            }
            !revoke
        });
        revoked_device_ids.sort();
        revoked_device_ids
    }

    fn remove_all_other_client_relay_grants(
        &mut self,
        relay_id: &str,
        broker_room_id: &str,
        keep_device_id: &str,
    ) -> Vec<String> {
        let mut revoked_device_ids = Vec::new();
        self.client_relay_grants_by_key.retain(|_, grant| {
            let revoke = grant.relay_id == relay_id
                && grant.broker_room_id == broker_room_id
                && grant.device_id != keep_device_id;
            if revoke && !revoked_device_ids.iter().any(|id| id == &grant.device_id) {
                revoked_device_ids.push(grant.device_id.clone());
            }
            !revoke
        });
        revoked_device_ids.sort();
        revoked_device_ids
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

    fn seed_relay_registrations(&mut self, registrations: Vec<RelayRegistrationConfig>) {
        for registration in registrations {
            let refresh_token_hash = sha256_hex(&registration.refresh_token);
            self.relay_registrations_by_hash
                .entry(refresh_token_hash.clone())
                .or_insert_with(|| PersistedRelayRegistration {
                    relay_id: registration.relay_id,
                    broker_room_id: registration.broker_room_id,
                    refresh_token_hash,
                    created_at: 0,
                    relay_label: None,
                    relay_verify_key: None,
                });
        }
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

fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
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
    let verify_key_bytes: [u8; 32] = STANDARD
        .decode(verify_key_b64)
        .map_err(|_| "relay verify key is invalid".to_string())?
        .try_into()
        .map_err(|_| "relay verify key is invalid".to_string())?;
    VerifyingKey::from_bytes(&verify_key_bytes)
        .map(|_| ())
        .map_err(|_| "relay verify key is invalid".to_string())
}

fn verify_relay_enrollment_challenge_signature(
    verify_key_b64: &str,
    challenge_id: &str,
    challenge: &str,
    signature_b64: &str,
) -> Result<(), String> {
    let verify_key_bytes: [u8; 32] = STANDARD
        .decode(verify_key_b64)
        .map_err(|_| "relay verify key is invalid".to_string())?
        .try_into()
        .map_err(|_| "relay verify key is invalid".to_string())?;
    let signature_bytes: [u8; 64] = STANDARD
        .decode(signature_b64)
        .map_err(|_| "relay enrollment signature is invalid".to_string())?
        .try_into()
        .map_err(|_| "relay enrollment signature is invalid".to_string())?;
    let verify_key = VerifyingKey::from_bytes(&verify_key_bytes)
        .map_err(|_| "relay verify key is invalid".to_string())?;
    let signature = Signature::from_bytes(&signature_bytes);
    verify_key
        .verify(
            relay_enrollment_challenge_message(challenge_id, challenge).as_bytes(),
            &signature,
        )
        .map_err(|_| "relay enrollment signature is invalid".to_string())
}

fn relay_enrollment_challenge_message(challenge_id: &str, challenge: &str) -> String {
    format!("agent-relay:relay-enroll:{challenge_id}:{challenge}")
}
