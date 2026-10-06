//! Phone requests through the production relay session, against a broker the test
//! scripts frame by frame. The broker can claim any `from_peer_id`, hold a frame, or send
//! it twice, which is what a hostile broker does.

use super::*;
use crate::fake_provider::FakeProviderBridge;
use sha2::{Digest, Sha256};
use tokio_tungstenite::WebSocketStream;

const ROOM: &str = "room-stalled";
const RELAY_PEER: &str = "relay-stalled";
const QUIET: Duration = Duration::from_millis(700);

/// A paired device: its id, its payload secret, and the private key only it holds.
#[derive(Clone)]
pub(super) struct Phone {
    pub(super) device_id: String,
    pub(super) secret: String,
    pub(super) key: SigningKey,
}

fn phone() -> Phone {
    Phone {
        device_id: "phone-1".to_string(),
        secret: "secret".to_string(),
        key: SigningKey::from_bytes(&[42; 32]),
    }
}

pub(super) struct Claim {
    pub(super) phone: Phone,
    pub(super) peer: String,
    pub(super) sid: String,
    pub(super) boot: String,
    relay_ms: u64,
    received: std::time::Instant,
    next_seq: u64,
}

impl Claim {
    /// The phone's estimate of the relay clock: the claim's stamp plus a monotonic
    /// elapsed time, never the phone's own wall clock.
    pub(super) fn relay_now(&self) -> u64 {
        self.relay_ms + self.received.elapsed().as_millis() as u64
    }

    fn take_seq(&mut self) -> u64 {
        self.next_seq += 1;
        self.next_seq
    }
}

/// Everything one attempt signs. Tests change one field to show it is bound.
#[derive(Clone)]
pub(super) struct Attempt {
    pub(super) key: SigningKey,
    pub(super) relay_verify_key: String,
    pub(super) room: String,
    pub(super) relay_peer: String,
    pub(super) device_id: String,
    pub(super) peer: String,
    pub(super) sid: String,
    pub(super) boot: String,
    pub(super) seq: u64,
    pub(super) time: u64,
    pub(super) action_id: String,
    pub(super) action: String,
    pub(super) op_boot: String,
    pub(super) op_t0: u64,
    pub(super) envelope: EncryptedEnvelope,
}

fn length_prefixed(domain: &[u8], fields: &[&[u8]]) -> Vec<u8> {
    let mut out = domain.to_vec();
    for field in fields {
        out.extend_from_slice(&(field.len() as u32).to_be_bytes());
        out.extend_from_slice(field);
    }
    out
}

