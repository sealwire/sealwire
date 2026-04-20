mod auth;
mod crypto;
mod remote_actions;
mod session_claim;

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use futures_util::{sink::SinkExt, stream::StreamExt};
use rand::RngCore;
use relay_broker::auth::{BrokerAuthMode, BROKER_AUTH_MODE_ENV};
use relay_broker::join_ticket::unix_now;
use relay_broker::protocol::{ClientMessage, PeerRole, PresenceKind, ServerMessage};
use relay_util::{trimmed_option_string, trimmed_string};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;
use tokio::time::{sleep_until, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};
use url::Url;

use crate::{
    protocol::{
        ApprovalReceipt, PairedDeviceView, SessionSnapshot, ThreadTranscriptResponse,
        ThreadsResponse,
    },
    state::{AppState, BrokerPendingMessage},
};

use self::auth::{
    complete_public_relay_enrollment, request_public_relay_enrollment_challenge, BrokerAuthConfig,
    BrokerJoinCredential, ClientBrokerGrant, DeviceBrokerCredential, PublicRelayRegistration,
    RELAY_BROKER_CONTROL_URL_ENV, RELAY_BROKER_REGISTRATION_PATH_ENV, RELAY_BROKER_RELAY_ID_ENV,
    RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV,
};
use self::crypto::{decrypt_json, encrypt_json, EncryptedEnvelope};
use self::remote_actions::{
    handle_encrypted_remote_action, handle_remote_action, RemoteActionKind, RemoteActionRequest,
};
use self::session_claim::{issue_session_claim, verify_session_claim};

const RECONNECT_DELAY_SECS: u64 = 2;
const PUBLIC_RELAY_AUTH_REQUEST_RETRY_SECS: u64 = 5;
const PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION: u32 = 1;
const PUBLIC_RELAY_IDENTITY_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_PUBLISH_MIN_INTERVAL_MILLIS: u64 = 500;
const DEFAULT_PUBLIC_RELAY_REGISTRATION_FILE: &str = ".agent-relay/public-broker-registration.json";
const DEFAULT_PUBLIC_RELAY_IDENTITY_FILE: &str = ".agent-relay/public-broker-identity.json";
pub(crate) const RELAY_BROKER_IDENTITY_PATH_ENV: &str = "RELAY_BROKER_IDENTITY_PATH";
type BrokerSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone, Debug)]
pub struct BrokerConfig {
    public_base_url: String,
    url: Url,
    broker_room_id: String,
    relay_peer_id: String,
    auth: BrokerAuthConfig,
}

enum BrokerConfigResolution {
    Disabled,
    Ready(BrokerConfig),
    PendingPublicEnrollment(PendingPublicEnrollment),
}

#[derive(Clone, Debug)]
struct PendingPublicEnrollment {
    control_url: Url,
    registration_path: PathBuf,
    identity_path: PathBuf,
}

#[derive(Debug, Clone)]
struct SnapshotPublishGate {
    min_interval: Duration,
    last_published_at: Option<Instant>,
    scheduled: bool,
}

