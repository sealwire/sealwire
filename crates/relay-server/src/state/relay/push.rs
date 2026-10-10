//! Web Push notifications for remote (mobile) devices.
//!
//! Three concerns live here:
//!
//!  1. [`PushAttentionTracker`] — a server-side port of the client's
//!     `thread-attention.js`. Fed the same `SessionSnapshot` stream the broker
//!     publishes, it emits a [`PushJob`] only on the *transition* into
//!     "needs input" or "completed", so a backgrounded/closed phone gets the
//!     same notifications the open app would. (The open app keeps doing its own
//!     in-app `Notification`; the push is the closed-app path.)
//!  2. The Web Push crypto itself — VAPID (RFC 8292) request signing plus
//!     RFC 8291 / RFC 8188 `aes128gcm` payload encryption — hand-rolled on the
//!     pure-Rust `p256`/`hkdf`/`aes-gcm` stack so we stay off OpenSSL (the rest
//!     of the workspace is rustls/RustCrypto; the `web-push` crate would drag in
//!     `ece`→`openssl`).
//!  3. [`PushDispatcher`] — an async task that owns the VAPID key + HTTP client,
//!     receives [`PushJob`]s off an mpsc channel (so senders never touch network
//!     IO under the state lock), and sends to every stored subscription,
//!     pruning the ones a push service reports `404`/`410 Gone`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Key, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hkdf::Hkdf;
use p256::ecdh::diffie_hellman;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, info, warn};

use super::{thread_status_is_working, RelayState};
use crate::protocol::SessionSnapshot;

/// How long a VAPID JWT stays valid. RFC 8292 caps this at 24h; 12h leaves slack.
const VAPID_TOKEN_TTL_SECS: u64 = 12 * 60 * 60;
/// `TTL` header on the push (how long the push service may hold an undelivered
/// message). A few hours is plenty for an "agent needs you" nudge.
const PUSH_MESSAGE_TTL_SECS: u64 = 6 * 60 * 60;
/// RFC 8188 record size. Our payloads are tiny; any value above the record fits.
const PUSH_RECORD_SIZE: u32 = 4096;

/// Env override for the VAPID key location. Prefer an absolute path: a relative
/// one re-anchors the key to the launch directory (see `state_paths`).
/// The credential kind holding the VAPID private scalar.
pub(crate) const VAPID_CREDENTIAL_KIND: &str = "vapid";

/// Default VAPID `sub` contact. Overridable via `RELAY_VAPID_SUBJECT`.
const DEFAULT_VAPID_SUBJECT: &str = "mailto:sealwire@localhost";

// ---------------------------------------------------------------------------
// Stored subscription + wire input
// ---------------------------------------------------------------------------

/// A browser Push subscription, keyed (in `RelayState`) by `device_id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushSubscription {
    pub endpoint: String,
    /// Receiver public key (base64url, uncompressed P-256 point), from
    /// `PushSubscription.getKey("p256dh")`.
    pub p256dh: String,
    /// Receiver auth secret (base64url, 16 bytes), from `getKey("auth")`.
    pub auth: String,
    pub device_id: String,
    pub created_at: u64,
}

/// Keys sub-object of the browser's `PushSubscription.toJSON()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushSubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// `input` of the `register_push_subscription` remote action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushSubscriptionInput {
    pub endpoint: String,
    pub keys: PushSubscriptionKeys,
    /// Injected by the broker's `bind_device`; never trusted from the client.
    #[serde(default)]
    pub device_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushKind {
    NeedsInput,
    Completed,
    Error,
}

impl PushKind {
    fn tag_slug(self) -> &'static str {
        match self {
            PushKind::NeedsInput => "needs_input",
            PushKind::Completed => "completed",
            PushKind::Error => "error",
        }
    }
}

/// One queued notification. `thread_name`/`reason` are filled by the caller (it
/// holds the state lock); the tracker leaves them `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushJob {
    pub kind: PushKind,
    pub thread_id: String,
    pub thread_name: Option<String>,
    pub reason: Option<String>,
}

impl PushJob {
    pub fn new(kind: PushKind, thread_id: impl Into<String>) -> Self {
        Self {
            kind,
            thread_id: thread_id.into(),
            thread_name: None,
            reason: None,
        }
    }

    pub fn with_name(mut self, name: Option<String>) -> Self {
        self.thread_name = name;
        self
    }

    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

// ---------------------------------------------------------------------------
// Attention tracker (server-side port of frontend/shared/thread-attention.js)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ThreadState {
    working: bool,
    needs_input: bool,
}

/// Derive a per-thread `{working, needs_input}` map from one snapshot. Mirrors
/// `computeThreadStates` in `thread-attention.js` — keep the two in lockstep.
fn compute_thread_states(snapshot: &SessionSnapshot) -> HashMap<String, ThreadState> {
    let mut states: HashMap<String, ThreadState> = HashMap::new();
    let active = snapshot.active_thread_id.clone();

    // Active thread: an in-flight turn OR a working status (a leftover phase
    // does NOT count — same as ThreadRuntime::is_working / sessionIsWorking).
    if let Some(active_id) = active.as_ref() {
        let working =
            snapshot.active_turn_id.is_some() || thread_status_is_working(&snapshot.current_status);
        if working {
            states.entry(active_id.clone()).or_default().working = true;
        }
    }

    // Backgrounded threads with an in-flight turn.
    for item in &snapshot.thread_activity {
        if !item.thread_id.is_empty() {
            states.entry(item.thread_id.clone()).or_default().working = true;
        }
    }

    // Approvals / ask-user questions belong to their own thread_id; one without
    // it marks no thread (never guessed onto the active one).
    let request_threads = snapshot
        .pending_approvals
        .iter()
        .map(|approval| &approval.thread_id)
        .chain(
            snapshot
                .pending_ask_user_questions
                .iter()
                .map(|question| &question.thread_id),
        );
    for thread_id in request_threads.filter(|id| !id.is_empty()) {
        states.entry(thread_id.clone()).or_default().needs_input = true;
    }

    // Fallback: active thread's waiting flags, in case the request arrays were
    // compacted out of a budget-limited snapshot.
    if let Some(active_id) = active.as_ref() {
        let waiting = snapshot
            .active_flags
            .iter()
            .any(|f| f == "waitingOnApproval" || f == "waitingOnAskUser");
        if waiting {
            states.entry(active_id.clone()).or_default().needs_input = true;
        }
    }

    states
}

/// Stateful diff over the snapshot stream. Emits push jobs only on transitions
/// into needs_input / completed. The first ingest establishes a baseline.
#[derive(Debug, Default)]
pub struct PushAttentionTracker {
    prev: Option<HashMap<String, ThreadState>>,
    /// Threads whose next work→idle "completed" transition should be swallowed
    /// because an explicit error/stall push already fired for them.
    suppress_completed: HashSet<String>,
}