/// The documented encoding, written out independently of the relay's own.
pub(super) fn envelope_digest_hex(envelope: &EncryptedEnvelope) -> String {
    let nonce = STANDARD
        .decode(&envelope.nonce)
        .expect("envelope nonce is base64");
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .expect("envelope ciphertext is base64");
    let digest = Sha256::digest(length_prefixed(
        b"agent-relay:remote-request-envelope-v1\0",
        &[&nonce, &ciphertext],
    ));
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Attempt {
    pub(super) fn message(&self) -> Vec<u8> {
        let version = RELAY_PROTOCOL_VERSION.to_string();
        let seq = self.seq.to_string();
        let time = self.time.to_string();
        let op_t0 = self.op_t0.to_string();
        let digest = envelope_digest_hex(&self.envelope);
        length_prefixed(
            b"agent-relay:remote-request-v1\0",
            &[
                version.as_bytes(),
                self.relay_verify_key.as_bytes(),
                self.room.as_bytes(),
                self.relay_peer.as_bytes(),
                self.device_id.as_bytes(),
                self.peer.as_bytes(),
                self.sid.as_bytes(),
                self.boot.as_bytes(),
                seq.as_bytes(),
                time.as_bytes(),
                self.action_id.as_bytes(),
                self.action.as_bytes(),
                self.op_boot.as_bytes(),
                op_t0.as_bytes(),
                digest.as_bytes(),
            ],
        )
    }

    pub(super) fn signed(&self) -> serde_json::Value {
        self.signed_by(&self.key)
    }

    pub(super) fn signed_by(&self, key: &SigningKey) -> serde_json::Value {
        let signature = STANDARD.encode(key.sign(&self.message()).to_bytes());
        self.payload_with_signature(&signature)
    }

    pub(super) fn payload_with_signature(&self, signature: &str) -> serde_json::Value {
        serde_json::json!({
            "kind": "encrypted_remote_action",
            "protocol_version": RELAY_PROTOCOL_VERSION,
            "target_peer_id": self.relay_peer,
            "action_id": self.action_id,
            "device_id": self.device_id,
            "action": self.action,
            "request_sid": self.sid,
            "request_boot": self.boot,
            "request_seq": self.seq,
            "request_time": self.time,
            "op_boot": self.op_boot,
            "op_t0": self.op_t0,
            "request_signature": signature,
            "envelope": self.envelope,
        })
    }
}

fn paired(phone: &Phone) -> crate::state::PairedDevice {
    crate::state::PairedDevice {
        device_id: phone.device_id.clone(),
        label: phone.device_id.clone(),
        payload_secret: phone.secret.clone(),
        device_verify_key: STANDARD.encode(phone.key.verifying_key().to_bytes()),
        created_at: 1,
        last_seen_at: Some(1),
        last_peer_id: None,
        broker_join_ticket_expires_at: None,
        path_scope: Vec::new(),
    }
}

pub(super) struct RelayUnderTest {
    pub(super) state: AppState,
    pub(super) relay: Arc<RwLock<RelayState>>,
    pub(super) fake: Arc<FakeProviderBridge>,
    pub(super) workspace: tempfile::TempDir,
    pub(super) relay_verify_key: String,
    pub(super) config: BrokerConfig,
    socket: WebSocketStream<tokio::net::TcpStream>,
    session: tokio::task::JoinHandle<()>,
    claims_made: u64,
}

impl Drop for RelayUnderTest {
    fn drop(&mut self) {
        self.session.abort();
    }
}

impl RelayUnderTest {
    pub(super) async fn start(surfaces: &[&str]) -> Self {
        let workspace = tempfile::TempDir::new().expect("workspace");
        let cwd = workspace.path().to_string_lossy().to_string();
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.clone(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        relay.write().await.trusted_workspaces.push(cwd.clone());
        let default_phone = phone();
        relay
            .write()
            .await
            .paired_devices
            .insert(default_phone.device_id.clone(), paired(&default_phone));
        let fake = Arc::new(
            FakeProviderBridge::spawn(relay.clone())
                .await
                .expect("fake provider"),
        );
        let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> =
            HashMap::new();
        providers.insert("fake".to_string(), fake.clone());
        let state = AppState::from_parts(relay.clone(), providers, change_tx);

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let address = listener.local_addr().expect("address");
        let config = heartbeat_test_config(format!("ws://{address}")).await;
        assert_eq!(config.broker_room_id(), ROOM);
        assert_eq!(config.relay_peer_id(), RELAY_PEER);
        let relay_verify_key = config.content_verify_key();
        let session = tokio::spawn({
            let state = state.clone();
            let config = config.clone();
            async move {
                let mut change_rx = state.subscribe();
                let _ = run_broker_session_with_liveness(
                    &state,
                    &mut change_rx,
                    &config,
                    BrokerLivenessConfig {
                        ping_interval: Duration::from_secs(30),
                        pong_timeout: Duration::from_secs(30),
                    },
                )
                .await;
            }
        });
        let (stream, _) = listener.accept().await.expect("relay connects");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake");
        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: ROOM.to_string(),
            peer_id: RELAY_PEER.to_string(),
            peers: surfaces
                .iter()
                .map(|peer| surface_peer(peer, "phone-1"))
                .collect(),
        };
        socket
            .send(Message::Text(serde_json::to_string(&welcome).unwrap()))
            .await
            .expect("welcome");
        Self {
            state,
            relay,
            fake,
            workspace,
            relay_verify_key,
            config,
            socket,
            session,
            claims_made: 0,
        }
    }

    pub(super) fn cwd(&self) -> String {
        self.workspace.path().to_string_lossy().to_string()
    }

    pub(super) async fn send_as(&mut self, from_peer: &str, payload: serde_json::Value) {
        let frame = serde_json::json!({
            "type": "message",
            "channel_id": ROOM,
            "from_peer_id": from_peer,
            "from_role": "surface",
            "payload": payload,
        });
        self.socket
            .send(Message::Text(frame.to_string()))
            .await
            .expect("broker frame sends");
    }

    pub(super) async fn presence(&mut self, peer: &str, joined: bool) {
        let frame = ServerMessage::Presence {
            channel_id: ROOM.to_string(),
            kind: if joined {
                PresenceKind::Joined
            } else {
                PresenceKind::Left
            },
            peer: surface_peer(peer, "phone-1"),
        };
        self.socket
            .send(Message::Text(serde_json::to_string(&frame).unwrap()))
            .await
            .expect("presence sends");
    }

    /// The next relay payload `matches` accepts, or `None` once `wait` passes.
    pub(super) async fn next_payload<F>(
        &mut self,
        wait: Duration,
        matches: F,
    ) -> Option<serde_json::Value>
    where
        F: Fn(&serde_json::Value) -> bool,
    {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let frame = match tokio::time::timeout_at(deadline, self.socket.next()).await {
                Err(_) => return None,
                Ok(None) => panic!("relay closed the broker socket"),
                Ok(Some(frame)) => frame.expect("relay frame"),
            };
            match frame {
                Message::Ping(payload) => {
                    let _ = self.socket.send(Message::Pong(payload)).await;
                }
                Message::Text(text) => {
                    let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let payload = &frame["payload"];
                    if payload["kind"] == "targeted_messages" {
                        for message in payload["messages"].as_array().unwrap() {
                            if matches(&message["payload"]) {
                                return Some(message["payload"].clone());
                            }
                        }
                        continue;
                    }
                    if matches(payload) {
                        return Some(payload.clone());
                    }
                }
                _ => {}
            }
        }
    }

    /// Any frame naming `action_id` for `peer`: a result, a chunk, or a notice.
    pub(super) async fn anything_for(
        &mut self,
        peer: &str,
        action_id: &str,
        wait: Duration,
    ) -> Option<serde_json::Value> {
        self.next_payload(wait, |payload| {
            payload["action_id"] == action_id && payload["target_peer_id"] == peer
        })
        .await
    }

    pub(super) async fn result_with(
        &mut self,
        secret: &str,
        peer: &str,
        action_id: &str,
        wait: Duration,
    ) -> Option<serde_json::Value> {
        let payload = self
            .next_payload(wait, |payload| {
                payload["kind"] == "encrypted_remote_action_result"
                    && payload["action_id"] == action_id
                    && payload["target_peer_id"] == peer
            })
            .await?;
        let envelope = serde_json::from_value(payload["envelope"].clone()).unwrap();
        Some(decrypt_json(secret, &envelope).expect("result decrypts"))
    }

    pub(super) async fn expect_result(&mut self, peer: &str, action_id: &str) -> serde_json::Value {
        self.result_with(&phone().secret, peer, action_id, Duration::from_secs(5))
            .await
            .unwrap_or_else(|| panic!("no result for {action_id} reached {peer}"))
    }

    pub(super) async fn expect_no_result(&mut self, peer: &str, action_id: &str) {
        if let Some(result) = self
            .result_with(&phone().secret, peer, action_id, QUIET)
            .await
        {
            panic!("{action_id} must get no answer, got {result}");
        }
    }

    /// Nothing at all comes back for this action: no result, chunk or notice.
    pub(super) async fn expect_silence(&mut self, peer: &str, action_id: &str) {
        if let Some(payload) = self.anything_for(peer, action_id, QUIET).await {
            panic!("{action_id} must get nothing back, got {payload}");
        }
    }

    pub(super) async fn expect_reauthorize(&mut self, peer: &str, action_id: &str) {
        self.next_payload(Duration::from_secs(5), |payload| {
            payload["kind"] == "remote_action_reauthorize"
                && payload["action_id"] == action_id
                && payload["target_peer_id"] == peer
        })
        .await
        .unwrap_or_else(|| panic!("{action_id} was not sent back to be re-authorized"));
    }

    pub(super) async fn hello(&mut self, peer: &str) {
        self.send_as(
            peer,
            serde_json::json!({
                "kind": "relay_hello",
                "protocol_version": RELAY_PROTOCOL_VERSION,
                "device_id": "phone-1",
                "hello_nonce": "ab".repeat(18),
            }),
        )
        .await;
        self.next_payload(Duration::from_secs(5), |payload| {
            payload["kind"] == "relay_hello_proof" && payload["target_peer_id"] == peer
        })
        .await
        .expect("relay answers the hello");
    }

    pub(super) async fn claim(&mut self, peer: &str) -> Claim {
        self.claim_as(peer, &phone()).await
    }

    /// The phone's real claim: signed challenge request, signed completion.
    pub(super) async fn claim_as(&mut self, peer: &str, phone: &Phone) -> Claim {
        self.claims_made += 1;
        let start_id = format!("claim-start-{}", self.claims_made);
        let init_proof = STANDARD.encode(
            phone
                .key
                .sign(
                    super::super::device_claim_init_proof_message(
                        &start_id,
                        &phone.device_id,
                        peer,
                    )
                    .as_bytes(),
                )
                .to_bytes(),
        );
        self.send_as(
            peer,
            serde_json::json!({
                "kind": "encrypted_remote_action",
                "protocol_version": RELAY_PROTOCOL_VERSION,
                "target_peer_id": RELAY_PEER,
                "action_id": start_id,
                "device_id": phone.device_id,
                "envelope": bound_action_envelope(&phone.secret, &start_id, &serde_json::json!({
                    "type": "claim_challenge", "proof": init_proof,
                })).unwrap(),
            }),
        )
        .await;
        let challenge = self
            .result_with(&phone.secret, peer, &start_id, Duration::from_secs(5))
            .await
            .expect("challenge reply");
        assert_eq!(challenge["ok"], true, "{challenge}");
        assert!(
            challenge["snapshot"].is_null(),
            "a claim reply carries no snapshot"
        );
        let challenge_id = challenge["claim_challenge_id"]
            .as_str()
            .unwrap()
            .to_string();
        let nonce = challenge["claim_challenge"].as_str().unwrap().to_string();
        let finish_id = format!("claim-finish-{}", self.claims_made);
        let proof = STANDARD.encode(
            phone
                .key
                .sign(
                    super::super::device_claim_proof_message(
                        &challenge_id,
                        &nonce,
                        &phone.device_id,
                        peer,
                    )
                    .as_bytes(),
                )
                .to_bytes(),
        );
        self.send_as(
            peer,
            serde_json::json!({
                "kind": "encrypted_remote_action",
                "protocol_version": RELAY_PROTOCOL_VERSION,
                "target_peer_id": RELAY_PEER,
                "action_id": finish_id,
                "device_id": phone.device_id,
                "envelope": bound_action_envelope(&phone.secret, &finish_id, &serde_json::json!({
                    "type": "claim_device",
                    "challenge_id": challenge_id,
                    "challenge": nonce,
                    "proof": proof,
                })).unwrap(),
            }),
        )
        .await;
        let received = std::time::Instant::now();
        let claimed = self
            .result_with(&phone.secret, peer, &finish_id, Duration::from_secs(5))
            .await
            .expect("claim reply");
        assert_eq!(claimed["ok"], true, "{claimed}");
        assert!(
            claimed["snapshot"].is_null(),
            "a claim reply carries no snapshot"
        );
        Claim {
            phone: phone.clone(),
            peer: peer.to_string(),
            sid: claimed["session_claim"].as_str().unwrap().to_string(),
            boot: claimed["session_claim_boot"]
                .as_str()
                .expect("a claim names its boot")
                .to_string(),
            relay_ms: claimed["session_claim_relay_ms"]
                .as_u64()
                .expect("a claim carries the relay clock"),
            received,
            next_seq: 0,
        }
    }

    /// A first attempt at an operation, the way the phone builds it.
    pub(super) fn attempt(
        &self,
        claim: &mut Claim,
        action_id: &str,
        request: serde_json::Value,
    ) -> Attempt {
        let time = claim.relay_now();
        let op_boot = claim.boot.clone();
        self.attempt_of(claim, action_id, request, op_boot, time, time)
    }

    /// Another attempt at an operation that began at `op_t0`.
    pub(super) fn attempt_of(
        &self,
        claim: &mut Claim,
        action_id: &str,
        request: serde_json::Value,
        op_boot: String,
        op_t0: u64,
        time: u64,
    ) -> Attempt {
        let action = request["type"].as_str().unwrap().to_string();
        Attempt {
            key: claim.phone.key.clone(),
            relay_verify_key: self.relay_verify_key.clone(),
            room: ROOM.to_string(),
            relay_peer: RELAY_PEER.to_string(),
            device_id: claim.phone.device_id.clone(),
            peer: claim.peer.clone(),
            sid: claim.sid.clone(),
            boot: claim.boot.clone(),
            seq: claim.take_seq(),
            time,
            action_id: action_id.to_string(),
            action,
            op_boot,
            op_t0,
            envelope: bound_action_envelope(&claim.phone.secret, action_id, &request).unwrap(),
        }
    }

    pub(super) async fn send_signed(&mut self, attempt: &Attempt) -> serde_json::Value {
        let payload = attempt.signed();
        self.send_as(&attempt.peer.clone(), payload.clone()).await;
        payload
    }

    pub(super) async fn starts(&self) -> usize {
        self.fake.started_models().await.len()
    }

    pub(super) fn start_session(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "start_session",
            "input": {"provider": "fake", "cwd": self.cwd()},
        })
    }
}