impl SnapshotPublishGate {
    fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_published_at: None,
            scheduled: false,
        }
    }

    fn has_pending_publish(&self) -> bool {
        self.scheduled
    }

    fn mark_published(&mut self, now: Instant) {
        self.last_published_at = Some(now);
        self.scheduled = false;
    }

    fn ready_or_deadline(&mut self, now: Instant) -> Result<(), Instant> {
        match self.last_published_at {
            None => {
                self.mark_published(now);
                Ok(())
            }
            Some(last_published_at)
                if now.duration_since(last_published_at) >= self.min_interval =>
            {
                self.mark_published(now);
                Ok(())
            }
            Some(last_published_at) => {
                self.scheduled = true;
                Err(last_published_at + self.min_interval)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedPublicRelayRegistration {
    schema_version: u32,
    control_url: String,
    relay_id: String,
    broker_room_id: String,
    relay_refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedPublicRelayIdentity {
    schema_version: u32,
    control_url: String,
    relay_signing_seed: String,
}

#[derive(Debug, Clone)]
struct PublicRelayIdentity {
    signing_key: SigningKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PairingRequestPlaintext {
    device_id: Option<String>,
    device_label: Option<String>,
    device_verify_key: String,
    pairing_proof: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum InboundBrokerPayload {
    PairingRequest {
        pairing_id: String,
        envelope: EncryptedEnvelope,
    },
    RemoteAction {
        action_id: String,
        session_claim: Option<String>,
        device_id: Option<String>,
        request: RemoteActionRequest,
    },
    EncryptedRemoteAction {
        action_id: String,
        session_claim: Option<String>,
        device_id: Option<String>,
        envelope: EncryptedEnvelope,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum OutboundBrokerPayload {
    SessionSnapshot {
        snapshot: SessionSnapshot,
    },
    RemoteActionResult {
        action_id: String,
        target_peer_id: String,
        action: RemoteActionKind,
        ok: bool,
        snapshot: SessionSnapshot,
        receipt: Option<ApprovalReceipt>,
        threads: Option<ThreadsResponse>,
        thread_transcript: Option<ThreadTranscriptResponse>,
        session_claim: Option<String>,
        session_claim_expires_at: Option<u64>,
        claim_challenge_id: Option<String>,
        claim_challenge: Option<String>,
        claim_challenge_expires_at: Option<u64>,
        error: Option<String>,
    },
    EncryptedSessionSnapshot {
        target_peer_id: String,
        device_id: String,
        envelope: EncryptedEnvelope,
    },
    EncryptedRemoteActionResult {
        action_id: String,
        target_peer_id: String,
        device_id: String,
        envelope: EncryptedEnvelope,
    },
    EncryptedPairingResult {
        pairing_id: String,
        target_peer_id: String,
        envelope: EncryptedEnvelope,
    },
}

#[derive(Debug, Clone, Serialize)]
struct PairingResultPlaintext {
    ok: bool,
    device: Option<PairedDeviceView>,
    payload_secret: Option<String>,
    relay_id: Option<String>,
    relay_label: Option<String>,
    client_id: Option<String>,
    client_refresh_token: Option<String>,
    device_refresh_token: Option<String>,
    device_join_ticket: Option<String>,
    device_join_ticket_expires_at: Option<u64>,
    error: Option<String>,
}

impl BrokerConfig {
    pub async fn from_env() -> Result<Option<Self>, String> {
        match Self::from_env_resolution().await? {
            BrokerConfigResolution::Disabled => Ok(None),
            BrokerConfigResolution::Ready(config) => Ok(Some(config)),
            BrokerConfigResolution::PendingPublicEnrollment(_) => Err(
                "public broker relay is not enrolled yet; wait for automatic enrollment to finish or inspect the local relay logs"
                    .to_string(),
            ),
        }
    }

    async fn from_env_resolution() -> Result<BrokerConfigResolution, String> {
        Self::from_parts_resolution(
            std::env::var("RELAY_BROKER_URL").ok(),
            std::env::var("RELAY_BROKER_PUBLIC_URL").ok(),
            std::env::var(RELAY_BROKER_CONTROL_URL_ENV).ok(),
            std::env::var("RELAY_BROKER_CHANNEL_ID").ok(),
            std::env::var("RELAY_BROKER_PEER_ID").ok(),
            std::env::var(BROKER_AUTH_MODE_ENV).ok(),
            std::env::var(relay_broker::join_ticket::JOIN_TICKET_SECRET_ENV).ok(),
            std::env::var(RELAY_BROKER_RELAY_ID_ENV).ok(),
            std::env::var(RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV).ok(),
            std::env::var(RELAY_BROKER_IDENTITY_PATH_ENV).ok(),
            std::env::var(RELAY_BROKER_REGISTRATION_PATH_ENV).ok(),
            std::env::var(self::auth::RELAY_BROKER_DEVICE_JOIN_TTL_SECS_ENV).ok(),
        )
        .await
    }

    pub(crate) async fn from_parts(
        url: Option<String>,
        public_url: Option<String>,
        control_url: Option<String>,
        broker_room_id: Option<String>,
        relay_peer_id: Option<String>,
        auth_mode: Option<String>,
        join_ticket_secret: Option<String>,
        relay_id: Option<String>,
        relay_refresh_token: Option<String>,
        relay_identity_path: Option<String>,
        registration_path: Option<String>,
        device_join_ttl_secs: Option<String>,
    ) -> Result<Option<Self>, String> {
        match Self::from_parts_resolution(
            url,
            public_url,
            control_url,
            broker_room_id,
            relay_peer_id,
            auth_mode,
            join_ticket_secret,
            relay_id,
            relay_refresh_token,
            relay_identity_path,
            registration_path,
            device_join_ttl_secs,
        )
        .await?
        {
            BrokerConfigResolution::Disabled => Ok(None),
            BrokerConfigResolution::Ready(config) => Ok(Some(config)),
            BrokerConfigResolution::PendingPublicEnrollment(_) => Err(
                "public broker relay is not enrolled yet; wait for automatic enrollment to finish or inspect the local relay logs"
                    .to_string(),
            ),
        }
    }

    async fn from_parts_resolution(
        url: Option<String>,
        public_url: Option<String>,
        control_url: Option<String>,
        broker_room_id: Option<String>,
        relay_peer_id: Option<String>,
        auth_mode: Option<String>,
        join_ticket_secret: Option<String>,
        relay_id: Option<String>,
        relay_refresh_token: Option<String>,
        relay_identity_path: Option<String>,
        registration_path: Option<String>,
        device_join_ttl_secs: Option<String>,
    ) -> Result<BrokerConfigResolution, String> {
        let Some(url) = url.and_then(trimmed_string) else {
            return Ok(BrokerConfigResolution::Disabled);
        };
        let relay_peer_id =
            trimmed_option_string(relay_peer_id).unwrap_or_else(|| "local-relay".to_string());
        let public_url = public_url
            .and_then(trimmed_string)
            .unwrap_or_else(|| url.clone());
        let auth_mode = BrokerAuthMode::parse(auth_mode)?;

        let mut broker_url = Url::parse(&url)
            .map_err(|error| format!("invalid RELAY_BROKER_URL `{url}`: {error}"))?;
        let scheme = broker_url.scheme().to_ascii_lowercase();
        if scheme != "ws" && scheme != "wss" {
            return Err("RELAY_BROKER_URL must use ws:// or wss://".to_string());
        }

        let mut parsed_public_url = Url::parse(&public_url)
            .map_err(|error| format!("invalid RELAY_BROKER_PUBLIC_URL `{public_url}`: {error}"))?;
        let public_scheme = parsed_public_url.scheme().to_ascii_lowercase();
        if public_scheme != "ws" && public_scheme != "wss" {
            return Err("RELAY_BROKER_PUBLIC_URL must use ws:// or wss://".to_string());
        }

        parsed_public_url.set_path("");
        parsed_public_url.set_query(None);
        let public_base_url = parsed_public_url.as_str().trim_end_matches('/').to_string();

        let control_url = control_url
            .or_else(|| Some(http_control_url(&url)))
            .and_then(trimmed_string);
        let current_dir = std::env::current_dir()
            .map_err(|error| format!("failed to resolve current directory: {error}"))?;
        let registration_path =
            resolve_public_relay_registration_path(&current_dir, registration_path);
        let identity_path = resolve_public_relay_identity_path(&current_dir, relay_identity_path);

        let (broker_room_id, relay_id, relay_refresh_token, pending_public_enrollment) =
            match auth_mode {
                BrokerAuthMode::SelfHostedSharedSecret => (
                    trimmed_option_string(broker_room_id).ok_or_else(|| {
                        "RELAY_BROKER_CHANNEL_ID is required when RELAY_BROKER_URL is set"
                            .to_string()
                    })?,
                    trimmed_option_string(relay_id),
                    trimmed_option_string(relay_refresh_token),
                    None,
                ),
                BrokerAuthMode::PublicControlPlane => {
                    let control_url_string = trimmed_option_string(control_url.clone())
                        .ok_or_else(|| {
                            format!(
                            "{RELAY_BROKER_CONTROL_URL_ENV} is required in public broker auth mode"
                        )
                        })?;
                    let control_url = Url::parse(&control_url_string).map_err(|error| {
                        format!(
                        "invalid {RELAY_BROKER_CONTROL_URL_ENV} `{control_url_string}`: {error}"
                    )
                    })?;
                    let scheme = control_url.scheme().to_ascii_lowercase();
                    if scheme != "http" && scheme != "https" {
                        return Err(format!(
                            "{RELAY_BROKER_CONTROL_URL_ENV} must use http:// or https://"
                        ));
                    }

                    if let (Some(broker_room_id), Some(relay_id), Some(relay_refresh_token)) = (
                        trimmed_option_string(broker_room_id.clone()),
                        trimmed_option_string(relay_id.clone()),
                        trimmed_option_string(relay_refresh_token.clone()),
                    ) {
                        (
                            broker_room_id,
                            Some(relay_id),
                            Some(relay_refresh_token),
                            None,
                        )
                    } else if let Some(cached) =
                        load_public_relay_registration(&registration_path, control_url.as_str())
                            .await?
                    {
                        (
                            cached.broker_room_id,
                            Some(cached.relay_id),
                            Some(cached.relay_refresh_token),
                            None,
                        )
                    } else {
                        (
                            String::new(),
                            None,
                            None,
                            Some(PendingPublicEnrollment {
                                control_url,
                                registration_path: registration_path.clone(),
                                identity_path: identity_path.clone(),
                            }),
                        )
                    }
                }
            };

        if let Some(pending) = pending_public_enrollment {
            return Ok(BrokerConfigResolution::PendingPublicEnrollment(pending));
        }

        let auth = BrokerAuthConfig::from_parts(
            Some(auth_mode.as_str().to_string()),
            join_ticket_secret,
            control_url.clone(),
            relay_id.clone(),
            relay_refresh_token.clone(),
            device_join_ttl_secs,
        )?;

        {
            let mut segments = broker_url.path_segments_mut().map_err(|_| {
                "RELAY_BROKER_URL cannot be a base URL without path support".to_string()
            })?;
            segments.clear();
            segments.push("ws");
            segments.push(&broker_room_id);
        }

        Ok(BrokerConfigResolution::Ready(Self {
            public_base_url,
            url: broker_url,
            broker_room_id,
            relay_peer_id,
            auth,
        }))
    }

    pub fn public_base_url(&self) -> &str {
        &self.public_base_url
    }

    pub(crate) fn auth_mode(&self) -> BrokerAuthMode {
        self.auth.mode()
    }

    pub(crate) fn device_join_ttl_secs(&self) -> Option<u64> {
        self.auth.device_join_ttl_secs()
    }

    pub(crate) fn predicted_device_join_expires_at(&self, now: u64) -> Option<u64> {
        self.auth.predicted_device_join_expires_at(now)
    }

    pub(crate) fn broker_room_id(&self) -> &str {
        &self.broker_room_id
    }

    pub(crate) fn relay_peer_id(&self) -> &str {
        &self.relay_peer_id
    }

    pub(crate) async fn relay_connect_url(&self) -> Result<Url, String> {
        let credential = self
            .auth
            .relay_connect_credential(&self.broker_room_id, &self.relay_peer_id)
            .await?;
        let mut url = self.url.clone();
        url.query_pairs_mut()
            .clear()
            .append_pair("peer_id", &self.relay_peer_id)
            .append_pair("role", "relay")
            .append_pair("join_ticket", &credential.token);
        Ok(url)
    }

    pub(crate) async fn pairing_join_credential(
        &self,
        pairing_id: &str,
        expires_at: u64,
    ) -> Result<BrokerJoinCredential, String> {
        self.auth
            .pairing_join_credential(&self.broker_room_id, pairing_id, expires_at)
            .await
    }

    pub(crate) async fn device_broker_credential(
        &self,
        device_id: &str,
        expires_at: Option<u64>,
    ) -> Result<DeviceBrokerCredential, String> {
        self.auth
            .device_broker_credential(&self.broker_room_id, device_id, expires_at)
            .await
    }

    pub(crate) async fn client_broker_grant(
        &self,
        device_id: &str,
        client_verify_key: &str,
        device_label: Option<String>,
    ) -> Result<Option<ClientBrokerGrant>, String> {
        self.auth
            .client_broker_grant(
                &self.broker_room_id,
                device_id,
                client_verify_key,
                device_label,
            )
            .await
    }

    pub(crate) async fn revoke_device_credential(&self, device_id: &str) -> Result<(), String> {
        self.auth
            .revoke_device_credential(&self.broker_room_id, device_id)
            .await
            .map(|_| ())
    }

    pub(crate) async fn revoke_other_device_credentials(
        &self,
        keep_device_id: &str,
    ) -> Result<(), String> {
        self.auth
            .revoke_other_device_credentials(&self.broker_room_id, keep_device_id)
            .await
            .map(|_| ())
    }
}

pub async fn spawn_broker_task(state: AppState) -> Result<(), String> {
    let resolution = BrokerConfig::from_env_resolution().await?;
    let (config, pending_public_enrollment) = match resolution {
        BrokerConfigResolution::Disabled => return Ok(()),
        BrokerConfigResolution::Ready(config) => (Some(config), None),
        BrokerConfigResolution::PendingPublicEnrollment(pending) => (None, Some(pending)),
    };

    if let Some(pending) = pending_public_enrollment {
        info!(
            broker_auth_mode = BrokerAuthMode::PublicControlPlane.as_str(),
            control_url = %pending.control_url,
            "relay-server is waiting for public broker enrollment"
        );
        let broker_state = state.clone();
        tokio::spawn(async move {
            run_public_broker_enrollment_loop(broker_state, pending).await;
        });
        return Ok(());
    }

    let config = config.expect("ready broker config should be present");

    info!(
        broker_room_id = config.broker_room_id(),
        peer_id = config.relay_peer_id(),
        broker_auth_mode = config.auth_mode().as_str(),
        broker_url = %config.url,
        "relay-server broker publishing is enabled"
    );
    if config.auth_mode() == BrokerAuthMode::SelfHostedSharedSecret
        && config.device_join_ttl_secs().is_none()
    {
        warn!(
            "self-hosted device join tickets are configured as long-lived bearer credentials until revoke"
        );
    }

    let change_rx = state.subscribe();
    let broker_state = state.clone();
    tokio::spawn(async move {
        broker_state
            .set_broker_channel(
                Some(config.broker_room_id().to_string()),
                Some(config.relay_peer_id().to_string()),
            )
            .await;
        broker_state
            .push_runtime_log(
                "info",
                format!(
                    "Broker publishing enabled for room {} as {} using {} auth.",
                    config.broker_room_id(),
                    config.relay_peer_id(),
                    config.auth_mode().as_str()
                ),
            )
            .await;
        if config.auth_mode() == BrokerAuthMode::SelfHostedSharedSecret
            && config.device_join_ttl_secs().is_none()
        {
            broker_state
                .push_runtime_log(
                    "warn",
                    "Device broker join tickets are long-lived bearer credentials until revoke."
                        .to_string(),
                )
                .await;
        }
        run_broker_loop(broker_state, change_rx, config).await;
    });

    Ok(())
}

async fn run_broker_loop(
    state: AppState,
    mut change_rx: watch::Receiver<u64>,
    config: BrokerConfig,
) {
    loop {
        match run_broker_session(&state, &mut change_rx, &config).await {
            Ok(()) => {
                debug!("broker session ended cleanly");
            }
            Err(error) => {
                warn!(
                    broker_room_id = config.broker_room_id(),
                    peer_id = config.relay_peer_id(),
                    %error,
                    "broker session ended"
                );
                state
                    .push_runtime_log("warn", format!("Broker disconnected: {error}"))
                    .await;
            }
        }

        state.set_broker_connection(false).await;
        tokio::time::sleep(Duration::from_secs(RECONNECT_DELAY_SECS)).await;
    }
}

async fn run_public_broker_enrollment_loop(state: AppState, pending: PendingPublicEnrollment) {
    let client = reqwest::Client::new();
    loop {
        match perform_public_relay_enrollment(&client, &pending).await {
            Ok(registration) => match BrokerConfig::from_env().await {
                Ok(Some(config)) => {
                    let change_rx = state.subscribe();
                    state
                        .set_broker_channel(
                            Some(config.broker_room_id().to_string()),
                            Some(config.relay_peer_id().to_string()),
                        )
                        .await;
                    state
                        .push_runtime_log(
                            "info",
                            format!(
                                "Public broker enrollment completed for room {}.",
                                config.broker_room_id()
                            ),
                        )
                        .await;
                    run_broker_loop(state.clone(), change_rx, config).await;
                }
                Ok(None) => return,
                Err(error) => {
                    state
                            .push_runtime_log(
                                "warn",
                                format!(
                                    "Public broker enrollment completed for relay {}, but broker config reload failed: {error}",
                                    registration.relay_id
                                ),
                            )
                            .await;
                }
            },
            Err(error) => {
                state
                    .push_runtime_log(
                        "warn",
                        format!("Automatic public broker enrollment failed: {error}"),
                    )
                    .await;
            }
        }

        tokio::time::sleep(Duration::from_secs(PUBLIC_RELAY_AUTH_REQUEST_RETRY_SECS)).await;
    }
}

async fn perform_public_relay_enrollment(
    client: &reqwest::Client,
    pending: &PendingPublicEnrollment,
) -> Result<PublicRelayRegistration, String> {
    let identity =
        load_or_create_public_relay_identity(&pending.identity_path, pending.control_url.as_str())
            .await?;
    let verify_key_b64 = STANDARD.encode(identity.signing_key.verifying_key().to_bytes());
    let challenge = request_public_relay_enrollment_challenge(
        client,
        &pending.control_url,
        verify_key_b64.clone(),
        None,
    )
    .await?;
    if challenge.expires_at <= unix_now() {
        return Err(
            "public relay enrollment challenge expired before it could be completed".to_string(),
        );
    }
    let challenge_signature = STANDARD.encode(
        identity
            .signing_key
            .sign(
                relay_enrollment_challenge_message(&challenge.challenge_id, &challenge.challenge)
                    .as_bytes(),
            )
            .to_bytes(),
    );
    let registration = complete_public_relay_enrollment(
        client,
        &pending.control_url,
        verify_key_b64,
        challenge.challenge_id,
        challenge_signature,
        None,
    )
    .await?;
    save_public_relay_registration(
        &pending.registration_path,
        pending.control_url.as_str(),
        &registration,
    )
    .await?;
    Ok(registration)
}

async fn run_broker_session(
    state: &AppState,
    change_rx: &mut watch::Receiver<u64>,
    config: &BrokerConfig,
) -> Result<(), String> {
    let connect_url = config.relay_connect_url().await?;
    let (socket, _) = connect_async(connect_url.as_str())
        .await
        .map_err(|error| format!("failed to connect to broker: {error}"))?;
    let (mut sender, mut receiver) = socket.split();

    let welcome = receiver
        .next()
        .await
        .ok_or_else(|| "broker closed before welcome".to_string())?
        .map_err(|error| format!("broker welcome read failed: {error}"))?;
    match decode_server_frame(welcome)? {
        Some(ServerMessage::Welcome { .. }) => {}
        Some(ServerMessage::Error { message, .. }) => return Err(message),
        Some(other) => {
            return Err(format!(
                "expected broker welcome frame, got {}",
                server_message_name(&other)
            ))
        }
        None => return Err("broker did not send a welcome frame".to_string()),
    }

    state.set_broker_connection(true).await;
    state
        .push_runtime_log(
            "info",
            format!("Connected to broker room {}.", config.broker_room_id()),
        )
        .await;
    publish_pending_broker_messages(&mut sender, state)
        .await
        .map_err(|error| format!("initial broker direct publish failed: {error}"))?;
    publish_snapshot(&mut sender, state)
        .await
        .map_err(|error| format!("initial broker publish failed: {error}"))?;
    let mut snapshot_publish_gate =
        SnapshotPublishGate::new(Duration::from_millis(SNAPSHOT_PUBLISH_MIN_INTERVAL_MILLIS));
    snapshot_publish_gate.mark_published(Instant::now());
    let _ = change_rx.borrow_and_update();
    let mut pending_snapshot_timer = Box::pin(sleep_until(
        Instant::now() + Duration::from_secs(24 * 60 * 60),
    ));

    loop {
        tokio::select! {
            changed = change_rx.changed() => {
                changed.map_err(|_| "relay change channel closed".to_string())?;
                publish_pending_broker_messages(&mut sender, state)
                    .await
                    .map_err(|error| format!("broker direct publish failed: {error}"))?;
                match snapshot_publish_gate.ready_or_deadline(Instant::now()) {
                    Ok(()) => {
                        publish_snapshot(&mut sender, state)
                            .await
                            .map_err(|error| format!("broker publish failed: {error}"))?;
                    }
                    Err(deadline) => {
                        pending_snapshot_timer.as_mut().reset(deadline);
                    }
                }
            }
            () = &mut pending_snapshot_timer, if snapshot_publish_gate.has_pending_publish() => {
                snapshot_publish_gate.mark_published(Instant::now());
                publish_snapshot(&mut sender, state)
                    .await
                    .map_err(|error| format!("broker publish failed: {error}"))?;
            }
            incoming = receiver.next() => {
                let Some(frame) = incoming else {
                    return Err("broker socket closed".to_string());
                };
                let frame = frame.map_err(|error| format!("broker receive failed: {error}"))?;
                if let Some(message) = decode_server_frame(frame)? {
                    handle_server_message(state, &mut sender, message).await?;
                }
            }
        }
    }
}

fn decode_server_frame(frame: Message) -> Result<Option<ServerMessage>, String> {
    match frame {
        Message::Text(text) => serde_json::from_str::<ServerMessage>(&text)
            .map(Some)
            .map_err(|error| format!("invalid broker frame: {error}")),
        Message::Ping(_) | Message::Pong(_) => Ok(None),
        Message::Close(_) => Err("broker closed the socket".to_string()),
        Message::Binary(_) => Ok(None),
        _ => Ok(None),
    }
}

async fn handle_server_message(
    state: &AppState,
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    message: ServerMessage,
) -> Result<(), String> {
    match message {
        ServerMessage::Welcome { .. } => Ok(()),
        ServerMessage::Presence {
            channel_id,
            kind,
            peer,
        } => {
            if peer.role == PeerRole::Surface {
                let status = match kind {
                    PresenceKind::Joined => "joined",
                    PresenceKind::Left => "left",
                };
                state
                    .push_runtime_log(
                        "info",
                        format!(
                            "Broker surface {} {status} channel {channel_id}.",
                            peer.peer_id
                        ),
                    )
                    .await;
            }
            Ok(())
        }
        ServerMessage::Message {
            from_peer_id,
            from_role,
            payload,
            ..
        } => {
            if from_role != PeerRole::Surface {
                debug!(
                    from_peer_id,
                    ?from_role,
                    "ignoring broker message from non-surface peer"
                );
                return Ok(());
            }

            match parse_inbound_payload(payload)? {
                Some(InboundBrokerPayload::PairingRequest {
                    pairing_id,
                    envelope,
                }) => {
                    handle_pairing_request(state, sender, from_peer_id, pairing_id, envelope).await
                }
                Some(InboundBrokerPayload::RemoteAction {
                    action_id,
                    session_claim,
                    device_id,
                    request,
                }) => {
                    handle_remote_action(
                        state,
                        sender,
                        from_peer_id,
                        action_id,
                        session_claim,
                        device_id,
                        request,
                    )
                    .await
                }
                Some(InboundBrokerPayload::EncryptedRemoteAction {
                    action_id,
                    session_claim,
                    device_id,
                    envelope,
                }) => {
                    handle_encrypted_remote_action(
                        state,
                        sender,
                        from_peer_id,
                        action_id,
                        session_claim,
                        device_id,
                        envelope,
                    )
                    .await
                }
                None => Ok(()),
            }
        }
        ServerMessage::Error { message, .. } => Err(message),
    }
}

async fn handle_pairing_request(
    state: &AppState,
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    from_peer_id: String,
    pairing_id: String,
    envelope: EncryptedEnvelope,
) -> Result<(), String> {
    state
        .push_runtime_log(
            "info",
            format!(
                "Broker pairing request {} received from {}.",
                pairing_id, from_peer_id
            ),
        )
        .await;
    let pairing_secret = match state.pending_pairing_secret(&pairing_id).await {
        Ok(secret) => secret,
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker pairing {} from {} could not be resumed: {error}",
                        pairing_id, from_peer_id
                    ),
                )
                .await;
            return Ok(());
        }
    };
    let pairing_request: PairingRequestPlaintext = decrypt_json(&pairing_secret, &envelope)?;
    if let Err(error) = verify_pairing_request_proof(
        &pairing_id,
        pairing_request.device_id.as_deref(),
        &pairing_request.device_verify_key,
        &pairing_request.pairing_proof,
    ) {
        state
            .push_runtime_log(
                "warn",
                format!(
                    "Broker pairing {} from {} failed proof verification: {error}",
                    pairing_id, from_peer_id
                ),
            )
            .await;
        return Ok(());
    }
    let replay_result = match state
        .completed_pairing_result(
            &pairing_id,
            &pairing_request.device_verify_key,
            &from_peer_id,
        )
        .await
    {
        Ok(result) => result,
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker pairing {} from {} could not replay an existing result: {error}",
                        pairing_id, from_peer_id
                    ),
                )
                .await;
            return Ok(());
        }
    };
    if let Some(result) = replay_result {
        publish_pairing_result(sender, result).await?;
        state
            .push_runtime_log(
                "info",
                format!(
                    "Replayed completed pairing result {} to broker peer {}.",
                    pairing_id, from_peer_id
                ),
            )
            .await;
        return Ok(());
    }
    let result = state
        .complete_pairing(
            &pairing_id,
            pairing_request.device_id,
            pairing_request.device_label,
            pairing_request.device_verify_key,
            &from_peer_id,
        )
        .await;
    match result {
        Ok(request) => {
            state
                .push_runtime_log(
                    "info",
                    format!(
                        "Broker pairing {} from {} is waiting for local approval as {}.",
                        pairing_id, from_peer_id, request.device_id
                    ),
                )
                .await;
            Ok(())
        }
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker pairing {} from {} failed: {error}",
                        pairing_id, from_peer_id
                    ),
                )
                .await;
            Ok(())
        }
    }
}

