mod access_release;
mod activation;
mod auth;
mod credentials;
mod crypto;
mod lifecycle;
mod protocol;
mod remote_actions;
mod request_auth;
mod signed_control;
mod stored_credentials;
mod writer;

pub use access_release::run_cloud_access_release;
#[cfg(test)]
pub(crate) use access_release::with_test_control_challenge;

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use futures_util::stream::StreamExt;
use rand::{Rng, RngCore};
use relay_broker::auth::{BrokerAuthMode, BROKER_AUTH_MODE_ENV};
use relay_broker::client_version::{MinRelayVersion, UPDATE_INSTRUCTIONS};
use relay_broker::join_ticket::unix_now;
use relay_broker::protocol::{
    ClientMessage, PeerRole, PresenceKind, ServerMessage, MAX_TARGETED_MESSAGES_PER_PUBLISH,
};
use relay_broker::public_control::relay_join_message;
use relay_util::{trimmed_option_string, trimmed_string};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use tokio::time::{sleep_until, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};
use url::Url;

use crate::protocol::TranscriptResyncEvent;
use crate::state::{
    AppState, BrokerPendingMessage, BrokerTarget, PendingTranscriptDelta, TranscriptDeltaKind,
};

use self::activation::{
    activation_override_env_present, cloud_activation_required,
    discard_oneshot_activation_file_input, resolve_activation_credential, scrub_activation_env,
    scrub_all_cloud_activation_env_for_normal_start, CLOUD_ACCESS_KEY_ENV,
    CLOUD_ACCESS_KEY_FILE_ENV, CLOUD_ACTIVATION_ENV,
};
use self::auth::{
    build_control_plane_client, complete_public_relay_enrollment, parse_control_plane_url,
    request_public_relay_enrollment_challenge, BrokerAuthConfig, BrokerJoinCredential,
    ClientBrokerGrant, DeviceBrokerCredential, PublicRelayRegistration,
    RELAY_BROKER_CONTROL_URL_ENV, RELAY_BROKER_RELAY_ID_ENV, RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV,
};
use self::crypto::{decrypt_json, encrypt_json, EncryptedEnvelope};
use self::lifecycle::{bearer_fingerprint, BrokerLifecycleLock, RegistrationIdentity};
#[cfg(test)]
use self::protocol::summarize_thread_transcript_response;
use self::protocol::{
    frame_bytes_for_payload, parse_inbound_payload, summarize_outbound_payload,
    validate_broker_protocol_version, InboundBrokerPayload, OutboundBrokerPayload,
    PairingRequestPlaintext, PairingResultPlaintext, TargetedBrokerMessage,
};
use self::remote_actions::handle_encrypted_remote_action;
#[cfg(test)]
use self::remote_actions::RemoteActionRequest;
use self::writer::{spawn_broker_writer, BrokerWriter};
#[cfg(test)]
use relay_broker::protocol::BROKER_PROTOCOL_VERSION;

const BROKER_RECONNECT_BASE_DELAY_SECS: u64 = 2;
const BROKER_RECONNECT_MAX_DELAY_SECS: u64 = 60;
const BROKER_RECONNECT_STABLE_SESSION_SECS: u64 = 60;
const BROKER_PING_INTERVAL_SECS: u64 = 20;
const BROKER_PONG_TIMEOUT_SECS: u64 = 10;
const PUBLIC_RELAY_AUTH_REQUEST_RETRY_SECS: u64 = 5;

fn product_version() -> &'static str {
    env!("SEALWIRE_PRODUCT_VERSION")
}

pub(crate) async fn check_broker_client_version() -> Result<(), String> {
    let broker_url = match std::env::var("RELAY_BROKER_URL") {
        Ok(url) if !url.trim().is_empty() => url,
        _ => return Ok(()),
    };
    let origin = std::env::var(RELAY_BROKER_CONTROL_URL_ENV)
        .ok()
        .and_then(trimmed_string)
        .unwrap_or(broker_url);
    let mut url = Url::parse(&origin).map_err(|error| format!("invalid broker URL: {error}"))?;
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        "http" => "http",
        "https" => "https",
        _ => return Err("broker URL must use http(s) or ws(s)".to_string()),
    };
    url.set_scheme(scheme)
        .map_err(|_| "failed to convert broker URL to HTTP".to_string())?;
    url.set_path("/api/health");
    url.set_query(None);
    url.set_fragment(None);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("broker version check setup failed: {error}"))?;
    let response = match client.get(url).send().await {
        Ok(response) => response,
        Err(error) => {
            eprintln!(
                "sealwire: broker version check is unavailable ({error}); starting the local relay and retrying broker connection"
            );
            return Ok(());
        }
    };
    if response.status().is_server_error() {
        eprintln!(
            "sealwire: broker health returned HTTP {}; starting the local relay and retrying broker connection",
            response.status()
        );
        return Ok(());
    }
    if !response.status().is_success() {
        return Err(format!(
            "broker version check failed with HTTP {}; retry or run `sealwire local`",
            response.status()
        ));
    }
    let health: relay_broker::protocol::HealthResponse = response
        .json()
        .await
        .map_err(|error| format!("invalid broker version response: {error}"))?;
    validate_broker_health(health, product_version())
}

fn validate_broker_health(
    health: relay_broker::protocol::HealthResponse,
    client_version: &str,
) -> Result<(), String> {
    if health.status != "ok" || health.service != "relay-broker" || !health.join_auth_ready {
        return Err("broker is not ready for relay connections".to_string());
    }
    validate_broker_protocol_version(health.broker_protocol_version).map_err(|error| {
        format!(
            "{error}; {UPDATE_INSTRUCTIONS}. The client and broker protocol versions must match"
        )
    })?;
    let minimum = MinRelayVersion::parse(health.minimum_relay_version)
        .ok_or_else(|| "broker returned an invalid minimum relay version".to_string())?;
    minimum.check(Some(client_version))
}

pub(crate) use self::activation::{
    CLOUD_EXPECTED_BEARER_FP_ENV, CLOUD_EXPECTED_CONTROL_URL_ENV, CLOUD_EXPECTED_RELAY_ID_ENV,
    CLOUD_EXPECTED_ROOM_ID_ENV, CLOUD_REQUIRE_CACHED_REGISTRATION_ENV,
};