/// A broker that saved a write and plays it back once the result cache has let go of it
/// must not get the write a second time, or anything back.
#[tokio::test]
async fn a_captured_write_does_not_run_again_after_the_result_cache_forgets_it() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    let start = relay.attempt(&mut claim, "op-start", relay.start_session());
    let captured = relay.send_signed(&start).await;
    let result = relay.expect_result("surface-a", "op-start").await;
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(relay.starts().await, 1);

    relay
        .relay
        .write()
        .await
        .forget_remote_action_replays_for_test();
    relay.send_as("surface-a", captured).await;
    relay.expect_silence("surface-a", "op-start").await;
    assert_eq!(relay.starts().await, 1, "the replayed write ran again");
}

/// The broker sees every outer field. Re-addressing an old, validly signed envelope to a
/// newer claim, peer or session must not turn it into a fresh authorization.
#[tokio::test]
async fn an_old_envelope_under_a_newer_claim_peer_or_session_is_refused() {
    let mut relay = RelayUnderTest::start(&["surface-a", "surface-b"]).await;
    relay.hello("surface-a").await;
    let mut first = relay.claim("surface-a").await;
    let start = relay.attempt(&mut first, "op-old", relay.start_session());
    let captured = relay.send_signed(&start).await;
    assert_eq!(relay.expect_result("surface-a", "op-old").await["ok"], true);
    assert_eq!(relay.starts().await, 1);
    relay
        .relay
        .write()
        .await
        .forget_remote_action_replays_for_test();

    relay.hello("surface-b").await;
    let second = relay.claim("surface-b").await;
    let refreshed = relay.claim("surface-a").await;
    for (from, sid, seq) in [
        ("surface-b", second.sid.as_str(), 1_u64),
        ("surface-a", refreshed.sid.as_str(), 1),
        ("surface-b", second.sid.as_str(), 7),
    ] {
        let mut moved = captured.clone();
        moved["request_sid"] = serde_json::json!(sid);
        moved["request_seq"] = serde_json::json!(seq);
        relay.send_as(from, moved).await;
        relay.expect_silence(from, "op-old").await;
    }
    assert_eq!(relay.starts().await, 1);
}