fn parse_inbound_payload(payload: Value) -> Result<Option<InboundBrokerPayload>, String> {
    let kind = payload.get("kind").and_then(Value::as_str);
    if !matches!(
        kind,
        Some("remote_action" | "pairing_request" | "encrypted_remote_action")
    ) {
        return Ok(None);
    }
    serde_json::from_value(payload)
        .map(Some)
        .map_err(|error| format!("invalid broker payload: {error}"))
}

fn summarize_thread_transcript_response(page: &ThreadTranscriptResponse) -> String {
    let part_count = page
        .entries
        .iter()
        .map(|entry| entry.parts.len())
        .sum::<usize>();
    format!(
        "thread_id={} entries={} parts={} next_cursor={} prev_cursor={}",
        page.thread_id,
        page.entries.len(),
        part_count,
        page.next_cursor
            .map(|cursor| cursor.to_string())
            .unwrap_or_else(|| "-".to_string()),
        page.prev_cursor
            .map(|cursor| cursor.to_string())
            .unwrap_or_else(|| "-".to_string()),
    )
}

fn summarize_outbound_payload(payload: &OutboundBrokerPayload) -> String {
    match payload {
        OutboundBrokerPayload::SessionSnapshot { snapshot } => format!(
            "kind=session_snapshot active_thread_id={} transcript_entries={} logs={} status={}",
            snapshot.active_thread_id.as_deref().unwrap_or("-"),
            snapshot.transcript.len(),
            snapshot.logs.len(),
            snapshot.current_status,
        ),
        OutboundBrokerPayload::RemoteActionResult {
            action_id,
            target_peer_id,
            action,
            ok,
            threads,
            thread_transcript,
            error,
            ..
        } => format!(
            "kind=remote_action_result action={} action_id={} target_peer_id={} ok={} threads={} {} error={}",
            action.as_str(),
            action_id,
            target_peer_id,
            ok,
            threads.as_ref().map(|response| response.threads.len()).unwrap_or(0),
            thread_transcript
                .as_ref()
                .map(summarize_thread_transcript_response)
                .unwrap_or_else(|| "thread_transcript=-".to_string()),
            error.as_deref().unwrap_or("-"),
        ),
        OutboundBrokerPayload::EncryptedSessionSnapshot {
            target_peer_id,
            device_id,
            ..
        } => format!(
            "kind=encrypted_session_snapshot target_peer_id={} device_id={}",
            target_peer_id, device_id
        ),
        OutboundBrokerPayload::EncryptedRemoteActionResult {
            action_id,
            target_peer_id,
            device_id,
            ..
        } => format!(
            "kind=encrypted_remote_action_result action_id={} target_peer_id={} device_id={}",
            action_id, target_peer_id, device_id
        ),
        OutboundBrokerPayload::EncryptedPairingResult {
            pairing_id,
            target_peer_id,
            ..
        } => format!(
            "kind=encrypted_pairing_result pairing_id={} target_peer_id={}",
            pairing_id, target_peer_id
        ),
    }
}

