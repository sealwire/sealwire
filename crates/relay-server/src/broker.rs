mod auth;
mod credentials;
mod crypto;
mod protocol;
mod remote_actions;
mod session_claim;
mod writer;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use futures_util::stream::StreamExt;
use rand::{Rng, RngCore};
use relay_broker::auth::{BrokerAuthMode, BROKER_AUTH_MODE_ENV};
use relay_broker::join_ticket::unix_now;
use relay_broker::protocol::{PeerRole, PresenceKind, ServerMessage};
use relay_util::{trimmed_option_string, trimmed_string};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio::time::{sleep_until, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};
use url::Url;

use crate::state::{
    AppState, BrokerPendingMessage, BrokerTarget, PendingTranscriptDelta, TranscriptDeltaKind,
};

use self::auth::{
    complete_public_relay_enrollment, request_public_relay_enrollment_challenge, BrokerAuthConfig,
    BrokerJoinCredential, ClientBrokerGrant, DeviceBrokerCredential, PublicRelayRegistration,
    RELAY_BROKER_CONTROL_URL_ENV, RELAY_BROKER_REGISTRATION_PATH_ENV, RELAY_BROKER_RELAY_ID_ENV,
    RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV,
};
use self::crypto::{decrypt_json, encrypt_json, EncryptedEnvelope};
#[cfg(test)]
use self::protocol::summarize_thread_transcript_response;
use self::protocol::{
    frame_bytes_for_payload, frame_text_for_payload, parse_inbound_payload,
    summarize_outbound_payload, validate_broker_protocol_version, InboundBrokerPayload,
    OutboundBrokerPayload, PairingRequestPlaintext, PairingResultPlaintext, TargetedBrokerMessage,
};
#[cfg(test)]
use self::remote_actions::RemoteActionRequest;
use self::remote_actions::{handle_encrypted_remote_action, handle_remote_action};
use self::session_claim::{issue_session_claim, verify_session_claim};
use self::writer::{spawn_broker_writer, BrokerWriter};
#[cfg(test)]
use relay_broker::protocol::BROKER_PROTOCOL_VERSION;

const BROKER_RECONNECT_BASE_DELAY_SECS: u64 = 2;
const BROKER_RECONNECT_MAX_DELAY_SECS: u64 = 60;
const BROKER_RECONNECT_STABLE_SESSION_SECS: u64 = 60;
const BROKER_PING_INTERVAL_SECS: u64 = 20;
const BROKER_PONG_TIMEOUT_SECS: u64 = 10;
const PUBLIC_RELAY_AUTH_REQUEST_RETRY_SECS: u64 = 5;
const PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION: u32 = 1;
const PUBLIC_RELAY_IDENTITY_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_PUBLISH_MIN_INTERVAL_MILLIS: u64 = 500;
const TRANSCRIPT_DELTA_PUBLISH_WINDOW_MILLIS: u64 = 100;
const BROKER_MESSAGE_HANDLER_SLOW_WARN_MILLIS: u128 = 1_000;
pub(crate) const RELAY_BROKER_IDENTITY_PATH_ENV: &str = "RELAY_BROKER_IDENTITY_PATH";
const MAX_BROKER_TEXT_FRAME_BYTES: usize = 65_536;
/// Bumped to 2 when chunked action results stopped base64'ing their payload: the field
/// `data_base64` became `data` and now carries JSON text rather than base64 of bytes. A
/// client that still expects `data_base64` rejects a v2 payload and tells the user to
/// refresh — which is the whole fix, since the surface bundle is served by the broker —
/// instead of silently failing to reassemble and sitting out the action deadline.
const RELAY_PROTOCOL_VERSION: u64 = 2;

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

/// License code the user sets to activate this relay against the public broker.
/// Only required when the broker has `RELAY_BROKER_REQUIRE_LICENSE_CODE=1`.
const RELAY_LICENSE_CODE_ENV: &str = "RELAY_LICENSE_CODE";

#[derive(Clone, Debug)]
struct PendingPublicEnrollment {
    control_url: Url,
    registration_path: PathBuf,
    identity_path: PathBuf,
    /// License code to present at enrollment; `None` if not configured.
    license_code: Option<String>,
}

#[derive(Debug, Clone)]
struct SnapshotPublishGate {
    min_interval: Duration,
    last_published_at: Option<Instant>,
    cooldown_until: Option<Instant>,
    scheduled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SnapshotPublishDecision {
    PublishSnapshot,
    FlushTranscriptDeltasThenPublishSnapshot,
    DelayUntil(Instant),
}

impl SnapshotPublishGate {
    fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_published_at: None,
            cooldown_until: None,
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

    fn defer_until(&mut self, deadline: Instant) {
        self.cooldown_until = Some(match self.cooldown_until {
            Some(current) if current > deadline => current,
            _ => deadline,
        });
        self.scheduled = true;
    }