/// A broker holding the payload secret and every session id it has seen still cannot act
/// for the phone, and what it tried does not get in the way of the phone's real request.
#[tokio::test]
async fn a_broker_with_the_payload_secret_cannot_forge_a_request() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    let attacker = SigningKey::from_bytes(&[7; 32]);
    let forged_requests = [
        relay.start_session(),
        serde_json::json!({"type": "send_message", "input": {"text": "rm -rf", "thread_id": "t1"}}),
        serde_json::json!({"type": "take_over", "input": {"thread_id": "t1"}}),
        serde_json::json!({"type": "decide_approval", "request_id": "r1", "input": {"decision": "approve"}}),
        serde_json::json!({"type": "watch_threads", "input": {"thread_ids": ["t1"]}}),
        serde_json::json!({"type": "heartbeat", "input": {}}),
    ];
    for request in forged_requests {
        let forged = relay.attempt(&mut claim, "op-shared", request);
        relay
            .send_as("surface-a", forged.signed_by(&attacker))
            .await;
        let mut unsigned = forged.payload_with_signature("");
        for field in [
            "action",
            "request_sid",
            "request_boot",
            "request_seq",
            "request_time",
            "op_boot",
            "op_t0",
            "request_signature",
        ] {
            unsigned.as_object_mut().unwrap().remove(field);
        }
        relay.send_as("surface-a", unsigned).await;
    }
    relay.expect_silence("surface-a", "op-shared").await;
    assert_eq!(relay.starts().await, 0);
    {
        let state = relay.relay.read().await;
        assert!(!state.any_device_watches_thread("t1"));
        assert_eq!(state.active_controller_device_id, None);
    }

    let real = relay.attempt(&mut claim, "op-shared", relay.start_session());
    relay.send_signed(&real).await;
    let result = relay.expect_result("surface-a", "op-shared").await;
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(relay.starts().await, 1);
}

/// First delivered more than a minute after it was signed, or stamped ahead of the relay
/// clock: not run. The phone is told to re-authorize, nothing else.
#[tokio::test]
async fn a_first_delivery_outside_the_freshness_window_never_runs() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    let now = claim.relay_now();
    let boot = claim.boot.clone();
    let late = relay.attempt_of(
        &mut claim,
        "op-late",
        relay.start_session(),
        boot.clone(),
        now - 61_000,
        now - 61_000,
    );
    relay.send_signed(&late).await;
    relay.expect_reauthorize("surface-a", "op-late").await;
    let early = relay.attempt_of(
        &mut claim,
        "op-early",
        relay.start_session(),
        boot.clone(),
        now + 30_000,
        now + 30_000,
    );
    relay.send_signed(&early).await;
    relay.expect_reauthorize("surface-a", "op-early").await;
    relay.expect_no_result("surface-a", "op-late").await;
    assert_eq!(relay.starts().await, 0);

    // Inside the window by a margin: accepted. The bound is the window, not a guess.
    let edge = relay.attempt_of(
        &mut claim,
        "op-edge",
        relay.start_session(),
        boot,
        now - 50_000,
        now - 50_000,
    );
    relay.send_signed(&edge).await;
    assert_eq!(
        relay.expect_result("surface-a", "op-edge").await["ok"],
        true
    );
    assert_eq!(relay.starts().await, 1);
}

/// Freshness bounds acceptance; preparation may outlast it without canceling the write.
#[tokio::test]
async fn an_accepted_request_runs_after_its_freshness_window_closes() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    relay.fake.hold_list_models(true);
    let signed_at = claim.relay_now() - 59_000;
    let boot = claim.boot.clone();
    let held = relay.attempt_of(
        &mut claim,
        "op-held",
        relay.start_session(),
        boot.clone(),
        signed_at,
        signed_at,
    );
    relay.send_signed(&held).await;
    wait_until_preparing(&relay, "op-held").await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    relay.fake.hold_list_models(false);
    assert_eq!(
        relay.expect_result("surface-a", "op-held").await["ok"],
        true
    );
    assert!(claim.relay_now() > signed_at + 60_000);
    assert_eq!(relay.starts().await, 1);

    let fresh_time = claim.relay_now();
    let retry = relay.attempt_of(
        &mut claim,
        "op-held",
        relay.start_session(),
        boot,
        signed_at,
        fresh_time,
    );
    relay.send_signed(&retry).await;
    assert_eq!(
        relay.expect_result("surface-a", "op-held").await["ok"],
        true
    );
    assert_eq!(relay.starts().await, 1);
}

#[tokio::test]
async fn an_accepted_request_survives_its_peer_rejoining() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut old_claim = relay.claim("surface-a").await;
    relay.fake.hold_list_models(true);
    let held = relay.attempt(
        &mut old_claim,
        "review-retired-request",
        relay.start_session(),
    );
    relay.send_signed(&held).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !relay
            .state
            .remote_write_waiter_is_current("phone-1", "review-retired-request", 0)
            .await
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the old request is admitted before departure");

    relay.presence("surface-a", false).await;
    relay.presence("surface-a", true).await;
    relay.hello("surface-a").await;
    let mut new_claim = relay.claim("surface-a").await;
    assert_ne!(old_claim.sid, new_claim.sid);
    relay.fake.hold_list_models(false);
    let result = relay
        .result_with(
            &phone().secret,
            "surface-a",
            "review-retired-request",
            QUIET,
        )
        .await;
    assert_eq!(
        relay.starts().await,
        1,
        "the accepted request was canceled by the peer rejoining"
    );
    assert!(
        result.is_none(),
        "the retired request returned business content"
    );

    let time = new_claim.relay_now();
    let retry = relay.attempt_of(
        &mut new_claim,
        "review-retired-request",
        relay.start_session(),
        held.op_boot,
        held.op_t0,
        time,
    );
    relay.send_signed(&retry).await;
    assert_eq!(
        relay
            .expect_result("surface-a", "review-retired-request")
            .await["ok"],
        true
    );
    assert_eq!(relay.starts().await, 1);
}

async fn wait_until_preparing(relay: &RelayUnderTest, action_id: &str) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !relay
            .state
            .remote_write_waiter_is_current("phone-1", action_id, 0)
            .await
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the request is admitted and preparing");
}

/// Session eviction affects later requests, not a write already accepted.
#[tokio::test]
async fn an_accepted_request_survives_its_session_being_evicted() {
    let peers = [
        "surface-a",
        "surface-b",
        "surface-c",
        "surface-d",
        "surface-e",
    ];
    let mut relay = RelayUnderTest::start(&peers).await;
    relay.hello("surface-a").await;
    let mut oldest = relay.claim("surface-a").await;
    relay.fake.hold_list_models(true);
    let held = relay.attempt(&mut oldest, "op-evicted", relay.start_session());
    relay.send_signed(&held).await;
    wait_until_preparing(&relay, "op-evicted").await;
    for peer in &peers[1..] {
        relay.hello(peer).await;
        relay.claim(peer).await;
    }
    relay.fake.hold_list_models(false);
    assert_eq!(
        relay.expect_result("surface-a", "op-evicted").await["ok"],
        true
    );
    assert_eq!(relay.starts().await, 1);
    let later = relay.attempt(&mut oldest, "after-eviction", relay.start_session());
    relay.send_signed(&later).await;
    relay
        .expect_reauthorize("surface-a", "after-eviction")
        .await;
    assert_eq!(relay.starts().await, 1);
}