fn server_message_name(message: &ServerMessage) -> &'static str {
    match message {
        ServerMessage::Welcome { .. } => "welcome",
        ServerMessage::Presence { .. } => "presence",
        ServerMessage::Message { .. } => "message",
        ServerMessage::Error { .. } => "error",
    }
}

async fn publish_snapshot(
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    state: &AppState,
) -> Result<(), String> {
    let snapshot = state.snapshot().await;
    let compacted = snapshot
        .clone()
        .compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface);
    info!(
        active_thread_id = snapshot.active_thread_id.as_deref().unwrap_or("-"),
        active_turn_id = snapshot.active_turn_id.as_deref().unwrap_or("-"),
        raw_transcript_entries = snapshot.transcript.len(),
        raw_transcript_truncated = snapshot.transcript_truncated,
        compacted_transcript_entries = compacted.transcript.len(),
        compacted_transcript_truncated = compacted.transcript_truncated,
        raw_logs = snapshot.logs.len(),
        compacted_logs = compacted.logs.len(),
        "publishing broker session snapshot"
    );
    if state.broker_can_read_content().await {
        publish_payload(
            sender,
            OutboundBrokerPayload::SessionSnapshot {
                snapshot: compacted,
            },
        )
        .await
        .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let targets = state.broker_targets().await;
    for target in targets {
        let envelope = encrypt_json(&target.payload_secret, &compacted)?;
        publish_payload(
            sender,
            OutboundBrokerPayload::EncryptedSessionSnapshot {
                target_peer_id: target.peer_id,
                device_id: target.device_id,
                envelope,
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    }

    Ok(())
}

async fn publish_pending_broker_messages(
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    state: &AppState,
) -> Result<(), String> {
    for message in state.drain_pending_broker_messages().await {
        match message {
            BrokerPendingMessage::PairingResult(result) => {
                publish_pairing_result(sender, result).await?;
            }
        }
    }
    Ok(())
}

async fn publish_pairing_result(
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    result: crate::state::PendingPairingResult,
) -> Result<(), String> {
    let encrypted = encrypt_json(
        &result.pairing_secret,
        &PairingResultPlaintext {
            ok: result.error.is_none(),
            device: result.device,
            payload_secret: result.payload_secret,
            relay_id: result.relay_id,
            relay_label: result.relay_label,
            client_id: result.client_id,
            client_refresh_token: result.client_refresh_token,
            device_refresh_token: result.device_refresh_token,
            device_join_ticket: result.device_join_ticket,
            device_join_ticket_expires_at: result.device_join_ticket_expires_at,
            error: result.error,
        },
    )?;
    publish_payload(
        sender,
        OutboundBrokerPayload::EncryptedPairingResult {
            pairing_id: result.pairing_id,
            target_peer_id: result.target_peer_id,
            envelope: encrypted,
        },
    )
    .await
    .map_err(|error| error.to_string())
}

async fn publish_payload(
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    payload: OutboundBrokerPayload,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let summary = summarize_outbound_payload(&payload);
    let frame = ClientMessage::Publish {
        payload: serde_json::to_value(payload).expect("broker payload should serialize"),
    };
    let frame_text = serde_json::to_string(&frame).expect("broker client frame should serialize");
    info!(
        broker_payload = %summary,
        frame_bytes = frame_text.len(),
        "publishing broker payload"
    );
    sender.send(Message::Text(frame_text)).await
}

fn resolve_public_relay_registration_path(cwd: &Path, configured: Option<String>) -> PathBuf {
    configured
        .and_then(trimmed_string)
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.join(DEFAULT_PUBLIC_RELAY_REGISTRATION_FILE))
}

fn resolve_public_relay_identity_path(cwd: &Path, configured: Option<String>) -> PathBuf {
    configured
        .and_then(trimmed_string)
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.join(DEFAULT_PUBLIC_RELAY_IDENTITY_FILE))
}

