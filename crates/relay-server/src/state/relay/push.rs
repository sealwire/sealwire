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
use std::path::{Path, PathBuf};
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
use tracing::{debug, warn};

use super::{thread_status_is_working, RelayState};
use crate::protocol::SessionSnapshot;

/// How long a VAPID JWT stays valid. RFC 8292 caps this at 24h; 12h leaves slack.
const VAPID_TOKEN_TTL_SECS: u64 = 12 * 60 * 60;
/// `TTL` header on the push (how long the push service may hold an undelivered
/// message). A few hours is plenty for an "agent needs you" nudge.
const PUSH_MESSAGE_TTL_SECS: u64 = 6 * 60 * 60;
/// RFC 8188 record size. Our payloads are tiny; any value above the record fits.
const PUSH_RECORD_SIZE: u32 = 4096;

/// Default VAPID `sub` contact. Overridable via `RELAY_VAPID_SUBJECT`.
const DEFAULT_VAPID_SUBJECT: &str = "mailto:sealwire@localhost";
/// Default on-disk location of the persisted VAPID private scalar.
pub(crate) const DEFAULT_VAPID_KEY_FILE: &str = ".agent-relay/vapid.key";

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

    // Approvals / ask-user questions are attributed to their own thread_id
    // (fall back to the active thread for legacy/empty ids).
    for approval in &snapshot.pending_approvals {
        let id = if approval.thread_id.is_empty() {
            active.clone()
        } else {
            Some(approval.thread_id.clone())
        };
        if let Some(id) = id {
            states.entry(id).or_default().needs_input = true;
        }
    }
    for question in &snapshot.pending_ask_user_questions {
        let id = if question.thread_id.is_empty() {
            active.clone()
        } else {
            Some(question.thread_id.clone())
        };
        if let Some(id) = id {
            states.entry(id).or_default().needs_input = true;
        }
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

/// Resolve the VAPID key path (env `RELAY_VAPID_KEY_PATH`, else `<cwd>/.agent-relay/vapid.key`).
pub(crate) fn vapid_key_path(cwd: &Path) -> PathBuf {
    std::env::var_os("RELAY_VAPID_KEY_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.join(DEFAULT_VAPID_KEY_FILE))
}

/// Load the VAPID private scalar from `path`, generating + persisting one on
/// first run. Stored as a base64url-encoded 32-byte scalar (not PEM — avoids the
/// pkcs8 feature dance and is trivially round-trippable).
pub fn load_or_generate_vapid(path: &Path) -> Result<VapidKeys, String> {
    let subject =
        std::env::var("RELAY_VAPID_SUBJECT").unwrap_or_else(|_| DEFAULT_VAPID_SUBJECT.to_string());

    if let Ok(contents) = std::fs::read_to_string(path) {
        let scalar = b64url_decode(contents.trim())
            .map_err(|e| format!("failed to decode VAPID key at {}: {e}", path.display()))?;
        let signing_key = SigningKey::from_slice(&scalar)
            .map_err(|e| format!("invalid VAPID key at {}: {e}", path.display()))?;
        let public_b64url = vapid_public_b64url(&signing_key);
        return Ok(VapidKeys {
            signing_key,
            public_b64url,
            subject,
        });
    }

    let signing_key = SigningKey::random(&mut OsRng);
    let scalar = signing_key.to_bytes();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::write(path, URL_SAFE_NO_PAD.encode(scalar)) {
        warn!(
            "failed to persist VAPID key to {}: {error}; push subscriptions will not survive restart",
            path.display()
        );
    } else {
        restrict_key_permissions(path);
    }
    let public_b64url = vapid_public_b64url(&signing_key);
    Ok(VapidKeys {
        signing_key,
        public_b64url,
        subject,
    })
}

#[cfg(unix)]
fn restrict_key_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_key_permissions(_path: &Path) {}

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
/// restrictive in practice.
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
        Some(url::Host::Ipv4(ip)) => {
            !(ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified())
        }
        Some(url::Host::Ipv6(ip)) => !(ip.is_loopback() || ip.is_unspecified()),
        None => false,
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
    ) -> mpsc::UnboundedSender<PushJob> {
        let (tx, rx) = mpsc::unbounded_channel();
        let dispatcher = Self {
            relay,
            // A per-request timeout so one hung push endpoint can't wedge the
            // serial dispatch queue.
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            vapid,
        };
        tokio::spawn(dispatcher.run(rx));
        tx
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
                warn!(endpoint = %subscription.endpoint, %error, "push request failed");
                SendOutcome::Failed
            }
        }
    }
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

    #[test]
    fn tracker_baseline_emits_nothing() {
        let mut tracker = PushAttentionTracker::new();
        assert!(tracker
            .ingest_states(states(&[("t1", true, false)]))
            .is_empty());
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
    }

    #[test]
    fn vapid_keygen_roundtrips() {
        let dir = std::env::temp_dir().join(format!("vapid-test-{}", std::process::id()));
        let path = dir.join("vapid.key");
        let _ = std::fs::remove_dir_all(&dir);
        let first = load_or_generate_vapid(&path).expect("generate");
        let second = load_or_generate_vapid(&path).expect("reload");
        assert_eq!(first.public_b64url(), second.public_b64url());
        // public key is an uncompressed P-256 point: 65 bytes, 0x04 prefix.
        let raw = b64url_decode(first.public_b64url()).unwrap();
        assert_eq!(raw.len(), 65);
        assert_eq!(raw[0], 0x04);
        let _ = std::fs::remove_dir_all(&dir);
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
}