/// Session expiry does not cancel accepted work; a renewed retry gets the same result.
#[tokio::test]
async fn an_accepted_request_survives_its_session_expiring() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    relay.fake.hold_list_models(true);
    let held = relay.attempt(&mut claim, "op-expired", relay.start_session());
    relay.send_signed(&held).await;
    wait_until_preparing(&relay, "op-expired").await;
    relay
        .relay
        .write()
        .await
        .expire_request_session_for_test(&claim.sid);
    relay.fake.hold_list_models(false);
    assert_eq!(
        relay.expect_result("surface-a", "op-expired").await["ok"],
        true
    );
    assert_eq!(relay.starts().await, 1);

    let mut renewed = relay.claim("surface-a").await;
    let time = renewed.relay_now();
    let retry = relay.attempt_of(
        &mut renewed,
        "op-expired",
        relay.start_session(),
        held.op_boot.clone(),
        held.op_t0,
        time,
    );
    relay.send_signed(&retry).await;
    assert_eq!(
        relay.expect_result("surface-a", "op-expired").await["ok"],
        true
    );
    assert_eq!(relay.starts().await, 1);
}

/// A reconnected retry waits for the accepted operation, without starting another one.
#[tokio::test]
async fn a_resend_waits_for_the_accepted_request_after_reconnection() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut old_claim = relay.claim("surface-a").await;
    relay.fake.hold_list_models(true);
    let held = relay.attempt(&mut old_claim, "op-taken-over", relay.start_session());
    relay.send_signed(&held).await;
    wait_until_preparing(&relay, "op-taken-over").await;

    relay.presence("surface-a", false).await;
    relay.presence("surface-a", true).await;
    relay.hello("surface-a").await;
    let mut new_claim = relay.claim("surface-a").await;
    let time = new_claim.relay_now();
    let resend = relay.attempt_of(
        &mut new_claim,
        "op-taken-over",
        relay.start_session(),
        held.op_boot.clone(),
        held.op_t0,
        time,
    );
    relay.send_signed(&resend).await;
    relay
        .next_payload(Duration::from_secs(5), |payload| {
            payload["kind"] == "remote_action_pending" && payload["action_id"] == "op-taken-over"
        })
        .await
        .expect("the resend waits behind the attempt still holding the write");
    assert_eq!(relay.starts().await, 0);
    relay.fake.hold_list_models(false);
    assert_eq!(
        relay.expect_result("surface-a", "op-taken-over").await["ok"],
        true
    );
    assert_eq!(relay.starts().await, 1);
}

/// Once its provider call has begun, an action is not stopped by its session being
/// retired: it finishes, and a later retry gets its result rather than a second run.
#[tokio::test]
async fn an_attempt_already_started_finishes_after_its_session_is_retired() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut old_claim = relay.claim("surface-a").await;
    relay.fake.set_start_thread_delay_ms(1_500);
    let started = relay.attempt(&mut old_claim, "op-started", relay.start_session());
    relay.send_signed(&started).await;
    wait_until_preparing(&relay, "op-started").await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    relay.presence("surface-a", false).await;
    relay.presence("surface-a", true).await;
    relay.hello("surface-a").await;
    let mut new_claim = relay.claim("surface-a").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while relay.starts().await == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the started provider call completes");
    let time = new_claim.relay_now();
    let retry = relay.attempt_of(
        &mut new_claim,
        "op-started",
        relay.start_session(),
        started.op_boot.clone(),
        started.op_t0,
        time,
    );
    relay.send_signed(&retry).await;
    assert_eq!(
        relay.expect_result("surface-a", "op-started").await["ok"],
        true
    );
    assert_eq!(relay.starts().await, 1);
}

/// One tab reconnecting retires only its own session: the other tab's preparing request
/// still starts.
#[tokio::test]
async fn a_tab_reconnecting_does_not_retire_another_tabs_request() {
    let mut relay = RelayUnderTest::start(&["surface-a", "surface-b"]).await;
    relay.hello("surface-a").await;
    relay.hello("surface-b").await;
    let mut tab_a = relay.claim("surface-a").await;
    relay.claim("surface-b").await;
    relay.fake.hold_list_models(true);
    let held = relay.attempt(&mut tab_a, "op-tab-a", relay.start_session());
    relay.send_signed(&held).await;
    wait_until_preparing(&relay, "op-tab-a").await;
    relay.presence("surface-b", false).await;
    relay.presence("surface-b", true).await;
    relay.hello("surface-b").await;
    relay.claim("surface-b").await;
    relay.fake.hold_list_models(false);
    assert_eq!(
        relay.expect_result("surface-a", "op-tab-a").await["ok"],
        true
    );
    assert_eq!(relay.starts().await, 1);
}

/// A request still queued when its window closes is rejected before acceptance.
#[tokio::test]
async fn a_request_that_goes_stale_in_its_surface_queue_never_runs() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    relay.fake.hold_list_models(true);
    let slow = relay.attempt(
        &mut claim,
        "op-slow-read",
        serde_json::json!({"type": "list_provider_models", "provider": "fake"}),
    );
    relay.send_signed(&slow).await;
    let signed_at = claim.relay_now() - 59_000;
    let boot = claim.boot.clone();
    let queued = relay.attempt_of(
        &mut claim,
        "op-queued",
        relay.start_session(),
        boot,
        signed_at,
        signed_at,
    );
    relay.send_signed(&queued).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    relay.fake.hold_list_models(false);
    assert_eq!(
        relay.expect_result("surface-a", "op-slow-read").await["ok"],
        true
    );
    relay.expect_reauthorize("surface-a", "op-queued").await;
    assert_eq!(relay.starts().await, 0);
}