    fn ready_or_deadline(&mut self, now: Instant) -> Result<(), Instant> {
        if let Some(cooldown_until) = self.cooldown_until {
            if now < cooldown_until {
                self.scheduled = true;
                return Err(cooldown_until);
            }
            self.cooldown_until = None;
        }
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

fn snapshot_publish_decision(
    gate: &mut SnapshotPublishGate,
    now: Instant,
    has_pending_transcript_deltas: bool,
) -> SnapshotPublishDecision {
    match gate.ready_or_deadline(now) {
        Ok(()) if has_pending_transcript_deltas => {
            SnapshotPublishDecision::FlushTranscriptDeltasThenPublishSnapshot
        }
        Ok(()) => SnapshotPublishDecision::PublishSnapshot,
        Err(deadline) => SnapshotPublishDecision::DelayUntil(deadline),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RetryDelay {
    delay: Duration,
    cap: Duration,
    consecutive_failures: u32,
}

#[derive(Debug, Clone)]
struct RetryBackoff {
    base_delay: Duration,
    max_delay: Duration,
    consecutive_failures: u32,
}

impl RetryBackoff {
    fn new(base_delay: Duration, max_delay: Duration) -> Self {
        assert!(
            !base_delay.is_zero() && max_delay >= base_delay,
            "retry backoff requires a non-zero base delay no larger than its maximum"
        );
        Self {
            base_delay,
            max_delay,
            consecutive_failures: 0,
        }
    }

    fn reset(&mut self) {
        self.consecutive_failures = 0;
    }

    fn reset_after_stable_session(&mut self, session_duration: Duration) {
        if session_duration >= Duration::from_secs(BROKER_RECONNECT_STABLE_SESSION_SECS) {
            self.reset();
        }
    }

    fn next_delay<R>(&mut self, rng: &mut R) -> RetryDelay
    where
        R: Rng + ?Sized,
    {
        let exponent = self.consecutive_failures.min(31);
        let cap = self
            .base_delay
            .saturating_mul(1_u32 << exponent)
            .min(self.max_delay);
        let cap_millis = cap.as_millis().min(u64::MAX as u128) as u64;
        let floor_millis = (cap_millis / 2).max(1);
        let delay = Duration::from_millis(rng.gen_range(floor_millis..=cap_millis));
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        RetryDelay {
            delay,
            cap,
            consecutive_failures: self.consecutive_failures,
        }
    }
}

#[derive(Debug, Clone)]
struct BrokerSessionError {
    message: String,
    connected_duration: Option<Duration>,
}

impl BrokerSessionError {
    fn before_connected(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            connected_duration: None,
        }
    }

    fn after_connected(message: impl Into<String>, connected_at: Instant) -> Self {
        Self {
            message: message.into(),
            connected_duration: Some(connected_at.elapsed()),
        }
    }

    fn message(&self) -> &str {
        &self.message
    }

    fn connected_duration(&self) -> Option<Duration> {
        self.connected_duration
    }
}

#[derive(Debug, Clone, Copy)]
struct BrokerLivenessConfig {
    ping_interval: Duration,
    pong_timeout: Duration,
}

impl Default for BrokerLivenessConfig {
    fn default() -> Self {
        Self {
            ping_interval: Duration::from_secs(BROKER_PING_INTERVAL_SECS),
            pong_timeout: Duration::from_secs(BROKER_PONG_TIMEOUT_SECS),
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
            std::env::var(RELAY_LICENSE_CODE_ENV).ok(),
        )
        .await
    }

    // Test-only constructor (exercised from `broker/tests.rs`); not yet wired to a
    // production caller.
    #[allow(dead_code)]
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
            None, // license_code — not used by the test wrapper
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
        license_code: Option<String>,
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
                        // F4: warn if a license code is set but the cached registration
                        // is used instead — the code was only needed at initial enrollment.
                        // If the relay's license has expired/been revoked, delete the cache
                        // file to force re-enrollment with a new code.
                        if trimmed_option_string(license_code.clone()).is_some() {
                            warn!(
                                registration_path = %registration_path.display(),
                                "RELAY_LICENSE_CODE is set but a cached registration already \
                                 exists — the code is ignored. To re-enroll with a new code, \
                                 delete the registration file and restart."
                            );
                        }
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
                                license_code: trimmed_option_string(license_code),
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
}

pub async fn spawn_broker_task(state: AppState) -> Result<(), String> {
    let resolution = BrokerConfig::from_env_resolution().await?;
    launch_broker(state, resolution).await;
    Ok(())
}

/// Spawn the broker task for an already-resolved config. `Disabled` spawns nothing.
/// Broker on/off is done by restarting the relay (the desktop restarts the sidecar
/// with the new broker config), so there is no runtime cancel path here.
async fn launch_broker(state: AppState, resolution: BrokerConfigResolution) {
    let (config, pending_public_enrollment) = match resolution {
        BrokerConfigResolution::Disabled => return,
        BrokerConfigResolution::Ready(config) => (Some(config), None),
        BrokerConfigResolution::PendingPublicEnrollment(pending) => (None, Some(pending)),
    };

    // A broker is configured for this relay lifetime — retain transcript deltas for
    // the publisher (they are dropped at enqueue only when no broker is configured).
    state.mark_broker_configured().await;

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
        return;
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
}

async fn run_broker_loop(
    state: AppState,
    mut change_rx: watch::Receiver<u64>,
    config: BrokerConfig,
) {
    let mut reconnect_backoff = RetryBackoff::new(
        Duration::from_secs(BROKER_RECONNECT_BASE_DELAY_SECS),
        Duration::from_secs(BROKER_RECONNECT_MAX_DELAY_SECS),
    );
    loop {
        let connected_duration = match run_broker_session(&state, &mut change_rx, &config).await {
            Ok(connected_duration) => {
                debug!("broker session ended cleanly");
                reconnect_backoff.reset_after_stable_session(connected_duration);
                Some(connected_duration)
            }
            Err(error) => {
                let connected_duration = error.connected_duration();
                warn!(
                    broker_room_id = config.broker_room_id(),
                    peer_id = config.relay_peer_id(),
                    error = %error.message(),
                    "broker session ended"
                );
                state
                    .push_runtime_log("warn", format!("Broker disconnected: {}", error.message()))
                    .await;
                if let Some(connected_duration) = connected_duration {
                    reconnect_backoff.reset_after_stable_session(connected_duration);
                }
                connected_duration
            }
        };

        state.set_broker_connection(false).await;
        let retry = {
            let mut rng = rand::thread_rng();
            reconnect_backoff.next_delay(&mut rng)
        };
        info!(
            broker_room_id = config.broker_room_id(),
            peer_id = config.relay_peer_id(),
            reconnect_delay_ms = retry.delay.as_millis(),
            reconnect_delay_cap_ms = retry.cap.as_millis(),
            consecutive_failures = retry.consecutive_failures,
            connected_duration_ms = connected_duration
                .map(|duration| duration.as_millis())
                .unwrap_or(0),
            "scheduling broker reconnect"
        );
        tokio::time::sleep(retry.delay).await;
    }
}

async fn run_public_broker_enrollment_loop(state: AppState, pending: PendingPublicEnrollment) {
    let client = reqwest::Client::new();
    let mut retry_backoff = RetryBackoff::new(
        Duration::from_secs(PUBLIC_RELAY_AUTH_REQUEST_RETRY_SECS),
        Duration::from_secs(BROKER_RECONNECT_MAX_DELAY_SECS),
    );
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

        let retry = {
            let mut rng = rand::thread_rng();
            retry_backoff.next_delay(&mut rng)
        };
        info!(
            control_url = %pending.control_url,
            retry_delay_ms = retry.delay.as_millis(),
            retry_delay_cap_ms = retry.cap.as_millis(),
            consecutive_failures = retry.consecutive_failures,
            "scheduling public broker enrollment retry"
        );
        tokio::time::sleep(retry.delay).await;
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
        pending.license_code.clone(),
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
) -> Result<Duration, BrokerSessionError> {
    run_broker_session_with_liveness(state, change_rx, config, BrokerLivenessConfig::default())
        .await
}

async fn run_broker_session_with_liveness(
    state: &AppState,
    change_rx: &mut watch::Receiver<u64>,
    config: &BrokerConfig,
    liveness: BrokerLivenessConfig,
) -> Result<Duration, BrokerSessionError> {
    let connect_url = config
        .relay_connect_url()
        .await
        .map_err(BrokerSessionError::before_connected)?;
    let (socket, _) = connect_async(connect_url.as_str()).await.map_err(|error| {
        BrokerSessionError::before_connected(format!("failed to connect to broker: {error}"))
    })?;
    let (sink, mut receiver) = socket.split();
    // The write half moves into its own task. Nothing on the read path may ever await a
    // socket write again: that coupling is what let a paced chunk train block the relay
    // from reading for seconds at a time. See `writer.rs`.
    // The guard aborts the writer on every exit path from this session. The socket is
    // the session: a writer left draining into a dead socket can outlive its reconnect.
    let (writer, mut writer_error, _writer_guard) = spawn_broker_writer(sink, state.clone());

    let welcome = receiver
        .next()
        .await
        .ok_or_else(|| BrokerSessionError::before_connected("broker closed before welcome"))?
        .map_err(|error| {
            BrokerSessionError::before_connected(format!("broker welcome read failed: {error}"))
        })?;
    match decode_server_frame(welcome).map_err(BrokerSessionError::before_connected)? {
        Some(ServerMessage::Welcome {
            protocol_version,
            peers,
            ..
        }) => {
            validate_broker_protocol_version(protocol_version)
                .map_err(BrokerSessionError::before_connected)?;
            let surface_peers = peers
                .into_iter()
                .filter(|peer| peer.role == PeerRole::Surface)
                .collect::<Vec<_>>();
            state
                .replace_online_surface_peers(surface_peers.iter().map(|peer| peer.peer_id.clone()))
                .await;
            for peer in &surface_peers {
                if let Some(device_id) = peer.device_id.as_deref() {
                    if let Err(error) = state
                        .mark_remote_device_seen(device_id, &peer.peer_id)
                        .await
                    {
                        warn!(
                            peer_id = %peer.peer_id,
                            device_id,
                            %error,
                            "failed to bind broker surface peer from welcome"
                        );
                    }
                }
            }
        }
        Some(ServerMessage::Error { message, .. }) => {
            return Err(BrokerSessionError::before_connected(message))
        }
        Some(other) => {
            return Err(BrokerSessionError::before_connected(format!(
                "expected broker welcome frame, got {}",
                server_message_name(&other)
            )))
        }
        None => {
            return Err(BrokerSessionError::before_connected(
                "broker did not send a welcome frame",
            ))
        }
    }

    state.set_broker_connection(true).await;
    let connected_at = Instant::now();
    state
        .push_runtime_log(
            "info",
            format!("Connected to broker room {}.", config.broker_room_id()),
        )
        .await;
    publish_pending_broker_messages(&writer, state)
        .await
        .map_err(|error| {
            BrokerSessionError::after_connected(
                format!("initial broker direct publish failed: {error}"),
                connected_at,
            )
        })?;
    publish_snapshot(&writer, state).await.map_err(|error| {
        BrokerSessionError::after_connected(
            format!("initial broker publish failed: {error}"),
            connected_at,
        )
    })?;
    let mut snapshot_publish_gate =
        SnapshotPublishGate::new(Duration::from_millis(SNAPSHOT_PUBLISH_MIN_INTERVAL_MILLIS));
    snapshot_publish_gate.mark_published(Instant::now());
    let _ = change_rx.borrow_and_update();
    let mut pending_snapshot_timer = Box::pin(sleep_until(
        Instant::now() + Duration::from_secs(24 * 60 * 60),
    ));
    let mut pending_transcript_deltas = Vec::new();
    let mut pending_transcript_delta_timer = Box::pin(sleep_until(
        Instant::now() + Duration::from_secs(24 * 60 * 60),
    ));
    let mut heartbeat_seq = 0_u64;
    let mut awaiting_pong: Option<Vec<u8>> = None;
    let mut broker_ping_timer = Box::pin(sleep_until(Instant::now() + liveness.ping_interval));
    let mut broker_pong_timer = Box::pin(sleep_until(
        Instant::now() + Duration::from_secs(24 * 60 * 60),
    ));

    loop {
        tokio::select! {
            // The socket is the session, so a write failure still ends it. It now
            // arrives here instead of as the return value of a publish call, because
            // publishing is a hand-off to the writer task.
            writer_failed = &mut writer_error => {
                let error = writer_failed
                    .unwrap_or_else(|_| "broker writer task stopped".to_string());
                return Err(BrokerSessionError::after_connected(error, connected_at));
            }
            changed = change_rx.changed() => {
                changed.map_err(|_| BrokerSessionError::after_connected("relay change channel closed", connected_at))?;
                let deltas = drain_pending_broker_messages_for_publish(&writer, state)
                    .await
                    .map_err(|error| BrokerSessionError::after_connected(format!("broker direct publish failed: {error}"), connected_at))?;
                if !deltas.is_empty() {
                    let schedule_flush = pending_transcript_deltas.is_empty();
                    pending_transcript_deltas.extend(deltas);
                    if schedule_flush {
                        pending_transcript_delta_timer.as_mut().reset(
                            Instant::now()
                                + Duration::from_millis(TRANSCRIPT_DELTA_PUBLISH_WINDOW_MILLIS),
                        );
                    }
                }
                match snapshot_publish_decision(
                    &mut snapshot_publish_gate,
                    Instant::now(),
                    !pending_transcript_deltas.is_empty(),
                ) {
                    SnapshotPublishDecision::PublishSnapshot => {
                        publish_snapshot(&writer, state)
                            .await
                            .map_err(|error| BrokerSessionError::after_connected(format!("broker publish failed: {error}"), connected_at))?;
                    }
                    SnapshotPublishDecision::FlushTranscriptDeltasThenPublishSnapshot => {
                        flush_pending_transcript_deltas(&writer,
                            state,
                            &mut pending_transcript_deltas,
                        )
                        .await
                        .map_err(|error| {
                            BrokerSessionError::after_connected(
                                format!("broker transcript delta publish before snapshot failed: {error}"),
                                connected_at,
                            )
                        })?;
                        publish_snapshot(&writer, state)
                            .await
                            .map_err(|error| BrokerSessionError::after_connected(format!("broker publish failed: {error}"), connected_at))?;
                    }
                    SnapshotPublishDecision::DelayUntil(deadline) => {
                        pending_snapshot_timer.as_mut().reset(deadline);
                    }
                }
            }
            () = &mut pending_transcript_delta_timer, if !pending_transcript_deltas.is_empty() => {
                let deltas = std::mem::take(&mut pending_transcript_deltas);
                pending_transcript_deltas = publish_transcript_delta_batch(&writer, state, deltas)
                    .await
                    .map_err(|error| BrokerSessionError::after_connected(format!("broker transcript delta publish failed: {error}"), connected_at))?;
                if !pending_transcript_deltas.is_empty() {
                    pending_transcript_delta_timer.as_mut().reset(
                        Instant::now()
                            + Duration::from_millis(TRANSCRIPT_DELTA_PUBLISH_WINDOW_MILLIS),
                    );
                }
            }
            () = &mut pending_snapshot_timer, if snapshot_publish_gate.has_pending_publish() => {
                match snapshot_publish_decision(
                    &mut snapshot_publish_gate,
                    Instant::now(),
                    !pending_transcript_deltas.is_empty(),
                ) {
                    SnapshotPublishDecision::PublishSnapshot => {
                        publish_snapshot(&writer, state)
                            .await
                            .map_err(|error| BrokerSessionError::after_connected(format!("broker publish failed: {error}"), connected_at))?;
                    }
                    SnapshotPublishDecision::FlushTranscriptDeltasThenPublishSnapshot => {
                        flush_pending_transcript_deltas(&writer,
                            state,
                            &mut pending_transcript_deltas,
                        )
                        .await
                        .map_err(|error| {
                            BrokerSessionError::after_connected(
                                format!("broker transcript delta publish before snapshot failed: {error}"),
                                connected_at,
                            )
                        })?;
                        publish_snapshot(&writer, state)
                            .await
                            .map_err(|error| BrokerSessionError::after_connected(format!("broker publish failed: {error}"), connected_at))?;
                    }
                    SnapshotPublishDecision::DelayUntil(deadline) => {
                        pending_snapshot_timer.as_mut().reset(deadline);
                    }
                }
            }
            () = &mut broker_ping_timer => {
                if awaiting_pong.is_some() {
                    return Err(BrokerSessionError::after_connected(
                        "broker heartbeat timed out before the next ping",
                        connected_at,
                    ));
                }
                heartbeat_seq = heartbeat_seq.wrapping_add(1);
                let payload = heartbeat_seq.to_be_bytes().to_vec();
                writer
                    .send_ping(Message::Ping(payload.clone()))
                    .map_err(|error| BrokerSessionError::after_connected(format!("broker heartbeat ping failed: {error}"), connected_at))?;
                debug!(heartbeat_seq, "sent broker heartbeat ping");
                awaiting_pong = Some(payload);
                broker_pong_timer
                    .as_mut()
                    .reset(Instant::now() + liveness.pong_timeout);
                broker_ping_timer
                    .as_mut()
                    .reset(Instant::now() + liveness.ping_interval);
            }
            () = &mut broker_pong_timer, if awaiting_pong.is_some() => {
                return Err(BrokerSessionError::after_connected(format!(
                    "broker heartbeat timed out after {}ms without pong",
                    liveness.pong_timeout.as_millis()
                ), connected_at));
            }
            incoming = receiver.next() => {
                let Some(frame) = incoming else {
                    return Err(BrokerSessionError::after_connected("broker socket closed", connected_at));
                };
                let frame = frame.map_err(|error| BrokerSessionError::after_connected(format!("broker receive failed: {error}"), connected_at))?;
                if let Message::Pong(payload) = &frame {
                    if awaiting_pong.as_deref() == Some(payload.as_slice()) {
                        awaiting_pong = None;
                        debug!(heartbeat_seq, "received broker heartbeat pong");
                    }
                    continue;
                }
                if let Some(message) = decode_server_frame(frame)
                    .map_err(|error| BrokerSessionError::after_connected(error, connected_at))?
                {
                    let message_name = server_message_name(&message);
                    let started_at = Instant::now();
                    handle_server_message(state, &writer, message)
                        .await
                        .map_err(|error| BrokerSessionError::after_connected(error, connected_at))?;
                    let elapsed_ms = started_at.elapsed().as_millis();
                    if elapsed_ms >= BROKER_MESSAGE_HANDLER_SLOW_WARN_MILLIS {
                        warn!(
                            message = message_name,
                            elapsed_ms,
                            "broker server message handling was slow"
                        );
                    }
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
    writer: &BrokerWriter,
    message: ServerMessage,
) -> Result<(), String> {
    match message {
        ServerMessage::Welcome {
            protocol_version, ..
        } => validate_broker_protocol_version(protocol_version),
        ServerMessage::Presence {
            channel_id,
            kind,
            peer,
        } => {
            if peer.role == PeerRole::Surface {
                state
                    .update_surface_presence(&peer.peer_id, matches!(kind, PresenceKind::Joined))
                    .await;
                if matches!(kind, PresenceKind::Joined) {
                    if let Some(device_id) = peer.device_id.as_deref() {
                        if let Err(error) = state
                            .mark_remote_device_seen(device_id, &peer.peer_id)
                            .await
                        {
                            warn!(
                                peer_id = %peer.peer_id,
                                device_id,
                                %error,
                                "failed to bind broker surface peer from presence"
                            );
                        }
                    }
                }
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

            // A payload this relay cannot parse costs the SURFACE its request, not the
            // room its session.
            //
            // This used to propagate, and `handle_server_message`'s error ends the whole
            // broker session — so one authenticated surface sending something malformed
            // disconnected every other surface, and the reconnect resynced a full
            // snapshot. Version skew is the likeliest trigger (see
            // `SUPPORTED_INBOUND_RELAY_PROTOCOL_VERSIONS`), but any junk frame did it.
            //
            // Errors that genuinely mean the CONNECTION is unusable — a dropped socket, a
            // `rate_limited` admission that a frame was discarded — still end the session
            // below. This narrows only the "one bad message" case.
            let parsed = match parse_inbound_payload(payload) {
                Ok(parsed) => parsed,
                Err(error) => {
                    warn!(
                        from_peer_id,
                        %error,
                        "ignoring an unparseable surface payload; the session continues"
                    );
                    return Ok(());
                }
            };
            let from_peer_id_for_log = from_peer_id.clone();
            let outcome = match parsed {
                Some(InboundBrokerPayload::PairingRequest {
                    pairing_id,
                    envelope,
                }) => {
                    handle_pairing_request(state, writer, from_peer_id, pairing_id, envelope).await
                }
                Some(InboundBrokerPayload::RemoteAction {
                    action_id,
                    session_claim,
                    device_id,
                    request,
                }) => {
                    handle_remote_action(
                        state,
                        writer,
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
                        writer,
                        from_peer_id,
                        action_id,
                        session_claim,
                        device_id,
                        envelope,
                    )
                    .await
                }
                None => Ok(()),
            };

            // A handler's failure belongs to the surface that caused it, not to the room.
            //
            // Parsing is not the only way a surface's message can fail, and refusing it is
            // not even unusual: plaintext remote actions are rejected in private mode,
            // which is the DEFAULT, so an ordinary misconfigured client produces one of
            // these on every request. Propagating it ends `run_broker_session`, which
            // disconnects every other surface in the room and resyncs a full snapshot on
            // the way back — repeatable at will by whoever sent the message.
            //
            // Nothing that genuinely requires a reconnect is lost by swallowing this:
            // - a dead writer has its own `select!` arm in the session loop, which is
            //   where write failures have arrived since publishing became a hand-off;
            // - a broker `rate_limited` is a `ServerMessage::Error`, handled in the arm
            //   below and still fatal on purpose.
            if let Err(error) = outcome {
                warn!(
                    from_peer_id = from_peer_id_for_log,
                    %error,
                    "a surface's message failed; answering nothing and keeping the session"
                );
            }
            Ok(())
        }
        ServerMessage::Error { code, message } => {
            if code == "rate_limited" {
                // Not backpressure — an admission that a frame was already discarded,
                // with no way to learn which. Deferring the next snapshot cannot bring
                // it back. Ending the session reconnects and resyncs, and the surface
                // fails its in-flight actions on the disconnect instead of waiting out
                // a deadline for chunks that will never arrive.
                warn!(%message, "broker dropped a publish; ending the session to resync");
            }
            Err(message)
        }
    }
}

async fn handle_pairing_request(
    state: &AppState,
    writer: &BrokerWriter,
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
        publish_pairing_result(writer, result).await?;
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

fn server_message_name(message: &ServerMessage) -> &'static str {
    match message {
        ServerMessage::Welcome { .. } => "welcome",
        ServerMessage::Presence { .. } => "presence",
        ServerMessage::Message { .. } => "message",
        ServerMessage::Error { .. } => "error",
    }
}

async fn publish_snapshot(writer: &BrokerWriter, state: &AppState) -> Result<(), String> {
    let snapshot = state.snapshot().await;
    let broker_can_read_content = state.broker_can_read_content().await;
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
        delivery_mode = if broker_can_read_content {
            "broker_readable_broadcast"
        } else {
            "e2ee_targeted"
        },
        "publishing broker session snapshot"
    );
    if broker_can_read_content {
        publish_payload(
            writer,
            OutboundBrokerPayload::SessionSnapshot {
                snapshot: compacted,
            },
        )
        .await
        .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let targets = state.broker_targets().await;
    let target_summary = targets
        .iter()
        .map(|target| format!("{}:{}", target.device_id, target.peer_id))
        .collect::<Vec<_>>()
        .join(",");
    let target_summary = if target_summary.is_empty() {
        "-".to_string()
    } else {
        target_summary
    };
    info!(
        scope = "session_snapshot",
        target_count = targets.len(),
        targets = %target_summary,
        delivery_mode = "e2ee_targeted",
        "resolved encrypted broker surface targets"
    );
    if targets.is_empty() {
        debug!(
            active_thread_id = compacted.active_thread_id.as_deref().unwrap_or("-"),
            transcript_entries = compacted.transcript.len(),
            "broker session snapshot has no online surface targets"
        );
    }
    let mut messages = Vec::new();
    for target in targets {
        let envelope = encrypt_json(&target.payload_secret, &compacted)?;
        messages.push(TargetedBrokerMessage {
            target_peer_id: target.peer_id.clone(),
            payload: Box::new(OutboundBrokerPayload::EncryptedSessionSnapshot {
                target_peer_id: target.peer_id,
                device_id: target.device_id,
                envelope,
            }),
        });
    }
    publish_targeted_messages(writer, messages).await?;

    Ok(())
}

async fn publish_pending_broker_messages(
    writer: &BrokerWriter,
    state: &AppState,
) -> Result<(), String> {
    let deltas = drain_pending_broker_messages_for_publish(writer, state).await?;
    for delta in coalesce_transcript_deltas(deltas) {
        publish_transcript_delta(writer, state, delta).await?;
    }
    Ok(())
}

async fn drain_pending_broker_messages_for_publish(
    writer: &BrokerWriter,
    state: &AppState,
) -> Result<Vec<PendingTranscriptDelta>, String> {
    let messages = state.drain_pending_broker_messages().await;
    let mut transcript_deltas = Vec::new();
    if !messages.is_empty() {
        let pairing_count = messages
            .iter()
            .filter(|message| matches!(message, BrokerPendingMessage::PairingResult(_)))
            .count();
        let transcript_delta_count = messages
            .iter()
            .filter(|message| matches!(message, BrokerPendingMessage::TranscriptDelta(_)))
            .count();
        info!(
            total_count = messages.len(),
            pairing_count, transcript_delta_count, "drained pending broker messages"
        );
    }
    for message in messages {
        match message {
            BrokerPendingMessage::PairingResult(result) => {
                publish_pairing_result(writer, result).await?;
            }
            BrokerPendingMessage::TranscriptDelta(delta) => transcript_deltas.push(delta),
        }
    }
    Ok(transcript_deltas)
}

async fn publish_transcript_delta_batch(
    writer: &BrokerWriter,
    state: &AppState,
    deltas: Vec<PendingTranscriptDelta>,
) -> Result<Vec<PendingTranscriptDelta>, String> {
    const MAX_DELTAS_PER_DRAIN: usize = 50;
    let mut deltas = coalesce_transcript_deltas(deltas);
    let remaining = if deltas.len() > MAX_DELTAS_PER_DRAIN {
        deltas.split_off(MAX_DELTAS_PER_DRAIN)
    } else {
        Vec::new()
    };

    let mut delta_count = 0;
    for delta in deltas {
        publish_transcript_delta(writer, state, delta).await?;
        delta_count += 1;
    }
    if delta_count > 0 {
        debug!(delta_count, "published coalesced broker transcript deltas");
    }
    Ok(remaining)
}

async fn flush_pending_transcript_deltas(
    writer: &BrokerWriter,
    state: &AppState,
    pending_transcript_deltas: &mut Vec<PendingTranscriptDelta>,
) -> Result<(), String> {
    let mut deltas = std::mem::take(pending_transcript_deltas);
    while !deltas.is_empty() {
        deltas = publish_transcript_delta_batch(writer, state, deltas).await?;
    }
    Ok(())
}

fn coalesce_transcript_deltas(deltas: Vec<PendingTranscriptDelta>) -> Vec<PendingTranscriptDelta> {
    let mut coalesced: Vec<PendingTranscriptDelta> = Vec::new();
    for delta in deltas {
        if let Some(last) = coalesced.last_mut() {
            if can_merge_transcript_delta(last, &delta) {
                last.delta.push_str(&delta.delta);
                last.revision = delta.revision;
                last.entry_seq = delta.entry_seq;
                // Same item (can_merge), so order_seq is identical by contract.
                last.server_time = delta.server_time;
                continue;
            }
        }
        coalesced.push(delta);
    }
    coalesced
}

fn can_merge_transcript_delta(
    current: &PendingTranscriptDelta,
    next: &PendingTranscriptDelta,
) -> bool {
    current.thread_id == next.thread_id
        && current.row_id == next.row_id
        && current.turn_id == next.turn_id
        && current.kind == next.kind
        && current.revision == next.base_revision
}

/// Decide who a transcript delta goes to and in what form.
///
/// Split out from the socket write so the delivery contract is testable without a live
/// websocket: which peers are targeted, and what each one actually receives. Both
/// delivery modes are TARGETED — managed mode used to broadcast one frame and let each
/// client discard threads it wasn't showing, which cannot work once every background
/// thread streams (N open threads would cost every paired surface N streams).
///
/// Targets come from the relay's own peer bookkeeping (`online_surface_peer_devices`),
/// which a broadcast never consulted. A paired surface is bound the moment it joins
/// (presence/welcome -> mark_remote_device_seen; a device join ticket must carry a
/// device_id, see relay-broker join_ticket.rs), so the only gap is the few ms before its
/// presence frame arrives. Snapshots are still broadcast in managed mode, and the client
/// has not rendered anything yet at that point, so nothing goes blank.
///
/// Surfaces that are mid-pairing carry no device_id and no payload_secret; they were
/// never in `broker_targets()`, before targeting or after.
fn build_transcript_delta_messages(
    targets: Vec<BrokerTarget>,
    broker_can_read_content: bool,
    delta: &PendingTranscriptDelta,
) -> Result<Vec<TargetedBrokerMessage>, String> {
    let kind = match delta.kind {
        TranscriptDeltaKind::AgentText => "agent_text",
        TranscriptDeltaKind::CommandOutput => "command_output",
    };

    if broker_can_read_content {
        return Ok(targets
            .into_iter()
            .map(|target| TargetedBrokerMessage {
                target_peer_id: target.peer_id,
                payload: Box::new(OutboundBrokerPayload::TranscriptDelta {
                    thread_id: delta.thread_id.clone(),
                    base_revision: delta.base_revision,
                    revision: delta.revision,
                    entry_seq: delta.entry_seq,
                    order_seq: delta.order_seq,
                    server_time: delta.server_time,
                    transcript_generation: delta.transcript_generation.clone(),
                    row_id: delta.row_id.clone(),
                    item_id: delta.row_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    delta: delta.delta.clone(),
                    delta_kind: kind.to_string(),
                    text_offset: delta.text_offset,
                }),
            })
            .collect());
    }

    let mut messages = Vec::new();
    for target in targets {
        // Encrypted per DEVICE: the payload secret is a device grant, so two surfaces of
        // one device share it while a different device cannot read either.
        let envelope = encrypt_json(
            &target.payload_secret,
            &serde_json::json!({
                "thread_id": delta.thread_id,
                "base_revision": delta.base_revision,
                "revision": delta.revision,
                "entry_seq": delta.entry_seq,
                "order_seq": delta.order_seq,
                "server_time": delta.server_time,
                "transcript_generation": delta.transcript_generation,
                "row_id": delta.row_id,
                // Compatibility alias; same value as `row_id`.
                "item_id": delta.row_id,
                "turn_id": delta.turn_id,
                "delta": delta.delta,
                "delta_kind": kind,
                "text_offset": delta.text_offset,
            }),
        )?;
        messages.push(TargetedBrokerMessage {
            target_peer_id: target.peer_id.clone(),
            payload: Box::new(OutboundBrokerPayload::EncryptedTranscriptDelta {
                target_peer_id: target.peer_id,
                device_id: target.device_id,
                envelope,
            }),
        });
    }
    Ok(messages)
}

async fn publish_transcript_delta(
    writer: &BrokerWriter,
    state: &AppState,
    delta: PendingTranscriptDelta,
) -> Result<(), String> {
    let kind = match delta.kind {
        TranscriptDeltaKind::AgentText => "agent_text",
        TranscriptDeltaKind::CommandOutput => "command_output",
    };

    let targets = state.broker_targets_for_thread(&delta.thread_id).await;
    if targets.is_empty() {
        debug!(
            row_id = %delta.row_id,
            thread_id = %delta.thread_id,
            turn_id = delta.turn_id.as_deref().unwrap_or("-"),
            delta_kind = kind,
            "no surface is watching this thread; dropping transcript delta"
        );
        return Ok(());
    }

    let broker_can_read_content = state.broker_can_read_content().await;
    let target_summary = targets
        .iter()
        .map(|target| format!("{}:{}", target.device_id, target.peer_id))
        .collect::<Vec<_>>()
        .join(",");
    info!(
        scope = "transcript_delta",
        target_count = targets.len(),
        targets = %target_summary,
        row_id = %delta.row_id,
        thread_id = %delta.thread_id,
        turn_id = delta.turn_id.as_deref().unwrap_or("-"),
        delta_kind = kind,
        delivery_mode = if broker_can_read_content {
            "broker_readable_targeted"
        } else {
            "e2ee_targeted"
        },
        "resolved broker surface targets"
    );

    let messages = build_transcript_delta_messages(targets, broker_can_read_content, &delta)?;
    publish_targeted_messages(writer, messages).await?;

    Ok(())
}

/// Seal a pairing result for exactly one broker peer.
///
/// The envelope carries the new device's `payload_secret` and refresh tokens
/// sealed with nothing but the `pairing_secret` printed into the QR code, so any
/// peer that can read the frame AND has seen the QR can open it. It therefore
/// MUST leave here inside a `targeted_messages` wrapper: the broker routes on
/// that wrapper alone, and a bare payload carrying an inner `target_peer_id` used
/// to be fanned out to the whole room — handing the credentials to any bystander
/// replaying the same pairing join ticket.
fn pairing_result_targeted_message(
    result: crate::state::PendingPairingResult,
) -> Result<TargetedBrokerMessage, String> {
    let encrypted = encrypt_json(
        &result.pairing_secret,
        &PairingResultPlaintext {
            ok: result.error.is_none(),
            device: result.device,
            payload_secret: result.payload_secret,
            relay_id: result.relay_id,
            relay_label: result.relay_label,
            client_claim_id: result.client_claim_id,
            client_claim_nonce: result.client_claim_nonce,
            client_claim_expires_at: result.client_claim_expires_at,
            device_refresh_token: result.device_refresh_token,
            device_join_ticket: result.device_join_ticket,
            device_join_ticket_expires_at: result.device_join_ticket_expires_at,
            error: result.error,
        },
    )?;
    Ok(TargetedBrokerMessage {
        target_peer_id: result.target_peer_id.clone(),
        payload: Box::new(OutboundBrokerPayload::EncryptedPairingResult {
            pairing_id: result.pairing_id,
            target_peer_id: result.target_peer_id,
            envelope: encrypted,
        }),
    })
}

async fn publish_pairing_result(
    writer: &BrokerWriter,
    result: crate::state::PendingPairingResult,
) -> Result<(), String> {
    publish_targeted_messages(writer, vec![pairing_result_targeted_message(result)?]).await
}

async fn publish_payload(
    writer: &BrokerWriter,
    payload: OutboundBrokerPayload,
) -> Result<(), String> {
    let summary = summarize_outbound_payload(&payload);
    let frame_text = frame_text_for_payload(&payload);
    let frame_bytes = frame_text.len();
    info!(
        broker_payload = %summary,
        frame_bytes,
        "publishing broker payload"
    );
    if frame_bytes > MAX_BROKER_TEXT_FRAME_BYTES {
        // TODO(broker-frame-budget): This warn is only diagnostic. The actual fix should live at
        // this transport boundary: measure the final serialized publish frame, then fall back to a
        // chunked broker payload when it exceeds the websocket limit instead of attempting a send.
        // Keep the budget check here even if upstream action-specific compaction improves, because
        // this is the last point where we know the true post-encryption/post-envelope frame size.
        warn!(
            broker_payload = %summary,
            frame_bytes,
            frame_limit_bytes = MAX_BROKER_TEXT_FRAME_BYTES,
            "broker payload exceeds websocket text frame limit before send"
        );
    }
    writer.send_now(Message::Text(frame_text)).await
}

/// Serialize a payload into the frame the writer will send, without sending it.
/// Used to build a chunk train up front so the writer can pace it.
fn frame_message_for_payload(payload: &OutboundBrokerPayload) -> Message {
    Message::Text(frame_text_for_payload(payload))
}

async fn publish_targeted_messages(
    writer: &BrokerWriter,
    messages: Vec<TargetedBrokerMessage>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }

    let mut batch = Vec::new();
    for message in messages {
        let mut candidate = batch.clone();
        candidate.push(message.clone());
        let candidate_payload = OutboundBrokerPayload::TargetedMessages {
            messages: candidate,
        };
        if !batch.is_empty()
            && frame_bytes_for_payload(&candidate_payload) > MAX_BROKER_TEXT_FRAME_BYTES
        {
            let payload = OutboundBrokerPayload::TargetedMessages { messages: batch };
            publish_payload(writer, payload)
                .await
                .map_err(|error| error.to_string())?;
            batch = vec![message];
            continue;
        }
        batch.push(message);
    }

    if !batch.is_empty() {
        publish_payload(
            writer,
            OutboundBrokerPayload::TargetedMessages { messages: batch },
        )
        .await
        .map_err(|error| error.to_string())?;
    }

    Ok(())
}

/// The broker registration and identity live next to the session file, not in
/// the launch directory: they are *this relay's* identity to the broker, so a
/// per-directory copy would re-enroll as a brand new relay and orphan the
/// devices already paired with the old one. See [`crate::state_paths`].
fn resolve_public_relay_registration_path(cwd: &Path, configured: Option<String>) -> PathBuf {
    crate::state_paths::sibling_state_file(
        cwd,
        RELAY_BROKER_REGISTRATION_PATH_ENV,
        configured.and_then(trimmed_string).map(OsString::from),
        crate::state_paths::PUBLIC_BROKER_REGISTRATION_FILE,
    )
}

fn resolve_public_relay_identity_path(cwd: &Path, configured: Option<String>) -> PathBuf {
    crate::state_paths::sibling_state_file(
        cwd,
        RELAY_BROKER_IDENTITY_PATH_ENV,
        configured.and_then(trimmed_string).map(OsString::from),
        crate::state_paths::PUBLIC_BROKER_IDENTITY_FILE,
    )
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

/// Write `payload` to `path` through a temp sibling and an atomic rename,
/// creating the temp file *exclusively* (`create_new`). That refuses a symlink
/// or hard link pre-planted at the temp path instead of following it to an
/// external target: the relay isn't sandboxed, so without this a
/// workspace-write-confined agent could redirect these broker cache / key
/// writes to a fixed filename outside the workspace. Callers create the parent
/// directory first. Mirrors `state::persistence::save`; `write_new_exclusive`
/// is sync I/O, hence the blocking pool.
async fn persist_bytes_atomically(path: &Path, payload: Vec<u8>) -> Result<(), String> {
    let temporary_path = path.with_extension("tmp");
    let write_path = temporary_path.clone();
    tokio::task::spawn_blocking(move || {
        crate::instance_lock::write_new_exclusive(&write_path, &payload)
    })
    .await
    .map_err(|error| format!("temp file write task panicked: {error}"))?
    .map_err(|error| format!("failed to write {}: {error}", temporary_path.display()))?;
    tokio::fs::rename(&temporary_path, path)
        .await
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    Ok(())
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
    persist_bytes_atomically(path, payload).await
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
    persist_bytes_atomically(path, payload).await
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