fn cloud_registration_required_from_env() -> bool {
    matches!(
        std::env::var(CLOUD_REQUIRE_CACHED_REGISTRATION_ENV)
            .ok()
            .as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

fn expected_registration_from_env() -> Result<RegistrationIdentity, String> {
    let invalid = || {
        "cloud launch registration witness is incomplete or invalid; refusing anonymous \
         enrollment. Re-run `sealwire cloud`."
            .to_string()
    };
    let control_url = std::env::var(CLOUD_EXPECTED_CONTROL_URL_ENV).map_err(|_| invalid())?;
    let relay_id = std::env::var(CLOUD_EXPECTED_RELAY_ID_ENV).map_err(|_| invalid())?;
    let broker_room_id = std::env::var(CLOUD_EXPECTED_ROOM_ID_ENV).map_err(|_| invalid())?;
    let bearer_fingerprint = std::env::var(CLOUD_EXPECTED_BEARER_FP_ENV).map_err(|_| invalid())?;
    if control_url.trim().is_empty()
        || relay_id.trim().is_empty()
        || broker_room_id.trim().is_empty()
        || bearer_fingerprint.trim().is_empty()
        || bearer_fingerprint.trim().len() != lifecycle::BEARER_FINGERPRINT_HEX_CHARS
        || !bearer_fingerprint
            .trim()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(invalid());
    }
    let control_url = parse_control_plane_url(control_url.trim()).map_err(|_| invalid())?;
    Ok(RegistrationIdentity {
        control_url: control_url.as_str().to_string(),
        relay_id: relay_id.trim().to_string(),
        broker_room_id: broker_room_id.trim().to_string(),
        bearer_fingerprint: bearer_fingerprint.trim().to_ascii_lowercase(),
    })
}

#[derive(Debug, Default)]
pub(crate) struct BrokerStartupContext {
    cloud_registration: CloudRegistrationRequirement,
}

#[derive(Debug, Default)]
enum CloudRegistrationRequirement {
    #[default]
    None,
    Required(RegistrationIdentity),
    Invalid(String),
}

fn emit_cloud_launch_witness(identity: &RegistrationIdentity) {
    // Machine-readable, secret-free witness for the Node launcher → long-lived child.
    let payload = serde_json::json!({
        "v": 1,
        "control_url": identity.control_url,
        "relay_id": identity.relay_id,
        "broker_room_id": identity.broker_room_id,
        "bearer_fingerprint": identity.bearer_fingerprint,
    });
    println!("sealwire-cloud-witness:{payload}");
}

/// Capture the secret-free preflight witness exactly once, then unconditionally
/// scrub every activation variable before AppState/provider construction.
/// Cloud-activate (subcommand) must run before this normal-start path.
pub fn capture_and_scrub_activation_for_normal_start() -> BrokerStartupContext {
    let cloud_registration = if cloud_registration_required_from_env() {
        match expected_registration_from_env() {
            Ok(identity) => CloudRegistrationRequirement::Required(identity),
            Err(error) => CloudRegistrationRequirement::Invalid(error),
        }
    } else {
        // Partial/ambient witness fields without the explicit requirement have
        // no startup semantics. They are scrubbed below and never reach a child.
        CloudRegistrationRequirement::None
    };
    scrub_all_cloud_activation_env_for_normal_start();
    BrokerStartupContext { cloud_registration }
}

pub(crate) const PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION: u32 = 1;
const PUBLIC_RELAY_IDENTITY_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_PUBLISH_MIN_INTERVAL_MILLIS: u64 = 500;
const TRANSCRIPT_DELTA_PUBLISH_WINDOW_MILLIS: u64 = 100;
const BROKER_MESSAGE_HANDLER_SLOW_WARN_MILLIS: u128 = 1_000;
/// How far the router may fall behind the socket before the session is ended. It only
/// routes, so filling this means something is badly wrong rather than merely slow.
const INBOUND_MESSAGE_QUEUE_CAPACITY: usize = 256;
/// How far ONE surface may fall behind before its frames are shed. Per surface, so a
/// phone waiting on something slow cannot make its backlog anyone else's problem.
const SURFACE_MESSAGE_QUEUE_CAPACITY: usize = 64;
const MAX_BROKER_TEXT_FRAME_BYTES: usize = 65_536;
// Version 4 signed every relay payload with the content key; version 5 also has the
// phone sign every action attempt. Exact match, no fallback.
const RELAY_PROTOCOL_VERSION: u64 = 5;

/// Session hex from `fresh_content_nonce` (18 bytes). Size estimates use this width.
const CONTENT_SESSION_HEX_LEN: usize = 36;
/// Decimal width of a u64. A shorter nonce still fits under an estimate that reserves this.
const CONTENT_NONCE_MAX_DIGITS: usize = 20;
/// Standard base64 of a 64-byte Ed25519 signature, including padding.
const CONTENT_SIGNATURE_B64_LEN: usize = 88;

struct RelayContentCrypto {
    key: SigningKey,
    relay_peer_id: String,
    broker_room_id: String,
    /// One content session per surface peer. Replaced by a new hello, removed on departure.
    sessions: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// Next sequence is per recipient and advances only when a frame is actually sealed.
    next_seq: std::sync::Mutex<std::collections::HashMap<String, u64>>,
}

impl RelayContentCrypto {
    fn new(key: SigningKey, relay_peer_id: String, broker_room_id: String) -> Self {
        Self {
            key,
            relay_peer_id,
            broker_room_id,
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            next_seq: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn open_session(&self, peer_id: &str) -> String {
        let session = fresh_content_nonce();
        debug_assert_eq!(session.len(), CONTENT_SESSION_HEX_LEN);
        self.sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(peer_id.to_string(), session.clone());
        session
    }

    fn forget_peer(&self, peer_id: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(peer_id);
        self.next_seq
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(peer_id);
    }

    fn request_binding(&self) -> request_auth::RelayRequestBinding {
        request_auth::RelayRequestBinding {
            relay_verify_key: STANDARD.encode(self.key.verifying_key().to_bytes()),
            broker_room_id: self.broker_room_id.clone(),
            relay_peer_id: self.relay_peer_id.clone(),
        }
    }

    fn session(&self, peer_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(peer_id)
            .cloned()
    }

    fn issued(&self, peer_id: &str) -> u64 {
        self.next_seq
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(peer_id)
            .copied()
            .unwrap_or(0)
    }

    /// Remember the session this frame is allowed to wear. A later hello must not
    /// rebind a frame that was already queued for the previous one.
    fn bind_epochs(&self, payload: &mut serde_json::Value) {
        if payload.get("kind").and_then(serde_json::Value::as_str) == Some("targeted_messages") {
            if let Some(messages) = payload
                .get_mut("messages")
                .and_then(serde_json::Value::as_array_mut)
            {
                for message in messages {
                    if let Some(inner) = message.get_mut("payload") {
                        self.bind_one(inner);
                    }
                }
            }
            return;
        }
        self.bind_one(payload);
    }

    fn bind_one(&self, payload: &mut serde_json::Value) {
        let Some(object) = payload.as_object_mut() else {
            return;
        };
        let target = object
            .get("target_peer_id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let session = self.session(target).unwrap_or_default();
        object.insert(
            "relay_content_session".to_string(),
            serde_json::Value::String(session),
        );
    }

    /// Sign a publish frame at the moment it is written. `None` means the frame was
    /// dropped because its queued session is no longer current — it is not sent unsigned.
    fn seal_frame_text(&self, text: &str) -> Result<Option<String>, String> {
        let mut frame: serde_json::Value = serde_json::from_str(text)
            .map_err(|_| "relay content publish could not be read".to_string())?;
        let kept = {
            let payload = frame
                .get_mut("payload")
                .ok_or_else(|| "relay content publish is missing its payload".to_string())?;
            self.seal_payload(payload)?
        };
        if !kept {
            return Ok(None);
        }
        serde_json::to_string(&frame)
            .map(Some)
            .map_err(|error| format!("relay content publish could not be encoded: {error}"))
    }

    fn seal_payload(&self, payload: &mut serde_json::Value) -> Result<bool, String> {
        if payload.get("kind").and_then(serde_json::Value::as_str) == Some("targeted_messages") {
            let Some(messages) = payload
                .get_mut("messages")
                .and_then(serde_json::Value::as_array_mut)
            else {
                return Ok(false);
            };
            let mut keep = Vec::with_capacity(messages.len());
            for message in messages.iter_mut() {
                let kept = match message.get_mut("payload") {
                    Some(inner) => self.seal_one(inner)?,
                    None => false,
                };
                keep.push(kept);
            }
            let mut index = 0;
            messages.retain(|_| {
                let kept = keep[index];
                index += 1;
                kept
            });
            return Ok(!messages.is_empty());
        }
        self.seal_one(payload)
    }

    fn seal_one(&self, payload: &mut serde_json::Value) -> Result<bool, String> {
        let Some(object) = payload.as_object_mut() else {
            return Ok(false);
        };
        let target = object
            .get("target_peer_id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let epoch = object
            .get("relay_content_session")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        if epoch.is_empty() || self.session(&target).as_deref() != Some(epoch.as_str()) {
            debug!(
                target_peer_id = %target,
                "dropping a relay payload queued for a content session that is no longer current"
            );
            return Ok(false);
        }
        let seq = self.allocate_seq(&target);
        let nonce = seq.to_string();
        object.insert(
            "relay_content_nonce".to_string(),
            serde_json::Value::String(nonce.clone()),
        );
        let message = relay_content_message(
            &self.relay_peer_id,
            &self.broker_room_id,
            &epoch,
            &nonce,
            object,
        )?;
        let signature = STANDARD.encode(self.key.sign(&message).to_bytes());
        object.insert(
            "relay_content_signature".to_string(),
            serde_json::Value::String(signature),
        );
        Ok(true)
    }

    fn allocate_seq(&self, target: &str) -> u64 {
        let mut seqs = self
            .next_seq
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let entry = seqs.entry(target.to_string()).or_insert(0);
        *entry = entry.saturating_add(1);
        *entry
    }
}

fn reserve_content_authentication(payload: &mut serde_json::Value) {
    if payload.get("kind").and_then(serde_json::Value::as_str) == Some("targeted_messages") {
        if let Some(messages) = payload
            .get_mut("messages")
            .and_then(serde_json::Value::as_array_mut)
        {
            for message in messages {
                if let Some(inner) = message.get_mut("payload") {
                    reserve_one_content_authentication(inner);
                }
            }
        }
        return;
    }
    reserve_one_content_authentication(payload);
}

fn reserve_one_content_authentication(payload: &mut serde_json::Value) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    object.insert(
        "relay_content_session".to_string(),
        serde_json::Value::String("0".repeat(CONTENT_SESSION_HEX_LEN)),
    );
    object.insert(
        "relay_content_nonce".to_string(),
        serde_json::Value::String("9".repeat(CONTENT_NONCE_MAX_DIGITS)),
    );
    object.insert(
        "relay_content_signature".to_string(),
        serde_json::Value::String("A".repeat(CONTENT_SIGNATURE_B64_LEN)),
    );
}

pub(super) fn reserved_publish_frame_len(payload: &serde_json::Value) -> usize {
    let mut reserved = payload.clone();
    reserve_content_authentication(&mut reserved);
    let frame = relay_broker::protocol::ClientMessage::Publish {
        protocol_version: relay_broker::protocol::BROKER_PROTOCOL_VERSION,
        payload: reserved,
    };
    serde_json::to_string(&frame)
        .expect("broker client frame should serialize")
        .len()
}

fn generate_content_signing_key() -> SigningKey {
    let mut seed = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut seed);
    SigningKey::from_bytes(&seed)
}

fn fresh_content_nonce() -> String {
    let mut bytes = [0_u8; 18];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn relay_content_message(
    from_peer_id: &str,
    broker_room_id: &str,
    session: &str,
    nonce: &str,
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<Vec<u8>, String> {
    let text = |name: &str| {
        object
            .get(name)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let number = |name: &str| {
        object
            .get(name)
            .and_then(serde_json::Value::as_u64)
            .or_else(|| {
                object
                    .get(name)
                    .and_then(serde_json::Value::as_i64)
                    .map(|value| value as u64)
            })
            .map(|value| value.to_string())
            .unwrap_or_default()
    };
    let envelope_nonce = object
        .get("envelope")
        .and_then(|value| value.get("nonce"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let envelope_ciphertext = object
        .get("envelope")
        .and_then(|value| value.get("ciphertext"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let fields = [
        number("protocol_version"),
        text("kind"),
        session.to_string(),
        nonce.to_string(),
        from_peer_id.to_string(),
        text("target_peer_id"),
        text("device_id"),
        text("action_id"),
        text("action"),
        text("pairing_id"),
        number("chunk_index"),
        number("chunk_count"),
        text("hello_nonce"),
        envelope_nonce.to_string(),
        envelope_ciphertext.to_string(),
        broker_room_id.to_string(),
    ];
    let mut out = Vec::new();
    out.extend_from_slice(b"agent-relay:relay-content-v1\0");
    for field in &fields {
        let bytes = field.as_bytes();
        let len = u32::try_from(bytes.len())
            .map_err(|_| "relay content field is too long".to_string())?;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(bytes);
    }
    Ok(out)
}

type BrokerSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone)]
pub struct BrokerConfig {
    public_base_url: String,
    url: Url,
    broker_room_id: String,
    relay_peer_id: String,
    auth: BrokerAuthConfig,
    /// Public enrollment key, or the self-hosted content key. Never sent off the host.
    content_signing_key: SigningKey,
    /// Public-mode only: watch the registration cache so an external `cloud unbind`
    /// stops reconnect retries instead of looping forever on a revoked refresh token.
    registration_watch: Option<RegistrationWatch>,
}

impl std::fmt::Debug for BrokerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrokerConfig")
            .field("public_base_url", &self.public_base_url)
            .field("url", &self.url)
            .field("broker_room_id", &self.broker_room_id)
            .field("relay_peer_id", &self.relay_peer_id)
            .field("auth", &self.auth)
            .field("registration_watch", &self.registration_watch)
            .finish()
    }
}

#[derive(Clone, Debug)]
struct RegistrationWatch {
    state_db: PathBuf,
    control_url: String,
    relay_id: String,
    broker_room_id: String,
    /// Truncated one-way fingerprint of the refresh bearer (never the bearer itself).
    refresh_fingerprint: String,
}

#[derive(Debug)]
enum BrokerConfigResolution {
    Disabled,
    Ready(BrokerConfig),
    PendingPublicEnrollment(PendingPublicEnrollment),
}

#[derive(Debug, Clone)]
struct PendingPublicEnrollment {
    control_url: Url,
    state_db: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnrollmentDisposition {
    Existing,
    Enrolled,
}

/// A registration selected or created while the lifecycle lock remains held.
/// Callers that reload broker configuration can therefore consume the exact
/// cache selected by the critical section before activate/unbind may proceed.
struct LockedPublicRelayRegistration {
    registration: PublicRelayRegistration,
    disposition: EnrollmentDisposition,
    #[allow(dead_code)]
    lifecycle: BrokerLifecycleLock,
}

#[derive(Debug)]
enum EnrollmentCriticalError {
    /// Lock/cache/save failures must stop: retrying could overwrite a different
    /// origin or issue a second remote completion after an uncertain save.
    Fatal(String),
    /// A remote enrollment attempt failed before a registration was available.
    Retryable(String),
}

impl EnrollmentCriticalError {
    fn message(&self) -> &str {
        match self {
            Self::Fatal(message) | Self::Retryable(message) => message,
        }
    }

    fn into_message(self) -> String {
        match self {
            Self::Fatal(message) | Self::Retryable(message) => message,
        }
    }
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

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct PersistedPublicRelayRegistration {
    schema_version: u32,
    control_url: String,
    relay_id: String,
    broker_room_id: String,
    relay_refresh_token: String,
}

#[cfg(test)]
impl PersistedPublicRelayRegistration {
    pub(crate) fn relay_id(&self) -> &str {
        &self.relay_id
    }
}

impl std::fmt::Debug for PersistedPublicRelayRegistration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PersistedPublicRelayRegistration")
            .field("schema_version", &self.schema_version)
            .field("control_url", &self.control_url)
            .field("relay_id", &self.relay_id)
            .field("broker_room_id", &self.broker_room_id)
            .field("relay_refresh_token", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct PersistedPublicRelayIdentity {
    schema_version: u32,
    control_url: String,
    relay_signing_seed: String,
}

impl std::fmt::Debug for PersistedPublicRelayIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PersistedPublicRelayIdentity")
            .field("schema_version", &self.schema_version)
            .field("control_url", &self.control_url)
            .field("relay_signing_seed", &"<redacted>")
            .finish()
    }
}

#[cfg(test)]
mod identity_debug_tests {
    use super::*;

    #[test]
    fn persisted_identity_debug_redacts_signing_seed() {
        let identity = PersistedPublicRelayIdentity {
            schema_version: 1,
            control_url: "http://127.0.0.1:9".into(),
            relay_signing_seed: "super-secret-seed-bytes".into(),
        };
        let rendered = format!("{identity:?}");
        assert!(!rendered.contains("super-secret-seed-bytes"));
        assert!(rendered.contains("redacted"));
    }
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
        Self::from_env_resolution_with_startup_context(BrokerStartupContext::default()).await
    }

    async fn from_env_resolution_with_startup_context(
        startup_context: BrokerStartupContext,
    ) -> Result<BrokerConfigResolution, String> {
        // Never forward activation env into provider children: consume-or-scrub
        // happens during resolution / enrollment. Removed RELAY_LICENSE_CODE is
        // scrub-only and never accepted as an activation input.
        let resolution = Self::from_parts_resolution_with_startup_context(
            std::env::var("RELAY_BROKER_URL").ok(),
            std::env::var("RELAY_BROKER_PUBLIC_URL").ok(),
            std::env::var(RELAY_BROKER_CONTROL_URL_ENV).ok(),
            std::env::var("RELAY_BROKER_CHANNEL_ID").ok(),
            std::env::var("RELAY_BROKER_PEER_ID").ok(),
            std::env::var(BROKER_AUTH_MODE_ENV).ok(),
            std::env::var(relay_broker::join_ticket::JOIN_TICKET_SECRET_ENV).ok(),
            std::env::var(RELAY_BROKER_RELAY_ID_ENV).ok(),
            std::env::var(RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV).ok(),
            None,
            std::env::var(self::auth::RELAY_BROKER_DEVICE_JOIN_TTL_SECS_ENV).ok(),
            startup_context,
        )
        .await?;
        match resolution {
            BrokerConfigResolution::Ready(mut config) => {
                config
                    .persist_self_hosted_content_key_if_configured()
                    .await?;
                Ok(BrokerConfigResolution::Ready(config))
            }
            other => Ok(other),
        }
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
        state_db: Option<String>,
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
            state_db,
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
        state_db: Option<String>,
        device_join_ttl_secs: Option<String>,
    ) -> Result<BrokerConfigResolution, String> {
        Self::from_parts_resolution_with_startup_context(
            url,
            public_url,
            control_url,
            broker_room_id,
            relay_peer_id,
            auth_mode,
            join_ticket_secret,
            relay_id,
            relay_refresh_token,
            state_db,
            device_join_ttl_secs,
            BrokerStartupContext::default(),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn from_parts_resolution_with_startup_context(
        url: Option<String>,
        public_url: Option<String>,
        control_url: Option<String>,
        broker_room_id: Option<String>,
        relay_peer_id: Option<String>,
        auth_mode: Option<String>,
        join_ticket_secret: Option<String>,
        relay_id: Option<String>,
        relay_refresh_token: Option<String>,
        state_db: Option<String>,
        device_join_ttl_secs: Option<String>,
        startup_context: BrokerStartupContext,
    ) -> Result<BrokerConfigResolution, String> {
        let explicit_cloud_requirement = match &startup_context.cloud_registration {
            CloudRegistrationRequirement::None => false,
            CloudRegistrationRequirement::Required(_) => true,
            CloudRegistrationRequirement::Invalid(error) => {
                scrub_activation_env();
                return Err(error.clone());
            }
        };

        let Some(url) = url.and_then(trimmed_string) else {
            scrub_activation_env();
            if explicit_cloud_requirement {
                return Err(
                    "cloud launch requires RELAY_BROKER_URL; refusing to start without the \
                     preflight-selected broker. Re-run `sealwire cloud`."
                        .to_string(),
                );
            }
            return Ok(BrokerConfigResolution::Disabled);
        };
        let relay_peer_id =
            trimmed_option_string(relay_peer_id).unwrap_or_else(|| "local-relay".to_string());
        let public_url = public_url
            .and_then(trimmed_string)
            .unwrap_or_else(|| url.clone());
        let auth_mode = BrokerAuthMode::parse(auth_mode)?;
        if explicit_cloud_requirement && !matches!(auth_mode, BrokerAuthMode::PublicControlPlane) {
            scrub_activation_env();
            return Err(
                "cloud launch requires public broker auth mode; refusing self-hosted or \
                 mismatched configuration. Re-run `sealwire cloud`."
                    .to_string(),
            );
        }

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
        let state_db = resolve_state_db(&current_dir, state_db);

        let (
            broker_room_id,
            relay_id,
            relay_refresh_token,
            pending_public_enrollment,
            registration_watch,
        ) = match auth_mode {
            BrokerAuthMode::SelfHostedSharedSecret => {
                scrub_activation_env();
                (
                    trimmed_option_string(broker_room_id).ok_or_else(|| {
                        "RELAY_BROKER_CHANNEL_ID is required when RELAY_BROKER_URL is set"
                            .to_string()
                    })?,
                    trimmed_option_string(relay_id),
                    trimmed_option_string(relay_refresh_token),
                    None,
                    None,
                )
            }
            BrokerAuthMode::PublicControlPlane => {
                let control_url_string =
                    trimmed_option_string(control_url.clone()).ok_or_else(|| {
                        format!(
                            "{RELAY_BROKER_CONTROL_URL_ENV} is required in public broker auth mode"
                        )
                    })?;
                let control_url = parse_control_plane_url(&control_url_string)?;
                let (require_cached, expected_cached) = match startup_context.cloud_registration {
                    CloudRegistrationRequirement::None => (false, None),
                    CloudRegistrationRequirement::Required(identity) => (true, Some(identity)),
                    CloudRegistrationRequirement::Invalid(error) => {
                        scrub_activation_env();
                        return Err(error);
                    }
                };

                if let (Some(broker_room_id), Some(relay_id), Some(relay_refresh_token)) = (
                    trimmed_option_string(broker_room_id.clone()),
                    trimmed_option_string(relay_id.clone()),
                    trimmed_option_string(relay_refresh_token.clone()),
                ) {
                    if require_cached {
                        scrub_activation_env();
                        return Err(
                            "cloud launch requires the just-validated registration cache; \
                             env-supplied relay credentials are not accepted for this path"
                                .to_string(),
                        );
                    }
                    scrub_activation_env();
                    (
                        broker_room_id,
                        Some(relay_id),
                        Some(relay_refresh_token),
                        None,
                        None,
                    )
                } else if let Some(cached) =
                    load_public_relay_registration(&state_db, control_url.as_str()).await?
                {
                    if require_cached {
                        let actual = RegistrationIdentity {
                            control_url: control_url.as_str().to_string(),
                            relay_id: cached.relay_id.clone(),
                            broker_room_id: cached.broker_room_id.clone(),
                            bearer_fingerprint: bearer_fingerprint(&cached.relay_refresh_token),
                        };
                        if expected_cached.as_ref() != Some(&actual) {
                            scrub_activation_env();
                            return Err(
                                "cloud registration changed or was replaced after preflight; \
                                 refusing anonymous re-enrollment. Re-run `sealwire cloud`."
                                    .to_string(),
                            );
                        }
                    }
                    if activation_override_env_present() {
                        scrub_activation_env();
                        return Err("already linked; run `sealwire cloud unbind` first".to_string());
                    }
                    scrub_activation_env();
                    let watch = RegistrationWatch {
                        state_db: state_db.clone(),
                        control_url: control_url.as_str().to_string(),
                        relay_id: cached.relay_id.clone(),
                        broker_room_id: cached.broker_room_id.clone(),
                        refresh_fingerprint: refresh_token_fingerprint(&cached.relay_refresh_token),
                    };
                    (
                        cached.broker_room_id,
                        Some(cached.relay_id),
                        Some(cached.relay_refresh_token),
                        None,
                        Some(watch),
                    )
                } else {
                    if require_cached {
                        scrub_activation_env();
                        return Err("cloud registration required but missing after preflight; \
                             refusing anonymous enrollment. Re-run `sealwire cloud`."
                            .to_string());
                    }
                    // Leave activation env for the enrollment loop to consume
                    // (generic `--broker` auto-enroll path only).
                    (
                        String::new(),
                        None,
                        None,
                        Some(PendingPublicEnrollment {
                            control_url,
                            state_db: state_db.clone(),
                        }),
                        None,
                    )
                }
            }
        };

        if let Some(pending) = pending_public_enrollment {
            return Ok(BrokerConfigResolution::PendingPublicEnrollment(pending));
        }

        let signing_key = if matches!(auth_mode, BrokerAuthMode::PublicControlPlane) {
            let control_url_string =
                trimmed_option_string(control_url.clone()).ok_or_else(|| {
                    format!("{RELAY_BROKER_CONTROL_URL_ENV} is required in public broker auth mode")
                })?;
            let parsed = parse_control_plane_url(&control_url_string)?;
            Some(
                load_existing_public_relay_identity(&state_db, parsed.as_str())
                    .await?
                    .signing_key,
            )
        } else {
            None
        };

        let content_signing_key = signing_key
            .clone()
            .unwrap_or_else(generate_content_signing_key);
        let auth = BrokerAuthConfig::from_parts(
            Some(auth_mode.as_str().to_string()),
            join_ticket_secret,
            control_url.clone(),
            relay_id.clone(),
            relay_refresh_token.clone(),
            device_join_ttl_secs,
            signing_key,
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
            content_signing_key,
            registration_watch,
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

    pub(crate) fn content_verify_key(&self) -> String {
        STANDARD.encode(self.content_signing_key.verifying_key().to_bytes())
    }

    pub(crate) fn content_signing_key(&self) -> &SigningKey {
        &self.content_signing_key
    }

    pub(crate) fn pairing_broker(&self) -> crate::state::PairingBroker {
        crate::state::PairingBroker {
            broker_url: self.public_base_url.clone(),
            broker_room_id: self.broker_room_id.clone(),
            relay_peer_id: self.relay_peer_id.clone(),
            relay_verify_key: self.content_verify_key(),
        }
    }

    async fn persist_self_hosted_content_key_if_configured(&mut self) -> Result<(), String> {
        if self.auth.relay_identity_key().is_some() {
            return Ok(());
        }
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let db = crate::state_paths::state_db_path(&cwd);
        self.content_signing_key = load_or_create_relay_content_identity(&db).await?;
        Ok(())
    }

    pub(crate) async fn relay_connect_url(&self) -> Result<Url, String> {
        let credential = self
            .auth
            .relay_connect_credential(
                &self.broker_room_id,
                &self.relay_peer_id,
                &self.content_verify_key(),
            )
            .await?;
        let mut url = self.url.clone();
        url.query_pairs_mut()
            .clear()
            .append_pair("peer_id", &self.relay_peer_id)
            .append_pair("role", "relay")
            .append_pair("client_version", product_version())
            .append_pair("join_ticket", &credential.token);
        Ok(url)
    }
}

pub async fn spawn_broker_task(
    state: AppState,
    startup_context: BrokerStartupContext,
) -> Result<(), String> {
    let resolution =
        BrokerConfig::from_env_resolution_with_startup_context(startup_context).await?;
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
        broker_state.set_broker_channel(&config).await;
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
        if registration_watch_diverged(&config).await {
            info!(
                broker_room_id = config.broker_room_id(),
                peer_id = config.relay_peer_id(),
                "public broker registration cache removed or replaced; stopping broker loop"
            );
            state
                .push_runtime_log(
                    "info",
                    "Broker registration cache was removed or replaced; stopping cloud reconnects."
                        .to_string(),
                )
                .await;
            state.set_broker_connection(false).await;
            return;
        }

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

        if registration_watch_diverged(&config).await {
            info!(
                broker_room_id = config.broker_room_id(),
                peer_id = config.relay_peer_id(),
                "public broker registration cache removed or replaced after disconnect; stopping broker loop"
            );
            state
                .push_runtime_log(
                    "info",
                    "Broker registration cache was removed or replaced; stopping cloud reconnects."
                        .to_string(),
                )
                .await;
            return;
        }

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

async fn registration_watch_diverged(config: &BrokerConfig) -> bool {
    let Some(watch) = config.registration_watch.as_ref() else {
        return false;
    };
    match load_public_relay_registration(&watch.state_db, &watch.control_url).await {
        Ok(Some(cached)) => {
            cached.relay_id != watch.relay_id
                || cached.broker_room_id != watch.broker_room_id
                || refresh_token_fingerprint(&cached.relay_refresh_token)
                    != watch.refresh_fingerprint
        }
        Ok(None) => true,
        Err(error) => {
            warn!(
                state_db = %watch.state_db.display(),
                error = %error,
                "failed to read broker registration cache while checking reconnect; treating as diverged"
            );
            true
        }
    }
}

fn refresh_token_fingerprint(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        .chars()
        .take(16)
        .collect()
}

async fn run_public_broker_enrollment_loop(state: AppState, pending: PendingPublicEnrollment) {
    // Explicit cloud activation belongs only in `cloud-activate` preflight.
    // Generic public `--broker` auto-enrolls with no access key (open brokers).
    // Never honor ambient RELAY_CLOUD_ACTIVATION here.
    scrub_all_cloud_activation_env_for_normal_start();
    let client = match build_control_plane_client() {
        Ok(client) => client,
        Err(error) => {
            state
                .push_runtime_log(
                    "error",
                    format!("Failed to build broker control client: {error}"),
                )
                .await;
            return;
        }
    };
    let mut retry_backoff = RetryBackoff::new(
        Duration::from_secs(PUBLIC_RELAY_AUTH_REQUEST_RETRY_SECS),
        Duration::from_secs(BROKER_RECONNECT_MAX_DELAY_SECS),
    );
    loop {
        match enroll_public_relay_if_absent(&pending, || {
            request_public_relay_enrollment(&client, &pending, None)
        })
        .await
        {
            Ok(locked) => {
                let registration = locked.registration.clone();
                let disposition = locked.disposition;
                // Reload while the same lifecycle lock is still held. A
                // concurrently completed cloud activation is therefore used
                // exactly; generic enrollment neither completes again nor
                // overwrites it.
                let config_result = BrokerConfig::from_env().await;
                drop(locked);
                match config_result {
                    Ok(Some(config)) => {
                        let change_rx = state.subscribe();
                        state.set_broker_channel(&config).await;
                        state
                            .push_runtime_log(
                                "info",
                                format!(
                                    "Public broker registration {} for room {}.",
                                    match disposition {
                                        EnrollmentDisposition::Existing => "became available",
                                        EnrollmentDisposition::Enrolled => "completed",
                                    },
                                    config.broker_room_id(),
                                ),
                            )
                            .await;
                        run_broker_loop(state.clone(), change_rx, config).await;
                        return;
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
                        return;
                    }
                }
            }
            Err(error) => {
                let fatal = matches!(error, EnrollmentCriticalError::Fatal(_));
                state
                    .push_runtime_log(
                        "warn",
                        format!(
                            "Automatic public broker enrollment failed: {}",
                            error.message()
                        ),
                    )
                    .await;
                if fatal {
                    return;
                }
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

/// Short-lived preflight used by `sealwire cloud` before starting the long-lived
/// relay. Consumes the access key here so the long-lived child never sees it.
pub async fn run_cloud_activate() -> i32 {
    run_cloud_activate_core(true).await
}

/// Test/production core for cloud activation. `allow_tty=false` forces the
/// non-interactive missing-key failure path used by CI and scripted callers.
pub(crate) async fn run_cloud_activate_core(allow_tty: bool) -> i32 {
    if !cloud_activation_required() {
        eprintln!(
            "sealwire: cloud-activate requires {CLOUD_ACTIVATION_ENV}=1 (set by `sealwire cloud`)"
        );
        scrub_activation_env();
        return 2;
    }

    let control_url_raw = match std::env::var(RELAY_BROKER_CONTROL_URL_ENV)
        .ok()
        .and_then(trimmed_string)
    {
        Some(url) => url,
        None => {
            eprintln!("sealwire: cloud activation requires {RELAY_BROKER_CONTROL_URL_ENV}");
            scrub_activation_env();
            return 1;
        }
    };
    let control_url = match parse_control_plane_url(&control_url_raw) {
        Ok(url) => url,
        Err(error) => {
            eprintln!("sealwire: cloud activation failed: {error}");
            scrub_activation_env();
            return 1;
        }
    };
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("sealwire: cloud activation failed: {error}");
            scrub_activation_env();
            return 1;
        }
    };
    let state_db = match crate::state::checked_state_db_path(&cwd) {
        Ok(state_db) => state_db,
        Err(error) => {
            eprintln!("sealwire: cloud activation failed: {error}");
            scrub_activation_env();
            return 1;
        }
    };
    let pending = PendingPublicEnrollment {
        control_url,
        state_db,
    };
    let activation_override = activation_override_env_present();
    let result = enroll_public_relay_if_absent(&pending, || async {
        let client = build_control_plane_client()?;
        let secret = match resolve_activation_credential(allow_tty)? {
            Some((secret, source)) => {
                eprintln!("sealwire: activating SealWire Cloud access ({source:?})…");
                secret
            }
            None => {
                return Err(format!(
                    "SealWire Cloud enrollment requires a Cloud access key. \
                     Set {CLOUD_ACCESS_KEY_ENV} or {CLOUD_ACCESS_KEY_FILE_ENV}, \
                     or run interactively in a TTY."
                ));
            }
        };
        request_public_relay_enrollment(&client, &pending, Some(secret.as_str())).await
    })
    .await;

    match result {
        Ok(locked) if locked.disposition == EnrollmentDisposition::Existing => {
            if activation_override {
                // Consume/unlink only a regular one-shot entry so it cannot
                // linger forever; discard never opens or overwrites its target.
                discard_oneshot_activation_file_input();
                scrub_activation_env();
                eprintln!("sealwire: already linked; run `sealwire cloud unbind` first");
                return 1;
            }
            let registration = &locked.registration;
            let identity = RegistrationIdentity {
                control_url: pending.control_url.as_str().to_string(),
                relay_id: registration.relay_id.clone(),
                broker_room_id: registration.broker_room_id.clone(),
                bearer_fingerprint: bearer_fingerprint(&registration.relay_refresh_token),
            };
            scrub_activation_env();
            eprintln!("sealwire: already linked to SealWire Cloud for this control origin.");
            emit_cloud_launch_witness(&identity);
            0
        }
        Ok(locked) => {
            let registration = &locked.registration;
            let identity = RegistrationIdentity {
                control_url: pending.control_url.as_str().to_string(),
                relay_id: registration.relay_id.clone(),
                broker_room_id: registration.broker_room_id.clone(),
                bearer_fingerprint: bearer_fingerprint(&registration.relay_refresh_token),
            };
            eprintln!(
                "sealwire: cloud access linked (relay {}). Starting local relay…",
                registration.relay_id
            );
            scrub_activation_env();
            emit_cloud_launch_witness(&identity);
            0
        }
        Err(error) => {
            scrub_activation_env();
            eprintln!("sealwire: cloud activation failed: {}", error.message());
            1
        }
    }
}

async fn perform_public_relay_enrollment(
    client: &reqwest::Client,
    pending: &PendingPublicEnrollment,
    enrollment_token: Option<&str>,
) -> Result<PublicRelayRegistration, String> {
    let locked = enroll_public_relay_if_absent(pending, || {
        request_public_relay_enrollment(client, pending, enrollment_token)
    })
    .await
    .map_err(EnrollmentCriticalError::into_message)?;
    Ok(locked.registration.clone())
}

async fn request_public_relay_enrollment(
    client: &reqwest::Client,
    pending: &PendingPublicEnrollment,
    enrollment_token: Option<&str>,
) -> Result<PublicRelayRegistration, String> {
    let identity =
        load_or_create_public_relay_identity(&pending.state_db, pending.control_url.as_str())
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
    complete_public_relay_enrollment(
        client,
        &pending.control_url,
        verify_key_b64,
        challenge.challenge_id,
        challenge_signature,
        None,
        enrollment_token,
    )
    .await
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
    let content = std::sync::Arc::new(RelayContentCrypto::new(
        config.content_signing_key().clone(),
        config.relay_peer_id().to_string(),
        config.broker_room_id().to_string(),
    ));
    run_broker_session_scoped(state, change_rx, config, liveness, content).await
}

async fn run_broker_session_scoped(
    state: &AppState,
    change_rx: &mut watch::Receiver<u64>,
    config: &BrokerConfig,
    liveness: BrokerLivenessConfig,
    content: std::sync::Arc<RelayContentCrypto>,
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
    let (writer, mut writer_error, _writer_guard) =
        spawn_broker_writer(sink, state.clone(), content);

    let first = receiver
        .next()
        .await
        .ok_or_else(|| BrokerSessionError::before_connected("broker closed before welcome"))?
        .map_err(|error| {
            BrokerSessionError::before_connected(format!("broker welcome read failed: {error}"))
        })?;
    let welcome = match decode_server_frame(first).map_err(BrokerSessionError::before_connected)? {
        Some(ServerMessage::RelayJoinChallenge {
            challenge_id,
            challenge,
            broker_origin,
            relay_id,
            broker_room_id,
            relay_peer_id,
            ticket_sha256,
            relay_verify_key,
        }) => {
            if relay_verify_key != config.content_verify_key() {
                return Err(BrokerSessionError::before_connected(
                    "broker join challenge names a different relay identity".to_string(),
                ));
            }
            let signing_key = config.content_signing_key();
            let message = relay_join_message(
                &broker_origin,
                &challenge_id,
                &challenge,
                &ticket_sha256,
                &relay_id,
                &broker_room_id,
                &relay_peer_id,
            )
            .map_err(BrokerSessionError::before_connected)?;
            if broker_room_id != config.broker_room_id() || relay_peer_id != config.relay_peer_id()
            {
                return Err(BrokerSessionError::before_connected(
                    "broker join challenge does not match this relay".to_string(),
                ));
            }
            let signature = STANDARD.encode(signing_key.sign(&message).to_bytes());
            let proof = serde_json::to_string(&ClientMessage::RelayJoinProof {
                challenge_id,
                signature,
            })
            .map_err(|error| {
                BrokerSessionError::before_connected(format!(
                    "failed to encode relay join proof: {error}"
                ))
            })?;
            writer
                .send_now(tokio_tungstenite::tungstenite::Message::Text(proof))
                .await
                .map_err(BrokerSessionError::before_connected)?;
            let next = receiver
                .next()
                .await
                .ok_or_else(|| {
                    BrokerSessionError::before_connected("broker closed before welcome")
                })?
                .map_err(|error| {
                    BrokerSessionError::before_connected(format!(
                        "broker welcome read failed: {error}"
                    ))
                })?;
            decode_server_frame(next).map_err(BrokerSessionError::before_connected)?
        }
        other => other,
    };
    match welcome {
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

    // Handling runs on its own task, in order. The receive arm used to await it, so one
    // slow action — a cold provider catalog is minutes — stopped the relay reading
    // anything at all, from any device, including its own heartbeat.
    let (inbound_tx, mut inbound_rx) =
        tokio::sync::mpsc::channel::<(u64, ServerMessage)>(INBOUND_MESSAGE_QUEUE_CAPACITY);
    let (handler_error_tx, mut handler_error) = tokio::sync::mpsc::channel::<String>(1);
    let handler_state = state.clone();
    let handler_writer = writer.clone();
    // Aborted on every exit path, like the writer. Frames still sitting in this queue
    // belong to a connection that has ended: applying a buffered arrival afterwards would
    // mark a surface present again that the disconnect has just recorded as gone, and the
    // client resends what it was waiting on anyway. Surfaces already dispatched keep
    // draining — their work was accepted.
    let _handler_task = AbortOnDrop(tokio::spawn(async move {
        // A queue and a worker per surface. Order comes from the queue, not from when a
        // task happens to be polled: two phones must not wait on each other, but one
        // phone's claim has to land before the action that presents it.
        let mut surfaces: std::collections::HashMap<
            String,
            tokio::sync::mpsc::Sender<(FrameOrigin, ServerMessage)>,
        > = std::collections::HashMap::new();
        while let Some((ingress, message)) = inbound_rx.recv().await {
            let key = message_ordering_key(&message);
            // Read before the frame is handled, so a departure landing afterwards leaves
            // everything already admitted holding the lease it was admitted under.
            let lease = if key.is_empty() {
                0
            } else {
                handler_state
                    .current_surface_lease(&key)
                    .await
                    .unwrap_or_default()
            };
            let origin = FrameOrigin { ingress, lease };
            let departing = matches!(
                &message,
                ServerMessage::Presence {
                    kind: PresenceKind::Left,
                    ..
                }
            );
            // Presence is handled here, in arrival order, because a departure that waits
            // behind its own surface's slow frame leaves the relay addressing a phone that
            // has gone — and an arrival applied out of order would undo one.
            if is_surface_presence(&message) {
                if let Err(error) =
                    handle_server_message(&handler_state, &handler_writer, origin, message).await
                {
                    let _ = handler_error_tx.try_send(error);
                    return;
                }
                if departing {
                    surfaces.remove(&key);
                }
                continue;
            }
            let sender = surfaces.entry(key.clone()).or_insert_with(|| {
                let (tx, mut rx) = tokio::sync::mpsc::channel::<(FrameOrigin, ServerMessage)>(
                    SURFACE_MESSAGE_QUEUE_CAPACITY,
                );
                let state = handler_state.clone();
                let writer = handler_writer.clone();
                let report = handler_error_tx.clone();
                tokio::spawn(async move {
                    while let Some((origin, message)) = rx.recv().await {
                        let message_name = server_message_name(&message);
                        let started_at = Instant::now();
                        // A handler that panics would otherwise take this surface's queue
                        // with it and report nothing, leaving the socket looking healthy.
                        let handled =
                            futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(
                                handle_server_message(&state, &writer, origin, message),
                            ))
                            .await;
                        match handled {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => {
                                let _ = report.try_send(error);
                                return;
                            }
                            Err(_) => {
                                let _ = report.try_send(format!(
                                    "broker message handler panicked on {message_name}"
                                ));
                                return;
                            }
                        }
                        let elapsed_ms = started_at.elapsed().as_millis();
                        if elapsed_ms >= BROKER_MESSAGE_HANDLER_SLOW_WARN_MILLIS {
                            warn!(
                                message = message_name,
                                elapsed_ms, "broker message handler was slow"
                            );
                        }
                    }
                });
                tx
            });
            // A frame with nowhere to go is a Stop or an approval the user pressed and
            // nothing ever ran: `frontend/remote/actions.js` retries only session-claim
            // failures. Ending the session is what makes the phone resend, so shedding is
            // the lossy option here, not the gentle one.
            //
            // Resend covers actions that WAIT for a reply, plus the watch declaration the
            // relay-left handler re-arms. A fire-and-forget action whose reply nobody
            // keeps — push registration is the one that matters — is still lost, and the
            // phone still believes it succeeded. Narrow, because that frame has to be the
            // one that overflows, but real.
            if let Err(error) = sender.try_send((origin, message)) {
                let _ = handler_error_tx.try_send(match error {
                    tokio::sync::mpsc::error::TrySendError::Full(_) => {
                        format!("broker surface {key} fell too far behind to keep its frames")
                    }
                    tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                        format!("broker surface {key} stopped handling frames")
                    }
                });
                return;
            }
            // Its worker drains what is queued and then stops, which is also what keeps
            // this map from growing for the length of the session.
            if departing {
                surfaces.remove(&key);
            }
        }
    }));

    loop {
        tokio::select! {
            // A handler error still ends the session; it just arrives here now rather
            // than as the return value of the arm that read the socket.
            handler_failed = handler_error.recv() => {
                let error = handler_failed
                    .unwrap_or_else(|| "broker message handler stopped".to_string());
                return Err(BrokerSessionError::after_connected(error, connected_at));
            }
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
                    // Handed over rather than awaited. A full queue means the handler is
                    // that far behind, which is a session to end, not a frame to drop.
                    if inbound_tx
                        .try_send((crate::state::next_relay_ingress(), message))
                        .is_err()
                    {
                        return Err(BrokerSessionError::after_connected(
                            "broker inbound queue overflowed".to_string(),
                            connected_at,
                        ));
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

/// Which frames must stay in order with each other: a surface's own, keyed by it.
/// Everything else shares one key, which keeps the session's own frames ordered without
/// putting them behind any surface.
/// A surface announcing it arrived or went. The relay's own bookkeeping, and the reason
/// the per-surface queues exist to be overtaken.
fn is_surface_presence(message: &ServerMessage) -> bool {
    matches!(
        message,
        ServerMessage::Presence { peer, .. } if peer.role == PeerRole::Surface
    )
}

/// Ends a task when the session that owns it does.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What the relay knew about a frame as it came off the socket: where it sat in the
/// order, and which surface lease admitted it.
///
/// `lease` is `0` when the sender held no lease at all as this was admitted — which in
/// practice means a connection that has already gone, since every surface takes a lease
/// from the welcome that lists it. Zero matches no live lease, so such a frame is stale
/// by the same comparison as any other.
#[derive(Clone, Copy)]
pub(super) struct FrameOrigin {
    pub(super) ingress: u64,
    pub(super) lease: u64,
}

fn message_ordering_key(message: &ServerMessage) -> String {
    match message {
        ServerMessage::Message { from_peer_id, .. } => from_peer_id.clone(),
        ServerMessage::Presence { peer, .. } => peer.peer_id.clone(),
        _ => String::new(),
    }
}

async fn handle_server_message(
    state: &AppState,
    writer: &BrokerWriter,
    origin: FrameOrigin,
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
                if matches!(kind, PresenceKind::Left) {
                    writer.forget_content_peer(&peer.peer_id);
                }
                state
                    .update_surface_presence(&peer.peer_id, matches!(kind, PresenceKind::Joined))
                    .await;
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
            if payload.get("kind").and_then(serde_json::Value::as_str) == Some("relay_hello") {
                if let Err(error) = handle_relay_hello(state, writer, &from_peer_id, &payload).await
                {
                    warn!(from_peer_id, %error, "relay hello was not answered");
                }
                return Ok(());
            }
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
                Some(InboundBrokerPayload::EncryptedRemoteAction {
                    action_id,
                    device_id,
                    action,
                    request_sid,
                    request_boot,
                    request_seq,
                    request_time,
                    op_boot,
                    op_t0,
                    request_signature,
                    envelope,
                }) => {
                    let signed = remote_actions::signed_attempt_from_parts(
                        action,
                        request_sid,
                        request_boot,
                        request_seq,
                        request_time,
                        op_boot,
                        op_t0,
                        request_signature,
                    );
                    handle_encrypted_remote_action(
                        state,
                        writer,
                        origin,
                        from_peer_id,
                        action_id,
                        device_id,
                        signed,
                        envelope,
                    )
                    .await
                }
                None => Ok(()),
            };

            // A malformed surface request must not disconnect every other device.
            if let Err(error) = outcome {
                warn!(
                    from_peer_id = from_peer_id_for_log,
                    %error,
                    "a surface's message failed; answering nothing and keeping the session"
                );
            }
            Ok(())
        }
        ServerMessage::RelayJoinChallenge { .. } => {
            Err("broker repeated a relay join challenge after the socket was seated".to_string())
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
    // A replaced QR's Cloud join ticket still works, so answer instead of going silent.
    if let Some(result) = state
        .retired_pairing_result(&pairing_id, &from_peer_id)
        .await
    {
        publish_pairing_result(writer, result).await?;
        state
            .push_runtime_log(
                "info",
                format!("Told broker peer {from_peer_id} that pairing {pairing_id} was replaced."),
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
            if let Some(refusal) = state
                .taken_pairing_refusal(
                    &pairing_id,
                    &pairing_request.device_verify_key,
                    &from_peer_id,
                )
                .await
            {
                publish_pairing_result(writer, refusal).await?;
            }
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
    let device_verify_key = pairing_request.device_verify_key.clone();
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
            if let Some(refusal) = state
                .taken_pairing_refusal(&pairing_id, &device_verify_key, &from_peer_id)
                .await
            {
                publish_pairing_result(writer, refusal).await?;
            }
            Ok(())
        }
    }
}

fn server_message_name(message: &ServerMessage) -> &'static str {
    match message {
        ServerMessage::RelayJoinChallenge { .. } => "relay_join_challenge",
        ServerMessage::Welcome { .. } => "welcome",
        ServerMessage::Presence { .. } => "presence",
        ServerMessage::Message { .. } => "message",
        ServerMessage::Error { .. } => "error",
    }
}

async fn publish_snapshot(writer: &BrokerWriter, state: &AppState) -> Result<(), String> {
    // Presence alone grants no content access; only peers bound by device proof are targets.
    let targets = state.broker_targets().await;
    if targets.is_empty() {
        debug!("no live paired surface; skipping broker session snapshot");
        return Ok(());
    }
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
        delivery_mode = "e2ee_targeted",
        "publishing broker session snapshot"
    );
    let target_summary = targets
        .iter()
        .map(|target| format!("{}:{}", target.device_id, target.peer_id))
        .collect::<Vec<_>>()
        .join(",");
    info!(
        scope = "session_snapshot",
        target_count = targets.len(),
        targets = %target_summary,
        delivery_mode = "e2ee_targeted",
        "resolved encrypted broker surface targets"
    );
    let mut messages = Vec::new();
    for target in targets {
        let Some(scoped) = state
            .snapshot_for_secret(&compacted, &target.device_id, &target.payload_secret)
            .await
        else {
            continue;
        };
        let envelope = encrypt_json(
            &target.payload_secret,
            scoped.as_ref().unwrap_or(&compacted),
        )?;
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

/// Kept in queue order: a resync overtaken by the deltas behind it would look stale and
/// be skipped.
#[derive(Clone, Debug)]
enum PendingTranscriptPublish {
    Delta(PendingTranscriptDelta),
    Resync(TranscriptResyncEvent),
}

async fn publish_pending_broker_messages(
    writer: &BrokerWriter,
    state: &AppState,
) -> Result<(), String> {
    let frames = drain_pending_broker_messages_for_publish(writer, state).await?;
    for frame in coalesce_transcript_deltas(frames) {
        publish_transcript_frame(writer, state, frame).await?;
    }
    Ok(())
}

async fn publish_transcript_frame(
    writer: &BrokerWriter,
    state: &AppState,
    frame: PendingTranscriptPublish,
) -> Result<(), String> {
    match frame {
        PendingTranscriptPublish::Delta(delta) => {
            publish_transcript_delta(writer, state, delta).await
        }
        PendingTranscriptPublish::Resync(resync) => {
            publish_transcript_resync(writer, state, resync).await
        }
    }
}

async fn drain_pending_broker_messages_for_publish(
    writer: &BrokerWriter,
    state: &AppState,
) -> Result<Vec<PendingTranscriptPublish>, String> {
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
            BrokerPendingMessage::TranscriptDelta(delta) => {
                transcript_deltas.push(PendingTranscriptPublish::Delta(delta));
            }
            BrokerPendingMessage::TranscriptResync(resync) => {
                transcript_deltas.push(PendingTranscriptPublish::Resync(resync));
            }
        }
    }
    Ok(transcript_deltas)
}

async fn publish_transcript_delta_batch(
    writer: &BrokerWriter,
    state: &AppState,
    deltas: Vec<PendingTranscriptPublish>,
) -> Result<Vec<PendingTranscriptPublish>, String> {
    const MAX_DELTAS_PER_DRAIN: usize = 50;
    let mut deltas = coalesce_transcript_deltas(deltas);
    let remaining = if deltas.len() > MAX_DELTAS_PER_DRAIN {
        deltas.split_off(MAX_DELTAS_PER_DRAIN)
    } else {
        Vec::new()
    };

    let mut delta_count = 0;
    for frame in deltas {
        publish_transcript_frame(writer, state, frame).await?;
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
    pending_transcript_deltas: &mut Vec<PendingTranscriptPublish>,
) -> Result<(), String> {
    let mut deltas = std::mem::take(pending_transcript_deltas);
    while !deltas.is_empty() {
        deltas = publish_transcript_delta_batch(writer, state, deltas).await?;
    }
    Ok(())
}

/// Merges runs of deltas to one row; a resync stays where it was queued.
fn coalesce_transcript_deltas(
    frames: Vec<PendingTranscriptPublish>,
) -> Vec<PendingTranscriptPublish> {
    let mut coalesced: Vec<PendingTranscriptPublish> = Vec::new();
    for frame in frames {
        if let (
            Some(PendingTranscriptPublish::Delta(last)),
            PendingTranscriptPublish::Delta(delta),
        ) = (coalesced.last_mut(), &frame)
        {
            if can_merge_transcript_delta(last, delta) {
                last.delta.push_str(&delta.delta);
                last.revision = delta.revision;
                last.entry_seq = delta.entry_seq;
                // Same item (can_merge), so order_seq is identical by contract.
                last.server_time = delta.server_time;
                continue;
            }
        }
        coalesced.push(frame);
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

// Encrypt per device and address only the peers currently watching this thread.
fn build_transcript_delta_messages(
    targets: Vec<BrokerTarget>,
    delta: &PendingTranscriptDelta,
) -> Result<Vec<TargetedBrokerMessage>, String> {
    let kind = match delta.kind {
        TranscriptDeltaKind::AgentText => "agent_text",
        TranscriptDeltaKind::CommandOutput => "command_output",
    };

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
        delivery_mode = "e2ee_targeted",
        "resolved broker surface targets"
    );

    let messages = build_transcript_delta_messages(targets, &delta)?;
    publish_targeted_messages(writer, messages).await?;

    Ok(())
}

async fn publish_transcript_resync(
    writer: &BrokerWriter,
    state: &AppState,
    resync: TranscriptResyncEvent,
) -> Result<(), String> {
    let targets = state.broker_targets_for_thread(&resync.thread_id).await;
    if targets.is_empty() {
        return Ok(());
    }
    info!(
        scope = "transcript_resync",
        target_count = targets.len(),
        thread_id = %resync.thread_id,
        revision = resync.revision,
        reason = ?resync.reason,
        "resolved broker surface targets"
    );
    let messages = build_transcript_resync_messages(targets, &resync)?;
    publish_targeted_messages(writer, messages).await
}

/// Addressed exactly like a delta: one frame per peer watching the thread, sealed per
/// device.
fn build_transcript_resync_messages(
    targets: Vec<BrokerTarget>,
    resync: &TranscriptResyncEvent,
) -> Result<Vec<TargetedBrokerMessage>, String> {
    targets
        .into_iter()
        .map(|target| {
            let payload = OutboundBrokerPayload::EncryptedTranscriptEvent {
                target_peer_id: target.peer_id.clone(),
                device_id: target.device_id.clone(),
                envelope: encrypt_json(&target.payload_secret, resync)?,
            };
            Ok(TargetedBrokerMessage {
                target_peer_id: target.peer_id,
                payload: Box::new(payload),
            })
        })
        .collect()
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

async fn handle_relay_hello(
    _state: &AppState,
    writer: &BrokerWriter,
    from_peer_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let version = payload
        .get("protocol_version")
        .and_then(serde_json::Value::as_u64);
    if version != Some(RELAY_PROTOCOL_VERSION) {
        return Err("relay hello protocol was rejected".to_string());
    }
    let hello_nonce = payload
        .get("hello_nonce")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if !(16..=128).contains(&hello_nonce.len())
        || !hello_nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("relay hello nonce was rejected".to_string());
    }
    let device_id = payload
        .get("device_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    writer.open_content_session(from_peer_id)?;
    let mut payload = serde_json::json!({
        "kind": "relay_hello_proof",
        "target_peer_id": from_peer_id,
        "device_id": device_id,
        "hello_nonce": hello_nonce,
    });
    protocol::add_relay_payload_protocol_version(&mut payload);
    writer.bind_content_epochs(&mut payload);
    writer
        .send_now(Message::Text(protocol::publish_frame_text(&payload)))
        .await
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
    let mut payload_value =
        serde_json::to_value(&payload).expect("broker payload should serialize");
    protocol::add_relay_payload_protocol_version(&mut payload_value);
    writer.bind_content_epochs(&mut payload_value);
    let frame_bytes = reserved_publish_frame_len(&payload_value);
    let frame_text = protocol::publish_frame_text(&payload_value);
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
fn frame_message_for_payload(writer: &BrokerWriter, payload: &OutboundBrokerPayload) -> Message {
    let mut payload_value = serde_json::to_value(payload).expect("broker payload should serialize");
    protocol::add_relay_payload_protocol_version(&mut payload_value);
    writer.bind_content_epochs(&mut payload_value);
    Message::Text(protocol::publish_frame_text(&payload_value))
}

async fn publish_targeted_messages(
    writer: &BrokerWriter,
    messages: Vec<TargetedBrokerMessage>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }

    let mut batch: Vec<TargetedBrokerMessage> = Vec::new();
    for message in messages {
        let mut candidate = batch.clone();
        candidate.push(message.clone());
        let candidate_payload = OutboundBrokerPayload::TargetedMessages {
            messages: candidate,
        };
        if !batch.is_empty()
            && (batch.len() >= MAX_TARGETED_MESSAGES_PER_PUBLISH
                || batch
                    .iter()
                    .any(|queued| queued.target_peer_id == message.target_peer_id)
                || frame_bytes_for_payload(&candidate_payload) > MAX_BROKER_TEXT_FRAME_BYTES)
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

/// The database holding this relay's broker identity: an explicit path (tests) or the
/// relay's own state database, so the identity always moves together with the relay.
fn resolve_state_db(cwd: &Path, configured: Option<String>) -> PathBuf {
    match configured.and_then(trimmed_string) {
        Some(explicit) => cwd.join(explicit),
        None => crate::state_paths::state_db_path(cwd),
    }
}

#[derive(Deserialize, Serialize)]
struct StoredRegistrationInfo {
    schema_version: u32,
    control_url: String,
    relay_id: String,
    broker_room_id: String,
}

pub(crate) fn load_public_relay_registration_raw(
    db: &Path,
    control_url: &str,
) -> Result<Option<PersistedPublicRelayRegistration>, String> {
    let Some(stored) = stored_credentials::read_for_origin(
        db,
        stored_credentials::PUBLIC_REGISTRATION,
        control_url,
    )
    .map_err(|error| {
        format!(
            "failed to read broker registration in {}: {error}",
            db.display()
        )
    })?
    else {
        return Ok(None);
    };
    let info: StoredRegistrationInfo = serde_json::from_str(stored.info.as_deref().unwrap_or(""))
        .map_err(|error| {
        format!(
            "failed to decode broker registration in {}: {error}",
            db.display()
        )
    })?;
    Ok(Some(PersistedPublicRelayRegistration {
        schema_version: info.schema_version,
        control_url: info.control_url,
        relay_id: info.relay_id,
        broker_room_id: info.broker_room_id,
        relay_refresh_token: stored.secret,
    }))
}

fn load_matching_registration_for_enrollment(
    pending: &PendingPublicEnrollment,
) -> Result<Option<PublicRelayRegistration>, String> {
    let Some(persisted) =
        load_public_relay_registration_raw(&pending.state_db, pending.control_url.as_str())?
    else {
        return Ok(None);
    };
    if persisted.schema_version != PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION {
        return Err(format!(
            "unsupported broker registration cache schema {} in {}",
            persisted.schema_version,
            pending.state_db.display()
        ));
    }
    if persisted.relay_id.trim().is_empty()
        || persisted.broker_room_id.trim().is_empty()
        || persisted.relay_refresh_token.trim().is_empty()
    {
        return Err(format!(
            "broker registration cache {} is incomplete; refusing to overwrite it",
            pending.state_db.display()
        ));
    }
    Ok(Some(PublicRelayRegistration {
        relay_id: persisted.relay_id,
        broker_room_id: persisted.broker_room_id,
        relay_refresh_token: persisted.relay_refresh_token,
    }))
}

/// Production critical section shared by generic enrollment and explicit cloud
/// activation. It re-reads the cache only after obtaining the lifecycle lock,
/// calls the remote enrollment operation only when still absent, and retains
/// the lock through the atomic save and caller handoff.
async fn enroll_public_relay_if_absent<F, Fut>(
    pending: &PendingPublicEnrollment,
    enroll_missing: F,
) -> Result<LockedPublicRelayRegistration, EnrollmentCriticalError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<PublicRelayRegistration, String>>,
{
    enroll_public_relay_if_absent_after_acquire(pending, enroll_missing, || {}).await
}

/// Same as [`enroll_public_relay_if_absent`], with a test-only hook invoked
/// immediately after the lifecycle lock is held and before any registration
/// read or remote enrollment. Production callers pass a no-op.
async fn enroll_public_relay_if_absent_after_acquire<F, Fut, H>(
    pending: &PendingPublicEnrollment,
    enroll_missing: F,
    after_acquire: H,
) -> Result<LockedPublicRelayRegistration, EnrollmentCriticalError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<PublicRelayRegistration, String>>,
    H: FnOnce(),
{
    let lifecycle = BrokerLifecycleLock::acquire_for_registration(&pending.state_db)
        .map_err(EnrollmentCriticalError::Fatal)?;
    after_acquire();
    if let Some(registration) = load_matching_registration_for_enrollment(pending)
        .map_err(EnrollmentCriticalError::Fatal)?
    {
        return Ok(LockedPublicRelayRegistration {
            registration,
            disposition: EnrollmentDisposition::Existing,
            lifecycle,
        });
    }

    let registration = enroll_missing()
        .await
        .map_err(EnrollmentCriticalError::Retryable)?;
    save_public_relay_registration(
        &pending.state_db,
        pending.control_url.as_str(),
        &registration,
    )
    .await
    .map_err(EnrollmentCriticalError::Fatal)?;
    Ok(LockedPublicRelayRegistration {
        registration,
        disposition: EnrollmentDisposition::Enrolled,
        lifecycle,
    })
}

async fn load_public_relay_registration(
    db: &Path,
    expected_control_url: &str,
) -> Result<Option<PublicRelayRegistration>, String> {
    let Some(persisted) = load_public_relay_registration_raw(db, expected_control_url)? else {
        return Ok(None);
    };
    if persisted.schema_version != PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION {
        return Err(format!(
            "unsupported broker registration cache schema {} in {}",
            persisted.schema_version,
            db.display()
        ));
    }

    Ok(Some(PublicRelayRegistration {
        relay_id: persisted.relay_id,
        broker_room_id: persisted.broker_room_id,
        relay_refresh_token: persisted.relay_refresh_token,
    }))
}

async fn save_public_relay_registration(
    db: &Path,
    control_url: &str,
    registration: &PublicRelayRegistration,
) -> Result<(), String> {
    let info = serde_json::to_string(&StoredRegistrationInfo {
        schema_version: PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION,
        control_url: control_url.to_string(),
        relay_id: registration.relay_id.clone(),
        broker_room_id: registration.broker_room_id.clone(),
    })
    .map_err(|error| format!("failed to encode broker registration: {error}"))?;
    stored_credentials::write_for_origin(
        db,
        stored_credentials::PUBLIC_REGISTRATION,
        control_url,
        &registration.relay_refresh_token,
        &info,
    )
    .map_err(|error| {
        format!(
            "failed to save broker registration in {}: {error}",
            db.display()
        )
    })
}

#[derive(Deserialize, Serialize)]
struct StoredIdentityInfo {
    schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    control_url: Option<String>,
}

const RELAY_CONTENT_IDENTITY_SCHEMA_VERSION: u32 = 1;

/// The self-hosted relay's content key. Created once; never replaced, because the
/// phones paired with it pinned its public half.
async fn load_or_create_relay_content_identity(db: &Path) -> Result<SigningKey, String> {
    let unusable = |reason: &str| {
        format!(
            "relay content identity in {} {reason}; refusing to replace it",
            db.display()
        )
    };
    stored_credentials::transact(db, |conn| {
        if let Some(stored) =
            stored_credentials::read_in(conn, stored_credentials::RELAY_CONTENT_IDENTITY)?
        {
            let info: StoredIdentityInfo =
                serde_json::from_str(stored.info.as_deref().unwrap_or(""))
                    .map_err(|_| unusable("is unreadable"))?;
            if info.schema_version != RELAY_CONTENT_IDENTITY_SCHEMA_VERSION {
                return Err(unusable(&format!("has schema {}", info.schema_version)));
            }
            let seed: [u8; 32] = STANDARD
                .decode(stored.secret.trim())
                .ok()
                .and_then(|seed| seed.as_slice().try_into().ok())
                .ok_or_else(|| unusable("has an unusable seed"))?;
            return Ok(SigningKey::from_bytes(&seed));
        }
        // A phone can only be stranded by a new key if it pinned one this database lost.
        let held = held_public_relay_verify_keys(conn)?;
        let mut stranded = Vec::new();
        let mut unrecorded = 0;
        for (device_id, pinned) in crate::state::paired_device_relay_keys(conn)? {
            match pinned {
                Some(key) if !held.contains(&key) => stranded.push(device_id),
                Some(_) => {}
                None => unrecorded += 1,
            }
        }
        if !stranded.is_empty() {
            stranded.sort();
            return Err(format!(
                "relay content identity in {} is missing but {} paired with it; restore the database or pair them again after removing them",
                db.display(),
                stranded.join(", ")
            ));
        }
        if unrecorded > 0 {
            warn!(
                unrecorded,
                "creating a self-hosted relay key; phones paired before relay keys were recorded \
                 will need pairing again if they were paired with an earlier self-hosted key"
            );
        }
        let key = generate_content_signing_key();
        let info = serde_json::to_string(&StoredIdentityInfo {
            schema_version: RELAY_CONTENT_IDENTITY_SCHEMA_VERSION,
            control_url: None,
        })
        .map_err(|error| format!("relay content identity could not be encoded: {error}"))?;
        stored_credentials::write_in(
            conn,
            stored_credentials::RELAY_CONTENT_IDENTITY,
            &STANDARD.encode(key.to_bytes()),
            Some(&info),
        )?;
        Ok(key)
    })
}

/// The public half of every Cloud-style broker identity this database still holds.
fn held_public_relay_verify_keys(
    conn: &rusqlite::Connection,
) -> Result<std::collections::HashSet<String>, String> {
    let mut held = std::collections::HashSet::new();
    for (id, seed, _) in
        crate::state::list_credentials(conn, stored_credentials::PUBLIC_RELAY_IDENTITY)
            .map_err(|error| format!("read broker relay identities: {error}"))?
    {
        let key = signing_key_from_seed(&seed, &format!("broker relay identity {id:?}"))?;
        held.insert(STANDARD.encode(key.verifying_key().to_bytes()));
    }
    Ok(held)
}

async fn load_existing_public_relay_identity(
    db: &Path,
    control_url: &str,
) -> Result<PublicRelayIdentity, String> {
    let Some(persisted) = load_public_relay_identity_raw(db, control_url)? else {
        return Err(format!(
            "public broker identity is missing in {}; refusing to generate a new key for an already enrolled relay",
            db.display()
        ));
    };
    identity_from_persisted(db, control_url, persisted)
}

async fn load_or_create_public_relay_identity(
    db: &Path,
    control_url: &str,
) -> Result<PublicRelayIdentity, String> {
    if let Some(persisted) = load_public_relay_identity_raw(db, control_url)? {
        return identity_from_persisted(db, control_url, persisted);
    }

    let mut signing_seed = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut signing_seed);
    let identity = PublicRelayIdentity {
        signing_key: SigningKey::from_bytes(&signing_seed),
    };
    save_public_relay_identity(db, control_url, &identity).await?;
    Ok(identity)
}

fn identity_from_persisted(
    db: &Path,
    control_url: &str,
    persisted: PersistedPublicRelayIdentity,
) -> Result<PublicRelayIdentity, String> {
    if persisted.schema_version != PUBLIC_RELAY_IDENTITY_SCHEMA_VERSION {
        return Err(format!(
            "unsupported broker relay identity schema {} in {}",
            persisted.schema_version,
            db.display()
        ));
    }
    let persisted_origin = access_release::normalize_control_origin(&persisted.control_url)?;
    let expected_origin = access_release::normalize_control_origin(control_url)?;
    if persisted_origin != expected_origin {
        return Err(format!(
            "broker relay identity in {} was created for {}, expected {}",
            db.display(),
            persisted.control_url,
            control_url
        ));
    }
    let signing_seed: [u8; 32] = STANDARD
        .decode(&persisted.relay_signing_seed)
        .map_err(|_| {
            format!(
                "broker relay identity in {} contains an invalid signing seed",
                db.display()
            )
        })?
        .try_into()
        .map_err(|_| {
            format!(
                "broker relay identity in {} contains an invalid signing seed",
                db.display()
            )
        })?;
    Ok(PublicRelayIdentity {
        signing_key: SigningKey::from_bytes(&signing_seed),
    })
}

fn load_public_relay_identity_raw(
    db: &Path,
    control_url: &str,
) -> Result<Option<PersistedPublicRelayIdentity>, String> {
    let Some(stored) = stored_credentials::read_for_origin(
        db,
        stored_credentials::PUBLIC_RELAY_IDENTITY,
        control_url,
    )
    .map_err(|error| {
        format!(
            "failed to read broker relay identity in {}: {error}",
            db.display()
        )
    })?
    else {
        return Ok(None);
    };
    let info: StoredIdentityInfo = serde_json::from_str(stored.info.as_deref().unwrap_or(""))
        .map_err(|error| {
            format!(
                "failed to decode broker relay identity in {}: {error}",
                db.display()
            )
        })?;
    Ok(Some(PersistedPublicRelayIdentity {
        schema_version: info.schema_version,
        control_url: info.control_url.unwrap_or_default(),
        relay_signing_seed: stored.secret,
    }))
}

async fn save_public_relay_identity(
    db: &Path,
    control_url: &str,
    identity: &PublicRelayIdentity,
) -> Result<(), String> {
    let info = serde_json::to_string(&StoredIdentityInfo {
        schema_version: PUBLIC_RELAY_IDENTITY_SCHEMA_VERSION,
        control_url: Some(control_url.to_string()),
    })
    .map_err(|error| format!("failed to encode broker relay identity: {error}"))?;
    stored_credentials::write_for_origin(
        db,
        stored_credentials::PUBLIC_RELAY_IDENTITY,
        control_url,
        &STANDARD.encode(identity.signing_key.to_bytes()),
        &info,
    )
    .map_err(|error| {
        format!(
            "failed to save broker relay identity in {}: {error}",
            db.display()
        )
    })
}

/// Holds the lock `cloud-activate` and `cloud unbind` take, so neither can change the
/// broker identity while it is being moved into the database.
pub(crate) struct LifecycleGuard(#[allow(dead_code)] BrokerLifecycleLock);

pub(crate) fn hold_lifecycle_lock(beside: &Path) -> Result<LifecycleGuard, String> {
    BrokerLifecycleLock::acquire_for_registration(beside).map(LifecycleGuard)
}

/// The identity files an older build kept beside `session.json`.
// TODO(2026-12): remove with `migrate-storage` once every relay has been imported.
pub(crate) struct LegacyBrokerFiles {
    pub(crate) registration: PathBuf,
    pub(crate) identity: PathBuf,
    pub(crate) content_identity: PathBuf,
}

fn read_legacy_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to read {}: {error}", path.display())),
    }
}

fn signing_key_from_seed(seed: &str, what: &str) -> Result<SigningKey, String> {
    let seed: [u8; 32] = STANDARD
        .decode(seed.trim())
        .ok()
        .and_then(|seed| seed.as_slice().try_into().ok())
        .ok_or_else(|| format!("{what} has an unusable seed"))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Copy the files into `conn` (inside the caller's transaction) unchanged, read each
/// back, and describe what was copied without printing any secret.
pub(crate) fn import_legacy_broker_files(
    conn: &rusqlite::Connection,
    files: &LegacyBrokerFiles,
) -> Result<Vec<String>, String> {
    let mut report = Vec::new();
    let registration = read_legacy_file(&files.registration)?;
    let identity = read_legacy_file(&files.identity)?;
    if registration.is_some() && identity.is_none() {
        return Err(format!(
            "{} exists but {} does not: this relay is enrolled and its identity is missing. \
             Restore the identity file before importing; a new one would strand every paired phone.",
            files.registration.display(),
            files.identity.display()
        ));
    }
    let copy = |kind: &str, secret: &str, info: &str| -> Result<(), String> {
        stored_credentials::write_in(conn, kind, secret, Some(info))?;
        let back = stored_credentials::read_in(conn, kind)?
            .ok_or_else(|| format!("{kind} was not written"))?;
        if back.secret != secret || back.info.as_deref() != Some(info) {
            return Err(format!("{kind} read back differently than it was written"));
        }
        Ok(())
    };

    if let Some(bytes) = identity {
        let persisted: PersistedPublicRelayIdentity = serde_json::from_slice(&bytes)
            .map_err(|error| format!("failed to decode {}: {error}", files.identity.display()))?;
        if persisted.schema_version != PUBLIC_RELAY_IDENTITY_SCHEMA_VERSION {
            return Err(format!(
                "unsupported broker relay identity schema {} in {}",
                persisted.schema_version,
                files.identity.display()
            ));
        }
        let key = signing_key_from_seed(
            &persisted.relay_signing_seed,
            &files.identity.display().to_string(),
        )?;
        let info = serde_json::to_string(&StoredIdentityInfo {
            schema_version: persisted.schema_version,
            control_url: Some(persisted.control_url.clone()),
        })
        .map_err(|error| error.to_string())?;
        copy(
            stored_credentials::PUBLIC_RELAY_IDENTITY,
            &persisted.relay_signing_seed,
            &info,
        )?;
        report.push(format!(
            "Cloud relay identity for {}: public key {}",
            persisted.control_url,
            STANDARD.encode(key.verifying_key().to_bytes())
        ));
    }

    if let Some(bytes) = registration {
        let persisted: PersistedPublicRelayRegistration =
            serde_json::from_slice(&bytes).map_err(|error| {
                format!("failed to decode {}: {error}", files.registration.display())
            })?;
        if persisted.schema_version != PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION {
            return Err(format!(
                "unsupported broker registration cache schema {} in {}",
                persisted.schema_version,
                files.registration.display()
            ));
        }
        let info = serde_json::to_string(&StoredRegistrationInfo {
            schema_version: persisted.schema_version,
            control_url: persisted.control_url.clone(),
            relay_id: persisted.relay_id.clone(),
            broker_room_id: persisted.broker_room_id.clone(),
        })
        .map_err(|error| error.to_string())?;
        copy(
            stored_credentials::PUBLIC_REGISTRATION,
            &persisted.relay_refresh_token,
            &info,
        )?;
        report.push(format!(
            "Cloud registration: relay {} in room {} (token fingerprint {})",
            persisted.relay_id,
            persisted.broker_room_id,
            bearer_fingerprint(&persisted.relay_refresh_token)
        ));
    }

    if let Some(bytes) = read_legacy_file(&files.content_identity)? {
        #[derive(Deserialize)]
        struct LegacyContentIdentity {
            schema_version: u32,
            content_signing_seed: String,
        }
        let persisted: LegacyContentIdentity = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "failed to decode {}: {error}",
                files.content_identity.display()
            )
        })?;
        if persisted.schema_version != RELAY_CONTENT_IDENTITY_SCHEMA_VERSION {
            return Err(format!(
                "unsupported relay content identity schema {} in {}",
                persisted.schema_version,
                files.content_identity.display()
            ));
        }
        let key = signing_key_from_seed(
            &persisted.content_signing_seed,
            &files.content_identity.display().to_string(),
        )?;
        let info = serde_json::to_string(&StoredIdentityInfo {
            schema_version: persisted.schema_version,
            control_url: None,
        })
        .map_err(|error| error.to_string())?;
        copy(
            stored_credentials::RELAY_CONTENT_IDENTITY,
            &persisted.content_signing_seed,
            &info,
        )?;
        report.push(format!(
            "self-hosted relay identity: public key {}",
            STANDARD.encode(key.verifying_key().to_bytes())
        ));
    }
    Ok(report)
}

/// A database of its own for one test, in a directory of its own so no other test's
/// files sit beside it.
#[cfg(test)]
pub(crate) fn temp_state_db(prefix: &str) -> String {
    // macOS clocks tick in microseconds, so two tests can read the same time.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("{prefix}-{}-{unique}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("test state directory");
    dir.join("sealwire.db").display().to_string()
}

/// The control URL of the one `kind` entry a test database holds, if any.
#[cfg(test)]
fn only_control_url(db: &Path, kind: &str) -> Option<String> {
    let rows = stored_credentials::transact(db, |conn| {
        crate::state::list_credentials(conn, kind).map_err(|error| error.to_string())
    })
    .expect("credentials read");
    assert!(
        rows.len() <= 1,
        "expected at most one {kind} entry, found {}",
        rows.len()
    );
    rows.first().map(|(_, _, info)| {
        serde_json::from_str::<serde_json::Value>(info.as_deref().unwrap_or(""))
            .expect("info is json")["control_url"]
            .as_str()
            .expect("info names a control url")
            .to_string()
    })
}

#[cfg(test)]
pub(crate) fn only_public_relay_registration(
    db: &Path,
) -> Result<Option<PersistedPublicRelayRegistration>, String> {
    match only_control_url(db, stored_credentials::PUBLIC_REGISTRATION) {
        Some(control_url) => load_public_relay_registration_raw(db, &control_url),
        None => Ok(None),
    }
}

#[cfg(test)]
pub(crate) fn only_public_relay_identity(
    db: &Path,
) -> Result<Option<PersistedPublicRelayIdentity>, String> {
    match only_control_url(db, stored_credentials::PUBLIC_RELAY_IDENTITY) {
        Some(control_url) => load_public_relay_identity_raw(db, &control_url),
        None => Ok(None),
    }
}

#[cfg(test)]
pub(crate) async fn save_test_public_identity(db: &str, control_url: &str, seed: [u8; 32]) {
    let parsed = auth::parse_control_plane_url(control_url).expect("control url");
    let identity = PublicRelayIdentity {
        signing_key: SigningKey::from_bytes(&seed),
    };
    save_public_relay_identity(Path::new(db), parsed.as_str(), &identity)
        .await
        .expect("identity should save");
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