/// Every field the phone signs is bound. A field the frame carries, changed after
/// signing; a request signed for another relay, room or recipient; or one the broker says
/// came from another connection: each is dropped unheard. The untouched request then
/// runs, so the setup was sound.
#[tokio::test]
async fn every_signed_field_is_bound() {
    let mut relay = RelayUnderTest::start(&["surface-a", "surface-b"]).await;
    relay.hello("surface-a").await;
    relay.hello("surface-b").await;
    let mut claim = relay.claim("surface-a").await;
    let other = relay.claim("surface-b").await;
    let other_request =
        serde_json::json!({"type": "start_session", "input": {"provider": "fake", "cwd": "/"}});
    type Mutation = Box<dyn Fn(&mut Attempt)>;
    let other_sid = other.sid.clone();
    let carried: Vec<(&str, Mutation)> = vec![
        ("device", Box::new(|a| a.device_id = "phone-2".into())),
        ("session", Box::new(move |a| a.sid = other_sid.clone())),
        ("boot", Box::new(|a| a.boot = "another-boot".into())),
        ("seq", Box::new(|a| a.seq += 1_000)),
        ("time", Box::new(|a| a.time -= 1)),
        ("action id", Box::new(|a| a.action_id = "op-renamed".into())),
        (
            "action kind",
            Box::new(|a| a.action = "list_threads".into()),
        ),
        ("op boot", Box::new(|a| a.op_boot = "another-boot".into())),
        ("op start", Box::new(|a| a.op_t0 -= 1)),
        (
            "body",
            Box::new(move |a| {
                a.envelope = bound_action_envelope("secret", "op-bound", &other_request).unwrap()
            }),
        ),
        (
            "envelope nonce",
            Box::new(|a| a.envelope.nonce = STANDARD.encode([5_u8; 24])),
        ),
    ];
    let meant_for_elsewhere: Vec<(&str, Mutation)> = vec![
        (
            "relay key",
            Box::new(|a| a.relay_verify_key = STANDARD.encode([9_u8; 32])),
        ),
        ("room", Box::new(|a| a.room = "room-other".into())),
        (
            "recipient",
            Box::new(|a| a.relay_peer = "relay-other".into()),
        ),
    ];
    let genuine = relay.attempt(&mut claim, "op-bound", relay.start_session());
    let signature = genuine.signed()["request_signature"]
        .as_str()
        .unwrap()
        .to_string();
    let mut cases: Vec<(String, &str, serde_json::Value)> = Vec::new();
    for (name, mutate) in &carried {
        let mut changed = genuine.clone();
        mutate(&mut changed);
        cases.push((
            format!("{name} changed after signing"),
            "surface-a",
            changed.payload_with_signature(&signature),
        ));
    }
    for (name, mutate) in &meant_for_elsewhere {
        let mut changed = genuine.clone();
        mutate(&mut changed);
        cases.push((
            format!("signed for another {name}"),
            "surface-a",
            changed.signed(),
        ));
    }
    cases.push((
        "delivered as another connection".to_string(),
        "surface-b",
        genuine.signed(),
    ));
    for (name, from, payload) in cases {
        relay.send_as(from, payload).await;
        for peer in ["surface-a", "surface-b"] {
            for action_id in ["op-bound", "op-renamed"] {
                if let Some(answer) = relay
                    .anything_for(peer, action_id, Duration::from_millis(150))
                    .await
                {
                    panic!("{name}: still got an answer: {answer}");
                }
            }
        }
        assert_eq!(relay.starts().await, 0, "{name}: still ran");
    }
    // The action kind is also checked against the sealed request, not only the signature.
    let mut mislabelled = relay.attempt(&mut claim, "op-mislabelled", relay.start_session());
    mislabelled.action = "list_threads".into();
    relay.send_signed(&mislabelled).await;
    relay.expect_silence("surface-a", "op-mislabelled").await;

    relay.send_as("surface-a", genuine.signed()).await;
    assert_eq!(
        relay.expect_result("surface-a", "op-bound").await["ok"],
        true
    );
    assert_eq!(relay.starts().await, 1);
}

/// A sequence number is spent once, and nothing older than the 256 before the highest
/// seen is accepted — whatever the request around it.
#[tokio::test]
async fn a_used_or_out_of_window_seq_is_refused() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    let list = serde_json::json!({"type": "list_threads", "query": {"limit": 5}});
    let first = relay.attempt(&mut claim, "read-1", list.clone());
    relay.send_signed(&first).await;
    assert_eq!(relay.expect_result("surface-a", "read-1").await["ok"], true);
    let mut reused = relay.attempt(&mut claim, "read-2", list.clone());
    reused.seq = first.seq;
    relay.send_signed(&reused).await;
    relay.expect_silence("surface-a", "read-2").await;

    let mut high = relay.attempt(&mut claim, "read-3", list.clone());
    high.seq = 300;
    relay.send_signed(&high).await;
    assert_eq!(relay.expect_result("surface-a", "read-3").await["ok"], true);
    let mut ancient = relay.attempt(&mut claim, "read-4", list.clone());
    ancient.seq = 44;
    relay.send_signed(&ancient).await;
    relay.expect_silence("surface-a", "read-4").await;
    let mut inside = relay.attempt(&mut claim, "read-5", list);
    inside.seq = 299;
    relay.send_signed(&inside).await;
    assert_eq!(relay.expect_result("surface-a", "read-5").await["ok"], true);
}