impl PushAttentionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Swallow the next `completed` transition for `thread_id` (the worker-crash /
    /// stall sites call this so the work→idle blip isn't double-sent as "finished").
    pub fn suppress_completed(&mut self, thread_id: &str) {
        self.suppress_completed.insert(thread_id.to_string());
    }

    pub fn ingest(&mut self, snapshot: &SessionSnapshot) -> Vec<PushJob> {
        self.ingest_states(compute_thread_states(snapshot))
    }

    /// Diff core, separated from snapshot parsing so the transition logic (the
    /// subtle part) is unit-testable with hand-built state maps.
    fn ingest_states(&mut self, next: HashMap<String, ThreadState>) -> Vec<PushJob> {
        let mut jobs = Vec::new();

        if let Some(prev) = self.prev.take() {
            let mut ids: HashSet<&String> = HashSet::new();
            ids.extend(prev.keys());
            ids.extend(next.keys());
            // Deterministic order keeps tests + logs stable.
            let mut ids: Vec<&String> = ids.into_iter().collect();
            ids.sort();

            for id in ids {
                let before = prev.get(id).copied().unwrap_or_default();
                let after = next.get(id).copied().unwrap_or_default();
                // A new turn starting clears any stale error-suppression: suppress
                // only applies to the work→idle edge of the *errored* turn. Without
                // this, a suppress that never met its edge (e.g. a sub-debounce
                // turn the tracker never saw as working) would swallow this new
                // turn's eventual completion.
                if !before.working && after.working {
                    self.suppress_completed.remove(id);
                }
                if after.needs_input && !before.needs_input {
                    jobs.push(PushJob::new(PushKind::NeedsInput, id.clone()));
                } else if before.working && !after.working && !after.needs_input {
                    if self.suppress_completed.remove(id) {
                        // An error already notified for this thread; skip the
                        // "finished" that the same work→idle edge would produce.
                    } else {
                        jobs.push(PushJob::new(PushKind::Completed, id.clone()));
                    }
                }
            }
        }

        self.prev = Some(next);
        jobs
    }
}

// ---------------------------------------------------------------------------
// Notification copy (mirrors formatThreadNotification in thread-notify.js)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushNotification {
    pub title: String,
    pub body: String,
    pub tag: String,
}

pub fn format_push_notification(job: &PushJob) -> PushNotification {
    let label = job.thread_name.as_deref().unwrap_or("A thread");
    let (title, body) = match job.kind {
        PushKind::NeedsInput => (
            "Agent needs your input".to_string(),
            format!("{label} is waiting for you."),
        ),
        PushKind::Completed => (
            "Agent finished".to_string(),
            format!("{label} completed its turn."),
        ),
        PushKind::Error => {
            let reason = job.reason.as_deref().unwrap_or("stopped unexpectedly.");
            ("Agent stopped".to_string(), format!("{label} {reason}"))
        }
    };
    PushNotification {
        title,
        body,
        tag: format!("thread-{}-{}", job.thread_id, job.kind.tag_slug()),
    }
}

/// JSON payload delivered to the service worker's `push` handler.
#[derive(Debug, Clone, Serialize)]
struct PushPayload {
    title: String,
    body: String,
    tag: String,
    #[serde(rename = "threadId")]
    thread_id: String,
    kind: String,
    url: String,
}

fn build_payload_bytes(job: &PushJob) -> Vec<u8> {
    let notification = format_push_notification(job);
    let payload = PushPayload {
        title: notification.title,
        body: notification.body,
        tag: notification.tag,
        thread_id: job.thread_id.clone(),
        kind: job.kind.tag_slug().to_string(),
        url: "/".to_string(),
    };
    serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec())
}

// ---------------------------------------------------------------------------
// VAPID key management
// ---------------------------------------------------------------------------

/// VAPID signing material plus the cached public key the client needs as its
/// `applicationServerKey`.
#[derive(Clone)]
pub struct VapidKeys {
    signing_key: SigningKey,
    public_b64url: String,
    subject: String,
}

impl VapidKeys {
    /// Public key (base64url, uncompressed P-256 point) for the client.
    pub fn public_b64url(&self) -> &str {
        &self.public_b64url
    }
}

fn vapid_public_b64url(signing_key: &SigningKey) -> String {
    let point = signing_key.verifying_key().to_encoded_point(false);
    URL_SAFE_NO_PAD.encode(point.as_bytes())
}

/// Load the VAPID private scalar from the database, generating and saving one on first
/// run. Stored base64url-encoded, the way older builds kept it in `vapid.key`.
///
/// A stored key that cannot be read is an error, never a reason to mint a new one:
/// a rotated VAPID key silently breaks every push subscription a phone already holds.
pub(crate) fn load_or_generate_vapid(
    store: &crate::usage::store::UsageStore,
) -> Result<VapidKeys, String> {
    let subject =
        std::env::var("RELAY_VAPID_SUBJECT").unwrap_or_else(|_| DEFAULT_VAPID_SUBJECT.to_string());
    let signing_key = store.with_connection(|conn| {
        let tx = conn
            .transaction()
            .map_err(|error| format!("failed to read the VAPID key: {error}"))?;
        let signing_key = match crate::state::read_credential(&tx, VAPID_CREDENTIAL_KIND, "")
            .map_err(|error| format!("failed to read the VAPID key: {error}"))?
        {
            Some((stored, _)) => {
                let scalar = b64url_decode(stored.trim())
                    .map_err(|error| format!("failed to decode the stored VAPID key: {error}"))?;
                SigningKey::from_slice(&scalar)
                    .map_err(|error| format!("the stored VAPID key is invalid: {error}"))?
            }
            None => {
                let signing_key = SigningKey::random(&mut OsRng);
                crate::state::put_credential(
                    &tx,
                    VAPID_CREDENTIAL_KIND,
                    "",
                    &URL_SAFE_NO_PAD.encode(signing_key.to_bytes()),
                    None,
                    crate::state::unix_now(),
                )
                .map_err(|error| format!("failed to save the VAPID key: {error}"))?;
                signing_key
            }
        };
        tx.commit()
            .map_err(|error| format!("failed to save the VAPID key: {error}"))?;
        Ok(signing_key)
    })?;
    let public_b64url = vapid_public_b64url(&signing_key);
    Ok(VapidKeys {
        signing_key,
        public_b64url,
        subject,
    })
}

/// Copy an older build's `vapid.key` into `conn` (inside the caller's transaction).
/// Returns the public key it holds, or `None` when there was no file.
// TODO(2026-12): remove with `migrate-storage` once every relay has been imported.
pub(crate) fn import_legacy_vapid_file(
    conn: &rusqlite::Connection,
    path: &std::path::Path,
) -> Result<Option<String>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };
    let scalar = b64url_decode(text.trim())
        .map_err(|error| format!("failed to decode {}: {error}", path.display()))?;
    let signing_key = SigningKey::from_slice(&scalar)
        .map_err(|error| format!("invalid VAPID key in {}: {error}", path.display()))?;
    let encoded = URL_SAFE_NO_PAD.encode(signing_key.to_bytes());
    crate::state::put_credential(
        conn,
        VAPID_CREDENTIAL_KIND,
        "",
        &encoded,
        None,
        crate::state::unix_now(),
    )
    .map_err(|error| format!("failed to save the VAPID key: {error}"))?;
    let back = crate::state::read_credential(conn, VAPID_CREDENTIAL_KIND, "")
        .map_err(|error| format!("failed to read back the VAPID key: {error}"))?;
    if back.map(|(secret, _)| secret).as_deref() != Some(encoded.as_str()) {
        return Err("the VAPID key read back differently than it was written".to_string());
    }
    Ok(Some(vapid_public_b64url(&signing_key)))
}

// ---------------------------------------------------------------------------
// Crypto: VAPID JWT (RFC 8292) + aes128gcm payload (RFC 8291 / RFC 8188)
// ---------------------------------------------------------------------------