async fn load_public_relay_registration(
    path: &Path,
    expected_control_url: &str,
) -> Result<Option<PublicRelayRegistration>, String> {
    let contents = match tokio::fs::read(path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to read broker registration cache {}: {error}",
                path.display()
            ))
        }
    };

    let persisted: PersistedPublicRelayRegistration =
        serde_json::from_slice(&contents).map_err(|error| {
            format!(
                "failed to decode broker registration cache {}: {error}",
                path.display()
            )
        })?;
    if persisted.schema_version != PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION {
        return Err(format!(
            "unsupported broker registration cache schema {} in {}",
            persisted.schema_version,
            path.display()
        ));
    }
    if persisted.control_url != expected_control_url {
        return Ok(None);
    }

    Ok(Some(PublicRelayRegistration {
        relay_id: persisted.relay_id,
        broker_room_id: persisted.broker_room_id,
        relay_refresh_token: persisted.relay_refresh_token,
    }))
}

async fn save_public_relay_registration(
    path: &Path,
    control_url: &str,
    registration: &PublicRelayRegistration,
) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("broker registration cache path must have a parent directory".to_string());
    };
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let payload = serde_json::to_vec_pretty(&PersistedPublicRelayRegistration {
        schema_version: PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION,
        control_url: control_url.to_string(),
        relay_id: registration.relay_id.clone(),
        broker_room_id: registration.broker_room_id.clone(),
        relay_refresh_token: registration.relay_refresh_token.clone(),
    })
    .map_err(|error| format!("failed to encode broker registration cache: {error}"))?;
    let temporary_path = path.with_extension("tmp");
    tokio::fs::write(&temporary_path, payload)
        .await
        .map_err(|error| format!("failed to write {}: {error}", temporary_path.display()))?;
    tokio::fs::rename(&temporary_path, path)
        .await
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    Ok(())
}