/// Two attempts at one write arriving together — a resend from a reconnected tab while
/// the first still runs — run it once and both get the answer.
#[tokio::test]
async fn concurrent_attempts_at_one_write_run_it_once() {
    let mut relay = RelayUnderTest::start(&["surface-a", "surface-b"]).await;
    relay.hello("surface-a").await;
    relay.hello("surface-b").await;
    let mut first = relay.claim("surface-a").await;
    let mut second = relay.claim("surface-b").await;
    relay.fake.set_start_thread_delay_ms(800);
    let original = relay.attempt(&mut first, "op-twice", relay.start_session());
    let resend_time = second.relay_now();
    let resend = relay.attempt_of(
        &mut second,
        "op-twice",
        relay.start_session(),
        original.op_boot.clone(),
        original.op_t0,
        resend_time,
    );
    relay.send_signed(&original).await;
    relay.send_signed(&resend).await;
    // Whichever attempt the relay admitted second is parked behind the other.
    let mut parked = false;
    let mut answered = std::collections::BTreeSet::new();
    while answered.len() < 2 {
        let payload = relay
            .next_payload(Duration::from_secs(5), |payload| {
                payload["action_id"] == "op-twice"
            })
            .await
            .expect("both attempts hear about the write");
        match payload["kind"].as_str() {
            Some("remote_action_pending") => parked = true,
            Some("encrypted_remote_action_result") => {
                let envelope = serde_json::from_value(payload["envelope"].clone()).unwrap();
                let result: serde_json::Value = decrypt_json("secret", &envelope).unwrap();
                assert_eq!(result["ok"], true, "{result}");
                answered.insert(payload["target_peer_id"].as_str().unwrap().to_string());
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(
        parked,
        "the later attempt was not parked behind the running write"
    );
    assert_eq!(relay.starts().await, 1);
}

/// Two tabs hold independent sessions; refreshing one's claim retires its old session
/// (re-authorize, not run) without touching the other; reads run again under a new
/// authorization once the result cache let go of them.
#[tokio::test]
async fn two_tabs_claim_refresh_and_reads_keep_working() {
    let mut relay = RelayUnderTest::start(&["surface-a", "surface-b"]).await;
    relay.hello("surface-a").await;
    relay.hello("surface-b").await;
    let mut tab_a = relay.claim("surface-a").await;
    let mut tab_b = relay.claim("surface-b").await;
    let list = serde_json::json!({"type": "list_threads", "query": {"limit": 5}});
    let read_a = relay.attempt(&mut tab_a, "tab-a-read", list.clone());
    let read_b = relay.attempt(&mut tab_b, "tab-b-read", list.clone());
    relay.send_signed(&read_a).await;
    relay.send_signed(&read_b).await;
    assert_eq!(
        relay.expect_result("surface-a", "tab-a-read").await["ok"],
        true
    );
    assert_eq!(
        relay.expect_result("surface-b", "tab-b-read").await["ok"],
        true
    );

    let mut refreshed = relay.claim("surface-a").await;
    assert_ne!(refreshed.sid, tab_a.sid);
    let stale = relay.attempt(&mut tab_a, "tab-a-stale", list.clone());
    relay.send_signed(&stale).await;
    relay.expect_reauthorize("surface-a", "tab-a-stale").await;
    let still_b = relay.attempt(&mut tab_b, "tab-b-again", list.clone());
    relay.send_signed(&still_b).await;
    assert_eq!(
        relay.expect_result("surface-b", "tab-b-again").await["ok"],
        true
    );

    // The same read, retried under the refreshed session after the cache forgot it.
    relay
        .relay
        .write()
        .await
        .forget_remote_action_replays_for_test();
    let reread_time = refreshed.relay_now();
    let reread = relay.attempt_of(
        &mut refreshed,
        "tab-a-read",
        list,
        read_a.op_boot.clone(),
        read_a.op_t0,
        reread_time,
    );
    relay.send_signed(&reread).await;
    assert_eq!(
        relay.expect_result("surface-a", "tab-a-read").await["ok"],
        true
    );
}

/// Heartbeat and watch declarations are signed and sequenced too, and answer nothing.
#[tokio::test]
async fn heartbeat_and_watch_are_authenticated_and_answer_nothing() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    let watch = relay.attempt(
        &mut claim,
        "watch-1",
        serde_json::json!({"type": "watch_threads", "input": {"thread_ids": ["thread-w"]}}),
    );
    relay.send_signed(&watch).await;
    let heartbeat = relay.attempt(
        &mut claim,
        "heartbeat-1",
        serde_json::json!({"type": "heartbeat", "input": {}}),
    );
    relay.send_signed(&heartbeat).await;
    relay.expect_silence("surface-a", "watch-1").await;
    relay.expect_silence("surface-a", "heartbeat-1").await;
    assert!(relay
        .relay
        .read()
        .await
        .any_device_watches_thread("thread-w"));
    let mut forged = relay.attempt(
        &mut claim,
        "watch-2",
        serde_json::json!({"type": "watch_threads", "input": {"thread_ids": ["thread-forged"]}}),
    );
    forged.key = SigningKey::from_bytes(&[8; 32]);
    relay.send_signed(&forged).await;
    relay.expect_silence("surface-a", "watch-2").await;
    assert!(!relay
        .relay
        .read()
        .await
        .any_device_watches_thread("thread-forged"));
}

/// A reply too big for one frame still arrives whole, chunk by signed chunk.
#[tokio::test]
async fn a_long_reply_arrives_in_chunks() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    let root = relay.workspace.path().to_path_buf();
    let run = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(&root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("git runs");
        assert!(status.success(), "git {args:?}");
    };
    run(&["init", "-q", "."]);
    run(&["config", "user.email", "test@example.test"]);
    run(&["config", "user.name", "test"]);
    let baseline: String = (0..4000).map(|i| format!("original line {i}\n")).collect();
    std::fs::write(root.join("big.txt"), baseline).unwrap();
    run(&["add", "-A"]);
    run(&["commit", "-qm", "baseline"]);
    let modified: String = (0..4000)
        .map(|i| format!("MODIFIED line {i} with padding to widen the diff\n"))
        .collect();
    std::fs::write(root.join("big.txt"), modified).unwrap();

    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    let diff = relay.attempt(
        &mut claim,
        "diff-1",
        serde_json::json!({"type": "fetch_workspace_diff"}),
    );
    relay.send_signed(&diff).await;
    let mut seen = std::collections::BTreeSet::new();
    let mut count = None;
    while count.is_none_or(|count| seen.len() < count) {
        let chunk = relay
            .next_payload(Duration::from_secs(10), |payload| {
                payload["kind"] == "encrypted_remote_action_result_chunk"
                    && payload["action_id"] == "diff-1"
            })
            .await
            .expect("the next chunk arrives");
        count = chunk["chunk_count"].as_u64().map(|value| value as usize);
        seen.insert(chunk["chunk_index"].as_u64().unwrap());
    }
    assert!(count.unwrap() > 1, "the reply was meant to need chunks");
}

/// A write first sent to another relay boot, or older than its retry window with no
/// record here, is not run again: the phone gets `outcome_unknown` and nothing else.
#[tokio::test]
async fn a_write_from_another_boot_or_past_its_retry_window_is_outcome_unknown() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    let now = claim.relay_now();
    let other_boot = relay.attempt_of(
        &mut claim,
        "op-before-restart",
        relay.start_session(),
        "a-previous-boot".to_string(),
        now,
        now,
    );
    relay.send_signed(&other_boot).await;
    let answer = relay.expect_result("surface-a", "op-before-restart").await;
    assert_eq!(answer["ok"], false, "{answer}");
    assert_eq!(answer["error_code"], "outcome_unknown");
    let boot = claim.boot.clone();
    let old = relay.attempt_of(
        &mut claim,
        "op-too-old",
        relay.start_session(),
        boot,
        now - 301_000,
        now,
    );
    relay.send_signed(&old).await;
    let answer = relay.expect_result("surface-a", "op-too-old").await;
    assert_eq!(answer["error_code"], "outcome_unknown");
    assert!(answer["snapshot"].is_null());
    assert_eq!(relay.starts().await, 0);
}

/// The freshness window bounds acceptance, not how long an accepted task may take.
#[tokio::test]
async fn an_accepted_long_task_finishes_after_its_window_closes() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    relay.fake.set_start_thread_delay_ms(2_000);
    let signed_at = claim.relay_now() - 59_000;
    let boot = claim.boot.clone();
    let long = relay.attempt_of(
        &mut claim,
        "op-long",
        relay.start_session(),
        boot,
        signed_at,
        signed_at,
    );
    relay.send_signed(&long).await;
    let answer = relay
        .result_with("secret", "surface-a", "op-long", Duration::from_secs(8))
        .await
        .expect("the long task answers");
    assert_eq!(answer["ok"], true, "{answer}");
    assert!(claim.relay_now() > signed_at + 60_000);
    assert_eq!(relay.starts().await, 1);
}

/// When the result cache has dropped a write's reply, a retry learns it ran — and it is
/// not run again.
#[tokio::test]
async fn a_retry_after_the_reply_was_dropped_is_told_it_already_ran() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    let first = relay.attempt(&mut claim, "op-done", relay.start_session());
    relay.send_signed(&first).await;
    assert_eq!(
        relay.expect_result("surface-a", "op-done").await["ok"],
        true
    );
    relay
        .relay
        .write()
        .await
        .forget_remote_action_replays_for_test();
    let time = claim.relay_now();
    let retry = relay.attempt_of(
        &mut claim,
        "op-done",
        relay.start_session(),
        first.op_boot.clone(),
        first.op_t0,
        time,
    );
    relay.send_signed(&retry).await;
    let answer = relay.expect_result("surface-a", "op-done").await;
    assert_eq!(answer["error_code"], "already_completed", "{answer}");
    assert_eq!(relay.starts().await, 1);
}