fn b64url_decode(value: &str) -> Result<Vec<u8>, String> {
    let trimmed = value.trim_end_matches('=');
    URL_SAFE_NO_PAD
        .decode(trimmed)
        .map_err(|e| format!("base64url decode failed: {e}"))
}

/// The `aud` claim is the *origin* (scheme://host[:port]) of the push endpoint.
fn endpoint_origin(endpoint: &str) -> Result<String, String> {
    let url = url::Url::parse(endpoint).map_err(|e| format!("invalid push endpoint: {e}"))?;
    Ok(url.origin().ascii_serialization())
}

/// Reject endpoints that aren't public https URLs. A paired device could
/// otherwise point the relay at an internal address (SSRF); real push services
/// (FCM / Mozilla autopush / Apple) are always public https, so this is not
/// restrictive in practice. A host name is checked again by [`PushResolver`] on
/// every connection, since its DNS answer is the attacker's to choose.
pub(crate) fn is_acceptable_push_endpoint(endpoint: &str) -> bool {
    let Ok(url) = url::Url::parse(endpoint) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.to_ascii_lowercase();
            host != "localhost" && !host.ends_with(".localhost") && !host.ends_with(".local")
        }
        Some(url::Host::Ipv4(ip)) => is_public_address(ip.into()),
        Some(url::Host::Ipv6(ip)) => is_public_address(ip.into()),
        None => false,
    }
}

/// Whether a push may be sent to `ip`: globally routed unicast only. Anything the
/// relay's own computer could reach privately (LAN, VPN, carrier NAT, cloud metadata) is out.
/// 198.18.0.0/15 stays allowed: Clash/Surge "fake-ip" mode answers every name from it.
fn is_public_address(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                // 100.64.0.0/10: carrier-grade NAT, and Tailscale's tailnet addresses.
                || (a == 100 && (b & 0xc0) == 64)
                || (a == 192 && b == 0 && c == 0))
        }
        IpAddr::V6(ip) => {
            let [s0, s1, ..] = ip.segments();
            // Only 2000::/3 is internet unicast, which also refuses the IPv4-compatible and NAT64
            // forms; inside it, 6to4 embeds an IPv4 address and the rest is reserved.
            (s0 & 0xe000) == 0x2000
                && !(s0 == 0x2001 && (s1 < 0x0200 || s1 == 0x0db8))
                && s0 != 0x2002
                && !(s0 == 0x3fff && s1 < 0x1000)
        }
    }
}

/// Build the `Authorization: vapid t=<jwt>, k=<public_key>` header value.
fn vapid_authorization(keys: &VapidKeys, endpoint: &str, now: u64) -> Result<String, String> {
    let aud = endpoint_origin(endpoint)?;
    let header = br#"{"typ":"JWT","alg":"ES256"}"#;
    let claims = serde_json::json!({
        "aud": aud,
        "exp": now + VAPID_TOKEN_TTL_SECS,
        "sub": keys.subject,
    });
    let claims_bytes = serde_json::to_vec(&claims).map_err(|e| e.to_string())?;
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header),
        URL_SAFE_NO_PAD.encode(&claims_bytes)
    );
    // ES256: ECDSA P-256 + SHA-256, signature is raw r||s (64 bytes).
    let signature: Signature = keys.signing_key.sign(signing_input.as_bytes());
    let jwt = format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    );
    Ok(format!("vapid t={jwt}, k={}", keys.public_b64url))
}

/// Encrypt `plaintext` for a subscription using a fresh ephemeral key + salt.
fn encrypt_aes128gcm(ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let as_secret = SecretKey::random(&mut OsRng);
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    encrypt_aes128gcm_with(ua_public, auth, plaintext, &as_secret, &salt)
}