async fn load_or_create_public_relay_identity(
    path: &Path,
    control_url: &str,
) -> Result<PublicRelayIdentity, String> {
    let contents = match tokio::fs::read(path).await {
        Ok(contents) => Some(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "failed to read broker relay identity {}: {error}",
                path.display()
            ))
        }
    };

    if let Some(contents) = contents {
        let persisted: PersistedPublicRelayIdentity =
            serde_json::from_slice(&contents).map_err(|error| {
                format!(
                    "failed to decode broker relay identity {}: {error}",
                    path.display()
                )
            })?;
        if persisted.schema_version != PUBLIC_RELAY_IDENTITY_SCHEMA_VERSION {
            return Err(format!(
                "unsupported broker relay identity schema {} in {}",
                persisted.schema_version,
                path.display()
            ));
        }
        if persisted.control_url != control_url {
            return Err(format!(
                "broker relay identity {} was created for {}, expected {}",
                path.display(),
                persisted.control_url,
                control_url
            ));
        }
        let signing_seed: [u8; 32] = STANDARD
            .decode(&persisted.relay_signing_seed)
            .map_err(|_| {
                format!(
                    "broker relay identity {} contains an invalid signing seed",
                    path.display()
                )
            })?
            .try_into()
            .map_err(|_| {
                format!(
                    "broker relay identity {} contains an invalid signing seed",
                    path.display()
                )
            })?;
        return Ok(PublicRelayIdentity {
            signing_key: SigningKey::from_bytes(&signing_seed),
        });
    }

    let mut signing_seed = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut signing_seed);
    let identity = PublicRelayIdentity {
        signing_key: SigningKey::from_bytes(&signing_seed),
    };
    save_public_relay_identity(path, control_url, &identity).await?;
    Ok(identity)
}