/// Revocation rejects unaccepted queued requests; a new phone pairs without the old one.
#[tokio::test]
async fn revoking_a_device_ends_its_sessions_and_a_new_phone_pairs_locally() {
    let mut relay = RelayUnderTest::start(&["surface-a", "surface-new"]).await;
    relay.hello("surface-a").await;
    let mut lost = relay.claim("surface-a").await;
    relay.fake.hold_list_models(true);
    let slow = relay.attempt(
        &mut lost,
        "slow-before-revoke",
        serde_json::json!({"type": "list_provider_models", "provider": "fake"}),
    );
    relay.send_signed(&slow).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !relay
            .state
            .remote_action_waiter_is_current("phone-1", "slow-before-revoke", 0)
            .await
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the read blocks the surface before the write is accepted");
    let queued = relay.attempt(&mut lost, "op-queued", relay.start_session());
    relay.send_signed(&queued).await;
    // The production local revoke, handed this relay's own self-hosted config rather than
    // reading the environment: the shell running tests may point at a live relay.
    let receipt = relay
        .state
        .revoke_device_with(Some(&relay.config), "phone-1")
        .await
        .expect("revoke");
    assert!(receipt.revoked);
    relay.fake.hold_list_models(false);
    relay.expect_silence("surface-a", "op-queued").await;
    assert_eq!(
        relay.starts().await,
        0,
        "a revoked device's queued write started"
    );
    let after = relay.attempt(&mut lost, "op-after", relay.start_session());
    relay.send_signed(&after).await;
    relay.expect_silence("surface-a", "op-after").await;
    assert_eq!(relay.starts().await, 0);

    // A new phone: QR on this computer, its own key, approved here.
    let ticket = relay
        .state
        .start_pairing_with(
            &relay.config,
            crate::protocol::PairingStartInput {
                expires_in_seconds: Some(600),
                path_scope: Some(Vec::new()),
            },
        )
        .await
        .expect("QR");
    let new_phone_key = SigningKey::from_bytes(&[43; 32]);
    relay.hello("surface-new").await;
    relay
        .send_as(
            "surface-new",
            serde_json::json!({
                "protocol_version": RELAY_PROTOCOL_VERSION,
                "kind": "pairing_request",
                "pairing_id": ticket.pairing_id,
                "envelope": encrypt_json(
                    &ticket.pairing_secret,
                    &PairingRequestPlaintext {
                        device_id: Some("phone-new".to_string()),
                        device_label: Some("New phone".to_string()),
                        device_verify_key: STANDARD.encode(new_phone_key.verifying_key().to_bytes()),
                        pairing_proof: STANDARD.encode(
                            new_phone_key
                                .sign(super::super::pairing_proof_message(&ticket.pairing_id, Some("phone-new")).as_bytes())
                                .to_bytes(),
                        ),
                    },
                ).unwrap(),
            }),
        )
        .await;
    for _ in 0..100 {
        if !relay
            .state
            .snapshot()
            .await
            .pending_pairing_requests
            .is_empty()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    relay
        .state
        .decide_pairing_request_with(
            &relay.config,
            &ticket.pairing_id,
            crate::protocol::PairingDecisionInput {
                decision: crate::protocol::PairingDecision::Approve,
            },
        )
        .await
        .expect("approved on this computer");
    let result = relay
        .next_payload(Duration::from_secs(5), |payload| {
            payload["kind"] == "encrypted_pairing_result"
        })
        .await
        .expect("pairing result");
    let envelope = serde_json::from_value(result["envelope"].clone()).unwrap();
    let paired_result: serde_json::Value = decrypt_json(&ticket.pairing_secret, &envelope).unwrap();
    assert_eq!(paired_result["ok"], true, "{paired_result}");
    let new_phone = Phone {
        device_id: paired_result["device"]["device_id"]
            .as_str()
            .unwrap()
            .to_string(),
        secret: paired_result["payload_secret"]
            .as_str()
            .unwrap()
            .to_string(),
        key: new_phone_key,
    };
    let mut fresh = relay.claim_as("surface-new", &new_phone).await;
    let works = relay.attempt(&mut fresh, "op-new-phone", relay.start_session());
    relay.send_signed(&works).await;
    let answer = relay
        .result_with(
            &new_phone.secret,
            "surface-new",
            "op-new-phone",
            Duration::from_secs(5),
        )
        .await
        .expect("the new phone is answered");
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(relay.starts().await, 1);
}

#[tokio::test]
async fn revoking_a_device_does_not_cancel_an_accepted_request() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    relay.fake.hold_list_models(true);
    let accepted = relay.attempt(&mut claim, "accepted-before-revoke", relay.start_session());
    relay.send_signed(&accepted).await;
    wait_until_preparing(&relay, "accepted-before-revoke").await;
    assert!(
        relay
            .state
            .revoke_device_with(Some(&relay.config), "phone-1")
            .await
            .unwrap()
            .revoked
    );
    relay.fake.hold_list_models(false);
    tokio::time::timeout(Duration::from_secs(5), async {
        while relay.starts().await == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the accepted operation still reaches the provider");
    assert_eq!(relay.starts().await, 1);
    relay
        .expect_silence("surface-a", "accepted-before-revoke")
        .await;
    let later = relay.attempt(&mut claim, "after-revoke", relay.start_session());
    relay.send_signed(&later).await;
    relay.expect_silence("surface-a", "after-revoke").await;
    assert_eq!(relay.starts().await, 1);
}

/// Reusing an action id for something else is refused, and leaves the original's record
/// and result exactly as they were for the phone's real retry. The original signed
/// attempt itself cannot fetch that result again: its sequence number is spent.
#[tokio::test]
async fn reusing_an_action_id_for_other_content_does_not_overwrite_the_original() {
    let mut relay = RelayUnderTest::start(&["surface-a"]).await;
    relay.hello("surface-a").await;
    let mut claim = relay.claim("surface-a").await;
    let first = relay.attempt(&mut claim, "op-once", relay.start_session());
    let captured = relay.send_signed(&first).await;
    let original = relay.expect_result("surface-a", "op-once").await;
    assert_eq!(original["ok"], true, "{original}");

    for other in [
        serde_json::json!({"type": "list_threads", "query": {"limit": 5}}),
        serde_json::json!({"type": "start_session", "input": {"provider": "fake", "cwd": "/elsewhere"}}),
    ] {
        let reuse = relay.attempt(&mut claim, "op-once", other);
        relay.send_signed(&reuse).await;
        let refused = relay.expect_result("surface-a", "op-once").await;
        assert_eq!(refused["ok"], false, "{refused}");
    }

    // Same operation, new attempt: new seq, new envelope nonce, same logical content.
    let now = claim.relay_now();
    let retry = relay.attempt_of(
        &mut claim,
        "op-once",
        relay.start_session(),
        first.op_boot.clone(),
        first.op_t0,
        now,
    );
    assert_ne!(retry.envelope.nonce, first.envelope.nonce);
    relay.send_signed(&retry).await;
    let replayed = relay.expect_result("surface-a", "op-once").await;
    assert_eq!(
        replayed["ok"], true,
        "the original result was overwritten: {replayed}"
    );
    relay.send_as("surface-a", captured).await;
    relay.expect_silence("surface-a", "op-once").await;
    assert_eq!(relay.starts().await, 1);
}