/// Deterministic core (injected ephemeral key + salt) — see RFC 8291 §3.4 and
/// RFC 8188 §2. Split out so tests can drive it with fixed vectors.
fn encrypt_aes128gcm_with(
    ua_public: &[u8],
    auth: &[u8],
    plaintext: &[u8],
    as_secret: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, String> {
    let ua_public_key =
        PublicKey::from_sec1_bytes(ua_public).map_err(|e| format!("invalid p256dh key: {e}"))?;
    let as_public_point = as_secret.public_key().to_encoded_point(false);
    let as_public_bytes = as_public_point.as_bytes();

    let shared = diffie_hellman(as_secret.to_nonzero_scalar(), ua_public_key.as_affine());
    let ecdh_secret = shared.raw_secret_bytes();

    // RFC 8291: IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0"||ua||as, 32)
    let mut key_info = Vec::with_capacity(14 + ua_public.len() + as_public_bytes.len());
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public_bytes);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), ecdh_secret.as_slice())
        .expand(&key_info, &mut ikm)
        .map_err(|_| "HKDF expand (IKM) failed".to_string())?;

    // RFC 8188: CEK / NONCE from the random salt.
    let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| "HKDF expand (CEK) failed".to_string())?;
    let mut nonce = [0u8; 12];
    hk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| "HKDF expand (nonce) failed".to_string())?;

    // Single record: plaintext || 0x02 (last-record delimiter), then AES-128-GCM.
    let mut record = Vec::with_capacity(plaintext.len() + 1);
    record.extend_from_slice(plaintext);
    record.push(0x02);
    let cipher = Aes128Gcm::new(Key::<Aes128Gcm>::from_slice(&cek));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), record.as_ref())
        .map_err(|_| "AES-128-GCM encryption failed".to_string())?;

    // aes128gcm header: salt(16) || rs(4) || idlen(1) || keyid(=as_public) || body.
    let mut out = Vec::with_capacity(16 + 4 + 1 + as_public_bytes.len() + ciphertext.len());
    out.extend_from_slice(salt);
    out.extend_from_slice(&PUSH_RECORD_SIZE.to_be_bytes());
    out.push(as_public_bytes.len() as u8);
    out.extend_from_slice(as_public_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendOutcome {
    Delivered,
    /// 404/410 — the subscription is dead; prune it.
    Gone,
    /// Transient/other failure — keep the subscription, just log.
    Failed,
}

/// Owns the VAPID key + HTTP client and drains the push job queue. Spawned once
/// on the production path; senders only enqueue (never block on network IO).
pub struct PushDispatcher {
    relay: Arc<RwLock<RelayState>>,
    http: reqwest::Client,
    vapid: VapidKeys,
}

impl PushDispatcher {
    /// Spawn the dispatcher task and return the sender to install on `RelayState`.
    pub fn spawn(
        relay: Arc<RwLock<RelayState>>,
        vapid: VapidKeys,
    ) -> Result<mpsc::UnboundedSender<PushJob>, String> {
        let through_proxy = proxy_configured();
        if through_proxy {
            info!("web push goes through the proxy in the environment; push addresses are not checked");
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let dispatcher = Self {
            relay,
            http: build_push_client(system_lookup(), through_proxy)?,
            vapid,
        };
        tokio::spawn(dispatcher.run(rx));
        Ok(tx)
    }

    async fn run(self, mut rx: mpsc::UnboundedReceiver<PushJob>) {
        while let Some(job) = rx.recv().await {
            self.handle(job).await;
        }
    }

    async fn handle(&self, job: PushJob) {
        let subscriptions = {
            let relay = self.relay.read().await;
            relay.push_subscriptions_vec()
        };
        if subscriptions.is_empty() {
            return;
        }
        let payload = build_payload_bytes(&job);
        let mut gone = Vec::new();
        for subscription in subscriptions {
            // Re-checked right before sending: a revoke since the clone dropped this
            // subscription (a re-pair does not restore it), and a narrowed scope may exclude it.
            {
                let relay = self.relay.read().await;
                let still_stored = relay
                    .push_subscriptions
                    .get(&subscription.device_id)
                    .is_some_and(|stored| stored.contains(&subscription));
                if !still_stored
                    || !relay.device_reaches_thread(&job.thread_id, &subscription.device_id)
                {
                    continue;
                }
            }
            match self.send_one(&subscription, &payload).await {
                SendOutcome::Gone => gone.push(subscription.endpoint),
                SendOutcome::Delivered | SendOutcome::Failed => {}
            }
        }
        if !gone.is_empty() {
            let mut relay = self.relay.write().await;
            relay.prune_push_subscriptions(&gone);
            relay.notify();
        }
    }

    async fn send_one(&self, subscription: &PushSubscription, payload: &[u8]) -> SendOutcome {
        // An IP-literal host skips the resolver, and a stored row may predate today's rules.
        if !is_acceptable_push_endpoint(&subscription.endpoint) {
            warn!(endpoint = %subscription.endpoint, "push endpoint is not a public https URL; pruning");
            return SendOutcome::Gone;
        }
        let ua_public = match b64url_decode(&subscription.p256dh) {
            Ok(bytes) => bytes,
            Err(error) => {
                warn!(endpoint = %subscription.endpoint, %error, "bad p256dh; pruning");
                return SendOutcome::Gone;
            }
        };
        let auth = match b64url_decode(&subscription.auth) {
            Ok(bytes) => bytes,
            Err(error) => {
                warn!(endpoint = %subscription.endpoint, %error, "bad auth secret; pruning");
                return SendOutcome::Gone;
            }
        };
        let body = match encrypt_aes128gcm(&ua_public, &auth, payload) {
            Ok(body) => body,
            Err(error) => {
                warn!(endpoint = %subscription.endpoint, %error, "push encryption failed");
                return SendOutcome::Failed;
            }
        };
        let authorization = match vapid_authorization(&self.vapid, &subscription.endpoint, now()) {
            Ok(value) => value,
            Err(error) => {
                warn!(endpoint = %subscription.endpoint, %error, "VAPID signing failed");
                return SendOutcome::Failed;
            }
        };

        let response = self
            .http
            .post(&subscription.endpoint)
            .header(reqwest::header::AUTHORIZATION, authorization)
            .header(reqwest::header::CONTENT_ENCODING, "aes128gcm")
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header("TTL", PUSH_MESSAGE_TTL_SECS.to_string())
            .body(body)
            .send()
            .await;

        match response {
            Ok(response) => {
                let status = response.status().as_u16();
                match status {
                    200 | 201 | 202 | 204 => {
                        debug!(endpoint = %subscription.endpoint, status, "push delivered");
                        SendOutcome::Delivered
                    }
                    404 | 410 => {
                        debug!(endpoint = %subscription.endpoint, status, "push endpoint gone; pruning");
                        SendOutcome::Gone
                    }
                    _ => {
                        warn!(endpoint = %subscription.endpoint, status, "push service rejected");
                        SendOutcome::Failed
                    }
                }
            }
            Err(error) => {
                warn!(endpoint = %subscription.endpoint, ?error, "push request failed");
                SendOutcome::Failed
            }
        }
    }
}

type LookupFuture = Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>>;
/// Injectable so tests can answer DNS without touching the network.
type Lookup = Arc<dyn Fn(String) -> LookupFuture + Send + Sync>;

fn system_lookup() -> Lookup {
    Arc::new(|host: String| {
        Box::pin(async move {
            Ok(tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .map(|addr| addr.ip())
                .collect())
        })
    })
}

/// The push client's only DNS. The connector dials exactly the addresses returned here,
/// so checking them leaves no second lookup for a rebinding name to win.
struct PushResolver {
    lookup: Lookup,
}

impl reqwest::dns::Resolve for PushResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let lookup = (self.lookup)(host.clone());
        Box::pin(async move {
            let addrs = lookup.await?;
            // One inward answer refuses the whole name: a real push service never has one,
            // and the connector would otherwise fall back to it when a public address fails.
            if let Some(ip) = addrs.iter().find(|ip| !is_public_address(**ip)) {
                return Err(format!("refusing push host {host}: it resolves to {ip}").into());
            }
            Ok(Box::new(addrs.into_iter().map(|ip| SocketAddr::new(ip, 0))) as reqwest::dns::Addrs)
        })
    }
}

/// HTTP client for sending pushes. The timeout stops a hung endpoint wedging the serial
/// queue; redirects are off because they would reach a host [`PushResolver`] never checked.
/// A proxy resolves the host itself, so proxy users keep the old unchecked path, and their
/// proxy's own host (often loopback or LAN) must not go through [`PushResolver`] either.
fn build_push_client(lookup: Lookup, through_proxy: bool) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    let builder = if through_proxy {
        builder
    } else {
        builder
            .no_proxy()
            .dns_resolver(Arc::new(PushResolver { lookup }))
    };
    builder
        .build()
        .map_err(|error| format!("failed to build the push client: {error}"))
}

/// Mirrors how reqwest picks a proxy for an https URL: the first of each pair that is set.
fn proxy_configured() -> bool {
    [["HTTPS_PROXY", "https_proxy"], ["ALL_PROXY", "all_proxy"]]
        .iter()
        .any(|names| {
            names
                .iter()
                .find_map(|name| std::env::var(name).ok())
                .is_some_and(|value| !value.is_empty())
        })
}