async fn save_public_relay_identity(
    path: &Path,
    control_url: &str,
    identity: &PublicRelayIdentity,
) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("broker relay identity path must have a parent directory".to_string());
    };
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let payload = serde_json::to_vec_pretty(&PersistedPublicRelayIdentity {
        schema_version: PUBLIC_RELAY_IDENTITY_SCHEMA_VERSION,
        control_url: control_url.to_string(),
        relay_signing_seed: STANDARD.encode(identity.signing_key.to_bytes()),
    })
    .map_err(|error| format!("failed to encode broker relay identity: {error}"))?;
    let temporary_path = path.with_extension("tmp");
    tokio::fs::write(&temporary_path, payload)
        .await
        .map_err(|error| format!("failed to write {}: {error}", temporary_path.display()))?;
    tokio::fs::rename(&temporary_path, path)
        .await
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    Ok(())
}

fn http_control_url(broker_ws_url: &str) -> String {
    let mut url = Url::parse(broker_ws_url).expect("broker url should already parse");
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        other => other,
    }
    .to_string();
    let _ = url.set_scheme(&scheme);
    url.set_path("");
    url.set_query(None);
    url.as_str().trim_end_matches('/').to_string()
}

fn verify_pairing_request_proof(
    pairing_id: &str,
    device_id: Option<&str>,
    verify_key_b64: &str,
    signature_b64: &str,
) -> Result<(), String> {
    let verify_key_bytes: [u8; 32] = STANDARD
        .decode(verify_key_b64)
        .map_err(|_| "pairing verify key is invalid".to_string())?
        .try_into()
        .map_err(|_| "pairing verify key is invalid".to_string())?;
    let signature_bytes: [u8; 64] = STANDARD
        .decode(signature_b64)
        .map_err(|_| "pairing proof is invalid".to_string())?
        .try_into()
        .map_err(|_| "pairing proof is invalid".to_string())?;
    let verify_key = VerifyingKey::from_bytes(&verify_key_bytes)
        .map_err(|_| "pairing verify key is invalid".to_string())?;
    let signature = Signature::from_bytes(&signature_bytes);
    verify_key
        .verify(
            pairing_proof_message(pairing_id, device_id).as_bytes(),
            &signature,
        )
        .map_err(|_| "pairing proof is invalid".to_string())
}