fn now() -> u64 {
    crate::state::unix_now()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn states(entries: &[(&str, bool, bool)]) -> HashMap<String, ThreadState> {
        entries
            .iter()
            .map(|(id, working, needs_input)| {
                (
                    (*id).to_string(),
                    ThreadState {
                        working: *working,
                        needs_input: *needs_input,
                    },
                )
            })
            .collect()
    }

    // The VAPID key IS the push identity: regenerating it silently invalidates every
    // subscription a phone already holds, so a restart must find the same key.
    #[test]
    fn the_vapid_key_is_saved_once_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sealwire.db");
        let first = load_or_generate_vapid(&crate::usage::store::UsageStore::open(&path)).unwrap();
        let second = load_or_generate_vapid(&crate::usage::store::UsageStore::open(&path)).unwrap();
        assert_eq!(
            first.public_b64url(),
            second.public_b64url(),
            "a restart must reuse the first key — a rotated key silently kills every push \
             subscription registered before it"
        );
    }

    fn test_vapid() -> VapidKeys {
        let dir = tempfile::tempdir().unwrap();
        load_or_generate_vapid(&crate::usage::store::UsageStore::open(
            &dir.path().join("sealwire.db"),
        ))
        .expect("vapid")
    }

    fn push_client(lookup: Lookup) -> reqwest::Client {
        build_push_client(lookup, false).expect("push client")
    }

    fn fixed_lookup(answer: &[&str]) -> Lookup {
        let answer: Vec<IpAddr> = answer.iter().map(|ip| ip.parse().unwrap()).collect();
        Arc::new(move |_host: String| {
            let answer = answer.clone();
            Box::pin(async move { Ok(answer) })
        })
    }

    fn no_dns() -> Lookup {
        Arc::new(|host: String| {
            Box::pin(async move { Err(std::io::Error::other(format!("no DNS in tests: {host}"))) })
        })
    }

    fn recording_lookup(seen: Arc<std::sync::Mutex<Vec<String>>>) -> Lookup {
        Arc::new(move |host: String| {
            seen.lock().unwrap().push(host.clone());
            Box::pin(async move { Err(std::io::Error::other(format!("no DNS in tests: {host}"))) })
        })
    }

    async fn resolve_with(lookup: Lookup) -> Result<Vec<SocketAddr>, String> {
        use reqwest::dns::Resolve as _;
        let name: reqwest::dns::Name = "push.example.test".parse().ok().unwrap();
        PushResolver { lookup }
            .resolve(name)
            .await
            .map(|addrs| addrs.collect())
            .map_err(|error| error.to_string())
    }

    fn test_relay() -> Arc<RwLock<RelayState>> {
        let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
        Arc::new(RwLock::new(RelayState::new(
            "/tmp/push-test".to_string(),
            change_tx,
            crate::state::SecurityProfile::private(),
        )))
    }

    fn pair(relay: &mut RelayState, device_id: &str, path_scope: Vec<String>) {
        relay.paired_devices.insert(
            device_id.to_string(),
            crate::state::relay::device::PairedDevice {
                device_id: device_id.to_string(),
                label: device_id.to_string(),
                payload_secret: "secret".to_string(),
                device_verify_key: "verify-key".to_string(),
                created_at: 0,
                last_seen_at: None,
                last_peer_id: None,
                broker_join_ticket_expires_at: None,
                path_scope,
                pairing_broker: None,
            },
        );
    }

    /// A real P-256 receiver key, so `send_one` gets as far as the network.
    fn receiver_keys() -> PushSubscriptionKeys {
        let recv = SecretKey::random(&mut OsRng);
        let mut auth = [0u8; 16];
        OsRng.fill_bytes(&mut auth);
        PushSubscriptionKeys {
            p256dh: URL_SAFE_NO_PAD.encode(recv.public_key().to_encoded_point(false).as_bytes()),
            auth: URL_SAFE_NO_PAD.encode(auth),
        }
    }

    fn stored_subscription(device_id: &str, endpoint: String) -> PushSubscription {
        let keys = receiver_keys();
        PushSubscription {
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            device_id: device_id.to_string(),
            created_at: 0,
        }
    }

    async fn counting_listener(bind: &str) -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = tokio::net::TcpListener::bind(bind).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let dialed = Arc::new(AtomicUsize::new(0));
        let counter = dialed.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                drop(sock);
            }
        });
        (port, dialed)
    }

    async fn registered_attacker_endpoint(
        bind: &str,
    ) -> (Arc<RwLock<RelayState>>, Arc<std::sync::atomic::AtomicUsize>) {
        let (port, dialed) = counting_listener(bind).await;
        let relay = test_relay();
        {
            let mut guard = relay.write().await;
            pair(&mut guard, "phone", Vec::new());
            guard
                .register_push_subscription(PushSubscriptionInput {
                    endpoint: format!("https://notify.attacker.test:{port}/push"),
                    keys: receiver_keys(),
                    device_id: Some("phone".to_string()),
                })
                .expect("a public-looking https name is accepted at registration");
        }
        (relay, dialed)
    }

    async fn deliver(relay: &Arc<RwLock<RelayState>>, lookup: Lookup) {
        PushDispatcher {
            relay: relay.clone(),
            http: push_client(lookup),
            vapid: test_vapid(),
        }
        .handle(PushJob::new(PushKind::NeedsInput, "t1"))
        .await;
    }

    #[test]
    fn tracker_baseline_emits_nothing() {
        let mut tracker = PushAttentionTracker::new();
        assert!(tracker
            .ingest_states(states(&[("t1", true, false)]))
            .is_empty());
    }

    // Mirrors thread-attention.js: a request without a thread id marks no thread,
    // rather than being guessed onto the active one.
    #[test]
    fn an_unattributed_request_marks_no_thread() {
        let (change_tx, _) = tokio::sync::watch::channel(0_u64);
        let relay = crate::state::RelayState::new(
            "/tmp/project".to_string(),
            change_tx,
            crate::state::SecurityProfile::private(),
        );
        let mut snapshot = relay.snapshot();
        snapshot.active_thread_id = Some("t1".to_string());
        snapshot.pending_approvals = vec![crate::protocol::ApprovalRequestView {
            request_id: "a-orphan".to_string(),
            thread_id: String::new(),
            kind: "command_execution".to_string(),
            summary: "Bash".to_string(),
            detail: None,
            command: None,
            cwd: None,
            context_preview: None,
            requested_permissions: None,
            available_decisions: Vec::new(),
            supports_session_scope: false,
        }];
        snapshot.pending_ask_user_questions = vec![
            crate::protocol::AskUserQuestionRequestView::with_inline_questions(
                "q-orphan".to_string(),
                "toolu-q".to_string(),
                String::new(),
                1,
                Vec::new(),
            ),
        ];

        let states = compute_thread_states(&snapshot);
        assert!(!states.get("t1").is_some_and(|state| state.needs_input));
    }

    #[test]
    fn tracker_emits_needs_input_then_completed() {
        let mut tracker = PushAttentionTracker::new();
        // baseline: working, no input
        tracker.ingest_states(states(&[("t1", true, false)]));
        // transition into needs_input
        let jobs = tracker.ingest_states(states(&[("t1", true, true)]));
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].kind, PushKind::NeedsInput);
        assert_eq!(jobs[0].thread_id, "t1");
        // request resolved but still working -> no event
        let jobs = tracker.ingest_states(states(&[("t1", true, false)]));
        assert!(jobs.is_empty());
        // work -> idle: completed
        let jobs = tracker.ingest_states(states(&[]));
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].kind, PushKind::Completed);
    }

    #[test]
    fn suppress_completed_does_not_swallow_a_later_unrelated_completion() {
        let mut tracker = PushAttentionTracker::new();
        tracker.ingest_states(states(&[])); // baseline
                                            // An error fired while the tracker never observed t1 as working (e.g. a
                                            // sub-debounce turn): the suppress entry has no matching work->idle edge.
        tracker.suppress_completed("t1");
        // A later, unrelated turn on t1 runs and completes normally.
        tracker.ingest_states(states(&[("t1", true, false)]));
        let jobs = tracker.ingest_states(states(&[]));
        assert!(
            jobs.iter()
                .any(|j| j.kind == PushKind::Completed && j.thread_id == "t1"),
            "a stale suppress must not swallow a later real completion: {jobs:?}"
        );
    }

    #[test]
    fn tracker_suppresses_completed_after_error() {
        let mut tracker = PushAttentionTracker::new();
        tracker.ingest_states(states(&[("t1", true, false)]));
        tracker.suppress_completed("t1");
        // work -> idle would normally be "completed" but the error suppressed it
        let jobs = tracker.ingest_states(states(&[]));
        assert!(jobs.is_empty(), "completed should be suppressed: {jobs:?}");
    }

    #[test]
    fn tracker_needs_input_does_not_double_fire() {
        let mut tracker = PushAttentionTracker::new();
        tracker.ingest_states(states(&[("t1", true, false)]));
        assert_eq!(
            tracker.ingest_states(states(&[("t1", true, true)])).len(),
            1
        );
        // still waiting on the next snapshot -> no new event
        assert!(tracker
            .ingest_states(states(&[("t1", true, true)]))
            .is_empty());
    }

    #[test]
    fn format_copy_matches_client() {
        let needs = format_push_notification(
            &PushJob::new(PushKind::NeedsInput, "t1").with_name(Some("Build".into())),
        );
        assert_eq!(needs.title, "Agent needs your input");
        assert_eq!(needs.body, "Build is waiting for you.");
        assert_eq!(needs.tag, "thread-t1-needs_input");

        let done = format_push_notification(&PushJob::new(PushKind::Completed, "t1"));
        assert_eq!(done.title, "Agent finished");
        assert_eq!(done.body, "A thread completed its turn.");
    }

    #[test]
    fn rejects_non_https_and_internal_push_endpoints() {
        assert!(is_acceptable_push_endpoint(
            "https://fcm.googleapis.com/fcm/send/abc"
        ));
        assert!(is_acceptable_push_endpoint(
            "https://updates.push.services.mozilla.com/wpush/v2/xyz"
        ));
        assert!(!is_acceptable_push_endpoint("http://fcm.googleapis.com/x"));
        assert!(!is_acceptable_push_endpoint("https://localhost/x"));
        assert!(!is_acceptable_push_endpoint("https://127.0.0.1/x"));
        assert!(!is_acceptable_push_endpoint("https://169.254.169.254/meta"));
        assert!(!is_acceptable_push_endpoint("https://10.0.0.5/x"));
        assert!(!is_acceptable_push_endpoint("https://192.168.1.1/x"));
        assert!(!is_acceptable_push_endpoint("not a url"));
        // IPv6 internal targets (incl. IPv4-mapped loopback/private) must also be rejected.
        assert!(!is_acceptable_push_endpoint("https://[::1]/x"));
        assert!(!is_acceptable_push_endpoint("https://[::ffff:127.0.0.1]/x"));
        assert!(!is_acceptable_push_endpoint("https://[::ffff:10.0.0.5]/x"));
        assert!(!is_acceptable_push_endpoint("https://[fc00::1]/x"));
        assert!(!is_acceptable_push_endpoint("https://[fe80::1]/x"));
        // A public IPv6 literal is still acceptable.
        assert!(is_acceptable_push_endpoint(
            "https://[2606:4700:4700::1111]/x"
        ));
    }

    #[tokio::test]
    async fn push_client_does_not_follow_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // A server that 302-redirects to a port nothing listens on. If the client
        // follows the redirect it errors (connection refused); if it does not, it
        // returns the 302 itself. This guards against a registered public-https
        // endpoint redirecting the relay to an internal address (SSRF).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/internal\r\nContent-Length: 0\r\n\r\n",
                    )
                    .await;
                let _ = sock.flush().await;
            }
        });

        let response = push_client(no_dns())
            .get(format!("http://{addr}/redirect"))
            .send()
            .await
            .expect("request must not error (the client must not follow the redirect)");
        assert_eq!(
            response.status().as_u16(),
            302,
            "push client must not follow redirects (SSRF guard)"
        );
    }

    #[tokio::test]
    async fn dispatcher_skips_subscription_when_device_revoked_mid_batch() {
        // One device, two subscriptions, sent in order. When the first send looks up its host
        // the phone is revoked and re-paired at once, which does not bring its subscriptions
        // back — after the batch was cloned, before the second send.
        let relay = test_relay();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let lookup: Lookup = {
            let relay = relay.clone();
            let seen = seen.clone();
            Arc::new(move |host: String| {
                let relay = relay.clone();
                seen.lock().unwrap().push(host);
                Box::pin(async move {
                    let mut relay = relay.write().await;
                    let device = relay.paired_devices["phone"].clone();
                    relay.revoke_paired_device("phone", 1);
                    relay.paired_devices.insert("phone".to_string(), device);
                    Err(std::io::Error::other("no DNS in tests"))
                })
            })
        };
        {
            let mut guard = relay.write().await;
            pair(&mut guard, "phone", Vec::new());
            guard.push_subscriptions.insert(
                "phone".to_string(),
                vec![
                    stored_subscription("phone", "https://s1.push.test/".to_string()),
                    stored_subscription("phone", "https://s2.push.test/".to_string()),
                ],
            );
        }

        deliver(&relay, lookup).await;

        assert_eq!(
            *seen.lock().unwrap(),
            vec!["s1.push.test".to_string()],
            "the second subscription must be skipped once the device is revoked mid-batch"
        );
    }

    // A notification names the session, so a device limited to other folders must not
    // get one for it.
    #[tokio::test]
    async fn a_folder_limited_device_is_not_notified_about_a_session_outside_its_folder() {
        let canonical = |dir: &tempfile::TempDir| {
            std::fs::canonicalize(dir.path())
                .expect("tempdir canonicalizes")
                .to_string_lossy()
                .to_string()
        };
        let phone_dir = tempfile::TempDir::new().expect("phone tempdir");
        let session_dir = tempfile::TempDir::new().expect("session tempdir");
        let relay = test_relay();
        {
            let mut guard = relay.write().await;
            for (device, path_scope) in [
                ("limited", vec![canonical(&phone_dir)]),
                ("inside", vec![canonical(&session_dir)]),
                ("open", Vec::new()),
            ] {
                pair(&mut guard, device, path_scope);
                guard.push_subscriptions.insert(
                    device.to_string(),
                    vec![stored_subscription(
                        device,
                        format!("https://{device}.push.test/"),
                    )],
                );
            }
            guard.ensure_runtime_for_thread("t1").current_cwd = canonical(&session_dir);
        }

        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        deliver(&relay, recording_lookup(seen.clone())).await;

        let seen = seen.lock().unwrap().clone();
        assert!(
            seen.contains(&"open.push.test".to_string()),
            "an unlimited device is notified"
        );
        assert!(
            seen.contains(&"inside.push.test".to_string()),
            "a device limited to this folder is notified"
        );
        assert!(
            !seen.contains(&"limited.push.test".to_string()),
            "the folder-limited device was notified (saw {seen:?})"
        );
    }

    // The bypass: a name that passes registration and then resolves to the relay's own
    // network. Loopback stands in for every non-public range; the address table covers each.
    #[tokio::test]
    async fn a_registered_name_that_resolves_inward_is_never_dialed() {
        for (bind, answer) in [
            ("127.0.0.1:0", &["127.0.0.1"][..]),
            ("[::1]:0", &["::1"][..]),
            ("127.0.0.1:0", &["::ffff:127.0.0.1"][..]),
            // Mixed answer: the inward address is first, so a connector falling back
            // through the list would reach it before the public one.
            ("127.0.0.1:0", &["127.0.0.1", "2606:4700:4700::1111"][..]),
        ] {
            let (relay, dialed) = registered_attacker_endpoint(bind).await;
            deliver(&relay, fixed_lookup(answer)).await;
            assert_eq!(
                dialed.load(std::sync::atomic::Ordering::SeqCst),
                0,
                "a push to a name answering {answer:?} connected to {bind}"
            );
        }
    }

    #[tokio::test]
    async fn dns_that_changes_after_registration_is_checked_again_at_delivery() {
        let (relay, dialed) = registered_attacker_endpoint("127.0.0.1:0").await;
        let answer = Arc::new(std::sync::Mutex::new(vec![IpAddr::from([
            216, 239, 36, 55,
        ])]));
        let lookup: Lookup = {
            let answer = answer.clone();
            Arc::new(move |_host: String| {
                let answer = answer.lock().unwrap().clone();
                Box::pin(async move { Ok(answer) })
            })
        };
        assert!(
            resolve_with(lookup.clone()).await.is_ok(),
            "the name starts out public"
        );

        *answer.lock().unwrap() = vec![IpAddr::from([127, 0, 0, 1])];
        deliver(&relay, lookup).await;

        assert_eq!(
            dialed.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a name that was public earlier must not be dialed once it resolves inward"
        );
    }

    #[tokio::test]
    async fn the_push_resolver_refuses_a_name_if_any_answer_is_not_public() {
        let public = resolve_with(fixed_lookup(&[
            "216.239.36.55",
            "2001:4860:4860::8888",
            "::ffff:17.188.172.31",
        ]))
        .await
        .expect("all-public answers pass");
        assert_eq!(
            public,
            vec![
                "216.239.36.55:0".parse::<SocketAddr>().unwrap(),
                "[2001:4860:4860::8888]:0".parse().unwrap(),
                "[::ffff:17.188.172.31]:0".parse().unwrap(),
            ],
            "port 0 leaves the port to the endpoint URL"
        );

        for answer in [
            &["216.239.36.55", "192.168.1.20"][..],
            &["10.0.0.5", "216.239.36.55"][..],
            &["2001:4860:4860::8888", "fd00::1"][..],
            &["216.239.36.55", "::ffff:169.254.169.254"][..],
        ] {
            assert!(
                resolve_with(fixed_lookup(answer)).await.is_err(),
                "an answer of {answer:?} must refuse the whole name"
            );
        }
        assert!(resolve_with(no_dns()).await.is_err());
    }

    // One policy for addresses in the URL and addresses DNS returns at send time.
    #[tokio::test]
    async fn push_destinations_must_be_public_addresses() {
        let cases: &[(&str, bool)] = &[
            ("216.239.36.55", true),
            ("17.188.172.31", true),
            ("151.101.205.91", true),
            ("1.1.1.1", true),
            ("11.0.0.1", true),
            ("100.63.255.255", true),
            ("100.128.0.1", true),
            ("172.15.255.255", true),
            ("172.32.0.1", true),
            ("198.17.255.255", true),
            ("198.20.0.1", true),
            ("223.255.255.254", true),
            ("0.0.0.0", false),
            ("0.1.2.3", false),
            ("10.0.0.5", false),
            ("100.64.0.1", false),
            ("100.100.100.100", false),
            ("127.0.0.1", false),
            ("127.8.8.8", false),
            ("169.254.169.254", false),
            ("172.16.0.1", false),
            ("172.31.255.255", false),
            ("192.0.0.170", false),
            ("192.0.2.1", false),
            ("192.168.1.20", false),
            ("198.18.0.1", true),
            ("198.19.255.255", true),
            ("198.51.100.1", false),
            ("203.0.113.1", false),
            ("224.0.0.251", false),
            ("239.255.255.250", false),
            ("240.0.0.1", false),
            ("255.255.255.255", false),
            ("2606:4700:4700::1111", true),
            ("2001:4860:4860::8888", true),
            ("2a00:1450:4001::200e", true),
            ("::ffff:216.239.36.55", true),
            ("::", false),
            ("::1", false),
            ("::ffff:127.0.0.1", false),
            ("::ffff:192.168.1.20", false),
            ("::ffff:169.254.169.254", false),
            ("::ffff:100.64.0.1", false),
            ("::127.0.0.1", false),
            ("64:ff9b::c0a8:114", false),
            ("100::1", false),
            ("fc00::1", false),
            ("fd12:3456::1", false),
            ("fe80::1", false),
            ("fec0::1", false),
            ("ff02::1", false),
            ("2001::1", false),
            ("2001:2::1", false),
            ("2001:db8::1", false),
            ("2002:c0a8:114::1", false),
            ("3fff::1", false),
        ];
        for &(ip, public) in cases {
            assert_eq!(
                resolve_with(fixed_lookup(&[ip])).await.is_ok(),
                public,
                "a name resolving to {ip}"
            );
            let literal = match ip.parse::<IpAddr>().unwrap() {
                IpAddr::V4(_) => format!("https://{ip}/push"),
                IpAddr::V6(_) => format!("https://[{ip}]/push"),
            };
            assert_eq!(is_acceptable_push_endpoint(&literal), public, "{literal}");
        }
    }

    // A stored row may predate the current rules, so registration is not the last check.
    #[tokio::test]
    async fn stored_endpoints_are_rechecked_before_every_send() {
        let (port, dialed) = counting_listener("127.0.0.1:0").await;
        let relay = test_relay();
        {
            let mut guard = relay.write().await;
            pair(&mut guard, "phone", Vec::new());
            guard.push_subscriptions.insert(
                "phone".to_string(),
                vec![
                    stored_subscription("phone", format!("https://127.0.0.1:{port}/old")),
                    stored_subscription("phone", "http://plain.push.test/old".to_string()),
                ],
            );
        }
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

        deliver(&relay, recording_lookup(seen.clone())).await;

        assert_eq!(
            dialed.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a stored loopback literal was dialed"
        );
        assert!(
            seen.lock().unwrap().is_empty(),
            "a stored plain-http endpoint was sent to"
        );
        assert!(
            relay.read().await.push_subscriptions.is_empty(),
            "endpoints that can never pass are pruned"
        );
    }

    const PROXY_PROBE_ENV: &str = "SEALWIRE_PUSH_PROXY_PROBE";

    // Users who need a proxy to reach the push services keep working, including a proxy
    // named by a host that resolves to a loopback or LAN address.
    #[tokio::test]
    async fn push_requests_go_through_a_proxy_set_in_the_environment() {
        let (port, dialed) = counting_listener("127.0.0.1:0").await;
        let proxy = format!("http://localhost:{port}");
        let probe = format!(
            "{}::push_proxy_probe",
            module_path!().split_once("::").unwrap().1
        );
        // Proxy settings are read from the process environment, so the probe runs in a child.
        let output = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([probe.as_str(), "--exact", "--ignored"])
            .env(PROXY_PROBE_ENV, "1")
            .env("HTTPS_PROXY", &proxy)
            .env_remove("https_proxy")
            .env_remove("ALL_PROXY")
            .env_remove("all_proxy")
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .output()
            .await
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "the probe did not run: {stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            dialed.load(std::sync::atomic::Ordering::SeqCst) > 0,
            "the push did not go through the proxy in HTTPS_PROXY"
        );
    }

    #[tokio::test]
    #[ignore = "run by push_requests_go_through_a_proxy_set_in_the_environment"]
    async fn push_proxy_probe() {
        if std::env::var_os(PROXY_PROBE_ENV).is_none() {
            return;
        }
        let _ = build_push_client(no_dns(), proxy_configured())
            .expect("push client")
            .post("https://notify.attacker.test/push")
            .send()
            .await;
    }

    #[test]
    fn registering_identical_push_subscription_is_a_noop() {
        // The client re-asserts its subscription to the relay on every load (the
        // register action is fire-and-forget and can be lost), so an identical
        // re-register must be free: no re-insert, no notify (no spurious
        // broadcast/persist). A rotated key on the same endpoint must still update.
        let (change_tx, rx) = tokio::sync::watch::channel(0_u64);
        let mut relay = RelayState::new(
            "/tmp/push-noop".to_string(),
            change_tx,
            crate::state::SecurityProfile::private(),
        );
        relay.paired_devices.insert(
            "dev".to_string(),
            crate::state::relay::device::PairedDevice {
                device_id: "dev".to_string(),
                label: "Dev".to_string(),
                payload_secret: "secret".to_string(),
                device_verify_key: "verify-key".to_string(),
                created_at: 0,
                last_seen_at: None,
                last_peer_id: None,
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
                pairing_broker: None,
            },
        );
        let input = || PushSubscriptionInput {
            endpoint: "https://push.example.com/e".to_string(),
            keys: PushSubscriptionKeys {
                p256dh: "p".to_string(),
                auth: "a".to_string(),
            },
            device_id: Some("dev".to_string()),
        };

        relay.register_push_subscription(input()).unwrap();
        let rev_after_first = *rx.borrow();

        // Identical re-register: no notify, no duplicate.
        relay.register_push_subscription(input()).unwrap();
        assert_eq!(
            *rx.borrow(),
            rev_after_first,
            "identical re-register must not bump the revision / notify"
        );
        assert_eq!(
            relay.push_subscriptions.get("dev").map(|v| v.len()),
            Some(1),
            "identical re-register must not create a duplicate"
        );

        // Same endpoint, rotated keys: must still update (and notify).
        relay
            .register_push_subscription(PushSubscriptionInput {
                endpoint: "https://push.example.com/e".to_string(),
                keys: PushSubscriptionKeys {
                    p256dh: "p2".to_string(),
                    auth: "a2".to_string(),
                },
                device_id: Some("dev".to_string()),
            })
            .unwrap();
        assert_ne!(
            *rx.borrow(),
            rev_after_first,
            "a rotated key on the same endpoint must still update / notify"
        );
    }

    #[test]
    fn vapid_keygen_roundtrips() {
        let first = test_vapid();
        // public key is an uncompressed P-256 point: 65 bytes, 0x04 prefix.
        let raw = b64url_decode(first.public_b64url()).unwrap();
        assert_eq!(raw.len(), 65);
        assert_eq!(raw[0], 0x04);
    }

    // Test-only receiver side: ECDH + same derivation, then AES-128-GCM decrypt.
    fn decrypt_aes128gcm(ua_secret: &SecretKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
        let salt = &body[0..16];
        let idlen = body[20] as usize;
        let keyid = &body[21..21 + idlen]; // sender (as) public
        let ciphertext = &body[21 + idlen..];
        let ua_public = ua_secret.public_key().to_encoded_point(false);

        let as_public = PublicKey::from_sec1_bytes(keyid).unwrap();
        let shared = diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());
        let ecdh_secret = shared.raw_secret_bytes();

        let mut key_info = Vec::new();
        key_info.extend_from_slice(b"WebPush: info\0");
        key_info.extend_from_slice(ua_public.as_bytes());
        key_info.extend_from_slice(keyid);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(auth), ecdh_secret.as_slice())
            .expand(&key_info, &mut ikm)
            .unwrap();

        let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let mut cek = [0u8; 16];
        hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
            .unwrap();
        let mut nonce = [0u8; 12];
        hk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();

        let cipher = Aes128Gcm::new(Key::<Aes128Gcm>::from_slice(&cek));
        let mut plain = cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext)
            .unwrap();
        // strip the 0x02 last-record delimiter
        assert_eq!(plain.pop(), Some(0x02));
        plain
    }

    // RFC 8291 Appendix A fixed vectors: receiver keypair + auth + sender (as)
    // private key. We don't hard-code the published ciphertext (avoids a brittle
    // transcription); instead we (a) confirm our as_public is derived correctly
    // from the vector's as_private, and (b) round-trip decrypt with the vector's
    // receiver private key. Together these exercise ECDH, the RFC 8291 IKM, the
    // RFC 8188 CEK/nonce derivation, and AES-128-GCM against known keys.
    #[test]
    fn webpush_encrypt_roundtrips_rfc8291_vectors() {
        let plaintext = b"When I grow up, I want to be a watermelon";
        let auth = b64url_decode("BTBZMqHH6r4Tts7J_aSIgg").unwrap();
        // Receiver (UA) private/public from RFC 8291 A.1/A.2.
        let ua_private = b64url_decode("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94").unwrap();
        let ua_public_expected =
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
        let ua_secret = SecretKey::from_slice(&ua_private).unwrap();
        let ua_public_point = ua_secret.public_key().to_encoded_point(false);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(ua_public_point.as_bytes()),
            ua_public_expected,
            "receiver public key derivation"
        );

        // Sender (AS) private from RFC 8291 A.2, and its expected public.
        let as_private = b64url_decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw").unwrap();
        let as_public_expected =
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
        let as_secret = SecretKey::from_slice(&as_private).unwrap();
        let as_public_point = as_secret.public_key().to_encoded_point(false);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(as_public_point.as_bytes()),
            as_public_expected,
            "sender public key derivation (catches scalar/point errors)"
        );

        let salt: [u8; 16] = b64url_decode("DGv6ra1nlYgDCS1FRnbzlw")
            .unwrap()
            .try_into()
            .unwrap();
        let body = encrypt_aes128gcm_with(
            ua_public_point.as_bytes(),
            &auth,
            plaintext,
            &as_secret,
            &salt,
        )
        .unwrap();

        // Header sanity: salt + rs + idlen=65 + keyid==as_public.
        assert_eq!(&body[0..16], salt.as_slice());
        assert_eq!(&body[16..20], &PUSH_RECORD_SIZE.to_be_bytes());
        assert_eq!(body[20], 65);
        assert_eq!(&body[21..86], as_public_point.as_bytes());

        // Golden: the full body must equal the RFC 8291 Appendix A.2 published
        // aes128gcm vector. A wrong info string / derivation would still round-trip
        // internally (encrypt+decrypt share the helpers) but fail HERE — this is
        // the only check that pins us to the spec rather than to ourselves.
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
            "encrypted body must match the RFC 8291 A.2 vector"
        );

        // Round-trip with the receiver private key recovers the plaintext.
        let recovered = decrypt_aes128gcm(&ua_secret, &auth, &body);
        assert_eq!(recovered, plaintext);
    }

    // A stored key that cannot be read is NOT missing: minting a new one would rotate
    // the VAPID identity and silently break every existing push subscription.
    #[test]
    fn a_stored_vapid_key_that_cannot_be_read_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sealwire.db");
        let store = crate::usage::store::UsageStore::open(&path);
        store
            .with_connection(|conn| {
                crate::state::put_credential(
                    conn,
                    VAPID_CREDENTIAL_KIND,
                    "",
                    "not base64 at all!",
                    None,
                    1,
                )
                .map_err(|error| error.to_string())
            })
            .unwrap();

        assert!(
            load_or_generate_vapid(&store).is_err(),
            "an unreadable key must surface, not silently regenerate"
        );
        let kept = rusqlite::Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT secret FROM credential WHERE kind = ?1",
                [VAPID_CREDENTIAL_KIND],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(
            kept, "not base64 at all!",
            "the stored key must be left as it was"
        );
    }
}