pub(super) fn verify_device_claim_challenge_proof(
    challenge_id: &str,
    challenge: &str,
    device_id: &str,
    peer_id: &str,
    verify_key_b64: &str,
    signature_b64: &str,
) -> Result<(), String> {
    let verify_key_bytes: [u8; 32] = STANDARD
        .decode(verify_key_b64)
        .map_err(|_| "device verify key is invalid".to_string())?
        .try_into()
        .map_err(|_| "device verify key is invalid".to_string())?;
    let signature_bytes: [u8; 64] = STANDARD
        .decode(signature_b64)
        .map_err(|_| "device claim proof is invalid".to_string())?
        .try_into()
        .map_err(|_| "device claim proof is invalid".to_string())?;
    let verify_key = VerifyingKey::from_bytes(&verify_key_bytes)
        .map_err(|_| "device verify key is invalid".to_string())?;
    let signature = Signature::from_bytes(&signature_bytes);
    verify_key
        .verify(
            device_claim_proof_message(challenge_id, challenge, device_id, peer_id).as_bytes(),
            &signature,
        )
        .map_err(|_| "device claim proof is invalid".to_string())
}

pub(super) fn verify_device_claim_init_proof(
    action_id: &str,
    device_id: &str,
    peer_id: &str,
    verify_key_b64: &str,
    signature_b64: &str,
) -> Result<(), String> {
    let verify_key_bytes: [u8; 32] = STANDARD
        .decode(verify_key_b64)
        .map_err(|_| "device verify key is invalid".to_string())?
        .try_into()
        .map_err(|_| "device verify key is invalid".to_string())?;
    let signature_bytes: [u8; 64] = STANDARD
        .decode(signature_b64)
        .map_err(|_| "device claim proof is invalid".to_string())?
        .try_into()
        .map_err(|_| "device claim proof is invalid".to_string())?;
    let verify_key = VerifyingKey::from_bytes(&verify_key_bytes)
        .map_err(|_| "device verify key is invalid".to_string())?;
    let signature = Signature::from_bytes(&signature_bytes);
    verify_key
        .verify(
            device_claim_init_proof_message(action_id, device_id, peer_id).as_bytes(),
            &signature,
        )
        .map_err(|_| "device claim proof is invalid".to_string())
}

fn pairing_proof_message(pairing_id: &str, device_id: Option<&str>) -> String {
    format!(
        "agent-relay:pairing:{}:{}",
        pairing_id,
        device_id.unwrap_or_default()
    )
}

fn device_claim_proof_message(
    challenge_id: &str,
    challenge: &str,
    device_id: &str,
    peer_id: &str,
) -> String {
    format!("agent-relay:claim-challenge:{challenge_id}:{challenge}:{device_id}:{peer_id}")
}

fn device_claim_init_proof_message(action_id: &str, device_id: &str, peer_id: &str) -> String {
    format!("agent-relay:claim-init:{action_id}:{device_id}:{peer_id}")
}

fn relay_enrollment_challenge_message(challenge_id: &str, challenge: &str) -> String {
    format!("agent-relay:relay-enroll:{challenge_id}:{challenge}")
}

#[cfg(test)]
mod tests;
