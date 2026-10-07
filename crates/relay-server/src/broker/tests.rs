use std::{collections::HashMap, sync::Arc, time::Duration};

use super::*;
// The relay itself no longer writes to a socket directly (see `writer.rs`), so this
// module needs its own `SinkExt` for the fake broker it stands up.
use crate::protocol::{
    SendMessageInput, ThreadTranscriptResponse, TranscriptEntryKind, TranscriptEntryView,
};
use crate::state::{
    AppState, PendingTranscriptDelta, RelayState, SecurityProfile, TranscriptDeltaKind,
};
use axum::{extract::Path, routing::post, Json, Router};
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signer, SigningKey, Verifier};
use futures_util::{SinkExt, StreamExt};
use rand::{rngs::StdRng, SeedableRng};
use relay_broker::public_control::{
    ClientGrantRequest, ClientGrantResponse, DeviceGrantBulkRevokeRequest,
    DeviceGrantBulkRevokeResponse, DeviceGrantRequest, DeviceGrantResponse,
    DeviceGrantRevokeRequest, DeviceGrantRevokeResponse, PairingWsTokenRequest,
    PairingWsTokenResponse, RelayControlChallengeRequest, RelayControlChallengeResponse,
    RelayEnrollmentChallengeRequest, RelayEnrollmentChallengeResponse,
    RelayEnrollmentCompleteRequest, RelayEnrollmentResponse, RelayWsTokenChallengeRequest,
    RelayWsTokenChallengeResponse, RelayWsTokenRequest, RelayWsTokenResponse,
};
use tokio::time::Instant;
use tokio::{
    net::TcpListener,
    sync::{watch, RwLock},
};

use relay_broker::join_ticket::unix_now;

fn cloud_env_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

struct EnvStringGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvStringGuard {
    fn set(key: &'static str, value: Option<&str>) -> Self {
        let previous = std::env::var_os(key);
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
        Self { key, previous }
    }
}

impl Drop for EnvStringGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(previous) => std::env::set_var(self.key, previous),
            None => std::env::remove_var(self.key),
        }
    }
}

async fn write_test_public_identity(path: &str, control_url: &str, seed: [u8; 32]) {
    let parsed = crate::broker::auth::parse_control_plane_url(control_url).expect("control url");
    let identity = PublicRelayIdentity {
        signing_key: SigningKey::from_bytes(&seed),
    };
    save_public_relay_identity(std::path::Path::new(path), parsed.as_str(), &identity)
        .await
        .expect("identity should save");
}

fn stored_registration(
    db: impl AsRef<std::path::Path>,
) -> Option<PersistedPublicRelayRegistration> {
    only_public_relay_registration(db.as_ref()).unwrap()
}

/// Everything the stored registration says, to check what did and did not end up in it.
fn stored_registration_text(db: impl AsRef<std::path::Path>) -> String {
    let stored = stored_registration(db).expect("a stored registration");
    format!(
        "{} {} {} {}",
        stored.control_url, stored.relay_id, stored.broker_room_id, stored.relay_refresh_token
    )
}

fn stored_identity_seed(db: impl AsRef<std::path::Path>) -> Option<String> {
    only_public_relay_identity(db.as_ref())
        .unwrap()
        .map(|identity| identity.relay_signing_seed)
}

fn temp_registration_path(prefix: &str) -> String {
    crate::broker::temp_state_db(prefix)
}

async fn spawn_public_control_mock() -> String {
    async fn relay_enrollment_challenge(
        Json(request): Json<RelayEnrollmentChallengeRequest>,
    ) -> Json<RelayEnrollmentChallengeResponse> {
        Json(RelayEnrollmentChallengeResponse {
            relay_verify_key: request.relay_verify_key,
            challenge_id: "rch-1".to_string(),
            challenge: "rc-1".to_string(),
            expires_at: unix_now() + 300,
        })
    }

    async fn relay_enrollment_complete(
        Json(request): Json<RelayEnrollmentCompleteRequest>,
    ) -> Json<RelayEnrollmentResponse> {
        assert_eq!(request.challenge_id, "rch-1");
        let verify_key_bytes: [u8; 32] = STANDARD
            .decode(&request.relay_verify_key)
            .expect("verify key should decode")
            .try_into()
            .expect("verify key length should match");
        let verify_key =
            ed25519_dalek::VerifyingKey::from_bytes(&verify_key_bytes).expect("verify key valid");
        let signature_bytes: [u8; 64] = STANDARD
            .decode(&request.challenge_signature)
            .expect("signature should decode")
            .try_into()
            .expect("signature length should match");
        let signature = ed25519_dalek::Signature::from_bytes(&signature_bytes);
        verify_key
            .verify("agent-relay:relay-enroll:rch-1:rc-1".as_bytes(), &signature)
            .expect("signature should verify");
        Json(RelayEnrollmentResponse {
            relay_id: "relay-enrolled".to_string(),
            broker_room_id: "room-enrolled".to_string(),
            relay_refresh_token: "relay-refresh-enrolled".to_string(),
            created_at: unix_now(),
            relay_label: request.relay_label,
        })
    }

    async fn relay_ws_challenge(
        headers: axum::http::HeaderMap,
        Json(request): Json<RelayWsTokenChallengeRequest>,
    ) -> Json<RelayWsTokenChallengeResponse> {
        let bearer = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or("");
        Json(RelayWsTokenChallengeResponse {
            challenge_id: "wch-test".to_string(),
            challenge: "wc-test".to_string(),
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            relay_peer_id: request.relay_peer_id,
            broker_origin: "sealwire-broker".to_string(),
            refresh_token_hash: relay_util::sha256_hex(bearer),
            expires_at: unix_now() + 60,
        })
    }

    async fn relay_ws_token(
        Json(request): Json<RelayWsTokenRequest>,
    ) -> Json<RelayWsTokenResponse> {
        Json(RelayWsTokenResponse {
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            relay_ws_token: "relay-ws-token".to_string(),
            relay_ws_token_expires_at: 111,
        })
    }

    async fn pairing_ws_token(
        Json(request): Json<PairingWsTokenRequest>,
    ) -> Json<PairingWsTokenResponse> {
        Json(PairingWsTokenResponse {
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            pairing_join_ticket: format!("pairing-token-{}", request.pairing_id),
            pairing_join_ticket_expires_at: request.expires_at,
        })
    }

    async fn device_grant(Json(request): Json<DeviceGrantRequest>) -> Json<DeviceGrantResponse> {
        Json(DeviceGrantResponse {
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            device_id: request.device_id.clone(),
            device_refresh_token: format!("refresh-{}", request.device_id),
            device_ws_token: format!("device-ws-{}", request.device_id),
            device_ws_token_expires_at: 222,
        })
    }

    async fn client_grant(Json(request): Json<ClientGrantRequest>) -> Json<ClientGrantResponse> {
        Json(ClientGrantResponse {
            claim_id: format!("claim-for-{}", request.device_id),
            claim_nonce: format!("nonce-for-{}", request.device_id),
            claim_expires_at: 999,
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            device_id: request.device_id,
            relay_label: Some("Demo Relay".to_string()),
        })
    }

    async fn revoke_device(
        Path(device_id): Path<String>,
        Json(request): Json<DeviceGrantRevokeRequest>,
    ) -> Json<DeviceGrantRevokeResponse> {
        Json(DeviceGrantRevokeResponse {
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            device_id,
            revoked: true,
            revoked_grant_count: 1,
        })
    }

    async fn revoke_other(
        Json(request): Json<DeviceGrantBulkRevokeRequest>,
    ) -> Json<DeviceGrantBulkRevokeResponse> {
        Json(DeviceGrantBulkRevokeResponse {
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            kept_device_id: request.keep_device_id,
            revoked_device_ids: vec!["device-b".to_string()],
            revoked_count: 1,
        })
    }

    async fn relay_control_challenge(
        headers: axum::http::HeaderMap,
        Json(request): Json<RelayControlChallengeRequest>,
    ) -> Json<RelayControlChallengeResponse> {
        let header = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let token = header.strip_prefix("Bearer ").unwrap_or(header).trim();
        Json(RelayControlChallengeResponse {
            challenge_id: "cch-test".to_string(),
            challenge: "ct-test".to_string(),
            operation: request.operation,
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            broker_origin: "sealwire-broker".to_string(),
            refresh_token_hash: relay_util::sha256_hex(token),
            request_sha256: request.request_sha256,
            expires_at: unix_now() + 60,
        })
    }

    let app = Router::new()
        .route(
            "/api/public/relay-enrollment/challenge",
            post(relay_enrollment_challenge),
        )
        .route(
            "/api/public/relay/control/challenge",
            post(relay_control_challenge),
        )
        .route(
            "/api/public/relay-enrollment/complete",
            post(relay_enrollment_complete),
        )
        .route(
            "/api/public/relay/ws-token/challenge",
            post(relay_ws_challenge),
        )
        .route("/api/public/relay/ws-token", post(relay_ws_token))
        .route("/api/public/pairing/ws-token", post(pairing_ws_token))
        .route("/api/public/devices", post(device_grant))
        .route("/api/public/clients/grants", post(client_grant))
        .route("/api/public/devices/:device_id/revoke", post(revoke_device))
        .route("/api/public/devices/revoke-others", post(revoke_other));
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("mock control plane should serve");
    });
    format!("http://{address}")
}

fn broker_test_state() -> AppState {
    let (change_tx, _) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        "/tmp/broker-test".to_string(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    AppState::from_parts(relay, HashMap::new(), change_tx)
}

async fn spawn_heartbeat_test_broker(respond_to_ping: bool) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("websocket handshake should succeed");
        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-stalled".to_string(),
            peer_id: "relay-stalled".to_string(),
            peers: Vec::new(),
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome should serialize"),
            ))
            .await
            .expect("welcome should send");

        if !respond_to_ping {
            // Model a connection that remains ESTABLISHED locally after the remote
            // path has died: keep the socket open, but never read, write, close, or
            // answer Ping.
            std::future::pending::<()>().await;
            drop(socket);
            return;
        }

        while let Some(frame) = socket.next().await {
            match frame.expect("heartbeat frame should read") {
                Message::Ping(payload) => socket
                    .send(Message::Pong(payload))
                    .await
                    .expect("heartbeat pong should send"),
                Message::Close(_) => return,
                _ => {}
            }
        }
    });
    format!("ws://{address}")
}

const TEST_PHONE_SEED: [u8; 32] = [31; 32];

fn test_phone_verify_key() -> String {
    STANDARD.encode(
        SigningKey::from_bytes(&TEST_PHONE_SEED)
            .verifying_key()
            .to_bytes(),
    )
}

/// What a claim would have opened for each connection these scripts speak for.
fn seed_test_request_sessions(relay: &mut RelayState) {
    for peer in ["surface-a", "surface-b", "surface-new", "surface-old"] {
        relay.insert_request_session_for_test(&test_sid(peer), "phone-1", peer);
    }
}

fn test_sid(peer: &str) -> String {
    format!("sid-{peer}")
}

/// The scripted phone's new connection completed a claim: the session it would get.
async fn authorize_joined(relay: &Arc<RwLock<RelayState>>, peer: &str) {
    for _ in 0..60 {
        if relay.read().await.surface_peer_is_online(peer) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    relay
        .write()
        .await
        .insert_request_session_for_test(&test_sid(peer), "phone-1", peer);
}

/// A surface's frames queued behind `action_id` have been handled once it finished: they
/// were admitted or refused in microseconds after it. Refusals to a departed surface
/// produce no frame, so the scripts read the relay's own record instead.
async fn wait_for_queue_behind(relay: &Arc<RwLock<RelayState>>, action_id: &str) -> bool {
    for _ in 0..60 {
        if relay
            .read()
            .await
            .completed_remote_action("phone-1", action_id)
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(300)).await;
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

static TEST_FRAME_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A relay hello for every surface in a scripted welcome: replies are signed for a
/// content session, and only a hello opens one.
async fn send_test_hellos(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    welcome: &ServerMessage,
) {
    let ServerMessage::Welcome {
        channel_id, peers, ..
    } = welcome
    else {
        return;
    };
    for peer in peers.iter().filter(|peer| peer.role == PeerRole::Surface) {
        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "message",
                    "channel_id": channel_id,
                    "from_peer_id": peer.peer_id,
                    "from_role": "surface",
                    "payload": {
                        "kind": "relay_hello",
                        "protocol_version": RELAY_PROTOCOL_VERSION,
                        "device_id": "phone-1",
                        "hello_nonce": "cd".repeat(18),
                    }
                })
                .to_string(),
            ))
            .await
            .expect("hello sends");
    }
}

async fn heartbeat_test_config(broker_url: String) -> BrokerConfig {
    BrokerConfig::from_parts(
        Some(broker_url),
        None,
        None,
        Some("room-stalled".to_string()),
        Some("relay-stalled".to_string()),
        Some("self_hosted".to_string()),
        Some("test-broker-ticket-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("config should parse")
    .map(|mut config| {
        // Fixed so a scripted phone can sign requests before the session starts.
        config.content_signing_key =
            SigningKey::from_bytes(&super::writer::TEST_RELAY_CONTENT_SEED);
        config
    })
    .expect("config should be enabled")
}

#[tokio::test]
async fn broker_session_times_out_when_peer_goes_silent() {
    let config = heartbeat_test_config(spawn_heartbeat_test_broker(false).await).await;
    let state = broker_test_state();
    let mut change_rx = state.subscribe();

    let error = tokio::time::timeout(
        Duration::from_secs(1),
        run_broker_session_with_liveness(
            &state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_millis(50),
                pong_timeout: Duration::from_millis(25),
            },
        ),
    )
    .await
    .expect("silent broker should hit the liveness deadline")
    .expect_err("silent broker session should end");

    assert!(
        error.message().contains("heartbeat timed out"),
        "silent broker should fail with a heartbeat timeout, got: {}",
        error.message()
    );
    assert!(
        error.connected_duration().is_some(),
        "post-welcome heartbeat failures should carry connected duration"
    );
}

#[tokio::test]
async fn broker_session_stays_connected_when_peer_answers_pings() {
    let config = heartbeat_test_config(spawn_heartbeat_test_broker(true).await).await;
    let state = broker_test_state();
    let mut change_rx = state.subscribe();

    let outcome = tokio::time::timeout(
        Duration::from_millis(250),
        run_broker_session_with_liveness(
            &state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_millis(50),
                pong_timeout: Duration::from_millis(25),
            },
        ),
    )
    .await;

    assert!(
        outcome.is_err(),
        "responsive broker session should remain connected"
    );
    assert!(
        state.snapshot().await.broker_connected,
        "responsive broker should remain broker_connected"
    );
}

#[tokio::test]
async fn broker_config_builds_websocket_url() {
    let config = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        None,
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled");

    assert_eq!(config.public_base_url(), "ws://127.0.0.1:8788");
    assert_eq!(config.url.as_str(), "ws://127.0.0.1:8788/ws/demo-room");
    let relay_url = config
        .relay_connect_url()
        .await
        .expect("relay connect url should mint");
    assert!(relay_url
        .as_str()
        .starts_with("ws://127.0.0.1:8788/ws/demo-room?"));
    assert!(relay_url.as_str().contains("peer_id=relay-1"));
    assert!(relay_url.as_str().contains("role=relay"));
    assert!(relay_url
        .query_pairs()
        .any(|(key, value)| key == "client_version" && value == product_version()));
    assert!(relay_url.as_str().contains("join_ticket="));
    assert_eq!(config.auth_mode(), BrokerAuthMode::SelfHostedSharedSecret);
}

#[test]
fn product_version_matches_npm_release_version() {
    let manifest_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest_path).expect("read npm manifest"))
            .expect("parse npm manifest");
    assert_eq!(
        product_version(),
        manifest["version"].as_str().expect("npm product version")
    );
}

#[test]
fn broker_health_requires_current_relay_version_before_start() {
    let health = relay_broker::protocol::HealthResponse {
        status: "ok".to_string(),
        service: "relay-broker".to_string(),
        broker_auth_mode: "public".to_string(),
        join_auth_ready: true,
        minimum_relay_version: "0.12.0".to_string(),
        broker_protocol_version: BROKER_PROTOCOL_VERSION,
        message: None,
        public_monitoring: None,
    };
    let error = validate_broker_health(health.clone(), "0.11.9").expect_err("old client");
    assert!(error.contains("0.12.0"), "{error}");
    assert!(error.contains("npx sealwire@latest"), "{error}");
    validate_broker_health(health.clone(), "0.12.0").expect("current client");
    let wrong_protocol = relay_broker::protocol::HealthResponse {
        broker_protocol_version: BROKER_PROTOCOL_VERSION + 1,
        ..health
    };
    assert!(validate_broker_health(wrong_protocol, "0.12.0").is_err());
}

#[tokio::test]
async fn broker_config_supports_distinct_public_url_for_pairing() {
    let config = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        Some("ws://192.168.1.105:8788".to_string()),
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled");

    assert_eq!(config.public_base_url(), "ws://192.168.1.105:8788");
}

#[tokio::test]
async fn broker_config_requires_channel() {
    let error = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        None,
        None,
        None,
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("missing channel should fail");
    assert!(error.contains("RELAY_BROKER_CHANNEL_ID"));
}

#[tokio::test]
async fn broker_config_disables_when_url_is_missing() {
    let config = BrokerConfig::from_parts(
        None,
        None,
        None,
        Some("demo-room".to_string()),
        None,
        None,
        Some("test-broker-ticket-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("missing url should be accepted");
    assert!(config.is_none());
}

#[tokio::test]
async fn broker_config_rejects_invalid_public_url_scheme() {
    let error = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        Some("http://192.168.1.105:8788".to_string()),
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("invalid public url scheme should fail");
    assert!(error.contains("RELAY_BROKER_PUBLIC_URL"));
}

#[tokio::test]
async fn broker_config_requires_join_ticket_secret_in_self_hosted_mode() {
    let error = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        None,
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("self_hosted".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("missing ticket secret should fail");
    assert!(error.contains(relay_broker::join_ticket::JOIN_TICKET_SECRET_ENV));
}

#[tokio::test]
async fn broker_config_public_mode_uses_control_plane_tokens() {
    let control_url = spawn_public_control_mock().await;
    let identity_path = temp_registration_path("agent-relay-public-connect-identity");
    write_test_public_identity(&identity_path, &control_url, [4_u8; 32]).await;
    let config = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url),
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("public".to_string()),
        None,
        Some("relay-owner-1".to_string()),
        Some("relay-refresh-1".to_string()),
        Some(identity_path),
        None,
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled");

    assert_eq!(config.auth_mode(), BrokerAuthMode::PublicControlPlane);
    let relay_url = config
        .relay_connect_url()
        .await
        .expect("public mode should fetch a relay ws token");
    assert!(relay_url.as_str().contains("join_ticket=relay-ws-token"));
    let pairing = config
        .pairing_join_credential("pair-1", 123)
        .await
        .expect("public mode should fetch a pairing token");
    assert_eq!(pairing.token, "pairing-token-pair-1");
    let device = config
        .device_broker_credential("device-1", None)
        .await
        .expect("public mode should fetch a device token bundle");
    assert_eq!(device.join_credential.token, "device-ws-device-1");
    assert_eq!(device.refresh_token.as_deref(), Some("refresh-device-1"));
    let client_grant = config
        .client_broker_grant(
            "device-1",
            &STANDARD.encode([5_u8; 32]),
            Some("Phone".to_string()),
        )
        .await
        .expect("public mode should fetch a client grant")
        .expect("public mode should issue a client grant");
    assert_eq!(client_grant.claim_id, "claim-for-device-1");
    assert_eq!(client_grant.claim_nonce, "nonce-for-device-1");
    assert_eq!(client_grant.claim_expires_at, 999);
    assert_eq!(client_grant.relay_id, "relay-owner-1");
    assert_eq!(client_grant.relay_label.as_deref(), Some("Demo Relay"));
}

const REAL_BROKER_ISSUER: &str = "public-broker-issuer-secret-a3f76b4c2089d15e6b0fa873c4e9521d";

async fn spawn_real_public_broker(registrations_json: &str) -> std::net::SocketAddr {
    let state_path = temp_registration_path("agent-relay-real-broker-state");
    let plane = relay_broker::public_control::PublicControlPlane::from_parts(
        Some(REAL_BROKER_ISSUER.to_string()),
        Some(registrations_json.to_string()),
        Some(state_path),
        Some("300".to_string()),
        Some("300".to_string()),
    )
    .await
    .expect("real public control plane should configure");
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("real broker should bind");
    let address = listener
        .local_addr()
        .expect("real broker should have an address");
    let app = relay_broker::app_with_access_strategy_public_control_and_origin_guard(
        relay_broker::BrokerState::default(),
        relay_broker::standard_public_access_strategy(),
        plane,
        relay_broker::OriginGuard::from_config(None, None, false).expect("origin guard"),
    )
    .await;
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .expect("real broker should serve");
    });
    address
}

async fn ready_public_broker_config(
    broker_ws: &str,
    control_url: &str,
    state_db: &str,
    seed: [u8; 32],
    relay_id: &str,
    refresh_token: &str,
    room: &str,
    peer: &str,
) -> BrokerConfig {
    write_test_public_identity(state_db, control_url, seed).await;
    BrokerConfig::from_parts(
        Some(broker_ws.to_string()),
        Some(broker_ws.to_string()),
        Some(control_url.to_string()),
        Some(room.to_string()),
        Some(peer.to_string()),
        Some("public".to_string()),
        None,
        Some(relay_id.to_string()),
        Some(refresh_token.to_string()),
        Some(state_db.to_string()),
        None,
    )
    .await
    .expect("production config should parse")
    .expect("production config should be enabled")
}

fn join_ticket_of(url: &url::Url) -> String {
    url.query_pairs()
        .find(|(key, _)| key == "join_ticket")
        .expect("production join url should carry a ticket")
        .1
        .into_owned()
}

async fn assert_relay_welcome(url: &url::Url, peer_id: &str, seed: [u8; 32]) {
    let (mut socket, _) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .expect("production ticket should open a websocket");
    let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("join challenge should arrive on the production websocket")
        .expect("production websocket should stay open")
        .expect("challenge frame should decode");
    let text = frame.into_text().expect("challenge should be text");
    let message: relay_broker::protocol::ServerMessage =
        serde_json::from_str(&text).expect("challenge should parse");
    let relay_broker::protocol::ServerMessage::RelayJoinChallenge {
        challenge_id,
        challenge,
        broker_origin,
        relay_id,
        broker_room_id,
        relay_peer_id,
        ticket_sha256,
        relay_verify_key,
    } = message
    else {
        panic!("production relay join must challenge before welcome, got {message:?}");
    };
    let signing_key = SigningKey::from_bytes(&seed);
    assert_eq!(
        relay_verify_key,
        STANDARD.encode(signing_key.verifying_key().to_bytes()),
        "join challenge must name the enrolled key, not a caller-supplied one"
    );
    assert_eq!(relay_peer_id, peer_id);
    let proof_message = relay_broker::public_control::relay_join_message(
        &broker_origin,
        &challenge_id,
        &challenge,
        &ticket_sha256,
        &relay_id,
        &broker_room_id,
        &relay_peer_id,
    )
    .expect("join message should encode");
    let signature = STANDARD.encode(signing_key.sign(&proof_message).to_bytes());
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            serde_json::to_string(&relay_broker::protocol::ClientMessage::RelayJoinProof {
                challenge_id,
                signature,
            })
            .expect("proof should encode"),
        ))
        .await
        .expect("proof should send");
    let welcome = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("welcome should arrive after the proof")
        .expect("production websocket should stay open")
        .expect("welcome frame should decode");
    let welcome_text = welcome.into_text().expect("welcome should be text");
    let welcomed: relay_broker::protocol::ServerMessage =
        serde_json::from_str(&welcome_text).expect("welcome should parse");
    match welcomed {
        relay_broker::protocol::ServerMessage::Welcome { peer_id: got, .. } => {
            assert_eq!(got, peer_id)
        }
        other => panic!("expected welcome, got {other:?}"),
    }
}

/// Production `BrokerConfig` reads an existing identity seed and
/// `relay_connect_url` (which calls `relay_connect_credential`) is accepted by
/// a real public broker, including a second challenge for reconnect. A
/// different seed already on disk cannot mint a ticket and is left in place.
#[tokio::test]
async fn production_relay_connect_credential_is_accepted_by_a_real_public_broker() {
    let seed = [5_u8; 32];
    let verify_key = STANDARD.encode(SigningKey::from_bytes(&seed).verifying_key().to_bytes());
    let relay_id = "relay-prod-proof";
    let refresh_token = "relay-refresh-prod-proof";
    let room = "room-prod-proof";
    let peer = "relay-peer-prod";
    let registrations = serde_json::json!([{
        "relay_id": relay_id,
        "broker_room_id": room,
        "refresh_token": refresh_token,
        "relay_verify_key": verify_key,
    }]);
    let address = spawn_real_public_broker(&registrations.to_string()).await;
    let broker_ws = format!("ws://{address}");
    let control_url = format!("http://{address}");
    let identity_path = temp_registration_path("agent-relay-prod-identity");
    let config = ready_public_broker_config(
        &broker_ws,
        &control_url,
        &identity_path,
        seed,
        relay_id,
        refresh_token,
        room,
        peer,
    )
    .await;

    let first = config
        .relay_connect_url()
        .await
        .expect("matching identity should obtain a production join url");
    let first_ticket = join_ticket_of(&first);
    assert!(
        first_ticket.starts_with("eyJ"),
        "real broker should mint a signed join ticket"
    );
    assert_relay_welcome(&first, peer, seed).await;

    let second = config
        .relay_connect_url()
        .await
        .expect("a fresh challenge should mint a reconnect ticket");
    let second_ticket = join_ticket_of(&second);
    assert_ne!(first_ticket, second_ticket);
    assert_relay_welcome(&second, peer, seed).await;

    let wrong_identity = temp_registration_path("agent-relay-prod-identity-mismatch");
    let wrong_registration = wrong_identity.clone();
    let wrong = ready_public_broker_config(
        &broker_ws,
        &control_url,
        &wrong_identity,
        [9_u8; 32],
        relay_id,
        refresh_token,
        room,
        peer,
    )
    .await;
    let identity_before =
        stored_identity_seed(&wrong_identity).expect("mismatch identity should exist");
    let error = wrong
        .auth
        .relay_connect_credential(
            wrong.broker_room_id(),
            wrong.relay_peer_id(),
            &wrong.content_verify_key(),
        )
        .await
        .expect_err("mismatched identity must not obtain a ticket");
    assert!(
        !error.contains("refusing to generate"),
        "mismatch must fail closed on the existing key: {error}"
    );
    assert_eq!(
        stored_identity_seed(&wrong_identity).expect("mismatch identity should remain"),
        identity_before,
        "a rejected proof must not replace the identity file"
    );
    assert!(
        stored_registration(&wrong_registration).is_none(),
        "a rejected proof must not write a replacement registration"
    );
    let still = config
        .relay_connect_url()
        .await
        .expect("original enrollment must still accept the matching identity");
    assert_ne!(join_ticket_of(&still), second_ticket);
    assert_relay_welcome(&still, peer, seed).await;
}

/// The production session loop, not the test helper, has to answer the join
/// challenge. A ticket or the wrong key must not take that seat, and the
/// seated session has to keep receiving pongs and be able to reconnect.
#[tokio::test]
async fn production_session_proves_possession_before_the_public_broker_seats_it() {
    let seed = [5_u8; 32];
    let verify_key = STANDARD.encode(SigningKey::from_bytes(&seed).verifying_key().to_bytes());
    let relay_id = "relay-prod-session";
    let refresh_token = "relay-refresh-prod-session";
    let room = "room-prod-session";
    let peer = "relay-peer-session";
    let registrations = serde_json::json!([{
        "relay_id": relay_id,
        "broker_room_id": room,
        "refresh_token": refresh_token,
        "relay_verify_key": verify_key,
    }]);
    let address = spawn_real_public_broker(&registrations.to_string()).await;
    let broker_ws = format!("ws://{address}");
    let control_url = format!("http://{address}");
    let identity_path = temp_registration_path("agent-relay-prod-session-identity");
    let config = ready_public_broker_config(
        &broker_ws,
        &control_url,
        &identity_path,
        seed,
        relay_id,
        refresh_token,
        room,
        peer,
    )
    .await;
    let state = broker_test_state();
    {
        let mut change_rx = state.subscribe();
        // A pong still missing at the next ping ends the session, so the interval is the
        // real deadline; at 40ms a loaded runner missed it.
        let liveness = BrokerLivenessConfig {
            ping_interval: Duration::from_millis(200),
            pong_timeout: Duration::from_secs(1),
        };
        let mut session = std::pin::pin!(run_broker_session_with_liveness(
            &state,
            &mut change_rx,
            &config,
            liveness,
        ));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if state.snapshot().await.broker_connected {
                break;
            }
            if Instant::now() > deadline {
                panic!("production session did not finish the join proof");
            }
            tokio::select! {
                result = &mut session => panic!("production session ended before it was seated: {result:?}"),
                _ = tokio::time::sleep(Duration::from_millis(20)) => {}
            }
        }

        let thief_url = {
            let connect = config.relay_connect_url();
            tokio::pin!(connect);
            loop {
                tokio::select! {
                    result = &mut session => panic!("production session ended while minting a second ticket: {result:?}"),
                    url = &mut connect => break url.expect("second ticket"),
                }
            }
        };
        let attack = async {
            let (mut socket, _) = tokio_tungstenite::connect_async(thief_url.as_str())
                .await
                .expect("copied ticket should open a socket");
            let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
                .await
                .expect("join challenge should arrive")
                .expect("socket should stay open")
                .expect("frame should decode");
            let text = frame.into_text().expect("challenge should be text");
            let message: relay_broker::protocol::ServerMessage =
                serde_json::from_str(&text).expect("challenge should parse");
            let relay_broker::protocol::ServerMessage::RelayJoinChallenge {
                challenge_id,
                challenge,
                broker_origin,
                relay_id,
                broker_room_id,
                relay_peer_id,
                ticket_sha256,
                relay_verify_key,
            } = message
            else {
                panic!("ticket alone must not welcome the socket, got {message:?}");
            };
            let wrong = SigningKey::from_bytes(&[9_u8; 32]);
            assert_ne!(
                relay_verify_key,
                STANDARD.encode(wrong.verifying_key().to_bytes())
            );
            let proof_message = relay_broker::public_control::relay_join_message(
                &broker_origin,
                &challenge_id,
                &challenge,
                &ticket_sha256,
                &relay_id,
                &broker_room_id,
                &relay_peer_id,
            )
            .expect("join message");
            let signature = STANDARD.encode(wrong.sign(&proof_message).to_bytes());
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    serde_json::to_string(&relay_broker::protocol::ClientMessage::RelayJoinProof {
                        challenge_id,
                        signature,
                    })
                    .expect("proof"),
                ))
                .await
                .expect("wrong proof should send");
            let rejected = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .expect("wrong key should be answered")
                .expect("wrong-key socket should produce a frame")
                .expect("frame should decode");
            let rejected_text = match rejected {
                tokio_tungstenite::tungstenite::Message::Text(text) => text,
                tokio_tungstenite::tungstenite::Message::Close(_) => String::new(),
                other => panic!("wrong key must not be seated, got {other:?}"),
            };
            assert!(
                !rejected_text.contains("\"type\":\"welcome\""),
                "wrong key must not be welcomed: {rejected_text}"
            );
        };
        tokio::select! {
            result = &mut session => panic!("seated session ended during the stolen-ticket attempt: {result:?}"),
            _ = attack => {}
        }
        let pong_deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < pong_deadline {
            tokio::select! {
                result = &mut session => panic!("seated session ended before a broker pong: {result:?}"),
                _ = tokio::time::sleep(Duration::from_millis(20)) => {}
            }
        }
        assert!(
            state.snapshot().await.broker_connected,
            "the seated production session must still be up after the heartbeat window"
        );
    }
    state.set_broker_connection(false).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut change_rx = state.subscribe();
    let mut reconnected = std::pin::pin!(run_broker_session_with_liveness(
        &state,
        &mut change_rx,
        &config,
        BrokerLivenessConfig {
            ping_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(30),
        },
    ));
    let reconnect_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if state.snapshot().await.broker_connected {
            break;
        }
        if Instant::now() > reconnect_deadline {
            panic!("production session did not reconnect");
        }
        tokio::select! {
            result = &mut reconnected => panic!("reconnect session ended early: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
    }
}

/// Grant, client grant, revoke, bulk revoke, pairing, and unbind go through
/// the production poster against a broker that actually checks the signature.
#[tokio::test]
async fn production_callers_complete_privileged_control_on_a_real_broker() {
    let seed = [5_u8; 32];
    let verify_key = STANDARD.encode(SigningKey::from_bytes(&seed).verifying_key().to_bytes());
    let client_key = STANDARD.encode(
        SigningKey::from_bytes(&[4_u8; 32])
            .verifying_key()
            .to_bytes(),
    );
    let relay_id = "relay-prod-control";
    let refresh_token = "relay-refresh-prod-control";
    let room = "room-prod-control";
    let peer = "relay-peer-control";
    let registrations = serde_json::json!([{
        "relay_id": relay_id,
        "broker_room_id": room,
        "refresh_token": refresh_token,
        "relay_verify_key": verify_key,
    }]);
    let address = spawn_real_public_broker(&registrations.to_string()).await;
    let control_url = format!("http://{address}");
    let dir = tempfile::tempdir().expect("tempdir");
    let registration_path = dir.path().join("sealwire.db");
    let config = ready_public_broker_config(
        &format!("ws://{address}"),
        &control_url,
        registration_path.to_str().expect("state database path"),
        seed,
        relay_id,
        refresh_token,
        room,
        peer,
    )
    .await;
    save_public_relay_registration(
        &registration_path,
        &control_url,
        &PublicRelayRegistration {
            relay_id: relay_id.to_string(),
            broker_room_id: room.to_string(),
            relay_refresh_token: refresh_token.to_string(),
        },
    )
    .await
    .expect("registration should save");

    let device = config
        .auth
        .device_broker_credential(room, "device-a", None)
        .await
        .expect("production device grant");
    assert!(!device.join_credential.token.is_empty());
    let _other = config
        .auth
        .device_broker_credential(room, "device-b", None)
        .await
        .expect("second device grant");
    let client = config
        .auth
        .client_broker_grant(room, "device-a", &client_key, Some("Phone".to_string()))
        .await
        .expect("production client grant")
        .expect("public mode returns a claim");
    assert!(!client.claim_id.is_empty());
    let pairing = config
        .auth
        .pairing_join_credential(room, "pair-prod", unix_now().saturating_add(60))
        .await
        .expect("production pairing ticket");
    assert!(!pairing.token.is_empty());
    let bulk = config
        .auth
        .revoke_other_device_credentials(room, "device-a")
        .await
        .expect("production bulk revoke")
        .expect("public mode returns a bulk revoke");
    assert_eq!(bulk.kept_device_id, "device-a");
    let revoked = config
        .auth
        .revoke_device_credential(room, "device-a")
        .await
        .expect("production revoke")
        .expect("public mode returns a revoke");
    assert!(revoked.revoked);
    let outcome =
        super::access_release::release_cloud_access(&control_url, &registration_path).await;
    assert!(
        matches!(outcome, super::access_release::ReleaseOutcome::Released),
        "production unbind should release access, got {outcome:?}"
    );
}

fn claim_challenge_payload(
    device_key: &SigningKey,
    device_id: &str,
    phone_peer: &str,
    action_id: &str,
    payload_secret: &str,
) -> serde_json::Value {
    let proof = STANDARD.encode(
        device_key
            .sign(
                super::device_claim_init_proof_message(action_id, device_id, phone_peer).as_bytes(),
            )
            .to_bytes(),
    );
    let envelope = bound_action_envelope(
        payload_secret,
        action_id,
        &serde_json::json!({ "type": "claim_challenge", "proof": proof }),
    )
    .expect("claim request encrypts");
    serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "kind": "encrypted_remote_action",
        "action_id": action_id,
        "device_id": device_id,
        "envelope": envelope,
    })
}

async fn send_phone_publish(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    relay_peer: &str,
    mut payload: serde_json::Value,
) {
    if payload.get("target_peer_id").is_none() {
        payload["target_peer_id"] = serde_json::json!(relay_peer);
    }
    let request = serde_json::json!({
        "type": "publish",
        "protocol_version": BROKER_PROTOCOL_VERSION,
        "payload": payload,
    });
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            request.to_string(),
        ))
        .await
        .expect("phone publish should send");
}

async fn read_signed_relay_payload<F>(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    key: &SigningKey,
    relay_peer: &str,
    room: &str,
    matches: F,
) -> serde_json::Value
where
    F: Fn(&serde_json::Value) -> bool,
{
    let mut seen = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = socket
                .next()
                .await
                .expect("phone socket remains open")
                .expect("phone frame");
            let Ok(text) = frame.into_text() else {
                seen.push("non-text".to_string());
                continue;
            };
            let message: serde_json::Value = serde_json::from_str(&text).expect("phone json");
            let payload = &message["payload"];
            let snippet: String = text.chars().take(240).collect();
            seen.push(format!(
                "{}:{} action={} pairing={} target={} :: {snippet}",
                message["type"].as_str().unwrap_or("-"),
                payload["kind"].as_str().unwrap_or("-"),
                payload["action_id"].as_str().unwrap_or("-"),
                payload["pairing_id"].as_str().unwrap_or("-"),
                payload["target_peer_id"].as_str().unwrap_or("-"),
            ));
            if !matches(payload) {
                continue;
            }
            let session = payload["relay_content_session"]
                .as_str()
                .expect("signed payload has a session");
            let nonce = payload["relay_content_nonce"]
                .as_str()
                .expect("signed payload has a nonce");
            let signed = super::relay_content_message(
                relay_peer,
                room,
                session,
                nonce,
                payload.as_object().expect("payload object"),
            )
            .expect("content message");
            let signature: [u8; 64] = STANDARD
                .decode(
                    payload["relay_content_signature"]
                        .as_str()
                        .expect("signature"),
                )
                .expect("signature bytes")
                .try_into()
                .expect("signature length");
            key.verifying_key()
                .verify(&signed, &ed25519_dalek::Signature::from_bytes(&signature))
                .expect("surface-worker reply must verify with the pinned identity");
            return payload.clone();
        }
    })
    .await;
    result.unwrap_or_else(|_| {
        panic!("the production session must sign this surface-worker reply; saw {seen:?}")
    })
}

#[tokio::test]
async fn production_session_answers_a_phone_hello_with_the_pinned_identity() {
    let seed = [5_u8; 32];
    let key = SigningKey::from_bytes(&seed);
    let verify_key = STANDARD.encode(key.verifying_key().to_bytes());
    let room = "room-prod-content";
    let relay_peer = "relay-prod-content";
    let registrations = serde_json::json!([{
        "relay_id": "relay-content-registration",
        "broker_room_id": room,
        "refresh_token": "relay-content-refresh",
        "relay_verify_key": verify_key,
    }]);
    let address = spawn_real_public_broker(&registrations.to_string()).await;
    let dir = tempfile::tempdir().expect("temporary identity directory");
    let config = ready_public_broker_config(
        &format!("ws://{address}"),
        &format!("http://{address}"),
        dir.path().join("identity.json").to_str().unwrap(),
        seed,
        "relay-content-registration",
        "relay-content-refresh",
        room,
        relay_peer,
    )
    .await;
    let ticket = config
        .pairing_join_credential("pair-prod-content", unix_now() + 60)
        .await
        .expect("production pairing ticket");
    let state = broker_test_state();
    let mut change_rx = state.subscribe();
    let session = run_broker_session_with_liveness(
        &state,
        &mut change_rx,
        &config,
        BrokerLivenessConfig {
            ping_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(30),
        },
    );
    let phone = async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !state.snapshot().await.broker_connected {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("production relay should join");
        let mut url = url::Url::parse(&format!("ws://{address}/ws/{room}")).unwrap();
        url.query_pairs_mut()
            .append_pair("role", "surface")
            .append_pair("peer_id", "phone-prod-content")
            .append_pair("client_version", product_version())
            .append_pair("join_ticket", &ticket.token);
        let (mut socket, _) = tokio_tungstenite::connect_async(url.as_str())
            .await
            .expect("phone should connect");
        let welcome = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let welcome: serde_json::Value = serde_json::from_str(&welcome).unwrap();
        assert_eq!(welcome["type"], "welcome");
        let phone_peer = welcome["peer_id"].as_str().unwrap().to_string();
        let hello_nonce = "ab".repeat(18);
        let request = serde_json::json!({
            "type": "publish",
            "protocol_version": BROKER_PROTOCOL_VERSION,
            "payload": {
                "protocol_version": RELAY_PROTOCOL_VERSION,
                "kind": "relay_hello",
                "target_peer_id": relay_peer,
                "device_id": "phone-content-device",
                "hello_nonce": hello_nonce,
            },
        });
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                request.to_string(),
            ))
            .await
            .expect("phone hello should send");
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let frame = socket
                    .next()
                    .await
                    .expect("phone socket remains open")
                    .unwrap();
                let Ok(text) = frame.into_text() else {
                    continue;
                };
                let message: serde_json::Value = serde_json::from_str(&text).unwrap();
                let payload = &message["payload"];
                if payload["kind"] != "relay_hello_proof" {
                    continue;
                }
                assert_eq!(payload["target_peer_id"], phone_peer);
                assert_eq!(payload["hello_nonce"], hello_nonce);
                assert_eq!(payload["device_id"], "phone-content-device");
                let session = payload["relay_content_session"].as_str().unwrap();
                assert!(!session.is_empty());
                let nonce = payload["relay_content_nonce"].as_str().unwrap();
                let signed = relay_content_message(
                    relay_peer,
                    room,
                    session,
                    nonce,
                    payload.as_object().unwrap(),
                )
                .unwrap();
                let signature: [u8; 64] = STANDARD
                    .decode(payload["relay_content_signature"].as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap();
                key.verifying_key()
                    .verify(&signed, &ed25519_dalek::Signature::from_bytes(&signature))
                    .expect("phone proof must verify with the QR-pinned identity");
                break;
            }
        })
        .await
        .expect("the real production session must answer the phone hello");

        let device_id = "phone-content-device";
        let payload_secret = "payload-secret-phone-content";
        let device_seed = [9_u8; 32];
        let device_key = SigningKey::from_bytes(&device_seed);
        let retired = state
            .start_pairing_with(
                &config,
                crate::protocol::PairingStartInput {
                    expires_in_seconds: Some(600),
                    path_scope: Some(Vec::new()),
                },
            )
            .await
            .expect("first QR");
        let _current = state
            .start_pairing_with(
                &config,
                crate::protocol::PairingStartInput {
                    expires_in_seconds: Some(600),
                    path_scope: Some(Vec::new()),
                },
            )
            .await
            .expect("replacement QR");
        let pairing_proof = STANDARD.encode(
            device_key
                .sign(super::pairing_proof_message(&retired.pairing_id, Some(device_id)).as_bytes())
                .to_bytes(),
        );
        let pairing_envelope = encrypt_json(
            &retired.pairing_secret,
            &PairingRequestPlaintext {
                device_id: Some(device_id.to_string()),
                device_label: Some("Content Phone".to_string()),
                device_verify_key: STANDARD.encode(device_key.verifying_key().to_bytes()),
                pairing_proof,
            },
        )
        .expect("pairing request encrypts");
        send_phone_publish(
            &mut socket,
            relay_peer,
            serde_json::json!({
                "protocol_version": RELAY_PROTOCOL_VERSION,
                "kind": "pairing_request",
                "pairing_id": retired.pairing_id,
                "envelope": pairing_envelope,
            }),
        )
        .await;
        let pairing = read_signed_relay_payload(&mut socket, &key, relay_peer, room, |payload| {
            payload["kind"] == "encrypted_pairing_result"
        })
        .await;
        assert_eq!(pairing["target_peer_id"], phone_peer);
        assert_eq!(pairing["pairing_id"], retired.pairing_id);

        state
            .insert_paired_device_for_test(crate::state::PairedDevice {
                device_id: device_id.to_string(),
                label: "Content Phone".to_string(),
                payload_secret: payload_secret.to_string(),
                device_verify_key: STANDARD.encode(device_key.verifying_key().to_bytes()),
                created_at: 1,
                last_seen_at: Some(1),
                last_peer_id: Some(phone_peer.clone()),
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
                pairing_broker: None,
            })
            .await;
        let claim_id = "claim-live";
        send_phone_publish(
            &mut socket,
            relay_peer,
            claim_challenge_payload(
                &device_key,
                device_id,
                &phone_peer,
                claim_id,
                payload_secret,
            ),
        )
        .await;
        let claim = read_signed_relay_payload(&mut socket, &key, relay_peer, room, |payload| {
            payload["kind"] == "encrypted_remote_action_result" && payload["action_id"] == claim_id
        })
        .await;
        let claim_body: serde_json::Value = decrypt_json(
            payload_secret,
            &serde_json::from_value(claim["envelope"].clone()).expect("claim envelope"),
        )
        .expect("claim reply decrypts");
        assert!(
            claim_body["claim_challenge"]
                .as_str()
                .is_some_and(|value| !value.is_empty()),
            "the surface worker's claim reply must be the real challenge, got {claim_body}"
        );

        let replay_id = "claim-wait";
        // Claims are cached per connection, not by the phone's action id alone.
        let replay_cache_id =
            serde_json::to_string(&(phone_peer.as_str(), replay_id)).expect("claim cache key");
        state
            .reserve_remote_action(device_id, &replay_cache_id, "claim_challenge")
            .await
            .expect("pre-seed the in-flight action");
        send_phone_publish(
            &mut socket,
            relay_peer,
            claim_challenge_payload(
                &device_key,
                device_id,
                &phone_peer,
                replay_id,
                payload_secret,
            ),
        )
        .await;
        let pending = read_signed_relay_payload(&mut socket, &key, relay_peer, room, |payload| {
            payload["kind"] == "remote_action_pending" && payload["action_id"] == replay_id
        })
        .await;
        assert_eq!(pending["target_peer_id"], phone_peer);
        state
            .store_remote_action_result(
                device_id,
                &replay_cache_id,
                crate::state::CachedRemoteActionResult {
                    action_kind: "claim_challenge".to_string(),
                    ok: true,
                    snapshot: None,
                    receipt: None,
                    ask_user_answer_receipt: None,
                    providers: None,
                    models: None,
                    threads: None,
                    thread_entry_detail: None,
                    thread_transcript: None,
                    workspace_diff: None,
                    workspace_git_context: None,
                    thread_workspace: None,
                    thread_settings: None,
                    thread_skills: None,
                    reviews: None,
                    workflows: None,
                    devices: None,
                    projects: None,
                    ask_user_question_detail: None,
                    ask_detail: None,
                    session_claim: None,
                    session_claim_expires_at: None,
                    session_claim_boot: None,
                    session_claim_relay_ms: None,
                    claim_challenge_id: Some("replay-marker".to_string()),
                    claim_challenge: Some("replay-challenge".to_string()),
                    claim_challenge_expires_at: Some(4_000_000_000),
                    response_secret: Some(payload_secret.to_string()),
                    error: None,
                    error_code: None,
                },
            )
            .await;
        let replay = read_signed_relay_payload(&mut socket, &key, relay_peer, room, |payload| {
            payload["kind"] == "encrypted_remote_action_result" && payload["action_id"] == replay_id
        })
        .await;
        let replay_body: serde_json::Value = decrypt_json(
            payload_secret,
            &serde_json::from_value(replay["envelope"].clone()).expect("replay envelope"),
        )
        .expect("replay reply decrypts");
        assert_eq!(replay_body["claim_challenge_id"], "replay-marker");
    };
    tokio::select! {
        result = session => panic!("production relay ended before answering the phone: {result:?}"),
        _ = phone => {}
    }
}

/// The whole chain on production code: a real public broker, the production relay
/// session, and a phone socket that claims, signs and acts. The broker routes honestly,
/// so a replayed frame keeps its genuine sender, and is still refused.
#[tokio::test]
async fn production_session_runs_a_signed_phone_action_once_through_a_real_broker() {
    let seed = [6_u8; 32];
    let key = SigningKey::from_bytes(&seed);
    let verify_key = STANDARD.encode(key.verifying_key().to_bytes());
    let room = "room-prod-request";
    let relay_peer = "relay-prod-request";
    let registrations = serde_json::json!([{
        "relay_id": "relay-request-registration",
        "broker_room_id": room,
        "refresh_token": "relay-request-refresh",
        "relay_verify_key": verify_key,
    }]);
    let address = spawn_real_public_broker(&registrations.to_string()).await;
    let dir = tempfile::tempdir().expect("temporary identity directory");
    let config = ready_public_broker_config(
        &format!("ws://{address}"),
        &format!("http://{address}"),
        dir.path().join("identity.json").to_str().unwrap(),
        seed,
        "relay-request-registration",
        "relay-request-refresh",
        room,
        relay_peer,
    )
    .await;
    let ticket = config
        .pairing_join_credential("pair-prod-request", unix_now() + 60)
        .await
        .expect("production pairing ticket");
    let device_id = "phone-request-device";
    let payload_secret = "payload-secret-phone-request";
    let device_key = SigningKey::from_bytes(&[19_u8; 32]);
    let state = broker_test_state();
    state
        .insert_paired_device_for_test(crate::state::PairedDevice {
            device_id: device_id.to_string(),
            label: "Request Phone".to_string(),
            payload_secret: payload_secret.to_string(),
            device_verify_key: STANDARD.encode(device_key.verifying_key().to_bytes()),
            created_at: 1,
            last_seen_at: Some(1),
            last_peer_id: None,
            broker_join_ticket_expires_at: None,
            path_scope: Vec::new(),
            pairing_broker: None,
        })
        .await;
    let binding = request_auth::RelayRequestBinding {
        relay_verify_key: config.content_verify_key(),
        broker_room_id: room.to_string(),
        relay_peer_id: relay_peer.to_string(),
    };
    let mut change_rx = state.subscribe();
    let session = run_broker_session_with_liveness(
        &state,
        &mut change_rx,
        &config,
        BrokerLivenessConfig {
            ping_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(30),
        },
    );
    let phone = async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !state.snapshot().await.broker_connected {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("production relay should join");
        let mut url = url::Url::parse(&format!("ws://{address}/ws/{room}")).unwrap();
        url.query_pairs_mut()
            .append_pair("role", "surface")
            .append_pair("peer_id", "phone-prod-request")
            .append_pair("client_version", product_version())
            .append_pair("join_ticket", &ticket.token);
        let (mut socket, _) = tokio_tungstenite::connect_async(url.as_str())
            .await
            .expect("phone should connect");
        let welcome = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let welcome: serde_json::Value = serde_json::from_str(&welcome).unwrap();
        let phone_peer = welcome["peer_id"].as_str().unwrap().to_string();
        send_phone_publish(
            &mut socket,
            relay_peer,
            serde_json::json!({
                "protocol_version": RELAY_PROTOCOL_VERSION,
                "kind": "relay_hello",
                "device_id": device_id,
                "hello_nonce": "ef".repeat(18),
            }),
        )
        .await;
        read_signed_relay_payload(&mut socket, &key, relay_peer, room, |payload| {
            payload["kind"] == "relay_hello_proof"
        })
        .await;

        let open = |payload: &serde_json::Value| -> serde_json::Value {
            decrypt_json(
                payload_secret,
                &serde_json::from_value(payload["envelope"].clone()).expect("envelope"),
            )
            .expect("reply decrypts")
        };
        send_phone_publish(
            &mut socket,
            relay_peer,
            claim_challenge_payload(
                &device_key,
                device_id,
                &phone_peer,
                "claim-start",
                payload_secret,
            ),
        )
        .await;
        let challenge = open(
            &read_signed_relay_payload(&mut socket, &key, relay_peer, room, |payload| {
                payload["action_id"] == "claim-start"
            })
            .await,
        );
        let challenge_id = challenge["claim_challenge_id"].as_str().unwrap();
        let nonce = challenge["claim_challenge"].as_str().unwrap();
        let proof = STANDARD.encode(
            device_key
                .sign(
                    super::device_claim_proof_message(challenge_id, nonce, device_id, &phone_peer)
                        .as_bytes(),
                )
                .to_bytes(),
        );
        send_phone_publish(
            &mut socket,
            relay_peer,
            serde_json::json!({
                "protocol_version": RELAY_PROTOCOL_VERSION,
                "kind": "encrypted_remote_action",
                "action_id": "claim-finish",
                "device_id": device_id,
                "envelope": bound_action_envelope(payload_secret, "claim-finish", &serde_json::json!({
                    "type": "claim_device",
                    "challenge_id": challenge_id,
                    "challenge": nonce,
                    "proof": proof,
                })).unwrap(),
            }),
        )
        .await;
        let claimed = open(
            &read_signed_relay_payload(&mut socket, &key, relay_peer, room, |payload| {
                payload["action_id"] == "claim-finish"
            })
            .await,
        );
        assert_eq!(claimed["ok"], true, "{claimed}");
        assert!(claimed["snapshot"].is_null());
        let sid = claimed["session_claim"].as_str().unwrap().to_string();
        assert_eq!(
            claimed["session_claim_boot"].as_str(),
            Some(crate::state::relay_boot_id())
        );

        let action = request_auth::test_signed_request(
            &device_key,
            &binding,
            device_id,
            &phone_peer,
            &sid,
            1,
            "devices-once",
            &serde_json::json!({"type": "fetch_devices"}),
            payload_secret,
        );
        send_phone_publish(&mut socket, relay_peer, action.clone()).await;
        let answer = open(
            &read_signed_relay_payload(&mut socket, &key, relay_peer, room, |payload| {
                payload["action_id"] == "devices-once"
            })
            .await,
        );
        assert_eq!(answer["ok"], true, "{answer}");
        assert!(answer["devices"].is_object());

        // The same frame again through the same broker and socket, and a forgery.
        send_phone_publish(&mut socket, relay_peer, action).await;
        let forged = request_auth::test_signed_request(
            &SigningKey::from_bytes(&[20_u8; 32]),
            &binding,
            device_id,
            &phone_peer,
            &sid,
            2,
            "devices-forged",
            &serde_json::json!({"type": "fetch_devices"}),
            payload_secret,
        );
        send_phone_publish(&mut socket, relay_peer, forged).await;
        let quiet = tokio::time::timeout(Duration::from_millis(800), async {
            loop {
                let frame = socket.next().await.expect("socket open").expect("frame");
                let Ok(text) = frame.into_text() else {
                    continue;
                };
                let message: serde_json::Value = serde_json::from_str(&text).unwrap();
                let action_id = message["payload"]["action_id"].as_str().unwrap_or("");
                if action_id == "devices-once" || action_id == "devices-forged" {
                    return message;
                }
            }
        })
        .await;
        if let Ok(message) = quiet {
            panic!("a replayed or forged request was answered: {message}");
        }
        // The channel still works: the silence above was a refusal, not a dead socket.
        let after = request_auth::test_signed_request(
            &device_key,
            &binding,
            device_id,
            &phone_peer,
            &sid,
            3,
            "devices-after",
            &serde_json::json!({"type": "fetch_devices"}),
            payload_secret,
        );
        send_phone_publish(&mut socket, relay_peer, after).await;
        let answer = open(
            &read_signed_relay_payload(&mut socket, &key, relay_peer, room, |payload| {
                payload["action_id"] == "devices-after"
            })
            .await,
        );
        assert_eq!(answer["ok"], true, "{answer}");
    };
    tokio::select! {
        result = session => panic!("production relay ended before the phone finished: {result:?}"),
        _ = phone => {}
    }
}

const CLOUD_CONTROL: &str = "https://app.sealwire.dev/";
const OTHER_CONTROL: &str = "https://broker.example.net/";

fn test_registration(relay_id: &str) -> PublicRelayRegistration {
    PublicRelayRegistration {
        relay_id: relay_id.into(),
        broker_room_id: format!("room-{relay_id}"),
        relay_refresh_token: format!("refresh-{relay_id}"),
    }
}

#[tokio::test]
async fn one_database_keeps_a_registration_and_identity_per_cloud_broker() {
    let db = temp_registration_path("agent-relay-two-brokers");
    let db_path = std::path::Path::new(&db);
    save_public_relay_registration(db_path, CLOUD_CONTROL, &test_registration("relay-cloud"))
        .await
        .expect("cloud registration saves");
    write_test_public_identity(&db, CLOUD_CONTROL, [1_u8; 32]).await;

    let pending = PendingPublicEnrollment {
        control_url: Url::parse(OTHER_CONTROL).unwrap(),
        state_db: db_path.to_path_buf(),
    };
    let locked =
        enroll_public_relay_if_absent(&pending, || async { Ok(test_registration("relay-other")) })
            .await
            .expect("a second broker enrolls beside the first");
    assert_eq!(locked.disposition, EnrollmentDisposition::Enrolled);
    drop(locked);
    let other_identity = load_or_create_public_relay_identity(db_path, OTHER_CONTROL)
        .await
        .expect("the second broker gets an identity");

    let cloud = load_public_relay_registration(db_path, CLOUD_CONTROL)
        .await
        .unwrap()
        .expect("the first broker's registration is kept");
    assert_eq!(cloud.relay_id, "relay-cloud");
    let other = load_public_relay_registration(db_path, OTHER_CONTROL)
        .await
        .unwrap()
        .expect("the second broker's registration is stored");
    assert_eq!(other.relay_id, "relay-other");
    let cloud_identity = load_existing_public_relay_identity(db_path, CLOUD_CONTROL)
        .await
        .expect("the first broker's identity still loads");
    assert_eq!(
        cloud_identity.signing_key.to_bytes(),
        [1_u8; 32],
        "enrolling with another broker must not touch the first one's key"
    );
    assert_ne!(
        other_identity.signing_key.to_bytes(),
        [1_u8; 32],
        "each broker sees its own relay key"
    );
}

fn seed_paired_phone(db: &str, device_id: &str, pinned_relay_key: Option<&str>) {
    let mut body = serde_json::json!({
        "device_id": device_id,
        "label": device_id,
        "device_verify_key": "",
        "created_at": 1,
        "last_seen_at": null,
        "last_peer_id": null,
    });
    if let Some(key) = pinned_relay_key {
        body["pairing_broker"] = serde_json::json!({
            "broker_url": "wss://app.sealwire.dev",
            "broker_room_id": "room",
            "relay_peer_id": "relay",
            "relay_verify_key": key,
        });
    }
    super::stored_credentials::transact(std::path::Path::new(db), |conn| {
        conn.execute(
            "INSERT INTO paired_device (key, body) VALUES (?1, ?2)",
            rusqlite::params![device_id, body.to_string()],
        )
        .map_err(|error| error.to_string())?;
        crate::state::put_credential(
            conn,
            crate::state::DEVICE_PAYLOAD_SECRET,
            device_id,
            "payload",
            None,
            1,
        )
        .map_err(|error| error.to_string())
    })
    .expect("paired phone seeds");
}

fn stored_content_identity(db: &str) -> Option<String> {
    super::stored_credentials::read(
        std::path::Path::new(db),
        super::stored_credentials::RELAY_CONTENT_IDENTITY,
    )
    .unwrap()
    .map(|stored| stored.secret)
}

#[tokio::test]
async fn a_missing_self_hosted_key_blocks_startup_only_for_phones_that_pinned_a_lost_key() {
    let db = temp_registration_path("agent-relay-content-key-cloud-phones");
    write_test_public_identity(&db, CLOUD_CONTROL, [9_u8; 32]).await;
    let cloud_key = STANDARD.encode(
        SigningKey::from_bytes(&[9_u8; 32])
            .verifying_key()
            .to_bytes(),
    );
    seed_paired_phone(&db, "phone-cloud", Some(&cloud_key));
    seed_paired_phone(&db, "phone-unrecorded", None);
    load_or_create_relay_content_identity(std::path::Path::new(&db))
        .await
        .expect("phones paired through Cloud never pinned the self-hosted key");
    assert!(stored_content_identity(&db).is_some());

    let db = temp_registration_path("agent-relay-content-key-lost");
    seed_paired_phone(&db, "phone-lost", Some(&STANDARD.encode([3_u8; 32])));
    let refused = load_or_create_relay_content_identity(std::path::Path::new(&db))
        .await
        .expect_err("a phone pinned a key this database no longer holds");
    assert!(
        refused.contains("phone-lost"),
        "name the stranded phone: {refused}"
    );
    assert!(
        stored_content_identity(&db).is_none(),
        "a lost key must not be silently replaced"
    );
}

#[tokio::test]
async fn self_hosted_content_identity_survives_restart_and_refuses_a_missing_paired_key() {
    let _cloud = cloud_env_lock().lock().expect("cloud env lock");
    let _state = crate::state_paths::env_lock();
    let home = tempfile::tempdir().expect("temp home");
    let _home = crate::state_paths::EnvVarGuard::set("HOME", Some(home.path()));
    let _url = EnvStringGuard::set("RELAY_BROKER_URL", Some("ws://127.0.0.1:9/ws"));
    let _public = EnvStringGuard::set("RELAY_BROKER_PUBLIC_URL", None);
    let _control = EnvStringGuard::set("RELAY_BROKER_CONTROL_URL", None);
    let _channel = EnvStringGuard::set("RELAY_BROKER_CHANNEL_ID", Some("room-identity"));
    let _peer = EnvStringGuard::set("RELAY_BROKER_PEER_ID", Some("relay-identity"));
    let _mode = EnvStringGuard::set("RELAY_BROKER_AUTH_MODE", Some("self_hosted"));
    let _secret = EnvStringGuard::set(
        "RELAY_BROKER_TICKET_SECRET",
        Some("test-broker-ticket-secret-a3f76b4c2089d15e6b0fa873c4e9521d"),
    );
    let _relay = EnvStringGuard::set("RELAY_BROKER_RELAY_ID", None);
    let _refresh = EnvStringGuard::set("RELAY_BROKER_RELAY_REFRESH_TOKEN", None);
    let _ttl = EnvStringGuard::set("RELAY_BROKER_DEVICE_JOIN_TTL_SECS", None);
    let _db = crate::state_paths::EnvVarGuard::set("RELAY_STATE_DB", None);

    let db = home.path().join(".sealwire").join("sealwire.db");
    let stored = |db: &std::path::Path| {
        super::stored_credentials::read(db, super::stored_credentials::RELAY_CONTENT_IDENTITY)
            .unwrap()
            .map(|stored| stored.secret)
    };
    let first = BrokerConfig::from_env()
        .await
        .expect("first start")
        .expect("self-hosted broker should be configured");
    let first_key = first.content_verify_key();
    assert!(
        stored(&db).is_some(),
        "the default database must hold the content identity"
    );
    let second = BrokerConfig::from_env()
        .await
        .expect("restart")
        .expect("restart should stay configured");
    assert_eq!(second.content_verify_key(), first_key);

    super::stored_credentials::write(
        &db,
        super::stored_credentials::RELAY_CONTENT_IDENTITY,
        "{",
        Some(r#"{"schema_version":1}"#),
    )
    .expect("corrupt identity");
    let corrupt = BrokerConfig::from_env().await;
    assert!(corrupt.is_err(), "a corrupt identity must not be replaced");
    assert_eq!(
        stored(&db).as_deref(),
        Some("{"),
        "corrupt value must stay in place"
    );

    super::stored_credentials::transact(&db, |conn| {
        crate::state::delete_credential(conn, super::stored_credentials::RELAY_CONTENT_IDENTITY, "")
            .map_err(|error| error.to_string())
    })
    .expect("the identity is lost");
    seed_paired_phone(db.to_str().expect("db path"), "phone-1", Some(&first_key));
    let lost = BrokerConfig::from_env().await;
    let message = lost.expect_err("missing identity with a phone that pinned it");
    assert!(
        message.contains("phone-1"),
        "identity loss must name the phones that need a trusted re-pair: {message}"
    );
    assert!(
        stored(&db).is_none(),
        "a lost identity must not be silently regenerated"
    );

    let scratch = tempfile::tempdir().expect("scratch state");
    let scratch_db = scratch.path().join("scratch.db");
    let _explicit = crate::state_paths::EnvVarGuard::set("RELAY_STATE_DB", Some(&scratch_db));
    let explicit = BrokerConfig::from_env()
        .await
        .expect("explicit database")
        .expect("explicit database should configure");
    let explicit_key = explicit.content_verify_key();
    assert!(stored(&scratch_db).is_some());
    assert_ne!(explicit_key, first_key);
    let explicit_again = BrokerConfig::from_env()
        .await
        .expect("explicit restart")
        .expect("explicit restart should configure");
    assert_eq!(explicit_again.content_verify_key(), explicit_key);
}

/// A broker that rejects device grants with the `device_limit_reached` 403.
async fn spawn_device_limit_mock() -> String {
    async fn device_grant_over_limit() -> (axum::http::StatusCode, Json<serde_json::Value>) {
        (
            axum::http::StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "device_limit_reached",
                "message": "device limit reached: this relay allows 2 device(s); \
                            remove a device to add a new one",
            })),
        )
    }
    let app = super::access_release::with_test_control_challenge(
        Router::new().route("/api/public/devices", post(device_grant_over_limit)),
    );
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("device-limit mock should serve");
    });
    format!("http://{address}")
}

// Cross-layer contract: when the broker rejects a device grant over the cap, the
// relay must surface the human-readable reason (so the approving operator sees
// "remove a device"), not a generic failure. Guards the error-body shape the
// relay depends on.
#[tokio::test]
async fn device_broker_credential_surfaces_device_limit_error() {
    let control_url = spawn_device_limit_mock().await;
    let identity_path = temp_registration_path("agent-relay-device-limit-identity");
    write_test_public_identity(&identity_path, &control_url, [4_u8; 32]).await;
    let config = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url),
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("public".to_string()),
        None,
        Some("relay-owner-1".to_string()),
        Some("relay-refresh-1".to_string()),
        Some(identity_path),
        None,
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled");

    let error = config
        .device_broker_credential("device-x", None)
        .await
        .expect_err("an over-cap device grant must surface an error");
    assert!(
        error.contains("device limit reached"),
        "the operator-facing error must explain the device limit, got: {error}"
    );
}

#[tokio::test]
async fn broker_config_public_mode_returns_pending_enrollment_until_cached_registration_exists() {
    let control_url = spawn_public_control_mock().await;
    let registration_path = temp_registration_path("agent-relay-public-registration");

    let pending = BrokerConfig::from_parts_resolution(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url.clone()),
        None,
        Some("relay-auto".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(registration_path.clone()),
        None,
    )
    .await
    .expect("config resolution should parse");
    assert!(matches!(
        pending,
        BrokerConfigResolution::PendingPublicEnrollment(_)
    ));

    let BrokerConfigResolution::PendingPublicEnrollment(pending) = pending else {
        panic!("expected pending public enrollment");
    };
    let client = reqwest::Client::new();
    let registration = perform_public_relay_enrollment(&client, &pending, None)
        .await
        .expect("challenge enrollment should succeed");
    assert_eq!(registration.relay_id, "relay-enrolled");
    assert_eq!(registration.broker_room_id, "room-enrolled");

    let cached = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url),
        None,
        Some("relay-auto".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(registration_path),
        None,
    )
    .await
    .expect("cached config should parse")
    .expect("cached config should be enabled");

    assert_eq!(cached.broker_room_id(), "room-enrolled");
    let cached_pairing = cached
        .pairing_join_credential("pair-cached", 123)
        .await
        .expect("cached relay should reuse the saved registration");
    assert_eq!(cached_pairing.token, "pairing-token-pair-cached");
}

#[test]
fn reconnect_backoff_grows_to_cap_with_jitter() {
    let mut backoff = RetryBackoff::new(Duration::from_secs(2), Duration::from_secs(60));
    let mut rng = StdRng::seed_from_u64(7);

    for (index, expected_cap_secs) in [2, 4, 8, 16, 32, 60, 60].into_iter().enumerate() {
        let retry = backoff.next_delay(&mut rng);
        assert_eq!(retry.cap, Duration::from_secs(expected_cap_secs));
        assert_eq!(retry.consecutive_failures, index as u32 + 1);
        assert!(
            retry.delay >= retry.cap / 2 && retry.delay <= retry.cap,
            "retry delay {:?} should stay inside the jitter window for cap {:?}",
            retry.delay,
            retry.cap
        );
    }
}

#[test]
fn reconnect_backoff_resets_only_after_a_stable_session() {
    let mut backoff = RetryBackoff::new(Duration::from_secs(2), Duration::from_secs(60));
    let mut rng = StdRng::seed_from_u64(11);

    assert_eq!(backoff.next_delay(&mut rng).cap, Duration::from_secs(2));
    assert_eq!(backoff.next_delay(&mut rng).cap, Duration::from_secs(4));

    backoff.reset_after_stable_session(Duration::from_secs(
        BROKER_RECONNECT_STABLE_SESSION_SECS - 1,
    ));
    assert_eq!(backoff.next_delay(&mut rng).cap, Duration::from_secs(8));

    backoff.reset_after_stable_session(Duration::from_secs(BROKER_RECONNECT_STABLE_SESSION_SECS));
    let retry = backoff.next_delay(&mut rng);
    assert_eq!(retry.cap, Duration::from_secs(2));
    assert_eq!(retry.consecutive_failures, 1);
}

#[test]
fn snapshot_publish_gate_throttles_burst_snapshot_updates() {
    let mut gate = SnapshotPublishGate::new(Duration::from_millis(500));
    let start = Instant::now();

    assert!(gate.ready_or_deadline(start).is_ok());
    assert!(!gate.has_pending_publish());

    let delayed_until = gate
        .ready_or_deadline(start + Duration::from_millis(100))
        .expect_err("burst update should be delayed");
    assert_eq!(delayed_until, start + Duration::from_millis(500));
    assert!(gate.has_pending_publish());

    assert!(gate
        .ready_or_deadline(start + Duration::from_millis(500))
        .is_ok());
    assert!(!gate.has_pending_publish());
}

#[test]
fn snapshot_publish_decision_flushes_pending_deltas_before_ready_snapshot() {
    let mut gate = SnapshotPublishGate::new(Duration::from_millis(500));
    let start = Instant::now();

    assert_eq!(
        snapshot_publish_decision(&mut gate, start, true),
        SnapshotPublishDecision::FlushTranscriptDeltasThenPublishSnapshot
    );
    assert!(!gate.has_pending_publish());

    let delayed_until = start + Duration::from_millis(500);
    assert_eq!(
        snapshot_publish_decision(&mut gate, start + Duration::from_millis(100), true),
        SnapshotPublishDecision::DelayUntil(delayed_until)
    );
    assert!(gate.has_pending_publish());
}

#[test]
fn transcript_delta_coalescing_merges_contiguous_item_updates() {
    let first = PendingTranscriptDelta {
        thread_id: "thread-1".to_string(),
        base_revision: 10,
        revision: 11,
        entry_seq: 4,
        order_seq: 0,
        server_time: 100,
        row_id: "item-1".to_string(),
        transcript_generation: String::new(),
        turn_id: Some("turn-1".to_string()),
        delta: "hel".to_string(),
        kind: TranscriptDeltaKind::AgentText,
        text_offset: Some(0),
    };
    let second = PendingTranscriptDelta {
        base_revision: 11,
        revision: 12,
        server_time: 101,
        delta: "lo".to_string(),
        ..first.clone()
    };
    let command = PendingTranscriptDelta {
        base_revision: 12,
        revision: 13,
        server_time: 102,
        delta: "!".to_string(),
        kind: TranscriptDeltaKind::CommandOutput,
        ..first.clone()
    };

    let coalesced = coalesce_transcript_deltas(
        [first, second, command]
            .into_iter()
            .map(PendingTranscriptPublish::Delta)
            .collect(),
    )
    .into_iter()
    .map(|frame| match frame {
        PendingTranscriptPublish::Delta(delta) => delta,
        other => panic!("only deltas went in: {other:?}"),
    })
    .collect::<Vec<_>>();

    assert_eq!(coalesced.len(), 2);
    assert_eq!(coalesced[0].base_revision, 10);
    assert_eq!(coalesced[0].revision, 12);
    assert_eq!(coalesced[0].server_time, 101);
    assert_eq!(coalesced[0].delta, "hello");
    // The coalesced delta begins where the first chunk began, so it keeps the
    // first chunk's text_offset (not the second's).
    assert_eq!(coalesced[0].text_offset, Some(0));
    assert_eq!(coalesced[1].delta, "!");
}

/// A resync is judged against the revision a surface holds when it arrives, so it may
/// not be merged away or overtaken by the deltas queued after it.
#[test]
fn a_resync_keeps_its_place_between_deltas_it_separates() {
    let delta = |base_revision, revision, text: &str| PendingTranscriptDelta {
        thread_id: "thread-1".to_string(),
        base_revision,
        revision,
        entry_seq: 4,
        order_seq: 0,
        server_time: 100,
        row_id: "item-1".to_string(),
        transcript_generation: String::new(),
        turn_id: Some("turn-1".to_string()),
        delta: text.to_string(),
        kind: TranscriptDeltaKind::AgentText,
        text_offset: None,
    };
    let resync = crate::protocol::TranscriptResyncEvent::new(
        "thread-1",
        11,
        crate::protocol::TranscriptResyncReason::RowsNotStreamed,
    );

    let frames = coalesce_transcript_deltas(vec![
        PendingTranscriptPublish::Delta(delta(10, 11, "a")),
        PendingTranscriptPublish::Resync(resync.clone()),
        PendingTranscriptPublish::Delta(delta(11, 12, "b")),
    ]);

    let shape = frames
        .iter()
        .map(|frame| match frame {
            PendingTranscriptPublish::Delta(delta) => format!("delta:{}", delta.delta),
            PendingTranscriptPublish::Resync(resync) => format!("resync:{}", resync.revision),
        })
        .collect::<Vec<_>>();
    assert_eq!(shape, vec!["delta:a", "resync:11", "delta:b"]);
}

#[test]
fn targeted_messages_inner_payloads_include_relay_protocol_version() {
    let payload = OutboundBrokerPayload::TargetedMessages {
        messages: vec![TargetedBrokerMessage {
            target_peer_id: "surface-1".to_string(),
            payload: Box::new(OutboundBrokerPayload::EncryptedTranscriptDelta {
                target_peer_id: "surface-1".to_string(),
                device_id: "device-1".to_string(),
                envelope: EncryptedEnvelope {
                    nonce: "nonce".to_string(),
                    ciphertext: "ciphertext".to_string(),
                },
            }),
        }],
    };

    let frame: serde_json::Value =
        serde_json::from_str(&protocol::frame_text_for_payload(&payload))
            .expect("frame should parse");
    let outer_payload = frame
        .get("payload")
        .expect("frame should contain publish payload");
    assert_eq!(
        outer_payload
            .get("protocol_version")
            .and_then(serde_json::Value::as_u64),
        Some(RELAY_PROTOCOL_VERSION)
    );
    let inner_payload = outer_payload
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .and_then(|messages| messages.first())
        .and_then(|message| message.get("payload"))
        .expect("targeted message should contain inner payload");
    assert_eq!(
        inner_payload
            .get("protocol_version")
            .and_then(serde_json::Value::as_u64),
        Some(RELAY_PROTOCOL_VERSION)
    );
    assert_eq!(
        inner_payload
            .get("kind")
            .and_then(serde_json::Value::as_str),
        Some("encrypted_transcript_delta")
    );
}

#[tokio::test]
async fn perform_public_relay_enrollment_uses_relay_keypair_challenge_flow() {
    let control_url = spawn_public_control_mock().await;
    let registration_path = temp_registration_path("agent-relay-public-registration");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).expect("control url should parse"),
        state_db: std::path::PathBuf::from(&registration_path),
    };

    let registration = perform_public_relay_enrollment(&reqwest::Client::new(), &pending, None)
        .await
        .expect("automatic relay enrollment should succeed");

    assert_eq!(registration.relay_id, "relay-enrolled");
    assert_eq!(registration.broker_room_id, "room-enrolled");
    assert_eq!(registration.relay_refresh_token, "relay-refresh-enrolled");

    let cached = load_public_relay_registration(
        std::path::Path::new(&registration_path),
        pending.control_url.as_str(),
    )
    .await
    .expect("cached registration should load")
    .expect("cached registration should exist");
    assert_eq!(cached, registration);

    let identity = load_or_create_public_relay_identity(
        std::path::Path::new(&registration_path),
        pending.control_url.as_str(),
    )
    .await
    .expect("relay identity should persist");
    let reloaded_identity = load_or_create_public_relay_identity(
        std::path::Path::new(&registration_path),
        pending.control_url.as_str(),
    )
    .await
    .expect("relay identity should reload");
    assert_eq!(
        STANDARD.encode(identity.signing_key.verifying_key().to_bytes()),
        STANDARD.encode(reloaded_identity.signing_key.verifying_key().to_bytes())
    );
}

#[tokio::test]
async fn broker_config_public_mode_requires_relay_refresh_token() {
    let error = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        None,
        Some("https://broker.example.com".to_string()),
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(temp_state_db("public-needs-refresh")),
        None,
    )
    .await
    .expect_err("public mode should require a relay refresh token");
    assert!(
        error.contains(RELAY_BROKER_RELAY_ID_ENV)
            || error.contains(RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV)
            || error.contains("not enrolled yet")
    );
}

#[tokio::test]
async fn broker_config_self_hosted_can_issue_expiring_device_join_credentials() {
    let config = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        None,
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("self_hosted".to_string()),
        Some("test-broker-ticket-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        None,
        Some("3600".to_string()),
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled");

    let credential = config
        .device_broker_credential("device-1", None)
        .await
        .expect("device credential should mint");
    assert!(credential.join_credential.expires_at.is_some());
    assert_eq!(config.device_join_ttl_secs(), Some(3600));
}

#[test]
fn parse_inbound_payload_parses_pairing_requests() {
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
    let device_id = "phone-1";
    let envelope = encrypt_json(
        "pairing-secret",
        &PairingRequestPlaintext {
            device_id: Some(device_id.to_string()),
            device_label: Some("My Phone".to_string()),
            device_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            pairing_proof: STANDARD.encode(
                signing_key
                    .sign(pairing_proof_message("pair-1", Some(device_id)).as_bytes())
                    .to_bytes(),
            ),
        },
    )
    .expect("pairing request should encrypt");
    let payload = serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "kind": "pairing_request",
        "pairing_id": "pair-1",
        "envelope": envelope
    });

    let request = parse_inbound_payload(payload)
        .expect("payload should parse")
        .expect("pairing request should be handled");
    match request {
        InboundBrokerPayload::PairingRequest {
            pairing_id,
            envelope,
        } => {
            assert_eq!(pairing_id, "pair-1");
            let decrypted: PairingRequestPlaintext =
                decrypt_json("pairing-secret", &envelope).expect("payload should decrypt");
            assert_eq!(decrypted.device_id.as_deref(), Some("phone-1"));
            assert_eq!(decrypted.device_label.as_deref(), Some("My Phone"));
            verify_pairing_request_proof(
                "pair-1",
                decrypted.device_id.as_deref(),
                &decrypted.device_verify_key,
                &decrypted.pairing_proof,
            )
            .expect("pairing proof should verify");
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_inbound_payload_parses_encrypted_remote_actions() {
    let envelope = bound_action_envelope(
        "device-secret",
        "act-2",
        &RemoteActionRequest::SendMessage {
            input: SendMessageInput {
                text: "encrypted hello".to_string(),
                model: None,
                effort: None,
                device_id: None,
                thread_id: "thread-1".to_string(),
            },
            skill: Some(crate::protocol::SkillInvocationInput {
                name: "probe".to_string(),
                path: Some("/repo/.codex/skills/probe/SKILL.md".to_string()),
            }),
        },
    )
    .expect("encrypted action should encrypt");
    let payload = serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "kind": "encrypted_remote_action",
        "action_id": "act-2",
        "device_id": "phone-1",
        "envelope": envelope
    });

    let action = parse_inbound_payload(payload)
        .expect("payload should parse")
        .expect("payload should be handled");
    match action {
        InboundBrokerPayload::EncryptedRemoteAction {
            action_id,
            device_id,
            request_sid,
            envelope,
            ..
        } => {
            assert_eq!(action_id, "act-2");
            assert_eq!(device_id.as_deref(), Some("phone-1"));
            assert!(request_sid.is_none());
            let request: RemoteActionRequest = remote_actions::decrypt_remote_action_with_secret(
                "device-secret",
                &action_id,
                &envelope,
            )
            .expect("payload should decrypt");
            match request {
                RemoteActionRequest::SendMessage { input, skill } => {
                    assert_eq!(input.text, "encrypted hello");
                    // The path is what tells two same-name Codex skills apart, so it has
                    // to survive the sealed hop intact.
                    assert_eq!(
                        skill,
                        Some(crate::protocol::SkillInvocationInput {
                            name: "probe".to_string(),
                            path: Some("/repo/.codex/skills/probe/SKILL.md".to_string()),
                        })
                    );
                }
                other => panic!("unexpected request: {other:?}"),
            }
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_inbound_payload_requires_relay_protocol_version() {
    let payload = serde_json::json!({
        "kind": "encrypted_remote_action",
        "action_id": "act-missing-version",
        "device_id": "phone-1",
        "request": {
            "type": "claim_challenge",
            "proof": "claim-init-proof"
        }
    });

    let error = parse_inbound_payload(payload).expect_err("protocol version should be required");
    assert!(error.contains("protocol_version is required"));
}

#[test]
fn parse_inbound_payload_rejects_unsupported_relay_protocol_version() {
    let payload = serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION + 1,
        "kind": "encrypted_remote_action",
        "action_id": "act-new-version",
        "device_id": "phone-1",
        "request": {
            "type": "claim_challenge",
            "proof": "claim-init-proof"
        }
    });

    let error =
        parse_inbound_payload(payload).expect_err("unsupported protocol version should reject");
    assert!(error.contains("unsupported relay payload protocol_version"));
}

#[test]
fn validate_broker_protocol_version_rejects_unsupported_welcome_version() {
    let error = validate_broker_protocol_version(BROKER_PROTOCOL_VERSION + 1)
        .expect_err("unsupported broker protocol should reject");
    assert!(error.contains("unsupported broker protocol_version"));
}

#[test]
fn parse_inbound_payload_ignores_non_action_payloads() {
    let payload = serde_json::json!({
        "kind": "session_snapshot",
        "snapshot": {
            "current_status": "idle"
        }
    });

    let action = parse_inbound_payload(payload).expect("non-action payload should be ignored");
    assert!(action.is_none());
}

#[tokio::test]
async fn targeted_publish_splits_repeated_peers_and_batch_limits_without_losing_order() {
    let (writer, mut frames, _trains) = writer::test_writer();
    let messages = (0..MAX_TARGETED_MESSAGES_PER_PUBLISH + 3)
        .map(|index| {
            let target_peer_id = if index < 2 {
                "surface-repeat".to_string()
            } else {
                format!("surface-{index}")
            };
            TargetedBrokerMessage {
                payload: Box::new(OutboundBrokerPayload::RemoteActionPending {
                    action_id: index.to_string(),
                    target_peer_id: target_peer_id.clone(),
                }),
                target_peer_id,
            }
        })
        .collect::<Vec<_>>();
    publish_targeted_messages(&writer, messages).await.unwrap();
    let mut delivered = Vec::new();
    let mut sizes = Vec::new();
    while let Ok(Message::Text(text)) = frames.try_recv() {
        let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
        let batch = frame["payload"]["messages"].as_array().unwrap();
        let mut targets = std::collections::HashSet::new();
        assert!(batch.len() <= MAX_TARGETED_MESSAGES_PER_PUBLISH);
        for message in batch {
            assert!(targets.insert(message["target_peer_id"].as_str().unwrap()));
            delivered.push(
                message["payload"]["action_id"]
                    .as_str()
                    .unwrap()
                    .parse::<usize>()
                    .unwrap(),
            );
        }
        sizes.push(batch.len());
    }
    assert_eq!(sizes, [1, MAX_TARGETED_MESSAGES_PER_PUBLISH, 2]);
    assert_eq!(
        delivered,
        (0..MAX_TARGETED_MESSAGES_PER_PUBLISH + 3).collect::<Vec<_>>()
    );
}

#[test]
fn device_claim_proof_round_trips_for_same_peer_and_action() {
    let signing_key = SigningKey::from_bytes(&[5_u8; 32]);
    let verify_key = STANDARD.encode(signing_key.verifying_key().to_bytes());
    let challenge_id = "claim-1";
    let challenge = "server-challenge";
    let signature = STANDARD.encode(
        signing_key
            .sign(
                device_claim_proof_message(challenge_id, challenge, "device-a", "peer-a")
                    .as_bytes(),
            )
            .to_bytes(),
    );

    verify_device_claim_challenge_proof(
        challenge_id,
        challenge,
        "device-a",
        "peer-a",
        &verify_key,
        &signature,
    )
    .expect("claim proof should verify");
}

#[test]
fn device_claim_proof_rejects_different_peer() {
    let signing_key = SigningKey::from_bytes(&[6_u8; 32]);
    let verify_key = STANDARD.encode(signing_key.verifying_key().to_bytes());
    let challenge_id = "claim-1";
    let challenge = "server-challenge";
    let signature = STANDARD.encode(
        signing_key
            .sign(
                device_claim_proof_message(challenge_id, challenge, "device-a", "peer-a")
                    .as_bytes(),
            )
            .to_bytes(),
    );

    let error = verify_device_claim_challenge_proof(
        challenge_id,
        challenge,
        "device-a",
        "peer-b",
        &verify_key,
        &signature,
    )
    .expect_err("claim proof should reject a different peer");
    assert!(error.contains("device claim proof is invalid"));
}

#[test]
fn summarize_thread_transcript_response_reports_entry_and_char_counts() {
    let summary = summarize_thread_transcript_response(&ThreadTranscriptResponse {
        transcript_generation: String::new(),
        thread_id: "thread-1".to_string(),
        revision: 5,
        server_time: 6,
        entries: vec![
            TranscriptEntryView {
                row_id: None,
                order_seq: None,
                withdrawn: false,
                item_id: Some("item-1".to_string()),
                kind: TranscriptEntryKind::AgentText,
                text: Some("helloworld".to_string()),
                status: "completed".to_string(),
                turn_id: Some("turn-1".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
                injection: None,
            },
            TranscriptEntryView {
                row_id: None,
                order_seq: None,
                withdrawn: false,
                item_id: Some("item-2".to_string()),
                kind: TranscriptEntryKind::ToolCall,
                text: Some("done".to_string()),
                status: "completed".to_string(),
                turn_id: Some("turn-1".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
                injection: None,
            },
        ],
        prev_cursor: Some(crate::protocol::TranscriptCursorToken::new(
            "tc1.test.3".to_string(),
        )),
        thread_state: None,
        missing_rows: Vec::new(),
        deferred_rows: Vec::new(),
    });

    assert!(summary.contains("thread_id=thread-1"));
    assert!(summary.contains("entries=2"));
    assert!(summary.contains("chars=14"));
    assert!(summary.contains("prev_cursor=tc1.test.3"));
}

// The broker registration and the identity seed are this relay's identity to the
// public broker. They live in the relay's own database, so `cd ~/elsewhere && sealwire
// cloud` cannot re-enroll as a new relay, and a scratch database takes its identity with it.
#[test]
fn the_broker_identity_lives_in_the_relay_database() {
    let _lock = crate::state_paths::env_lock();
    let home = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let _home = crate::state_paths::EnvVarGuard::set("HOME", Some(home.path()));
    let _state = crate::state_paths::EnvVarGuard::set("RELAY_STATE_DB", None);

    let a = std::path::Path::new("/tmp/workspace-a");
    let b = std::path::Path::new("/tmp/workspace-b");
    assert_eq!(
        resolve_state_db(a, None),
        resolve_state_db(b, None),
        "the broker identity must not fork per launch directory"
    );
    assert_eq!(
        resolve_state_db(a, None),
        home.path().join(".sealwire").join("sealwire.db")
    );

    let explicit = scratch.path().join("scratch.db");
    let _explicit = crate::state_paths::EnvVarGuard::set("RELAY_STATE_DB", Some(&explicit));
    assert_eq!(resolve_state_db(a, None), explicit);
}

/// End-to-end delivery contract for transcript deltas, in BOTH security modes.
///
/// Everything above this point tested the state layer (who *should* be a target). These
/// drive real relay state through `build_transcript_delta_messages` to the actual wire
/// payloads: which peer each frame is addressed to, and what that peer can read.
mod transcript_delta_delivery {
    use super::*;
    use crate::state::{PairedDevice, RelayState};

    const SECRET_A: &str = "payload-secret-phone-a";
    const SECRET_B: &str = "payload-secret-phone-b";

    fn delta(thread_id: &str, text: &str) -> PendingTranscriptDelta {
        PendingTranscriptDelta {
            thread_id: thread_id.to_string(),
            base_revision: 4,
            revision: 5,
            entry_seq: 2,
            order_seq: 0,
            server_time: 1_700,
            row_id: "item-1".to_string(),
            transcript_generation: String::new(),
            turn_id: Some("turn-1".to_string()),
            delta: text.to_string(),
            kind: TranscriptDeltaKind::AgentText,
            text_offset: Some(11),
        }
    }

    fn relay_with_two_phones() -> RelayState {
        let (change_tx, _) = watch::channel(0_u64);
        let mut relay = RelayState::new(
            "/tmp/project".to_string(),
            change_tx,
            SecurityProfile::private(),
        );
        for (device_id, peer_id, secret) in [
            ("phone-a", "peer-a", SECRET_A),
            ("phone-b", "peer-b", SECRET_B),
        ] {
            relay.paired_devices.insert(
                device_id.to_string(),
                PairedDevice {
                    device_id: device_id.to_string(),
                    label: device_id.to_string(),
                    payload_secret: secret.to_string(),
                    device_verify_key: String::new(),
                    created_at: 0,
                    last_seen_at: None,
                    last_peer_id: Some(peer_id.to_string()),
                    broker_join_ticket_expires_at: None,
                    path_scope: Vec::new(),
                    pairing_broker: None,
                },
            );
            relay.mark_surface_peer_online(peer_id);
            relay.bind_surface_peer_to_device(device_id, peer_id);
            relay.register_broker_surface(peer_id);
        }
        relay
    }

    fn targets_for(relay: &RelayState, thread_id: &str) -> Vec<BrokerTarget> {
        relay
            .broker_targets_for_thread(thread_id)
            .into_iter()
            .map(|(device_id, peer_id, payload_secret)| BrokerTarget {
                device_id,
                peer_id,
                payload_secret,
            })
            .collect()
    }

    fn addressed_peers(messages: &[TargetedBrokerMessage]) -> Vec<String> {
        let mut peers: Vec<String> = messages
            .iter()
            .map(|message| message.target_peer_id.clone())
            .collect();
        peers.sort();
        peers
    }

    /// E2EE: one envelope per watching peer, and ONLY that peer's device key opens it.
    #[test]
    fn e2ee_mode_encrypts_per_device_and_addresses_only_the_watcher() {
        let mut relay = relay_with_two_phones();
        relay.set_watched_threads("peer-a", "phone-a", vec!["thread-x".to_string()]);
        relay.set_watched_threads("peer-b", "phone-b", vec!["thread-other".to_string()]);

        let messages = build_transcript_delta_messages(
            targets_for(&relay, "thread-x"),
            &delta("thread-x", "secret text"),
        )
        .expect("e2ee delivery should build");

        assert_eq!(addressed_peers(&messages), vec!["peer-a".to_string()]);
        match &*messages[0].payload {
            OutboundBrokerPayload::EncryptedTranscriptDelta {
                target_peer_id,
                device_id,
                envelope,
            } => {
                assert_eq!(target_peer_id, "peer-a");
                assert_eq!(device_id, "phone-a");
                let opened: serde_json::Value =
                    decrypt_json(SECRET_A, envelope).expect("the addressed device must decrypt");
                assert_eq!(opened["delta"], "secret text");
                assert_eq!(opened["thread_id"], "thread-x");
                assert_eq!(opened["text_offset"], 11);
                // The other paired device must not be able to read it, even if the frame
                // reached it: targeting is not the only barrier.
                assert!(
                    decrypt_json::<serde_json::Value>(SECRET_B, envelope).is_err(),
                    "another device's key must not open this envelope"
                );
            }
            other => panic!("private mode must encrypt, got: {other:?}"),
        }
    }

    fn resync(thread_id: &str) -> crate::protocol::TranscriptResyncEvent {
        let mut resync = crate::protocol::TranscriptResyncEvent::new(
            thread_id,
            42,
            crate::protocol::TranscriptResyncReason::WatchStarted,
        );
        resync.transcript_generation = "gen-1".to_string();
        resync
    }

    #[test]
    fn a_sealed_resync_opens_to_the_same_event_for_its_device_only() {
        let mut relay = relay_with_two_phones();
        relay.set_watched_threads("peer-a", "phone-a", vec!["thread-x".to_string()]);

        let messages =
            build_transcript_resync_messages(targets_for(&relay, "thread-x"), &resync("thread-x"))
                .expect("e2ee delivery should build");

        assert_eq!(addressed_peers(&messages), vec!["peer-a".to_string()]);
        match &*messages[0].payload {
            OutboundBrokerPayload::EncryptedTranscriptEvent {
                target_peer_id,
                device_id,
                envelope,
            } => {
                assert_eq!(
                    (target_peer_id.as_str(), device_id.as_str()),
                    ("peer-a", "phone-a")
                );
                let opened: serde_json::Value =
                    decrypt_json(SECRET_A, envelope).expect("the addressed device must decrypt");
                assert_eq!(opened["kind"], "transcript_resync");
                assert_eq!(opened["thread_id"], "thread-x");
                assert_eq!(opened["revision"], 42);
                assert_eq!(opened["reason"], "watch_started");
                assert_eq!(opened["transcript_generation"], "gen-1");
                assert!(decrypt_json::<serde_json::Value>(SECRET_B, envelope).is_err());
            }
            other => panic!("private mode must encrypt, got: {other:?}"),
        }
    }

    /// Two devices watching the same thread each get their OWN envelope, sealed to their
    /// own key — not one shared ciphertext.
    #[test]
    fn e2ee_mode_seals_a_separate_envelope_per_watching_device() {
        let mut relay = relay_with_two_phones();
        relay.set_watched_threads("peer-a", "phone-a", vec!["thread-x".to_string()]);
        relay.set_watched_threads("peer-b", "phone-b", vec!["thread-x".to_string()]);

        let messages = build_transcript_delta_messages(
            targets_for(&relay, "thread-x"),
            &delta("thread-x", "shared"),
        )
        .expect("e2ee delivery should build");

        assert_eq!(
            addressed_peers(&messages),
            vec!["peer-a".to_string(), "peer-b".to_string()]
        );
        for message in &messages {
            let (secret, expected_device) = if message.target_peer_id == "peer-a" {
                (SECRET_A, "phone-a")
            } else {
                (SECRET_B, "phone-b")
            };
            match &*message.payload {
                OutboundBrokerPayload::EncryptedTranscriptDelta {
                    device_id,
                    envelope,
                    ..
                } => {
                    assert_eq!(device_id, expected_device);
                    let opened: serde_json::Value =
                        decrypt_json(secret, envelope).expect("each device opens its own envelope");
                    assert_eq!(opened["delta"], "shared");
                }
                other => panic!("expected an encrypted delta, got: {other:?}"),
            }
        }
    }

    /// A thread nobody declared produces no frames at all, in either mode. This is the
    /// whole point of declaring: an unwatched background thread costs nothing.
    #[test]
    fn an_unwatched_thread_produces_no_frames_in_either_mode() {
        let mut relay = relay_with_two_phones();
        relay.set_watched_threads("peer-a", "phone-a", vec!["thread-other".to_string()]);
        relay.set_watched_threads("peer-b", "phone-b", vec!["thread-other".to_string()]);

        {
            let messages = build_transcript_delta_messages(
                targets_for(&relay, "thread-x"),
                &delta("thread-x", "hello"),
            )
            .expect("building should succeed");
            assert!(
                messages.is_empty(),
                "an unwatched thread must produce no frames"
            );
        }
    }

    /// Two surfaces of the SAME device viewing different threads each get only their own
    /// thread — the device-union targeting sent both threads to both peers.
    #[test]
    fn two_surfaces_of_one_device_receive_only_their_own_thread() {
        let (change_tx, _) = watch::channel(0_u64);
        let mut relay = RelayState::new(
            "/tmp/project".to_string(),
            change_tx,
            SecurityProfile::private(),
        );
        relay.paired_devices.insert(
            "phone".to_string(),
            PairedDevice {
                device_id: "phone".to_string(),
                label: "phone".to_string(),
                payload_secret: SECRET_A.to_string(),
                device_verify_key: String::new(),
                created_at: 0,
                last_seen_at: None,
                last_peer_id: Some("peer-2".to_string()),
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
                pairing_broker: None,
            },
        );
        for peer in ["peer-1", "peer-2"] {
            relay.mark_surface_peer_online(peer);
            relay.bind_surface_peer_to_device("phone", peer);
            relay.register_broker_surface(peer);
        }
        relay.set_watched_threads("peer-1", "phone", vec!["thread-a".to_string()]);
        relay.set_watched_threads("peer-2", "phone", vec!["thread-b".to_string()]);

        let a = build_transcript_delta_messages(
            targets_for(&relay, "thread-a"),
            &delta("thread-a", "A"),
        )
        .expect("build");
        assert_eq!(addressed_peers(&a), vec!["peer-1".to_string()]);

        let b = build_transcript_delta_messages(
            targets_for(&relay, "thread-b"),
            &delta("thread-b", "B"),
        )
        .expect("build");
        assert_eq!(addressed_peers(&b), vec!["peer-2".to_string()]);
    }

    /// A device whose path scope excludes the thread gets nothing, even though it
    /// declared the watch — delivery re-checks, so tightening a scope takes effect.
    #[test]
    fn a_scope_that_excludes_the_thread_produces_no_frames() {
        let mut relay = relay_with_two_phones();
        relay.ensure_runtime_for_thread("thread-x").current_cwd = "/tmp/project/secret".to_string();
        relay.set_watched_threads("peer-a", "phone-a", vec!["thread-x".to_string()]);
        assert_eq!(
            targets_for(&relay, "thread-x").len(),
            1,
            "legal while unscoped"
        );

        relay
            .paired_devices
            .get_mut("phone-a")
            .expect("paired")
            .path_scope = vec!["/tmp/project/allowed".to_string()];

        let messages = build_transcript_delta_messages(
            targets_for(&relay, "thread-x"),
            &delta("thread-x", "nope"),
        )
        .expect("build");
        assert!(
            messages.is_empty(),
            "a device whose scope no longer covers the thread must receive nothing"
        );
    }
}

#[test]
fn a_pairing_result_is_addressed_to_one_peer_and_never_broadcast() {
    // SECURITY: the pairing result seals payload_secret + refresh tokens with the
    // pairing_secret printed into the QR. If it goes out as a bare payload the
    // broker fans it out to the whole room, so any bystander replaying the same
    // pairing join ticket gets the envelope and can open it with the QR's secret.
    // The `targeted_messages` wrapper is what confines it to one peer.
    let result = crate::state::PendingPairingResult {
        pairing_id: "pair-abc".to_string(),
        target_peer_id: "surface-intended".to_string(),
        pairing_secret: "pairing-secret-from-the-qr".to_string(),
        device: None,
        payload_secret: Some("payload-secret-must-stay-sealed".to_string()),
        relay_id: Some("relay-1".to_string()),
        relay_label: None,
        client_claim_id: Some("claim-1".to_string()),
        client_claim_nonce: Some("cn-must-stay-sealed".to_string()),
        client_claim_expires_at: Some(300),
        device_refresh_token: Some("dref-must-stay-sealed".to_string()),
        device_join_ticket: Some("join-ticket-must-stay-sealed".to_string()),
        device_join_ticket_expires_at: Some(300),
        error: None,
    };

    let message = pairing_result_targeted_message(result).expect("pairing result should seal");
    assert_eq!(
        message.target_peer_id, "surface-intended",
        "the wrapper must address the peer that completed the handshake"
    );

    let frame = protocol::frame_text_for_payload(&OutboundBrokerPayload::TargetedMessages {
        messages: vec![message],
    });
    let parsed: serde_json::Value =
        serde_json::from_str(&frame).expect("outbound frame should parse");
    assert_eq!(
        parsed["payload"]["kind"], "targeted_messages",
        "a pairing result published bare is broadcast by the broker; frame was {frame}"
    );
    assert_eq!(
        parsed["payload"]["messages"][0]["target_peer_id"], "surface-intended",
        "the broker routes on the wrapper's target_peer_id"
    );

    for secret in [
        "payload-secret-must-stay-sealed",
        "cref-must-stay-sealed",
        "dref-must-stay-sealed",
        "join-ticket-must-stay-sealed",
    ] {
        assert!(
            !frame.contains(secret),
            "{secret} must be sealed inside the envelope, not readable in the frame"
        );
    }
}

// ---------------------------------------------------------------------------
// Broker session integration: does a paced chunk train still deafen the relay?
//
// The unit tests around `publish_chunk_train` and `drive_writer` pin the pieces. This
// drives the REAL session loop (`run_broker_session_with_liveness`) against a real
// websocket, because the defect being guarded was never visible in a piece: it was the
// coupling between them. `handle_server_message` is awaited inline in the `select!` arm
// that reads the socket, so publishing a reply used to stop the relay reading anything
// at all — from any surface — for the length of that reply.
//
// Slow by nature (a real socket, a real git diff, and real 250ms pacing), so it is
// opt-in the way the live-provider tests are: set AGENT_RELAY_BROKER_SESSION_E2E=1.
// ---------------------------------------------------------------------------

fn broker_session_e2e_enabled() -> bool {
    std::env::var("AGENT_RELAY_BROKER_SESSION_E2E")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// A workspace whose `git diff HEAD` is comfortably past
/// `MAX_BROKER_TEXT_FRAME_BYTES`, so `fetch_workspace_diff` has to chunk its reply.
fn workspace_with_a_large_diff() -> tempfile::TempDir {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let root = dir.path();
    let run = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("git should run");
        assert!(status.success(), "git {args:?} should succeed");
    };
    run(&["init", "-q", "."]);
    run(&["config", "user.email", "test@example.test"]);
    run(&["config", "user.name", "test"]);
    let baseline: String = (0..4000).map(|i| format!("original line {i}\n")).collect();
    std::fs::write(root.join("big.txt"), baseline).expect("baseline written");
    run(&["add", "-A"]);
    run(&["commit", "-qm", "baseline"]);
    let modified: String = (0..4000)
        .map(|i| format!("MODIFIED line {i} with padding to widen the diff\n"))
        .collect();
    std::fs::write(root.join("big.txt"), modified).expect("modification written");
    dir
}

async fn encrypted_broker_state(cwd: &str) -> AppState {
    encrypted_broker_state_with_providers(cwd, HashMap::new()).await
}

async fn encrypted_broker_state_with_providers(
    cwd: &str,
    providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>>,
) -> AppState {
    encrypted_broker_state_parts(cwd, providers).await.0
}

/// Also hands back the relay itself: `AppState` keeps it private, and some of what the
/// broker does is only observable as state while a session is still running.
async fn encrypted_broker_state_parts(
    cwd: &str,
    providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>>,
) -> (AppState, Arc<RwLock<RelayState>>) {
    let (change_tx, _) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        cwd.to_string(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    // An untrusted workspace answers a diff with a short "cannot read this", which is
    // indistinguishable from a small diff to any test that measures the reply.
    relay.write().await.trusted_workspaces.push(cwd.to_string());
    relay.write().await.paired_devices.insert(
        "phone-1".to_string(),
        crate::state::PairedDevice {
            device_id: "phone-1".to_string(),
            label: "phone-1".to_string(),
            payload_secret: "secret".to_string(),
            device_verify_key: test_phone_verify_key(),
            created_at: 1,
            last_seen_at: Some(1),
            last_peer_id: None,
            broker_join_ticket_expires_at: None,
            path_scope: Vec::new(),
            pairing_broker: None,
        },
    );
    seed_test_request_sessions(&mut *relay.write().await);
    (
        AppState::from_parts(Arc::clone(&relay), providers, change_tx),
        relay,
    )
}

/// Falls over where a provider bug would.
struct PanickingProvider;

#[async_trait::async_trait]
impl crate::provider::ProviderBridge for PanickingProvider {
    async fn list_threads(
        &self,
        _limit: usize,
    ) -> Result<Vec<crate::protocol::ThreadSummaryView>, String> {
        panic!("this provider falls over")
    }
    async fn list_models(&self) -> Result<Vec<crate::protocol::ModelOptionView>, String> {
        Ok(Vec::new())
    }

    async fn default_model(&self, _cwd: &str) -> Result<String, String> {
        Err("no default model".to_string())
    }
    async fn start_thread(
        &self,
        _request: crate::provider::StartThreadRequest,
    ) -> Result<crate::provider::StartThreadResult, String> {
        Err("not used by this test".to_string())
    }
    async fn resume_thread(
        &self,
        _thread_id: &str,
        _approval_policy: &str,
        _sandbox: &str,
    ) -> Result<(), String> {
        Err("not used by this test".to_string())
    }
    async fn read_thread(
        &self,
        _thread_id: &str,
    ) -> Result<crate::provider::ThreadSyncData, String> {
        Err("not used by this test".to_string())
    }
    async fn read_thread_entry_detail(
        &self,
        _thread_id: &str,
        _item_id: &str,
    ) -> Result<Option<crate::protocol::TranscriptEntryView>, String> {
        Ok(None)
    }
    async fn archive_thread(&self, _thread_id: &str) -> Result<(), String> {
        Err("not used by this test".to_string())
    }
    async fn delete_thread_permanently(
        &self,
        _thread_id: &str,
    ) -> Result<crate::codex_local::LocalThreadDeleteSummary, String> {
        Err("not used by this test".to_string())
    }
    async fn start_turn(
        &self,
        _thread_id: &str,
        _text: &str,
        _model: &str,
        _effort: &str,
        _images: &[crate::provider::ProviderImage],
    ) -> Result<Option<String>, String> {
        Err("not used by this test".to_string())
    }
    async fn request_turn_stop(
        &self,
        _thread_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn respond_to_approval(
        &self,
        _pending: &crate::state::PendingApproval,
        _input: &crate::protocol::ApprovalDecisionInput,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn respond_to_ask_user_question(
        &self,
        _request_id: &str,
        _answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        Ok(())
    }
    fn provider_name(&self) -> &'static str {
        "panics"
    }
}

/// Hangs until the test lets go, so a queue can be filled behind it and then drained.
struct GatedThreadsProvider {
    entered_list_threads: Arc<tokio::sync::Notify>,
    released: Arc<tokio::sync::Notify>,
    entries: Arc<std::sync::atomic::AtomicUsize>,
}

#[async_trait::async_trait]
impl crate::provider::ProviderBridge for GatedThreadsProvider {
    async fn list_threads(
        &self,
        _limit: usize,
    ) -> Result<Vec<crate::protocol::ThreadSummaryView>, String> {
        self.entries
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.entered_list_threads.notify_one();
        self.released.notified().await;
        Ok(Vec::new())
    }
    async fn list_models(&self) -> Result<Vec<crate::protocol::ModelOptionView>, String> {
        Ok(Vec::new())
    }

    async fn default_model(&self, _cwd: &str) -> Result<String, String> {
        Err("no default model".to_string())
    }
    async fn start_thread(
        &self,
        _request: crate::provider::StartThreadRequest,
    ) -> Result<crate::provider::StartThreadResult, String> {
        Err("not used by this test".to_string())
    }
    async fn resume_thread(
        &self,
        _thread_id: &str,
        _approval_policy: &str,
        _sandbox: &str,
    ) -> Result<(), String> {
        Err("not used by this test".to_string())
    }
    async fn read_thread(
        &self,
        _thread_id: &str,
    ) -> Result<crate::provider::ThreadSyncData, String> {
        Err("not used by this test".to_string())
    }
    async fn read_thread_entry_detail(
        &self,
        _thread_id: &str,
        _item_id: &str,
    ) -> Result<Option<crate::protocol::TranscriptEntryView>, String> {
        Ok(None)
    }
    async fn archive_thread(&self, _thread_id: &str) -> Result<(), String> {
        Err("not used by this test".to_string())
    }
    async fn delete_thread_permanently(
        &self,
        _thread_id: &str,
    ) -> Result<crate::codex_local::LocalThreadDeleteSummary, String> {
        Err("not used by this test".to_string())
    }
    async fn start_turn(
        &self,
        _thread_id: &str,
        _text: &str,
        _model: &str,
        _effort: &str,
        _images: &[crate::provider::ProviderImage],
    ) -> Result<Option<String>, String> {
        Err("not used by this test".to_string())
    }
    async fn request_turn_stop(
        &self,
        _thread_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn respond_to_approval(
        &self,
        _pending: &crate::state::PendingApproval,
        _input: &crate::protocol::ApprovalDecisionInput,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn respond_to_ask_user_question(
        &self,
        _request_id: &str,
        _answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        Ok(())
    }
    fn provider_name(&self) -> &'static str {
        "gated"
    }
}

/// Answers nothing, slowly. A cold provider catalog is the real shape of this: Codex
/// alone is allowed thirty seconds, and the relay awaits it inside the receive loop.
struct NeverAnswersProvider {
    /// Signalled on the way into the hang: "A got no reply" is also what a frame nobody
    /// ever handled looks like, so a test has to prove the hang before reading absence.
    entered_list_threads: Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl crate::provider::ProviderBridge for NeverAnswersProvider {
    async fn list_threads(
        &self,
        _limit: usize,
    ) -> Result<Vec<crate::protocol::ThreadSummaryView>, String> {
        self.entered_list_threads.notify_one();
        std::future::pending().await
    }
    async fn list_models(&self) -> Result<Vec<crate::protocol::ModelOptionView>, String> {
        std::future::pending().await
    }

    async fn default_model(&self, _cwd: &str) -> Result<String, String> {
        Err("no default model".to_string())
    }
    async fn start_thread(
        &self,
        _request: crate::provider::StartThreadRequest,
    ) -> Result<crate::provider::StartThreadResult, String> {
        Err("not used by this test".to_string())
    }
    async fn resume_thread(
        &self,
        _thread_id: &str,
        _approval_policy: &str,
        _sandbox: &str,
    ) -> Result<(), String> {
        Err("not used by this test".to_string())
    }
    async fn read_thread(
        &self,
        _thread_id: &str,
    ) -> Result<crate::provider::ThreadSyncData, String> {
        Err("not used by this test".to_string())
    }
    async fn read_thread_entry_detail(
        &self,
        _thread_id: &str,
        _item_id: &str,
    ) -> Result<Option<crate::protocol::TranscriptEntryView>, String> {
        Ok(None)
    }
    async fn archive_thread(&self, _thread_id: &str) -> Result<(), String> {
        Err("not used by this test".to_string())
    }
    async fn delete_thread_permanently(
        &self,
        _thread_id: &str,
    ) -> Result<crate::codex_local::LocalThreadDeleteSummary, String> {
        Err("not used by this test".to_string())
    }
    async fn start_turn(
        &self,
        _thread_id: &str,
        _text: &str,
        _model: &str,
        _effort: &str,
        _images: &[crate::provider::ProviderImage],
    ) -> Result<Option<String>, String> {
        Err("not used by this test".to_string())
    }
    async fn request_turn_stop(
        &self,
        _thread_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn respond_to_approval(
        &self,
        _pending: &crate::state::PendingApproval,
        _input: &crate::protocol::ApprovalDecisionInput,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn respond_to_ask_user_question(
        &self,
        _request_id: &str,
        _answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        Ok(())
    }
    fn provider_name(&self) -> &'static str {
        "never-answers"
    }
}

/// What the fake broker saw, with arrival times, so the test can talk about latency
/// rather than just ordering.
#[derive(Default)]
struct BrokerObservations {
    frames: Vec<(String, std::time::Instant)>,
}

impl BrokerObservations {
    fn kinds(&self) -> Vec<String> {
        self.frames.iter().map(|(kind, _)| kind.clone()).collect()
    }

    fn count_of(&self, kind: &str) -> usize {
        self.frames.iter().filter(|(seen, _)| seen == kind).count()
    }

    fn first_at(&self, kind: &str) -> Option<std::time::Instant> {
        self.frames
            .iter()
            .find(|(seen, _)| seen == kind)
            .map(|(_, at)| *at)
    }
}

fn encrypted_action_result_ok(frame: &serde_json::Value) -> Option<bool> {
    let payload = frame.get("payload")?;
    if payload.get("kind")?.as_str()? != "encrypted_remote_action_result" {
        return None;
    }
    let envelope =
        serde_json::from_value(payload["envelope"].clone()).expect("reply envelope parses");
    let opened: serde_json::Value = decrypt_json("secret", &envelope).expect("reply decrypts");
    Some(opened["ok"].as_bool().expect("reply must carry an ok flag"))
}

fn surface_peer(peer_id: &str, device_id: &str) -> relay_broker::protocol::PeerSummary {
    relay_broker::protocol::PeerSummary {
        peer_id: peer_id.to_string(),
        role: PeerRole::Surface,
        device_id: Some(device_id.to_string()),
    }
}

fn bound_action_envelope(
    secret: &str,
    action_id: &str,
    request: &impl serde::Serialize,
) -> Result<EncryptedEnvelope, String> {
    encrypt_json(
        secret,
        &serde_json::json!({ "action_id": action_id, "request": request }),
    )
}

fn encrypted_action_frame(
    from_peer_id: &str,
    action_id: &str,
    request: serde_json::Value,
) -> String {
    encrypted_action_frame_versioned(from_peer_id, action_id, request, RELAY_PROTOCOL_VERSION)
}

/// One slow action must not cost every other surface — or the session itself.
///
/// A's provider never answers. Two things must hold: B, a different surface, is still
/// answered, and A's own later frame is NOT — a surface's frames stay in order however
/// long the one in front takes.
#[tokio::test]
async fn one_slow_action_does_not_deafen_the_relay_to_every_other_device() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    // A cold provider catalog is minutes, not milliseconds, and the relay awaits it in
    // the same arm that reads the socket — so one phone asking for its thread list used
    // to stop the relay hearing anything at all, from anyone.
    let workspace = tempfile::TempDir::new().expect("tmpdir");
    let cwd = workspace.path().to_string_lossy().to_string();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let observations = Arc::new(std::sync::Mutex::new(BrokerObservations::default()));
    let broker_view = Arc::clone(&observations);
    let entered_the_hang = Arc::new(tokio::sync::Notify::new());
    let broker_waits_for_the_hang = Arc::clone(&entered_the_hang);

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");

        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![
                surface_peer("surface-a", "phone-1"),
                surface_peer("surface-b", "phone-1"),
            ],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;

        // A asks the thing that never comes back.
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-threads",
                serde_json::json!({ "type": "list_threads", "query": { "limit": 20 } }),
            )))
            .await
            .expect("threads request sends");

        // Nothing else goes out until that request is demonstrably inside the provider.
        // Sending straight away makes both "A got nothing" assertions hold even when A's
        // frames were never handled at all, which is not the property under test.
        if tokio::time::timeout(Duration::from_secs(2), broker_waits_for_the_hang.notified())
            .await
            .is_ok()
        {
            broker_view
                .lock()
                .unwrap()
                .frames
                .push(("entered-the-hang".to_string(), std::time::Instant::now()));
        }

        // A asks a SECOND thing, behind its own hung one. Same surface, so it must wait.
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-a-projects",
                serde_json::json!({ "type": "fetch_projects" }),
            )))
            .await
            .expect("A's second request sends");

        // B asks something the relay can answer without any provider at all.
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-b",
                "action-b-projects",
                serde_json::json!({ "type": "fetch_projects" }),
            )))
            .await
            .expect("projects request sends");

        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    broker_view
                        .lock()
                        .unwrap()
                        .frames
                        .push(("ping".to_string(), std::time::Instant::now()));
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    let payload = serde_json::from_str::<serde_json::Value>(&text).ok();
                    let field = |name: &str| {
                        payload
                            .as_ref()
                            .and_then(|value| value.get("payload"))
                            .and_then(|payload| payload.get(name))
                            .and_then(|found| found.as_str())
                            .map(str::to_string)
                    };
                    // The action id, not just the kind: which request was answered is the
                    // whole question when the point is what had to wait for what.
                    let kind = field("kind").unwrap_or_else(|| "unknown".to_string());
                    let label = match field("action_id") {
                        Some(action_id) => format!("{kind}:{action_id}"),
                        None => kind,
                    };
                    broker_view
                        .lock()
                        .unwrap()
                        .frames
                        .push((label, std::time::Instant::now()));
                }
                _ => {}
            }
        }
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let state = {
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.clone(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        relay.write().await.paired_devices.insert(
            "phone-1".to_string(),
            crate::state::PairedDevice {
                device_id: "phone-1".to_string(),
                label: "phone-1".to_string(),
                payload_secret: "secret".to_string(),
                device_verify_key: test_phone_verify_key(),
                created_at: 1,
                last_seen_at: Some(1),
                last_peer_id: None,
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
                pairing_broker: None,
            },
        );
        seed_test_request_sessions(&mut *relay.write().await);
        let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> =
            HashMap::new();
        providers.insert(
            "never-answers".to_string(),
            Arc::new(NeverAnswersProvider {
                entered_list_threads: Arc::clone(&entered_the_hang),
            }),
        );
        AppState::from_parts(relay, providers, change_tx)
    };
    let mut change_rx = state.subscribe();

    let _session = tokio::time::timeout(
        Duration::from_secs(3),
        run_broker_session_with_liveness(
            &state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_millis(300),
                pong_timeout: Duration::from_secs(30),
            },
        ),
    )
    .await;

    let seen = observations.lock().unwrap();
    let kinds = seen.kinds();
    // Read this one first: every assertion below is about what A did NOT get, and none of
    // them is evidence unless A's request actually reached the provider and stayed there.
    assert!(
        seen.count_of("entered-the-hang") > 0,
        "A's request never reached the hanging provider, so nothing below tells us anything \
         about a slow action; saw {kinds:?}"
    );
    // A's reply is `remote_threads_result` and must be absent — if it arrived, the
    // provider answered and this test proved nothing about a slow one.
    assert_eq!(
        seen.count_of("encrypted_remote_action_result"),
        0,
        "the hanging provider answered, so nothing here was actually slow; saw {kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|kind| kind.ends_with(":action-b-projects")),
        "the second device was never answered while the first one's request hung; saw {kinds:?}"
    );
    // The other half, and the one that spawn-then-lock got wrong: a surface's own frames
    // are FIFO, so A's second request waits behind A's first however long that takes.
    assert!(
        !kinds
            .iter()
            .any(|kind| kind.ends_with(":action-a-projects")),
        "A's later request overtook its own hung one; saw {kinds:?}"
    );
    assert!(
        seen.count_of("ping") > 0,
        "the relay never got to send its own heartbeat either; saw {kinds:?}"
    );
}

/// A stale declaration must not be applied to the connection that replaced it.
///
/// The departed check reads the peer the DEVICE is currently bound to, and by the time a
/// queued declaration runs that is the replacement connection — which has not departed.
/// So the old connection's watch set is written under the new one, and whatever the phone
/// is actually looking at stops receiving deltas.
#[tokio::test]
async fn a_stale_declaration_does_not_overwrite_the_replacement_connections_watch() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    let workspace = tempfile::TempDir::new().expect("tmpdir");
    let cwd = workspace.path().to_string_lossy().to_string();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let observations = Arc::new(std::sync::Mutex::new(BrokerObservations::default()));
    let broker_view = Arc::clone(&observations);
    let entered_the_hang = Arc::new(tokio::sync::Notify::new());
    let broker_waits_for_the_hang = Arc::clone(&entered_the_hang);
    let hang_was_entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let broker_saw_the_hang = Arc::clone(&hang_was_entered);
    let release_the_hang = Arc::new(tokio::sync::Notify::new());

    let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> = HashMap::new();
    providers.insert(
        "gated".to_string(),
        Arc::new(GatedThreadsProvider {
            entered_list_threads: Arc::clone(&entered_the_hang),
            released: Arc::clone(&release_the_hang),
            entries: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }),
    );
    let (state, relay) = encrypted_broker_state_parts(&cwd, providers).await;
    let script_relay = Arc::clone(&relay);
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");

        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![surface_peer("surface-old", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;

        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-old",
                "action-hangs",
                serde_json::json!({ "type": "list_threads", "query": { "limit": 20 } }),
            )))
            .await
            .expect("hanging request sends");
        if tokio::time::timeout(Duration::from_secs(2), broker_waits_for_the_hang.notified())
            .await
            .is_ok()
        {
            broker_saw_the_hang.store(true, std::sync::atomic::Ordering::SeqCst);
        }

        for (action_id, request) in [
            (
                "action-stale-watch",
                serde_json::json!({
                    "type": "watch_threads",
                    "input": { "thread_ids": ["thread-stale"], "device_id": "phone-1" }
                }),
            ),
            (
                "action-after-stale",
                serde_json::json!({ "type": "fetch_projects" }),
            ),
        ] {
            socket
                .send(Message::Text(encrypted_action_frame(
                    "surface-old",
                    action_id,
                    request,
                )))
                .await
                .expect("queued request sends");
        }

        for (kind, peer) in [
            (PresenceKind::Left, "surface-old"),
            (PresenceKind::Joined, "surface-new"),
        ] {
            let presence = ServerMessage::Presence {
                channel_id: "room-e2e".to_string(),
                kind,
                peer: surface_peer(peer, "phone-1"),
            };
            socket
                .send(Message::Text(
                    serde_json::to_string(&presence).expect("presence serializes"),
                ))
                .await
                .expect("presence sends");
        }

        // The replacement connection proves itself, then declares what the phone is
        // really looking at.
        authorize_joined(&script_relay, "surface-new").await;
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-new",
                "action-live-watch",
                serde_json::json!({
                    "type": "watch_threads",
                    "input": { "thread_ids": ["thread-live"], "device_id": "phone-1" }
                }),
            )))
            .await
            .expect("live watch sends");

        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    let payload = serde_json::from_str::<serde_json::Value>(&text).ok();
                    let field = |name: &str| {
                        payload
                            .as_ref()
                            .and_then(|value| value.get("payload"))
                            .and_then(|payload| payload.get(name))
                            .and_then(|found| found.as_str())
                            .map(str::to_string)
                    };
                    let kind = field("kind").unwrap_or_else(|| "unknown".to_string());
                    let label = match field("action_id") {
                        Some(action_id) => format!("{kind}:{action_id}"),
                        None => kind,
                    };
                    broker_view
                        .lock()
                        .unwrap()
                        .frames
                        .push((label, std::time::Instant::now()));
                }
                _ => {}
            }
        }
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let session_state = state.clone();
    let session = tokio::spawn(async move {
        let mut change_rx = session_state.subscribe();
        let _ = run_broker_session_with_liveness(
            &session_state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        )
        .await;
    });

    let mut live_watch_landed = false;
    for _ in 0..60 {
        if relay.read().await.any_device_watches_thread("thread-live") {
            live_watch_landed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    release_the_hang.notify_one();

    let stale_queue_drained = wait_for_queue_behind(&relay, "action-hangs").await;
    let (live_still_watched, stale_watched) = {
        let relay = relay.read().await;
        (
            relay.any_device_watches_thread("thread-live"),
            relay.any_device_watches_thread("thread-stale"),
        )
    };
    session.abort();

    let kinds = observations.lock().unwrap().kinds();
    assert!(
        hang_was_entered.load(std::sync::atomic::Ordering::SeqCst),
        "nothing was ever stuck, so the stale declaration was not queued behind anything"
    );
    assert!(
        live_watch_landed,
        "the replacement connection never got its declaration in, so there was nothing to \
         overwrite; saw {kinds:?}"
    );
    assert!(
        stale_queue_drained,
        "the stale declaration never ran, so this proves nothing; saw {kinds:?}"
    );
    assert!(
        live_still_watched && !stale_watched,
        "the closed connection's declaration was applied to the connection that replaced \
         it, so the phone stopped receiving what it is looking at; saw {kinds:?}"
    );
}

/// A reply must reach the connection that ASKED AGAIN, not the one that asked first.
///
/// The relay reserves an action id, enters the provider, and the broker connection blips.
/// The phone resends the same id when the relay is back — deliberately the same id, so the
/// replay cache answers instead of the action running twice. The relay sees it is still
/// running and says nothing at all, while the original task publishes its result through
/// the writer of a session that is gone. The phone waits out its deadline for work that
/// has in fact been done, which for a write is the one outcome worth avoiding.
#[tokio::test]
async fn a_result_reaches_the_session_that_asked_again_after_a_reconnect() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    let workspace = tempfile::TempDir::new().expect("tmpdir");
    let cwd = workspace.path().to_string_lossy().to_string();
    let entered_the_hang = Arc::new(tokio::sync::Notify::new());
    let release_the_hang = Arc::new(tokio::sync::Notify::new());
    let provider_entries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> = HashMap::new();
    providers.insert(
        "gated".to_string(),
        Arc::new(GatedThreadsProvider {
            entered_list_threads: Arc::clone(&entered_the_hang),
            released: Arc::clone(&release_the_hang),
            entries: Arc::clone(&provider_entries),
        }),
    );
    let (state, _relay) = encrypted_broker_state_parts(&cwd, providers).await;

    // Session one: ask, and get as far as the provider.
    let first_listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let first_address = first_listener
        .local_addr()
        .expect("listener should resolve");
    tokio::spawn(async move {
        let (stream, _) = first_listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");
        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![surface_peer("surface-a", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-survives",
                serde_json::json!({ "type": "list_threads", "query": { "limit": 20 } }),
            )))
            .await
            .expect("request sends");
        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            if let Message::Ping(payload) = frame {
                let _ = socket.send(Message::Pong(payload)).await;
            }
        }
    });

    let first_config = heartbeat_test_config(format!("ws://{first_address}")).await;
    let first_state = state.clone();
    let first_session = tokio::spawn(async move {
        let mut change_rx = first_state.subscribe();
        let _ = run_broker_session_with_liveness(
            &first_state,
            &mut change_rx,
            &first_config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        )
        .await;
    });

    let reached_the_provider =
        tokio::time::timeout(Duration::from_secs(3), entered_the_hang.notified())
            .await
            .is_ok();
    // The connection dies with the action still inside the provider.
    first_session.abort();

    // Session two: the same phone, the same action id, a connection that can be answered.
    let second_listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let second_address = second_listener
        .local_addr()
        .expect("listener should resolve");
    let observations = Arc::new(std::sync::Mutex::new(BrokerObservations::default()));
    let broker_view = Arc::clone(&observations);
    tokio::spawn(async move {
        let (stream, _) = second_listener
            .accept()
            .await
            .expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");
        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![surface_peer("surface-a", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-survives",
                serde_json::json!({ "type": "list_threads", "query": { "limit": 20 } }),
            )))
            .await
            .expect("resend sends");
        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    let payload = serde_json::from_str::<serde_json::Value>(&text).ok();
                    let field = |name: &str| {
                        payload
                            .as_ref()
                            .and_then(|value| value.get("payload"))
                            .and_then(|payload| payload.get(name))
                            .and_then(|found| found.as_str())
                            .map(str::to_string)
                    };
                    let kind = field("kind").unwrap_or_else(|| "unknown".to_string());
                    let ok = payload.as_ref().and_then(encrypted_action_result_ok);
                    let label = match (field("action_id"), ok) {
                        (Some(action_id), Some(ok)) => format!("{kind}:{action_id}:{ok}"),
                        (Some(action_id), None) => format!("{kind}:{action_id}"),
                        (None, _) => kind,
                    };
                    broker_view
                        .lock()
                        .unwrap()
                        .frames
                        .push((label, std::time::Instant::now()));
                }
                _ => {}
            }
        }
    });

    let second_config = heartbeat_test_config(format!("ws://{second_address}")).await;
    let second_state = state.clone();
    let second_session = tokio::spawn(async move {
        let mut change_rx = second_state.subscribe();
        let _ = run_broker_session_with_liveness(
            &second_state,
            &mut change_rx,
            &second_config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        )
        .await;
    });

    // Wait for the resend to have been PARKED rather than for a duration: on a slow run a
    // sleep can outlast the original, and then the resend is an ordinary replay and this
    // test passes with the waiting removed entirely.
    let mut resend_is_waiting = false;
    for _ in 0..60 {
        if state
            .remote_action_waiter_is_current("phone-1", "action-survives", 1)
            .await
        {
            resend_is_waiting = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let ran_twice = provider_entries.load(std::sync::atomic::Ordering::SeqCst) > 1;
    release_the_hang.notify_one();

    let mut answered = false;
    for _ in 0..60 {
        if observations
            .lock()
            .unwrap()
            .kinds()
            .iter()
            .any(|kind| kind.ends_with(":action-survives:true"))
        {
            answered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    second_session.abort();

    let kinds = observations.lock().unwrap().kinds();
    assert!(
        reached_the_provider,
        "the first session never got as far as the provider, so nothing was in flight \
         across the reconnect"
    );
    assert!(
        resend_is_waiting,
        "the resend was never parked behind the original, so it was answered as an \
         ordinary replay and proves nothing about a reconnect; saw {kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|kind| kind.starts_with("remote_action_pending:action-survives")),
        "the parked resend was never told it was still being worked on, so the phone \
         counts down against it and reports a failure for work still in progress; saw \
         {kinds:?}"
    );
    assert!(
        !ran_twice,
        "the resend ran the action a second time; the replay cache exists precisely so a \
         resend of a write cannot do that"
    );
    assert!(
        answered,
        "the second connection asked for the same action and was told nothing, so the \
         phone waits out its deadline for work the relay had already done; saw {kinds:?}"
    );
}

/// A handler that panics must still answer the device that asked.
///
/// Otherwise the reserved action id sits "still running" until a lazy sweep notices it,
/// every resend is parked behind an owner that will never finish, and the phone is left
/// counting down against work whose outcome nobody will ever state.
#[tokio::test]
async fn a_panicking_action_answers_the_device_rather_than_going_quiet() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    let workspace = tempfile::TempDir::new().expect("tmpdir");
    let cwd = workspace.path().to_string_lossy().to_string();
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let observations = Arc::new(std::sync::Mutex::new(BrokerObservations::default()));
    let broker_view = Arc::clone(&observations);

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");
        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![surface_peer("surface-a", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-panics",
                serde_json::json!({ "type": "list_threads", "query": { "limit": 20 } }),
            )))
            .await
            .expect("request sends");
        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    let payload = serde_json::from_str::<serde_json::Value>(&text).ok();
                    let field = |name: &str| {
                        payload
                            .as_ref()
                            .and_then(|value| value.get("payload"))
                            .and_then(|payload| payload.get(name))
                            .and_then(|found| found.as_str())
                            .map(str::to_string)
                    };
                    let kind = field("kind").unwrap_or_else(|| "unknown".to_string());
                    let ok = payload.as_ref().and_then(encrypted_action_result_ok);
                    let label = match (field("action_id"), ok) {
                        (Some(action_id), Some(ok)) => format!("{kind}:{action_id}:{ok}"),
                        (Some(action_id), None) => format!("{kind}:{action_id}"),
                        (None, _) => kind,
                    };
                    broker_view
                        .lock()
                        .unwrap()
                        .frames
                        .push((label, std::time::Instant::now()));
                }
                _ => {}
            }
        }
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> = HashMap::new();
    providers.insert("panics".to_string(), Arc::new(PanickingProvider));
    let (state, _relay) = encrypted_broker_state_parts(&cwd, providers).await;
    let session_state = state.clone();
    let session = tokio::spawn(async move {
        let mut change_rx = session_state.subscribe();
        let _ = run_broker_session_with_liveness(
            &session_state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        )
        .await;
    });

    let mut answered = false;
    for _ in 0..60 {
        if observations
            .lock()
            .unwrap()
            .kinds()
            .iter()
            .any(|kind| kind.contains(":action-panics:"))
        {
            answered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    session.abort();

    let kinds = observations.lock().unwrap().kinds();
    assert!(
        answered,
        "a handler that fell over left the device with no answer at all, and its action id \
         reserved against every resend; saw {kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|kind| kind.ends_with(":action-panics:false")),
        "the answer has to say it did not succeed; saw {kinds:?}"
    );
}

/// A joined-then-left pair must settle as LEFT, whichever way the queue runs.
///
/// A departure is handled on the router and an arrival was not, so an arrival that
/// arrived FIRST could be applied last and mark an already-gone surface present again —
/// which quietly reopens every guard that keys off the departure.
#[tokio::test]
async fn an_arrival_queued_before_a_departure_cannot_undo_it() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    let workspace = tempfile::TempDir::new().expect("tmpdir");
    let cwd = workspace.path().to_string_lossy().to_string();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let observations = Arc::new(std::sync::Mutex::new(BrokerObservations::default()));
    let broker_view = Arc::clone(&observations);
    let entered_the_hang = Arc::new(tokio::sync::Notify::new());
    let broker_waits_for_the_hang = Arc::clone(&entered_the_hang);
    let hang_was_entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let broker_saw_the_hang = Arc::clone(&hang_was_entered);
    let release_the_hang = Arc::new(tokio::sync::Notify::new());

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");

        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![surface_peer("surface-a", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;

        // Bury this surface's worker, so anything the router hands it stays unhandled.
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-hangs",
                serde_json::json!({ "type": "list_threads", "query": { "limit": 20 } }),
            )))
            .await
            .expect("hanging request sends");
        if tokio::time::timeout(Duration::from_secs(2), broker_waits_for_the_hang.notified())
            .await
            .is_ok()
        {
            broker_saw_the_hang.store(true, std::sync::atomic::Ordering::SeqCst);
        }

        let arrival = ServerMessage::Presence {
            channel_id: "room-e2e".to_string(),
            kind: PresenceKind::Joined,
            peer: surface_peer("surface-a", "phone-1"),
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&arrival).expect("presence serializes"),
            ))
            .await
            .expect("presence sends");
        // Behind the arrival in wire order, so its reply is proof the arrival has been
        // dealt with — the hanging request's own reply is not, it comes first either way.
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-after-arrival",
                serde_json::json!({ "type": "fetch_projects" }),
            )))
            .await
            .expect("marker sends");
        let departure = ServerMessage::Presence {
            channel_id: "room-e2e".to_string(),
            kind: PresenceKind::Left,
            peer: surface_peer("surface-a", "phone-1"),
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&departure).expect("presence serializes"),
            ))
            .await
            .expect("presence sends");

        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    let payload = serde_json::from_str::<serde_json::Value>(&text).ok();
                    let field = |name: &str| {
                        payload
                            .as_ref()
                            .and_then(|value| value.get("payload"))
                            .and_then(|payload| payload.get(name))
                            .and_then(|found| found.as_str())
                            .map(str::to_string)
                    };
                    let kind = field("kind").unwrap_or_else(|| "unknown".to_string());
                    let label = match field("action_id") {
                        Some(action_id) => format!("{kind}:{action_id}"),
                        None => kind,
                    };
                    broker_view
                        .lock()
                        .unwrap()
                        .frames
                        .push((label, std::time::Instant::now()));
                }
                _ => {}
            }
        }
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> = HashMap::new();
    providers.insert(
        "gated".to_string(),
        Arc::new(GatedThreadsProvider {
            entered_list_threads: Arc::clone(&entered_the_hang),
            released: Arc::clone(&release_the_hang),
            entries: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }),
    );
    let (state, relay) = encrypted_broker_state_parts(&cwd, providers).await;
    let session_state = state.clone();
    let session = tokio::spawn(async move {
        let mut change_rx = session_state.subscribe();
        let _ = run_broker_session_with_liveness(
            &session_state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        )
        .await;
    });

    release_the_hang.notify_one();

    let queue_drained = wait_for_queue_behind(&relay, "action-hangs").await;
    let (still_departed, back_online) = {
        let relay = relay.read().await;
        (
            relay.current_surface_lease("surface-a").is_none(),
            relay.surface_peer_is_online("surface-a"),
        )
    };
    session.abort();

    let kinds = observations.lock().unwrap().kinds();
    assert!(
        hang_was_entered.load(std::sync::atomic::Ordering::SeqCst),
        "nothing was ever stuck, so the arrival was not queued behind anything"
    );
    assert!(
        queue_drained,
        "nothing queued after the arrival ever ran, so the arrival itself may not have; \
         saw {kinds:?}"
    );
    assert!(
        still_departed && !back_online,
        "an arrival that arrived BEFORE the departure was applied after it, so a surface \
         that is gone reads as present again; saw {kinds:?}"
    );
}

/// A surface's queued frames outlive its departure. They must not put it back.
///
/// The departure prunes the surface's watch set, but a `watch_threads` already queued
/// behind a slow action runs afterwards and re-registers it. Nothing prunes it again, so
/// the provider keeps producing deltas for a phone that has gone, until the relay's whole
/// broker connection resets.
#[tokio::test]
async fn a_frame_queued_before_a_departure_does_not_re_register_the_surface() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    let workspace = tempfile::TempDir::new().expect("tmpdir");
    let cwd = workspace.path().to_string_lossy().to_string();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let observations = Arc::new(std::sync::Mutex::new(BrokerObservations::default()));
    let broker_view = Arc::clone(&observations);
    let entered_the_hang = Arc::new(tokio::sync::Notify::new());
    let broker_waits_for_the_hang = Arc::clone(&entered_the_hang);
    let hang_was_entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let broker_saw_the_hang = Arc::clone(&hang_was_entered);
    let release_the_hang = Arc::new(tokio::sync::Notify::new());
    let departure_sent = Arc::new(tokio::sync::Notify::new());
    let broker_announces_departure = Arc::clone(&departure_sent);

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");

        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![surface_peer("surface-a", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;

        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-hangs",
                serde_json::json!({ "type": "list_threads", "query": { "limit": 20 } }),
            )))
            .await
            .expect("hanging request sends");
        if tokio::time::timeout(Duration::from_secs(2), broker_waits_for_the_hang.notified())
            .await
            .is_ok()
        {
            broker_saw_the_hang.store(true, std::sync::atomic::Ordering::SeqCst);
        }

        // Both queue behind the hang. The second one only exists so the test can tell
        // when the first has run: a watch declaration is answered with nothing.
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-watch",
                serde_json::json!({
                    "type": "watch_threads",
                    "input": { "thread_ids": ["thread-x"], "device_id": "phone-1" }
                }),
            )))
            .await
            .expect("watch request sends");
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-after-watch",
                serde_json::json!({ "type": "fetch_projects" }),
            )))
            .await
            .expect("follow-up request sends");

        let left = ServerMessage::Presence {
            channel_id: "room-e2e".to_string(),
            kind: PresenceKind::Left,
            peer: surface_peer("surface-a", "phone-1"),
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&left).expect("presence serializes"),
            ))
            .await
            .expect("presence sends");
        broker_announces_departure.notify_one();

        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    let payload = serde_json::from_str::<serde_json::Value>(&text).ok();
                    let field = |name: &str| {
                        payload
                            .as_ref()
                            .and_then(|value| value.get("payload"))
                            .and_then(|payload| payload.get(name))
                            .and_then(|found| found.as_str())
                            .map(str::to_string)
                    };
                    let kind = field("kind").unwrap_or_else(|| "unknown".to_string());
                    let label = match field("action_id") {
                        Some(action_id) => format!("{kind}:{action_id}"),
                        None => kind,
                    };
                    broker_view
                        .lock()
                        .unwrap()
                        .frames
                        .push((label, std::time::Instant::now()));
                }
                _ => {}
            }
        }
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> = HashMap::new();
    providers.insert(
        "gated".to_string(),
        Arc::new(GatedThreadsProvider {
            entered_list_threads: Arc::clone(&entered_the_hang),
            released: Arc::clone(&release_the_hang),
            entries: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }),
    );
    let (state, relay) = encrypted_broker_state_parts(&cwd, providers).await;
    let session_state = state.clone();
    let session = tokio::spawn(async move {
        let mut change_rx = session_state.subscribe();
        let _ = run_broker_session_with_liveness(
            &session_state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        )
        .await;
    });

    // Wait for the departure to be on the wire, THEN for the relay to have applied it.
    // Polling for "gone" before it is sent would pass at once — nothing has arrived yet —
    // and the queue would drain with no departure for it to outlive.
    let _ = tokio::time::timeout(Duration::from_secs(3), departure_sent.notified()).await;
    let mut recorded_as_gone = false;
    for _ in 0..60 {
        if !relay.read().await.surface_peer_is_online("surface-a") {
            recorded_as_gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Only now let the queue drain, so the watch declaration lands AFTER the departure.
    release_the_hang.notify_one();

    let queue_drained = wait_for_queue_behind(&relay, "action-hangs").await;
    let still_watched = relay.read().await.any_device_watches_thread("thread-x");
    session.abort();

    let kinds = observations.lock().unwrap().kinds();
    assert!(
        hang_was_entered.load(std::sync::atomic::Ordering::SeqCst),
        "nothing was ever stuck, so the frames below were not queued behind anything"
    );
    assert!(
        recorded_as_gone,
        "the surface never departed, so re-registering it would be correct; saw {kinds:?}"
    );
    assert!(
        queue_drained,
        "the frames queued behind the hang never ran, so this proves nothing about what \
         they did; saw {kinds:?}"
    );
    assert!(
        !still_watched,
        "a watch declaration queued before the departure put the departed surface back, \
         so the provider keeps producing deltas nobody will read; saw {kinds:?}"
    );
}

/// A late frame from a gone connection must not steal the device back from the live one.
///
/// Every action stamps "this device was last seen at this peer". A frame queued behind a
/// slow action runs after its phone has reconnected as a NEW peer, and stamping the old
/// one there points every reply at a connection that is closed.
#[tokio::test]
async fn a_late_frame_does_not_rebind_a_device_to_its_closed_connection() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    let workspace = tempfile::TempDir::new().expect("tmpdir");
    let cwd = workspace.path().to_string_lossy().to_string();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let observations = Arc::new(std::sync::Mutex::new(BrokerObservations::default()));
    let broker_view = Arc::clone(&observations);
    let entered_the_hang = Arc::new(tokio::sync::Notify::new());
    let broker_waits_for_the_hang = Arc::clone(&entered_the_hang);
    let hang_was_entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let broker_saw_the_hang = Arc::clone(&hang_was_entered);
    let release_the_hang = Arc::new(tokio::sync::Notify::new());

    let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> = HashMap::new();
    providers.insert(
        "gated".to_string(),
        Arc::new(GatedThreadsProvider {
            entered_list_threads: Arc::clone(&entered_the_hang),
            released: Arc::clone(&release_the_hang),
            entries: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }),
    );
    let (state, relay) = encrypted_broker_state_parts(&cwd, providers).await;
    let script_relay = Arc::clone(&relay);
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");

        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![surface_peer("surface-old", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;

        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-old",
                "action-hangs",
                serde_json::json!({ "type": "list_threads", "query": { "limit": 20 } }),
            )))
            .await
            .expect("hanging request sends");
        if tokio::time::timeout(Duration::from_secs(2), broker_waits_for_the_hang.notified())
            .await
            .is_ok()
        {
            broker_saw_the_hang.store(true, std::sync::atomic::Ordering::SeqCst);
        }

        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-old",
                "action-late",
                serde_json::json!({ "type": "fetch_projects" }),
            )))
            .await
            .expect("late request sends");

        // The phone drops and comes back as a new peer, which is what a reconnect looks
        // like from here: same device id, different connection.
        for (kind, peer) in [
            (PresenceKind::Left, "surface-old"),
            (PresenceKind::Joined, "surface-new"),
        ] {
            let presence = ServerMessage::Presence {
                channel_id: "room-e2e".to_string(),
                kind,
                peer: surface_peer(peer, "phone-1"),
            };
            socket
                .send(Message::Text(
                    serde_json::to_string(&presence).expect("presence serializes"),
                ))
                .await
                .expect("presence sends");
        }
        // The new connection proves itself (a claim) and acts, which is what binds it.
        authorize_joined(&script_relay, "surface-new").await;
        send_test_hellos(
            &mut socket,
            &ServerMessage::Welcome {
                protocol_version: BROKER_PROTOCOL_VERSION,
                channel_id: "room-e2e".to_string(),
                peer_id: "relay-e2e".to_string(),
                peers: vec![surface_peer("surface-new", "phone-1")],
            },
        )
        .await;
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-new",
                "action-new-heartbeat",
                serde_json::json!({ "type": "heartbeat", "input": {} }),
            )))
            .await
            .expect("heartbeat sends");

        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    let payload = serde_json::from_str::<serde_json::Value>(&text).ok();
                    let field = |name: &str| {
                        payload
                            .as_ref()
                            .and_then(|value| value.get("payload"))
                            .and_then(|payload| payload.get(name))
                            .and_then(|found| found.as_str())
                            .map(str::to_string)
                    };
                    let kind = field("kind").unwrap_or_else(|| "unknown".to_string());
                    let label = match field("action_id") {
                        Some(action_id) => format!("{kind}:{action_id}"),
                        None => kind,
                    };
                    broker_view
                        .lock()
                        .unwrap()
                        .frames
                        .push((label, std::time::Instant::now()));
                }
                _ => {}
            }
        }
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let session_state = state.clone();
    let session = tokio::spawn(async move {
        let mut change_rx = session_state.subscribe();
        let _ = run_broker_session_with_liveness(
            &session_state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        )
        .await;
    });

    let mut reconnected = false;
    for _ in 0..60 {
        if relay
            .read()
            .await
            .paired_device_peer_id("phone-1")
            .as_deref()
            == Some("surface-new")
        {
            reconnected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    release_the_hang.notify_one();

    let late_frame_ran = wait_for_queue_behind(&relay, "action-hangs").await;
    let bound_to = relay.read().await.paired_device_peer_id("phone-1");
    session.abort();

    let kinds = observations.lock().unwrap().kinds();
    assert!(
        hang_was_entered.load(std::sync::atomic::Ordering::SeqCst),
        "nothing was ever stuck, so the late frame was not queued behind anything"
    );
    assert!(
        reconnected,
        "the device never moved to the new connection, so there was nothing to steal back; \
         saw {kinds:?}"
    );
    assert!(
        late_frame_ran,
        "the queued frame never ran, so this proves nothing about what it did; saw {kinds:?}"
    );
    assert_eq!(
        bound_to.as_deref(),
        Some("surface-new"),
        "a frame from the closed connection took the device back, so replies now go to a \
         peer that is gone; saw {kinds:?}"
    );
}

/// A big reply is not paced at a surface the relay WATCHED leave.
///
/// The writer abandons a train only when it was told which surface the train is for, and
/// `publish_remote_action_result_chunks` only records that when the surface is online as
/// the train is queued. So a departure that lands first turns the reply into one nobody
/// can stop: it paces to the end, holding the single train slot against everyone else.
/// Realistically the departure arrives mid-action; sending the request afterwards is the
/// same publisher decision with none of the timing.
#[tokio::test]
async fn a_big_reply_is_not_paced_at_a_surface_the_relay_saw_leave() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    let workspace = workspace_with_a_large_diff();
    let cwd = workspace.path().to_string_lossy().to_string();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let observations = Arc::new(std::sync::Mutex::new(BrokerObservations::default()));
    let broker_view = Arc::clone(&observations);
    let arrival_was_seen = Arc::new(tokio::sync::Notify::new());
    let broker_waits_for_arrival = Arc::clone(&arrival_was_seen);
    let departure_was_seen = Arc::new(tokio::sync::Notify::new());
    let broker_waits_for_departure = Arc::clone(&departure_was_seen);

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");

        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![surface_peer("surface-a", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;

        let _ =
            tokio::time::timeout(Duration::from_secs(3), broker_waits_for_arrival.notified()).await;
        let left = ServerMessage::Presence {
            channel_id: "room-e2e".to_string(),
            kind: PresenceKind::Left,
            peer: surface_peer("surface-a", "phone-1"),
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&left).expect("presence serializes"),
            ))
            .await
            .expect("presence sends");

        let _ = tokio::time::timeout(
            Duration::from_secs(3),
            broker_waits_for_departure.notified(),
        )
        .await;
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-diff",
                serde_json::json!({ "type": "fetch_workspace_diff" }),
            )))
            .await
            .expect("diff request sends");

        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    let kind = serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|value| {
                            value
                                .get("payload")
                                .and_then(|payload| payload.get("kind"))
                                .and_then(|kind| kind.as_str())
                                .map(str::to_string)
                        })
                        .unwrap_or_else(|| "unknown".to_string());
                    broker_view
                        .lock()
                        .unwrap()
                        .frames
                        .push((kind, std::time::Instant::now()));
                }
                _ => {}
            }
        }
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let (state, relay) = encrypted_broker_state_parts(&cwd, HashMap::new()).await;
    let session_state = state.clone();
    let session = tokio::spawn(async move {
        let mut change_rx = session_state.subscribe();
        let _ = run_broker_session_with_liveness(
            &session_state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        )
        .await;
    });

    let mut was_ever_online = false;
    for _ in 0..60 {
        if relay.read().await.surface_peer_is_online("surface-a") {
            was_ever_online = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    arrival_was_seen.notify_one();
    let mut recorded_as_gone = false;
    if was_ever_online {
        for _ in 0..60 {
            if !relay.read().await.surface_peer_is_online("surface-a") {
                recorded_as_gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    departure_was_seen.notify_one();
    // Long enough for a full train to have paced: ~10 chunks at 250ms.
    tokio::time::sleep(Duration::from_secs(3)).await;
    session.abort();

    let seen = observations.lock().unwrap();
    let kinds = seen.kinds();
    assert!(
        was_ever_online && recorded_as_gone,
        "the departure was never recorded, so the reply below was not aimed at a surface \
         the relay knew had gone; saw {kinds:?}"
    );
    let chunks = seen.count_of("encrypted_remote_action_result_chunk");
    assert!(
        chunks <= 1,
        "the relay paced {chunks} chunks at a surface it had already watched leave, and \
         held the one train slot for the length of it; saw {kinds:?}"
    );
}

/// A phone that has gone must be recorded as gone, even while its own last request hangs.
///
/// Until it is, the relay still believes it is there: replies keep being addressed at it
/// and it still counts as a watcher. Nothing about that gets better by waiting for a
/// provider call the departed phone will never read the answer to.
#[tokio::test]
async fn a_departure_is_recorded_while_that_surface_is_still_hanging() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    let workspace = tempfile::TempDir::new().expect("tmpdir");
    let cwd = workspace.path().to_string_lossy().to_string();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let entered_the_hang = Arc::new(tokio::sync::Notify::new());
    let broker_waits_for_the_hang = Arc::clone(&entered_the_hang);
    // The departure must not be sent until the test has SEEN the surface online: the fix
    // makes it land fast enough that arrival and departure can both pass between polls.
    let arrival_was_seen = Arc::new(tokio::sync::Notify::new());
    let broker_waits_for_arrival = Arc::clone(&arrival_was_seen);
    let hang_was_entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let broker_saw_the_hang = Arc::clone(&hang_was_entered);

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");

        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![surface_peer("surface-a", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;

        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-hangs",
                serde_json::json!({ "type": "list_threads", "query": { "limit": 20 } }),
            )))
            .await
            .expect("hanging request sends");

        if tokio::time::timeout(Duration::from_secs(2), broker_waits_for_the_hang.notified())
            .await
            .is_ok()
        {
            broker_saw_the_hang.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let _ =
            tokio::time::timeout(Duration::from_secs(3), broker_waits_for_arrival.notified()).await;

        let left = ServerMessage::Presence {
            channel_id: "room-e2e".to_string(),
            kind: PresenceKind::Left,
            peer: surface_peer("surface-a", "phone-1"),
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&left).expect("presence serializes"),
            ))
            .await
            .expect("presence sends");

        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> = HashMap::new();
    providers.insert(
        "never-answers".to_string(),
        Arc::new(NeverAnswersProvider {
            entered_list_threads: Arc::clone(&entered_the_hang),
        }),
    );
    let (state, relay) = encrypted_broker_state_parts(&cwd, providers).await;

    let session_state = state.clone();
    let session = tokio::spawn(async move {
        let mut change_rx = session_state.subscribe();
        let _ = run_broker_session_with_liveness(
            &session_state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        )
        .await;
    });

    // "Not online" is also true before the relay has connected at all, so the arrival has
    // to be witnessed first or the departure below proves nothing.
    let mut was_ever_online = false;
    for _ in 0..60 {
        if relay.read().await.surface_peer_is_online("surface-a") {
            was_ever_online = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    arrival_was_seen.notify_one();
    let mut recorded_as_gone = false;
    if was_ever_online {
        for _ in 0..60 {
            if !relay.read().await.surface_peer_is_online("surface-a") {
                recorded_as_gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    session.abort();

    assert!(
        hang_was_entered.load(std::sync::atomic::Ordering::SeqCst),
        "the request never reached the hanging provider, so the departure below overtook \
         nothing"
    );
    assert!(
        was_ever_online,
        "the surface was never recorded as present, so its departure is not evidence of \
         anything"
    );
    assert!(
        recorded_as_gone,
        "the relay still has the departed surface online: its departure is queued behind \
         its own hung request, which is exactly the frame that cannot wait"
    );
}

/// A frame the relay cannot queue must not simply vanish.
///
/// `frontend/remote/actions.js` retries only session-claim failures, so a shed frame is
/// a Stop or an approval the user pressed and nothing ever did. Ending the session is
/// lossy in appearance only: the phone resends its pending action ids on reconnect.
#[tokio::test]
async fn a_full_surface_queue_ends_the_session_rather_than_shedding_a_frame() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    let workspace = tempfile::TempDir::new().expect("tmpdir");
    let cwd = workspace.path().to_string_lossy().to_string();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let entered_the_hang = Arc::new(tokio::sync::Notify::new());
    let broker_waits_for_the_hang = Arc::clone(&entered_the_hang);
    let hang_was_entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let broker_saw_the_hang = Arc::clone(&hang_was_entered);
    let overflowed_by = 8_usize;

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");

        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![surface_peer("surface-a", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;

        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-hangs",
                serde_json::json!({ "type": "list_threads", "query": { "limit": 20 } }),
            )))
            .await
            .expect("hanging request sends");

        // Only once its worker is stuck does anything sent after it have nowhere to go.
        if tokio::time::timeout(Duration::from_secs(2), broker_waits_for_the_hang.notified())
            .await
            .is_ok()
        {
            broker_saw_the_hang.store(true, std::sync::atomic::Ordering::SeqCst);
        }

        for index in 0..(SURFACE_MESSAGE_QUEUE_CAPACITY + overflowed_by) {
            socket
                .send(Message::Text(encrypted_action_frame(
                    "surface-a",
                    &format!("action-buried-{index}"),
                    serde_json::json!({ "type": "fetch_projects" }),
                )))
                .await
                .expect("buried request sends");
        }

        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> = HashMap::new();
    providers.insert(
        "never-answers".to_string(),
        Arc::new(NeverAnswersProvider {
            entered_list_threads: Arc::clone(&entered_the_hang),
        }),
    );
    let state = encrypted_broker_state_with_providers(&cwd, providers).await;
    let mut change_rx = state.subscribe();

    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        run_broker_session_with_liveness(
            &state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        ),
    )
    .await;

    let ended = outcome.expect(
        "the relay carried on after a surface's queue overflowed, so the frames past it \
         were dropped and nothing will ever ask for them again",
    );
    let error = ended.expect_err("an overflowed surface queue must end the session");
    assert!(
        hang_was_entered.load(std::sync::atomic::Ordering::SeqCst),
        "the buried frames were sent before anything was actually stuck, so the queue \
         filled for some other reason than a slow action"
    );
    // The exact reason, not just "surface": a worker that died or panicked ends the session
    // too, and would otherwise satisfy this test without any frame having overflowed.
    assert!(
        error.message().contains("fell too far behind"),
        "the session ended for some other reason than the overflow: {}",
        error.message()
    );
}

/// A surface that leaves mid-reply must not cost every other surface the rest of that
/// reply's pacing.
///
/// Surface A asks for a workspace diff big enough to be chunked (~10 chunks, 250ms
/// apart — about 2.3s of pacing). While that reply is going out, A leaves and B asks a
/// question. Two things must hold, and before this work neither did:
///
///   * B is answered promptly, because the relay is still READING. Previously the
///     session loop awaited the whole chunked publish inline, so B's frame sat unread
///     on the socket until A's reply had finished.
///   * A's train stops, because the departure is now observable while the train paces.
///     Previously the presence frame announcing it could not be read until afterwards,
///     which is what made the first attempt at this fix a no-op.
///
/// Only the second bullet still has teeth. Publishing is a hand-off to the writer task
/// now, so the first one holds even with message handling made serial again — checked.
#[tokio::test]
async fn a_departing_surface_does_not_stall_the_relay_for_everyone_else() {
    if !broker_session_e2e_enabled() {
        eprintln!("skipping: set AGENT_RELAY_BROKER_SESSION_E2E=1 to run the broker session e2e");
        return;
    }

    let workspace = workspace_with_a_large_diff();
    let cwd = workspace.path().to_string_lossy().to_string();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let observations = Arc::new(std::sync::Mutex::new(BrokerObservations::default()));
    let broker_view = Arc::clone(&observations);

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");

        // Both surfaces are in the room, so the relay records them as online — which is
        // what later makes A's departure an *observed* one.
        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-e2e".to_string(),
            peer_id: "relay-e2e".to_string(),
            peers: vec![
                surface_peer("surface-a", "phone-1"),
                surface_peer("surface-b", "phone-1"),
            ],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;

        // A asks for the big diff.
        socket
            .send(Message::Text(encrypted_action_frame(
                "surface-a",
                "action-diff",
                serde_json::json!({ "type": "fetch_workspace_diff" }),
            )))
            .await
            .expect("diff request sends");

        let mut announced_departure = false;
        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    let payload: serde_json::Value =
                        serde_json::from_str(&text).expect("broker frame parses");
                    let kind = payload
                        .get("payload")
                        .and_then(|payload| payload.get("kind"))
                        .and_then(|kind| kind.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| "unknown".to_string());
                    broker_view.lock().unwrap().frames.push((
                        if kind == "encrypted_remote_action_result" {
                            format!(
                                "{kind}:{}",
                                payload["payload"]["action_id"]
                                    .as_str()
                                    .expect("reply has an action id")
                            )
                        } else {
                            kind.clone()
                        },
                        std::time::Instant::now(),
                    ));

                    // The moment A's reply starts streaming, A goes away and B asks
                    // something. This is the interleaving the old code could not serve.
                    if kind == "encrypted_remote_action_result_chunk" && !announced_departure {
                        announced_departure = true;
                        let left = ServerMessage::Presence {
                            channel_id: "room-e2e".to_string(),
                            kind: PresenceKind::Left,
                            peer: surface_peer("surface-a", "phone-1"),
                        };
                        socket
                            .send(Message::Text(
                                serde_json::to_string(&left).expect("presence serializes"),
                            ))
                            .await
                            .expect("presence sends");
                        socket
                            .send(Message::Text(encrypted_action_frame(
                                "surface-b",
                                "action-threads",
                                serde_json::json!({ "type": "list_threads", "query": { "limit": 5 } }),
                            )))
                            .await
                            .expect("second request sends");
                    }
                }
                _ => {}
            }
        }
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let state = encrypted_broker_state(&cwd).await;
    let mut change_rx = state.subscribe();

    let _session = tokio::time::timeout(
        Duration::from_secs(3),
        run_broker_session_with_liveness(
            &state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        ),
    )
    .await;

    let seen = observations.lock().unwrap();
    let kinds = seen.kinds();

    // `expect` takes a literal, so the `{kinds:?}` this used to pass never interpolated —
    // the failure told you nothing about what actually arrived.
    let first_chunk_at = seen
        .first_at("encrypted_remote_action_result_chunk")
        .unwrap_or_else(|| panic!("the diff reply must be chunked; saw {kinds:?}"));
    let threads_at = seen
        .first_at("encrypted_remote_action_result:action-threads")
        .unwrap_or_else(|| panic!("surface B was never answered at all; saw {kinds:?}"));

    let b_waited = threads_at.saturating_duration_since(first_chunk_at);
    assert!(
        b_waited < Duration::from_millis(750),
        "surface B waited {}ms behind another surface's chunked reply. The reply paces \
         ~2.3s, so anything near that means the relay stopped reading while it wrote — \
         the exact stall this test exists for. Frames: {kinds:?}",
        b_waited.as_millis()
    );

    let chunks = seen.count_of("encrypted_remote_action_result_chunk");
    assert!(
        chunks < 8,
        "surface A left after its first chunk, so its train should have been abandoned; \
         got {chunks} chunks. Frames: {kinds:?}"
    );
}

/// A dropped publish must never pass unnoticed.
///
/// The broker's answer to an over-budget peer is to discard that frame and keep the
/// socket open. The relay used to treat the resulting `rate_limited` as mild
/// backpressure and merely delay its next snapshot — but nothing about that recovers
/// the frame that was already thrown away, and the relay cannot even tell which one it
/// was. A discarded transcript delta the client can repair; a discarded chunk it
/// cannot, and the reply it belongs to can then only time out.
///
/// So it is fatal. The session ends, reconnects, and resyncs — and the surface fails its
/// in-flight actions immediately on the disconnect rather than waiting out a deadline
/// for chunks that will never come. A visible, self-healing reconnect beats silent
/// corruption; the allowance is sized so this should not happen in the first place.
#[tokio::test]
async fn a_dropped_publish_ends_the_session_instead_of_passing_unnoticed() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");
        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-stalled".to_string(),
            peer_id: "relay-stalled".to_string(),
            peers: Vec::new(),
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;
        let rate_limited = ServerMessage::Error {
            code: "rate_limited".to_string(),
            message: "broker publish rate limit exceeded for this peer".to_string(),
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&rate_limited).expect("error serializes"),
            ))
            .await
            .expect("error sends");
        std::future::pending::<()>().await;
    });

    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let state = broker_test_state();
    let mut change_rx = state.subscribe();

    let outcome = tokio::time::timeout(
        Duration::from_secs(2),
        run_broker_session_with_liveness(
            &state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        ),
    )
    .await
    .expect("the session must not sit there after a frame was dropped");

    assert!(
        outcome.is_err(),
        "a dropped publish must end the session so it reconnects and resyncs, rather \
         than continuing with a hole in what the surface received"
    );
}

// ---------------------------------------------------------------------------
// One bad payload must not disconnect the room
//
// The payload version is a hard cut: relay and surface ship together, so an older
// version is simply not served. What must NOT happen is the rest of the room paying for
// it. A rejected payload is a parse-level failure, and that error used to end the whole
// broker session — every surface, not just the one that sent the bad frame. A tab left
// open across a relay restart is enough to trigger it, and each teardown resyncs a full
// snapshot. These run in CI (no git, no pacing) because they guard an availability
// property nobody can test by hand.
// ---------------------------------------------------------------------------

/// A phone frame signed under the session `seed_test_request_sessions` opened for
/// `from_peer_id`, against the fixed relay identity `heartbeat_test_config` uses.
fn encrypted_action_frame_versioned(
    from_peer_id: &str,
    action_id: &str,
    request: serde_json::Value,
    protocol_version: u64,
) -> String {
    let binding = request_auth::RelayRequestBinding {
        relay_verify_key: STANDARD.encode(
            SigningKey::from_bytes(&super::writer::TEST_RELAY_CONTENT_SEED)
                .verifying_key()
                .to_bytes(),
        ),
        broker_room_id: "room-stalled".to_string(),
        relay_peer_id: "relay-stalled".to_string(),
    };
    let mut payload = request_auth::test_signed_request(
        &SigningKey::from_bytes(&TEST_PHONE_SEED),
        &binding,
        "phone-1",
        from_peer_id,
        &test_sid(from_peer_id),
        TEST_FRAME_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1,
        action_id,
        &request,
        "secret",
    );
    // The constant, not a literal, unless a test asks: the wrong version is refused
    // at parse, and a stale literal reads like a hang rather than a version mismatch.
    payload["protocol_version"] = serde_json::json!(protocol_version);
    serde_json::to_string(&serde_json::json!({
        "type": "message",
        "channel_id": "room-e2e",
        "from_peer_id": from_peer_id,
        "from_role": "surface",
        "payload": payload,
    }))
    .expect("action frame serializes")
}

/// Same as [`encrypted_broker_state`] but in PRIVATE mode, which is the default and the
/// one where plaintext remote actions are refused.
async fn private_broker_state(cwd: &str) -> AppState {
    let (change_tx, _) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        cwd.to_string(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    relay.write().await.paired_devices.insert(
        "phone-1".to_string(),
        crate::state::PairedDevice {
            device_id: "phone-1".to_string(),
            label: "phone-1".to_string(),
            payload_secret: "secret".to_string(),
            device_verify_key: test_phone_verify_key(),
            created_at: 1,
            last_seen_at: Some(1),
            last_peer_id: None,
            broker_join_ticket_expires_at: None,
            path_scope: Vec::new(),
            pairing_broker: None,
        },
    );
    seed_test_request_sessions(&mut *relay.write().await);
    AppState::from_parts(relay, HashMap::new(), change_tx)
}

/// Drive one relay session against a fake broker that sends `frames` after the welcome,
/// and report every payload kind the relay published back.
async fn observe_relay_session_for_frames(frames: Vec<String>) -> Vec<String> {
    observe_relay_session_with_state(frames, None).await
}

async fn observe_relay_session_with_state(
    frames: Vec<String>,
    state_override: Option<AppState>,
) -> Vec<String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    let observations = Arc::new(std::sync::Mutex::new(BrokerObservations::default()));
    let broker_view = Arc::clone(&observations);

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("handshake should succeed");

        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-version".to_string(),
            peer_id: "relay-version".to_string(),
            peers: vec![surface_peer("surface-a", "phone-1")],
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome serializes"),
            ))
            .await
            .expect("welcome sends");
        send_test_hellos(&mut socket, &welcome).await;
        // A phone hello is what installs the content session. Without it the writer
        // drops the reply instead of sending it unsigned.
        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "message",
                    "channel_id": "room-version",
                    "from_peer_id": "surface-a",
                    "from_role": "surface",
                    "payload": {
                        "kind": "relay_hello",
                        "protocol_version": RELAY_PROTOCOL_VERSION,
                        "device_id": "phone-1",
                        "hello_nonce": "cd".repeat(18),
                    }
                })
                .to_string(),
            ))
            .await
            .expect("hello sends");
        for frame in frames {
            socket
                .send(Message::Text(frame))
                .await
                .expect("frame sends");
        }

        while let Some(frame) = socket.next().await {
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(payload) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    let payload: serde_json::Value =
                        serde_json::from_str(&text).expect("broker frame parses");
                    let kind = payload
                        .get("payload")
                        .and_then(|payload| payload.get("kind"))
                        .and_then(|kind| kind.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| "unknown".to_string());
                    broker_view.lock().unwrap().frames.push((
                        if kind == "encrypted_remote_action_result" {
                            format!(
                                "{kind}:{}",
                                payload["payload"]["action_id"]
                                    .as_str()
                                    .expect("reply has an action id")
                            )
                        } else {
                            kind
                        },
                        std::time::Instant::now(),
                    ));
                }
                _ => {}
            }
        }
    });

    let dir = tempfile::TempDir::new().expect("tmpdir");
    let cwd = dir.path().to_string_lossy().to_string();
    let config = heartbeat_test_config(format!("ws://{address}")).await;
    let state = match state_override {
        Some(state) => state,
        None => encrypted_broker_state(&cwd).await,
    };
    let mut change_rx = state.subscribe();

    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        run_broker_session_with_liveness(
            &state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(30),
            },
        ),
    )
    .await;

    let seen = observations.lock().unwrap();
    seen.kinds()
}

/// A stale tab's previous-version request is ignored — and costs only that request.
///
/// The version is a hard cut, so the old request is deliberately NOT served. But a tab
/// left open across a relay restart will send one, and if that ends the session then
/// every other surface in the room is disconnected by somebody else's stale JavaScript,
/// with a full snapshot resync on the way back.
#[tokio::test]
async fn a_previous_version_request_does_not_end_the_session() {
    let kinds = observe_relay_session_for_frames(vec![
        encrypted_action_frame_versioned(
            "surface-a",
            "action-old",
            serde_json::json!({ "type": "list_threads", "query": { "limit": 5 } }),
            RELAY_PROTOCOL_VERSION - 1,
        ),
        encrypted_action_frame_versioned(
            "surface-a",
            "action-new",
            serde_json::json!({ "type": "list_threads", "query": { "limit": 5 } }),
            RELAY_PROTOCOL_VERSION,
        ),
    ])
    .await;

    let answered = kinds
        .iter()
        .filter(|kind| kind.starts_with("encrypted_remote_action_result:"))
        .count();
    assert!(kinds
        .iter()
        .any(|kind| kind == "encrypted_remote_action_result:action-new"));
    assert_eq!(
        answered, 1,
        "the current-version request must still be answered after a previous-version one \
         was refused — exactly one reply, proving the stale frame was dropped on its own \
         rather than taking the session with it. Saw {kinds:?}"
    );
}

/// …and a payload the relay genuinely cannot understand must still not end the session.
///
/// This is the general form of the same hazard, and it is not limited to version skew: a
/// single authenticated surface sending junk should cost that surface its request, not
/// cost every other surface the connection. Fixing only the version case would leave the
/// denial-of-service intact behind a different malformed frame.
#[tokio::test]
async fn an_unparseable_payload_does_not_end_the_session() {
    let kinds = observe_relay_session_for_frames(vec![
        encrypted_action_frame_versioned(
            "surface-a",
            "action-garbage",
            serde_json::json!({ "type": "list_threads", "query": { "limit": 5 } }),
            9_999,
        ),
        encrypted_action_frame_versioned(
            "surface-a",
            "action-good",
            serde_json::json!({ "type": "list_threads", "query": { "limit": 5 } }),
            RELAY_PROTOCOL_VERSION,
        ),
    ])
    .await;

    assert!(
        kinds
            .iter()
            .any(|kind| kind == "encrypted_remote_action_result:action-good"),
        "a valid request after an unparseable one must still be answered; one surface \
         sending junk must not disconnect the room. Saw {kinds:?}"
    );
}

// A missing device identity must cost its request, not the room's connection.
#[tokio::test]
async fn a_handler_error_after_parsing_does_not_end_the_session() {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let state = private_broker_state(&dir.path().to_string_lossy()).await;

    let refused = encrypted_action_frame_versioned(
        "surface-a",
        "action-missing-device",
        serde_json::json!({ "type": "list_threads", "query": { "limit": 5 } }),
        RELAY_PROTOCOL_VERSION,
    );

    let mut refused: serde_json::Value = serde_json::from_str(&refused).expect("frame parses");
    refused["payload"]
        .as_object_mut()
        .unwrap()
        .remove("device_id");
    let refused = serde_json::to_string(&refused).expect("frame serializes");
    // A valid signed request must still be served after the refusal.
    let sealed = encrypted_action_frame(
        "surface-a",
        "action-sealed",
        serde_json::json!({ "type": "list_threads", "query": { "limit": 5 } }),
    );

    let kinds = observe_relay_session_with_state(vec![refused, sealed], Some(state)).await;

    assert!(
        kinds
            .iter()
            .any(|kind| kind == "encrypted_remote_action_result:action-sealed"),
        "the valid request must still be answered after the missing-device request was refused. \
         A handler error belongs to the surface that caused it, not to the room. Saw {kinds:?}"
    );
}

#[tokio::test]
async fn public_cached_registration_rejects_activation_override() {
    let control_url = spawn_public_control_mock().await;
    let registration_path = temp_registration_path("agent-relay-public-registration-override");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).expect("control url"),
        state_db: std::path::PathBuf::from(&registration_path),
    };
    perform_public_relay_enrollment(&reqwest::Client::new(), &pending, Some("first-key"))
        .await
        .expect("enroll");

    std::env::set_var(
        crate::broker::activation::CLOUD_ACCESS_KEY_ENV,
        "second-key",
    );
    let err = BrokerConfig::from_parts_resolution(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url),
        None,
        Some("relay-auto".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(registration_path),
        None,
    )
    .await
    .expect_err("override while linked must fail");
    assert!(
        err.contains("already linked") && err.contains("unbind"),
        "got: {err}"
    );
    assert!(
        std::env::var(crate::broker::activation::CLOUD_ACCESS_KEY_ENV).is_err(),
        "activation env must be scrubbed even on the reject path"
    );
}

#[tokio::test]
async fn registration_watch_diverged_when_cache_removed() {
    let control_url = spawn_public_control_mock().await;
    let registration_path = temp_registration_path("agent-relay-public-registration-watch");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).expect("control url"),
        state_db: std::path::PathBuf::from(&registration_path),
    };
    perform_public_relay_enrollment(&reqwest::Client::new(), &pending, None)
        .await
        .expect("enroll");

    let config = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url),
        None,
        Some("relay-auto".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(registration_path.clone()),
        None,
    )
    .await
    .expect("parse")
    .expect("enabled");
    assert!(
        config.registration_watch.is_some(),
        "public cached config must retain a registration watch"
    );
    assert!(!registration_watch_diverged(&config).await);
    std::fs::remove_file(&registration_path).expect("remove cache");
    assert!(registration_watch_diverged(&config).await);
}

#[test]
fn enrollment_complete_request_uses_enrollment_token_only() {
    let via_new = serde_json::from_value::<
        relay_broker::public_control::RelayEnrollmentCompleteRequest,
    >(serde_json::json!({
        "relay_verify_key": "k",
        "challenge_id": "c",
        "challenge_signature": "s",
        "enrollment_token": "tok-new"
    }))
    .expect("deserialize enrollment_token");
    assert_eq!(via_new.enrollment_token.as_deref(), Some("tok-new"));

    let via_alias = serde_json::from_value::<
        relay_broker::public_control::RelayEnrollmentCompleteRequest,
    >(serde_json::json!({
        "relay_verify_key": "k",
        "challenge_id": "c",
        "challenge_signature": "s",
        "license_code": "tok-legacy"
    }));
    assert!(
        via_alias.is_err(),
        "legacy license_code must be rejected, not aliased"
    );

    let encoded = serde_json::to_value(&via_new).expect("serialize");
    assert!(encoded.get("enrollment_token").is_some());
    assert!(encoded.get("license_code").is_none());
}

#[tokio::test]
async fn enrollment_complete_refuses_redirect_and_does_not_exfiltrate_token() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        routing::post,
        Router,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tower::ServiceExt;

    let redirected = Arc::new(AtomicBool::new(false));
    let redirected_flag = redirected.clone();
    let app = Router::new()
        .route(
            "/api/public/relay-enrollment/complete",
            post(|| async {
                (
                    StatusCode::TEMPORARY_REDIRECT,
                    [(axum::http::header::LOCATION, "http://evil.example/steal")],
                )
            }),
        )
        .route(
            "/steal",
            post(move |req: Request<Body>| {
                let redirected_flag = redirected_flag.clone();
                async move {
                    redirected_flag.store(true, Ordering::SeqCst);
                    let body = axum::body::to_bytes(req.into_body(), 64 * 1024)
                        .await
                        .unwrap_or_default();
                    assert!(
                        !String::from_utf8_lossy(&body).contains("secret-enroll-token"),
                        "redirect target must never receive the enrollment token"
                    );
                    StatusCode::OK
                }
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = crate::broker::auth::build_control_plane_client().unwrap();
    let control = url::Url::parse(&format!("http://{addr}")).unwrap();
    let err = crate::broker::auth::complete_public_relay_enrollment(
        &client,
        &control,
        "vk".into(),
        "cid".into(),
        "sig".into(),
        None,
        Some("secret-enroll-token"),
    )
    .await
    .expect_err("redirect must fail closed");
    assert!(err.to_ascii_lowercase().contains("redirect"), "got: {err}");
    assert!(!err.contains("secret-enroll-token"));
    assert!(
        !redirected.load(Ordering::SeqCst),
        "client must not follow the redirect"
    );
}

#[tokio::test]
async fn enrollment_maps_reflected_key_error_to_safe_message() {
    use axum::{routing::post, Json, Router};

    let app = Router::new().route(
        "/api/public/relay-enrollment/complete",
        post(|| async {
            (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid",
                    "message": "bad secret-enroll-token"
                })),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = crate::broker::auth::build_control_plane_client().unwrap();
    let control = url::Url::parse(&format!("http://{addr}")).unwrap();
    let err = crate::broker::auth::complete_public_relay_enrollment(
        &client,
        &control,
        "vk".into(),
        "cid".into(),
        "sig".into(),
        None,
        Some("secret-enroll-token"),
    )
    .await
    .expect_err("invalid enrollment must fail");
    assert!(!err.contains("secret-enroll-token"), "got: {err}");
    assert!(
        err.contains("invalid") || err.contains("expired") || err.contains("revoked"),
        "got: {err}"
    );
}

#[tokio::test]
async fn enrollment_error_code_equal_to_secret_is_not_reflected() {
    use axum::{routing::post, Json, Router};

    let secret = "exact-secret-as-error-code";
    let app = Router::new().route(
        "/api/public/relay-enrollment/complete",
        post(|| async {
            (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "exact-secret-as-error-code"
                })),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = crate::broker::auth::build_control_plane_client().unwrap();
    let control = url::Url::parse(&format!("http://{addr}")).unwrap();
    let err = crate::broker::auth::complete_public_relay_enrollment(
        &client,
        &control,
        "vk".into(),
        "cid".into(),
        "sig".into(),
        None,
        Some(secret),
    )
    .await
    .expect_err("unknown error code must fail closed");
    assert!(!err.contains(secret), "got: {err}");
    assert_eq!(err, "broker control-plane request failed");
}

#[tokio::test]
async fn cloud_require_cached_fails_closed_when_registration_missing() {
    let _guard = cloud_env_lock().lock().unwrap();
    std::env::set_var(crate::broker::CLOUD_REQUIRE_CACHED_REGISTRATION_ENV, "1");
    std::env::set_var(
        crate::broker::CLOUD_EXPECTED_CONTROL_URL_ENV,
        "http://127.0.0.1:9",
    );
    std::env::set_var(crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV, "relay-x");
    std::env::set_var(crate::broker::CLOUD_EXPECTED_ROOM_ID_ENV, "room-x");
    std::env::set_var(
        crate::broker::CLOUD_EXPECTED_BEARER_FP_ENV,
        "deadbeefdeadbeef",
    );
    let startup = crate::broker::capture_and_scrub_activation_for_normal_start();
    let registration_path = temp_registration_path("agent-relay-require-cached-missing");
    let err = BrokerConfig::from_parts_resolution_with_startup_context(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some("http://127.0.0.1:9".to_string()),
        None,
        Some("relay-auto".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(registration_path),
        None,
        startup,
    )
    .await
    .expect_err("missing cache must fail closed for cloud require path");
    std::env::remove_var(crate::broker::CLOUD_REQUIRE_CACHED_REGISTRATION_ENV);
    std::env::remove_var(crate::broker::CLOUD_EXPECTED_CONTROL_URL_ENV);
    std::env::remove_var(crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV);
    std::env::remove_var(crate::broker::CLOUD_EXPECTED_ROOM_ID_ENV);
    std::env::remove_var(crate::broker::CLOUD_EXPECTED_BEARER_FP_ENV);
    assert!(
        err.contains("missing") || err.contains("refusing anonymous"),
        "got: {err}"
    );
}

#[tokio::test]
async fn cloud_require_cached_fails_closed_when_registration_replaced() {
    let _guard = cloud_env_lock().lock().unwrap();
    let control_url = spawn_public_control_mock().await;
    let registration_path = temp_registration_path("agent-relay-require-cached-replaced");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).expect("control url"),
        state_db: std::path::PathBuf::from(&registration_path),
    };
    let registration = perform_public_relay_enrollment(&reqwest::Client::new(), &pending, None)
        .await
        .expect("enroll");
    let expected_fp = super::lifecycle::bearer_fingerprint(&registration.relay_refresh_token);

    // Replace with a different bearer after preflight witnessed the old one.
    let replaced = PublicRelayRegistration {
        relay_id: registration.relay_id.clone(),
        broker_room_id: registration.broker_room_id.clone(),
        relay_refresh_token: "replaced-token-after-preflight".into(),
    };
    save_public_relay_registration(
        std::path::Path::new(&registration_path),
        &control_url,
        &replaced,
    )
    .await
    .expect("replace");

    std::env::set_var(crate::broker::CLOUD_REQUIRE_CACHED_REGISTRATION_ENV, "1");
    std::env::set_var(crate::broker::CLOUD_EXPECTED_CONTROL_URL_ENV, &control_url);
    std::env::set_var(
        crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV,
        &registration.relay_id,
    );
    std::env::set_var(
        crate::broker::CLOUD_EXPECTED_ROOM_ID_ENV,
        &registration.broker_room_id,
    );
    std::env::set_var(crate::broker::CLOUD_EXPECTED_BEARER_FP_ENV, &expected_fp);
    let startup = crate::broker::capture_and_scrub_activation_for_normal_start();

    let err = BrokerConfig::from_parts_resolution_with_startup_context(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url),
        None,
        Some("relay-auto".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(registration_path),
        None,
        startup,
    )
    .await
    .expect_err("replaced cache must fail closed");
    std::env::remove_var(crate::broker::CLOUD_REQUIRE_CACHED_REGISTRATION_ENV);
    std::env::remove_var(crate::broker::CLOUD_EXPECTED_CONTROL_URL_ENV);
    std::env::remove_var(crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV);
    std::env::remove_var(crate::broker::CLOUD_EXPECTED_ROOM_ID_ENV);
    std::env::remove_var(crate::broker::CLOUD_EXPECTED_BEARER_FP_ENV);
    assert!(
        err.contains("changed") || err.contains("replaced") || err.contains("refusing"),
        "got: {err}"
    );
}

#[tokio::test]
async fn cloud_launch_capture_scrub_then_matching_config_succeeds() {
    let _guard = cloud_env_lock().lock().unwrap();
    let control_url = crate::broker::auth::parse_control_plane_url("http://127.0.0.1:9")
        .expect("control url")
        .as_str()
        .to_string();
    let registration_path = temp_registration_path("agent-relay-witness-matching");
    write_test_public_identity(&registration_path, &control_url, [4_u8; 32]).await;
    let registration = PublicRelayRegistration {
        relay_id: "relay-match".into(),
        broker_room_id: "room-match".into(),
        relay_refresh_token: "refresh-independent-secret".into(),
    };
    save_public_relay_registration(
        std::path::Path::new(&registration_path),
        &control_url,
        &registration,
    )
    .await
    .unwrap();
    std::env::set_var(crate::broker::CLOUD_REQUIRE_CACHED_REGISTRATION_ENV, "1");
    std::env::set_var(crate::broker::CLOUD_EXPECTED_CONTROL_URL_ENV, &control_url);
    std::env::set_var(crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV, "relay-match");
    std::env::set_var(crate::broker::CLOUD_EXPECTED_ROOM_ID_ENV, "room-match");
    std::env::set_var(
        crate::broker::CLOUD_EXPECTED_BEARER_FP_ENV,
        super::lifecycle::bearer_fingerprint("refresh-independent-secret"),
    );

    let startup = crate::broker::capture_and_scrub_activation_for_normal_start();
    assert!(std::env::var_os(crate::broker::CLOUD_REQUIRE_CACHED_REGISTRATION_ENV).is_none());
    assert!(std::env::var_os(crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV).is_none());

    // An unrelated ordinary resolution has no ownership of the captured value.
    let disabled = BrokerConfig::from_parts_resolution(
        None, None, None, None, None, None, None, None, None, None, None,
    )
    .await
    .unwrap();
    assert!(matches!(disabled, BrokerConfigResolution::Disabled));

    let result = BrokerConfig::from_parts_resolution_with_startup_context(
        Some("wss://broker.example.com".into()),
        Some("wss://public-broker.example.com".into()),
        Some(control_url.clone()),
        None,
        Some("relay-auto".into()),
        Some("public".into()),
        None,
        None,
        None,
        Some(registration_path),
        None,
        startup,
    )
    .await
    .unwrap();
    assert!(matches!(result, BrokerConfigResolution::Ready(_)));
}

#[tokio::test]
async fn enrolled_relay_refuses_to_mint_a_replacement_identity() {
    let control_url = crate::broker::auth::parse_control_plane_url("http://127.0.0.1:9")
        .expect("control url")
        .as_str()
        .to_string();
    let registration_path = temp_registration_path("agent-relay-missing-identity-reg");
    save_public_relay_registration(
        std::path::Path::new(&registration_path),
        &control_url,
        &PublicRelayRegistration {
            relay_id: "relay-keep".into(),
            broker_room_id: "room-keep".into(),
            relay_refresh_token: "refresh-keep".into(),
        },
    )
    .await
    .expect("registration should save");

    let missing = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        None,
        Some(control_url.clone()),
        None,
        Some("relay-auto".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(registration_path.clone()),
        None,
    )
    .await
    .expect_err("a cached registration without an identity must fail");
    assert!(missing.contains("refusing to generate"), "got: {missing}");
    assert!(
        stored_identity_seed(&registration_path).is_none(),
        "startup must not create a replacement identity"
    );

    write_test_public_identity(&registration_path, "http://127.0.0.1:8", [4_u8; 32]).await;
    let before = stored_identity_seed(&registration_path).expect("identity should exist");
    let mismatched = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        None,
        Some(control_url),
        None,
        Some("relay-auto".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(registration_path.clone()),
        None,
    )
    .await
    .expect_err("another broker's identity is not this broker's");
    assert!(
        mismatched.contains("refusing to generate"),
        "got: {mismatched}"
    );
    assert_eq!(
        stored_identity_seed(&registration_path).expect("identity should remain"),
        before,
        "another broker's identity must not be rewritten"
    );
}

#[tokio::test]
async fn cloud_launch_partial_or_malformed_required_witness_fails_closed_after_scrub() {
    let _guard = cloud_env_lock().lock().unwrap();
    for malformed_fingerprint in [None, Some("not-hex")] {
        crate::broker::activation::scrub_activation_env();
        std::env::set_var(crate::broker::CLOUD_REQUIRE_CACHED_REGISTRATION_ENV, "1");
        std::env::set_var(
            crate::broker::CLOUD_EXPECTED_CONTROL_URL_ENV,
            "http://127.0.0.1:9",
        );
        std::env::set_var(crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV, "relay-x");
        std::env::set_var(crate::broker::CLOUD_EXPECTED_ROOM_ID_ENV, "room-x");
        if let Some(value) = malformed_fingerprint {
            std::env::set_var(crate::broker::CLOUD_EXPECTED_BEARER_FP_ENV, value);
        }
        let startup = crate::broker::capture_and_scrub_activation_for_normal_start();
        let error = BrokerConfig::from_parts_resolution_with_startup_context(
            Some("wss://broker.example.com".into()),
            Some("wss://public-broker.example.com".into()),
            Some("http://127.0.0.1:9".into()),
            None,
            Some("relay-auto".into()),
            Some("public".into()),
            None,
            None,
            None,
            Some(temp_registration_path("agent-relay-witness-invalid")),
            None,
            startup,
        )
        .await
        .expect_err("required partial/malformed witness must fail");
        assert!(error.contains("incomplete or invalid"), "got: {error}");
    }
}

#[tokio::test]
async fn ambient_partial_witness_without_require_is_ignored_after_scrub() {
    let _guard = cloud_env_lock().lock().unwrap();
    crate::broker::activation::scrub_activation_env();
    // Ambient junk without RELAY_CLOUD_REQUIRE_CACHED_REGISTRATION must not
    // force fail-closed cloud semantics on ordinary/public broker startup.
    std::env::set_var(crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV, "ambient-relay");
    std::env::set_var(
        crate::broker::CLOUD_EXPECTED_BEARER_FP_ENV,
        "not-a-fingerprint",
    );
    let startup = crate::broker::capture_and_scrub_activation_for_normal_start();
    assert!(std::env::var_os(crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV).is_none());
    assert!(std::env::var_os(crate::broker::CLOUD_EXPECTED_BEARER_FP_ENV).is_none());

    let result = BrokerConfig::from_parts_resolution_with_startup_context(
        Some("wss://broker.example.com".into()),
        Some("wss://public-broker.example.com".into()),
        Some("http://127.0.0.1:9".into()),
        None,
        Some("relay-auto".into()),
        Some("public".into()),
        None,
        None,
        None,
        Some(temp_registration_path("agent-relay-ambient-witness")),
        None,
        startup,
    )
    .await
    .expect("ambient partial witness must not poison generic public startup");
    assert!(matches!(
        result,
        BrokerConfigResolution::PendingPublicEnrollment(_)
    ));
}

#[tokio::test]
async fn required_cloud_witness_fails_closed_when_broker_url_missing() {
    let _guard = cloud_env_lock().lock().unwrap();
    crate::broker::activation::scrub_activation_env();
    std::env::set_var(crate::broker::CLOUD_REQUIRE_CACHED_REGISTRATION_ENV, "1");
    std::env::set_var(
        crate::broker::CLOUD_EXPECTED_CONTROL_URL_ENV,
        "http://127.0.0.1:9/",
    );
    std::env::set_var(crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV, "relay-x");
    std::env::set_var(crate::broker::CLOUD_EXPECTED_ROOM_ID_ENV, "room-x");
    std::env::set_var(
        crate::broker::CLOUD_EXPECTED_BEARER_FP_ENV,
        "deadbeefdeadbeef",
    );
    let startup = crate::broker::capture_and_scrub_activation_for_normal_start();
    let error = BrokerConfig::from_parts_resolution_with_startup_context(
        None, None, None, None, None, None, None, None, None, None, None, startup,
    )
    .await
    .expect_err("required cloud witness must not disappear into Disabled");
    assert!(
        error.contains("RELAY_BROKER_URL") || error.contains("refusing"),
        "got: {error}"
    );
}

#[tokio::test]
async fn required_cloud_witness_fails_closed_for_self_hosted_auth() {
    let _guard = cloud_env_lock().lock().unwrap();
    crate::broker::activation::scrub_activation_env();
    std::env::set_var(crate::broker::CLOUD_REQUIRE_CACHED_REGISTRATION_ENV, "1");
    std::env::set_var(
        crate::broker::CLOUD_EXPECTED_CONTROL_URL_ENV,
        "http://127.0.0.1:9/",
    );
    std::env::set_var(crate::broker::CLOUD_EXPECTED_RELAY_ID_ENV, "relay-x");
    std::env::set_var(crate::broker::CLOUD_EXPECTED_ROOM_ID_ENV, "room-x");
    std::env::set_var(
        crate::broker::CLOUD_EXPECTED_BEARER_FP_ENV,
        "deadbeefdeadbeef",
    );
    let startup = crate::broker::capture_and_scrub_activation_for_normal_start();
    let error = BrokerConfig::from_parts_resolution_with_startup_context(
        Some("wss://broker.example.com".into()),
        Some("wss://broker.example.com".into()),
        None,
        Some("channel-1".into()),
        None,
        Some("self_hosted".into()),
        Some("join-secret".into()),
        None,
        None,
        None,
        None,
        startup,
    )
    .await
    .expect_err("required cloud witness must refuse self-hosted auth");
    assert!(
        error.contains("public") || error.contains("refusing"),
        "got: {error}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn registration_and_identity_files_are_mode_0600() {
    let control_url = spawn_public_control_mock().await;
    let registration_path = temp_registration_path("agent-relay-mode-reg");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).expect("control url"),
        state_db: std::path::PathBuf::from(&registration_path),
    };
    perform_public_relay_enrollment(&reqwest::Client::new(), &pending, None)
        .await
        .expect("enroll");
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&registration_path)
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        mode, 0o600,
        "the database holding the registration must be owner-only"
    );
}

#[cfg(windows)]
#[tokio::test]
async fn windows_state_permissions_protect_broker_credentials_without_rotating_them() {
    use crate::windows_state_permissions::{assert_private_acl, make_world_readable};

    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join(crate::state_paths::STATE_DIR_NAME);
    let db = directory.join("sealwire.db");
    let control_url = "https://broker.example.test";
    let identity = load_or_create_public_relay_identity(&db, control_url)
        .await
        .unwrap();
    let registration = PublicRelayRegistration {
        relay_id: "test-relay".into(),
        broker_room_id: "test-room".into(),
        relay_refresh_token: "test-refresh-token".into(),
    };
    save_public_relay_registration(&db, control_url, &registration)
        .await
        .unwrap();
    assert_private_acl(&directory);
    assert_private_acl(&db);
    make_world_readable(&directory);
    make_world_readable(&db);
    let loaded = load_public_relay_registration(&db, control_url)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.relay_refresh_token, registration.relay_refresh_token);
    let reloaded = load_or_create_public_relay_identity(&db, control_url)
        .await
        .unwrap();
    assert_eq!(
        reloaded.signing_key.to_bytes(),
        identity.signing_key.to_bytes()
    );
    assert_private_acl(&directory);
    assert_private_acl(&db);
}

#[tokio::test]
async fn cloud_activate_non_tty_missing_key_exits_nonzero() {
    let _guard = cloud_env_lock().lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let reg = dir.path().join("sealwire.db");
    std::env::set_var(crate::broker::activation::CLOUD_ACTIVATION_ENV, "1");
    std::env::set_var(
        crate::broker::auth::RELAY_BROKER_CONTROL_URL_ENV,
        "http://127.0.0.1:9",
    );
    std::env::set_var("RELAY_STATE_DB", &reg);
    // Ensure no credentials.
    crate::broker::activation::scrub_activation_env();
    std::env::set_var(crate::broker::activation::CLOUD_ACTIVATION_ENV, "1");

    let code = crate::broker::run_cloud_activate_core(false).await;

    std::env::remove_var(crate::broker::activation::CLOUD_ACTIVATION_ENV);
    std::env::remove_var(crate::broker::auth::RELAY_BROKER_CONTROL_URL_ENV);
    std::env::remove_var("RELAY_STATE_DB");
    assert_ne!(
        code, 0,
        "non-TTY cloud-activate without a key must fail closed"
    );
}

#[tokio::test]
async fn cloud_activate_cached_registration_emits_witness_without_prompt() {
    let _guard = cloud_env_lock().lock().unwrap();
    let control_url = spawn_public_control_mock().await;
    let registration_path = temp_registration_path("agent-relay-cloud-cached-witness");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).unwrap(),
        state_db: std::path::PathBuf::from(&registration_path),
    };
    perform_public_relay_enrollment(&reqwest::Client::new(), &pending, None)
        .await
        .expect("enroll");

    std::env::set_var(crate::broker::activation::CLOUD_ACTIVATION_ENV, "1");
    std::env::set_var(
        crate::broker::auth::RELAY_BROKER_CONTROL_URL_ENV,
        &control_url,
    );
    std::env::set_var("RELAY_STATE_DB", &registration_path);
    crate::broker::activation::scrub_activation_env();
    std::env::set_var(crate::broker::activation::CLOUD_ACTIVATION_ENV, "1");

    let code = crate::broker::run_cloud_activate().await;

    std::env::remove_var(crate::broker::activation::CLOUD_ACTIVATION_ENV);
    std::env::remove_var(crate::broker::auth::RELAY_BROKER_CONTROL_URL_ENV);
    std::env::remove_var("RELAY_STATE_DB");
    assert_eq!(code, 0);
    assert!(
        only_public_relay_registration(std::path::Path::new(&registration_path))
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn enroll_release_reenroll_different_key_lifecycle() {
    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::post,
        Json, Router,
    };
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Plane {
        enrollments: Arc<Mutex<Vec<String>>>,
        released: Arc<Mutex<Vec<String>>>,
        next_refresh: Arc<std::sync::atomic::AtomicUsize>,
    }

    async fn challenge(
        Json(request): Json<RelayEnrollmentChallengeRequest>,
    ) -> Json<RelayEnrollmentChallengeResponse> {
        Json(RelayEnrollmentChallengeResponse {
            relay_verify_key: request.relay_verify_key,
            challenge_id: "rch-lifecycle".into(),
            challenge: "rc-lifecycle".into(),
            expires_at: unix_now() + 300,
        })
    }

    async fn complete(
        State(plane): State<Plane>,
        Json(request): Json<RelayEnrollmentCompleteRequest>,
    ) -> Json<RelayEnrollmentResponse> {
        let token = request
            .enrollment_token
            .clone()
            .unwrap_or_else(|| "anonymous".into());
        plane.enrollments.lock().unwrap().push(token);
        let refresh_number = plane
            .next_refresh
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // Refresh tokens and room/relay ids must never echo the submitted
        // activation key — persisted registration JSON is secret-free of it.
        Json(RelayEnrollmentResponse {
            relay_id: format!("relay-{refresh_number}"),
            broker_room_id: format!("room-{refresh_number}"),
            relay_refresh_token: format!("refresh-token-{refresh_number}"),
            created_at: unix_now(),
            relay_label: None,
        })
    }

    async fn release(
        State(plane): State<Plane>,
        headers: HeaderMap,
        Json(body): Json<relay_broker::public_control::AccessReleaseRequest>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let auth = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        plane.released.lock().unwrap().push(auth);
        let _ = body;
        (
            StatusCode::OK,
            Json(serde_json::json!({ "released": true })),
        )
    }

    let plane = Plane {
        enrollments: Arc::new(Mutex::new(Vec::new())),
        released: Arc::new(Mutex::new(Vec::new())),
        next_refresh: Arc::new(std::sync::atomic::AtomicUsize::new(1)),
    };
    let app = super::access_release::with_test_control_challenge(
        Router::new()
            .route("/api/public/relay-enrollment/challenge", post(challenge))
            .route("/api/public/relay-enrollment/complete", post(complete))
            .route("/api/public/relay/access/release", post(release))
            .with_state(plane.clone()),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let control_url = format!("http://{addr}");

    let lifecycle_dir = tempfile::tempdir().expect("lifecycle dir");
    let registration_path = lifecycle_dir
        .path()
        .join("sealwire.db")
        .display()
        .to_string();
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).unwrap(),
        state_db: std::path::PathBuf::from(&registration_path),
    };
    let client = reqwest::Client::new();

    let first = perform_public_relay_enrollment(&client, &pending, Some("key-a"))
        .await
        .expect("enroll A");
    assert!(!first.relay_refresh_token.contains("key-a"));

    let outcome = crate::broker::access_release::release_cloud_access(
        &control_url,
        std::path::Path::new(&registration_path),
    )
    .await;
    assert_eq!(
        outcome,
        crate::broker::access_release::ReleaseOutcome::Released
    );
    assert!(
        only_public_relay_registration(std::path::Path::new(&registration_path))
            .unwrap()
            .is_none()
    );

    let second = perform_public_relay_enrollment(&client, &pending, Some("key-b"))
        .await
        .expect("enroll B");
    assert!(!second.relay_refresh_token.contains("key-b"));
    assert_ne!(first.relay_refresh_token, second.relay_refresh_token);
    assert_eq!(
        plane.enrollments.lock().unwrap().as_slice(),
        ["key-a", "key-b"]
    );
    assert_eq!(plane.released.lock().unwrap().len(), 1);
    let persisted = stored_registration_text(&registration_path);
    assert!(!persisted.contains("key-a"));
    assert!(!persisted.contains("key-b"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_production_enrollment_critical_sections_complete_once() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let dir = tempfile::tempdir().unwrap();
    let pending = PendingPublicEnrollment {
        control_url: Url::parse("http://127.0.0.1:9").unwrap(),
        state_db: dir.path().join("sealwire.db"),
    };
    let completions = Arc::new(AtomicUsize::new(0));
    let make = |submitted_key: &'static str| {
        let pending = pending.clone();
        let completions = completions.clone();
        tokio::spawn(async move {
            enroll_public_relay_if_absent(&pending, || async move {
                let sequence = completions.fetch_add(1, Ordering::SeqCst) + 1;
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                Ok(PublicRelayRegistration {
                    relay_id: "relay-shared".into(),
                    broker_room_id: "room-shared".into(),
                    // Fake remote bearer generation is deliberately independent
                    // from the submitted activation key.
                    relay_refresh_token: format!("server-refresh-{sequence}"),
                })
            })
            .await
            .map(|locked| {
                (
                    locked.disposition,
                    locked.registration.clone(),
                    submitted_key,
                )
            })
        })
    };

    let (first, second) = tokio::join!(make("activation-key-a"), make("activation-key-b"));
    let first = first.unwrap().unwrap();
    let second = second.unwrap().unwrap();
    assert_eq!(completions.load(Ordering::SeqCst), 1);
    let dispositions = [first.0, second.0];
    assert!(dispositions.contains(&EnrollmentDisposition::Enrolled));
    assert!(dispositions.contains(&EnrollmentDisposition::Existing));
    assert_eq!(first.1.relay_refresh_token, second.1.relay_refresh_token);
    let persisted = stored_registration_text(&pending.state_db);
    assert!(!persisted.contains(first.2));
    assert!(!persisted.contains(second.2));
    assert!(persisted.contains("server-refresh-1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_generic_enrollment_rechecks_after_activation_writes() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let dir = tempfile::tempdir().unwrap();
    let pending = PendingPublicEnrollment {
        control_url: Url::parse("http://127.0.0.1:9").unwrap(),
        state_db: dir.path().join("sealwire.db"),
    };
    let remote_calls = Arc::new(AtomicUsize::new(0));
    let lock = BrokerLifecycleLock::acquire_for_registration(&pending.state_db).unwrap();
    let generic_pending = pending.clone();
    let generic_calls = remote_calls.clone();
    let generic = tokio::spawn(async move {
        enroll_public_relay_if_absent(&generic_pending, || async move {
            generic_calls.fetch_add(1, Ordering::SeqCst);
            Err("generic remote completion must not run".to_string())
        })
        .await
    });

    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let activated = PublicRelayRegistration {
        relay_id: "relay-activated".into(),
        broker_room_id: "room-activated".into(),
        relay_refresh_token: "refresh-created-by-activation".into(),
    };
    save_public_relay_registration(&pending.state_db, pending.control_url.as_str(), &activated)
        .await
        .unwrap();
    drop(lock);

    let observed = generic.await.unwrap().unwrap();
    assert_eq!(observed.disposition, EnrollmentDisposition::Existing);
    assert_eq!(remote_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        observed.registration.relay_refresh_token,
        activated.relay_refresh_token
    );
    let persisted = load_matching_registration_for_enrollment(&pending)
        .unwrap()
        .unwrap();
    assert_eq!(persisted.relay_refresh_token, activated.relay_refresh_token);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_activate_then_matching_release_clears() {
    use axum::{routing::post, Json, Router};

    let app = super::access_release::with_test_control_challenge(Router::new().route(
        "/api/public/relay/access/release",
        post(|| async { Json(serde_json::json!({ "released": true })) }),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let control_url = format!("http://{addr}");

    let dir = tempfile::tempdir().unwrap();
    let registration_path = dir.path().join("sealwire.db");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).unwrap(),
        state_db: registration_path.clone(),
    };

    let locked = enroll_public_relay_if_absent(&pending, || async {
        Ok(PublicRelayRegistration {
            relay_id: "relay-live".into(),
            broker_room_id: "room-live".into(),
            relay_refresh_token: "refresh-live".into(),
        })
    })
    .await
    .unwrap();
    assert_eq!(locked.disposition, EnrollmentDisposition::Enrolled);
    drop(locked);
    write_test_public_identity(
        pending.state_db.to_str().expect("identity path"),
        &control_url,
        [4_u8; 32],
    )
    .await;

    let outcome =
        crate::broker::access_release::release_cloud_access(&control_url, &registration_path).await;
    assert_eq!(
        outcome,
        crate::broker::access_release::ReleaseOutcome::Released
    );
    assert!(only_public_relay_registration(&registration_path)
        .unwrap()
        .is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_stale_release_refuses_after_locked_activation_rebind() {
    use axum::{routing::post, Json, Router};
    use std::sync::Arc;

    let started = Arc::new(std::sync::Barrier::new(2));
    let started_server = started.clone();
    let app = super::access_release::with_test_control_challenge(Router::new().route(
        "/api/public/relay/access/release",
        post(move || {
            let started_server = started_server.clone();
            async move {
                tokio::task::spawn_blocking(move || {
                    started_server.wait();
                })
                .await
                .ok();
                tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                Json(serde_json::json!({ "released": true }))
            }
        }),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let control_url = format!("http://{addr}");

    let dir = tempfile::tempdir().unwrap();
    let registration_path = dir.path().join("sealwire.db");
    save_public_relay_registration(
        &registration_path,
        &control_url,
        &PublicRelayRegistration {
            relay_id: "relay-shared".into(),
            broker_room_id: "room-shared".into(),
            relay_refresh_token: "refresh-old".into(),
        },
    )
    .await
    .unwrap();
    write_test_public_identity(
        dir.path()
            .join("sealwire.db")
            .to_str()
            .expect("identity path"),
        &control_url,
        [4_u8; 32],
    )
    .await;

    // release_cloud_access holds the lifecycle lock across HTTP. Replace the
    // registration under that same lock using the production enroll critical
    // section only after release has loaded the old identity and entered HTTP —
    // which requires a writer that does not take the lock (hostile/stale). The
    // production enroll path itself cannot interleave mid-release; assert the
    // CAS outcome when a newer registration appears before deletion.
    let reg_clone = registration_path.clone();
    let origin_clone = control_url.clone();
    let release_task = tokio::spawn(async move {
        crate::broker::access_release::release_cloud_access(&origin_clone, &reg_clone).await
    });

    tokio::task::spawn_blocking(move || {
        started.wait();
    })
    .await
    .unwrap();
    save_public_relay_registration(
        &registration_path,
        &control_url,
        &PublicRelayRegistration {
            relay_id: "relay-shared".into(),
            broker_room_id: "room-shared".into(),
            relay_refresh_token: "refresh-new".into(),
        },
    )
    .await
    .unwrap();

    let outcome = release_task.await.unwrap();
    assert!(
        matches!(
            outcome,
            crate::broker::access_release::ReleaseOutcome::Failed(ref msg)
                if msg.contains("replaced") || msg.contains("newer") || msg.contains("untouched")
        ),
        "got: {outcome:?}"
    );
    let persisted = stored_registration_text(&registration_path);
    assert!(persisted.contains("refresh-new"));
    assert!(!persisted.contains("refresh-old"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_release_first_then_activate_under_contended_lock() {
    use axum::{routing::post, Json, Router};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    let remote_enrolls = Arc::new(AtomicUsize::new(0));
    let app = super::access_release::with_test_control_challenge(Router::new().route(
        "/api/public/relay/access/release",
        post(|| async { Json(serde_json::json!({ "released": true })) }),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let control_url = format!("http://{addr}");

    let dir = tempfile::tempdir().unwrap();
    let registration_path = dir.path().join("sealwire.db");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).unwrap(),
        state_db: registration_path.clone(),
    };
    save_public_relay_registration(
        &registration_path,
        &control_url,
        &PublicRelayRegistration {
            relay_id: "relay-seed".into(),
            broker_room_id: "room-seed".into(),
            relay_refresh_token: "refresh-seed".into(),
        },
    )
    .await
    .unwrap();
    write_test_public_identity(
        registration_path.to_str().expect("identity path"),
        &control_url,
        [4_u8; 32],
    )
    .await;

    // Force release→activate by pausing release immediately after it holds the
    // real lifecycle lock (before it reads/mutates registration), then starting
    // activate while that lock is still held. No sleep/FIFO assumptions.
    let release_acquired = Arc::new(Barrier::new(2));
    let release_proceed = Arc::new(Barrier::new(2));
    let activate_acquired = Arc::new(AtomicBool::new(false));
    let release = {
        let control_url = control_url.clone();
        let registration_path = registration_path.clone();
        let release_acquired = release_acquired.clone();
        let release_proceed = release_proceed.clone();
        tokio::spawn(async move {
            crate::broker::access_release::release_cloud_access_after_acquire(
                &control_url,
                &registration_path,
                move || {
                    release_acquired.wait();
                    release_proceed.wait();
                },
            )
            .await
        })
    };
    tokio::task::spawn_blocking({
        let release_acquired = release_acquired.clone();
        move || {
            release_acquired.wait();
        }
    })
    .await
    .unwrap();

    let enrolls = remote_enrolls.clone();
    let activate_acquired_flag = activate_acquired.clone();
    let activate = {
        let pending = pending.clone();
        tokio::spawn(async move {
            enroll_public_relay_if_absent_after_acquire(
                &pending,
                || async move {
                    enrolls.fetch_add(1, Ordering::SeqCst);
                    Ok(PublicRelayRegistration {
                        relay_id: "relay-after-release".into(),
                        broker_room_id: "room-after-release".into(),
                        relay_refresh_token: "refresh-after-release".into(),
                    })
                },
                move || {
                    activate_acquired_flag.store(true, Ordering::SeqCst);
                },
            )
            .await
        })
    };
    // Release still holds the lock at its after-acquire pause; activate must
    // not have entered its critical section yet.
    tokio::task::yield_now().await;
    assert!(
        !activate_acquired.load(Ordering::SeqCst),
        "activate must remain blocked on the lifecycle lock while release holds it"
    );
    assert!(
        stored_registration(&registration_path).is_some(),
        "seed registration must still be present before release mutates"
    );
    let seed = stored_registration(&registration_path)
        .unwrap()
        .relay_refresh_token;
    assert!(seed.contains("refresh-seed"));

    tokio::task::spawn_blocking(move || {
        release_proceed.wait();
    })
    .await
    .unwrap();

    let released = release.await.unwrap();
    let activated = activate.await.unwrap().unwrap();
    assert_eq!(
        released,
        crate::broker::access_release::ReleaseOutcome::Released
    );
    assert_eq!(activated.disposition, EnrollmentDisposition::Enrolled);
    assert_eq!(remote_enrolls.load(Ordering::SeqCst), 1);
    assert!(activate_acquired.load(Ordering::SeqCst));
    let persisted = stored_registration_text(&registration_path);
    assert!(persisted.contains("refresh-after-release"));
    assert!(!persisted.contains("refresh-seed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_activate_first_then_release_under_contended_lock() {
    use axum::{routing::post, Json, Router};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    let remote_enrolls = Arc::new(AtomicUsize::new(0));
    let app = super::access_release::with_test_control_challenge(Router::new().route(
        "/api/public/relay/access/release",
        post(|| async { Json(serde_json::json!({ "released": true })) }),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let control_url = format!("http://{addr}");

    let dir = tempfile::tempdir().unwrap();
    let registration_path = dir.path().join("sealwire.db");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).unwrap(),
        state_db: registration_path.clone(),
    };
    write_test_public_identity(
        registration_path.to_str().expect("identity path"),
        &control_url,
        [4_u8; 32],
    )
    .await;

    // Force activate→release by pausing activate immediately after it holds the
    // real lifecycle lock (before enroll/save), then starting release while that
    // lock is still held.
    let activate_acquired = Arc::new(Barrier::new(2));
    let activate_proceed = Arc::new(Barrier::new(2));
    let release_acquired = Arc::new(AtomicBool::new(false));
    let enrolls = remote_enrolls.clone();
    let activate = {
        let pending = pending.clone();
        let activate_acquired = activate_acquired.clone();
        let activate_proceed = activate_proceed.clone();
        tokio::spawn(async move {
            let locked = enroll_public_relay_if_absent_after_acquire(
                &pending,
                || async move {
                    enrolls.fetch_add(1, Ordering::SeqCst);
                    Ok(PublicRelayRegistration {
                        relay_id: "relay-first".into(),
                        broker_room_id: "room-first".into(),
                        relay_refresh_token: "refresh-first".into(),
                    })
                },
                move || {
                    activate_acquired.wait();
                    activate_proceed.wait();
                },
            )
            .await?;
            let disposition = locked.disposition;
            let registration = locked.registration.clone();
            // Drop the lifecycle lock before returning so the queued release can
            // proceed; holding it across the join would deadlock the test.
            drop(locked);
            Ok::<_, EnrollmentCriticalError>((disposition, registration))
        })
    };
    tokio::task::spawn_blocking({
        let activate_acquired = activate_acquired.clone();
        move || {
            activate_acquired.wait();
        }
    })
    .await
    .unwrap();

    let release_acquired_flag = release_acquired.clone();
    let release = {
        let control_url = control_url.clone();
        let registration_path = registration_path.clone();
        tokio::spawn(async move {
            crate::broker::access_release::release_cloud_access_after_acquire(
                &control_url,
                &registration_path,
                move || {
                    release_acquired_flag.store(true, Ordering::SeqCst);
                },
            )
            .await
        })
    };
    tokio::task::yield_now().await;
    assert!(
        !release_acquired.load(Ordering::SeqCst),
        "release must remain blocked on the lifecycle lock while activate holds it"
    );
    assert!(
        stored_registration(&registration_path).is_none(),
        "activation must not have written registration before after-acquire pause lifts"
    );

    tokio::task::spawn_blocking(move || {
        activate_proceed.wait();
    })
    .await
    .unwrap();

    let activated = activate.await.unwrap().unwrap();
    let released = release.await.unwrap();
    assert_eq!(activated.0, EnrollmentDisposition::Enrolled);
    assert_eq!(activated.1.relay_refresh_token, "refresh-first");
    assert_eq!(remote_enrolls.load(Ordering::SeqCst), 1);
    assert!(release_acquired.load(Ordering::SeqCst));
    assert_eq!(
        released,
        crate::broker::access_release::ReleaseOutcome::Released
    );
    assert!(
        stored_registration(&registration_path).is_none(),
        "release after activate must clear the just-written registration"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_release_then_activate_reenrolls_cleanly() {
    use axum::{routing::post, Json, Router};

    let app = super::access_release::with_test_control_challenge(Router::new().route(
        "/api/public/relay/access/release",
        post(|| async { Json(serde_json::json!({ "released": true })) }),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let control_url = format!("http://{addr}");

    let dir = tempfile::tempdir().unwrap();
    let registration_path = dir.path().join("sealwire.db");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).unwrap(),
        state_db: registration_path.clone(),
    };
    save_public_relay_registration(
        &registration_path,
        &control_url,
        &PublicRelayRegistration {
            relay_id: "relay-old".into(),
            broker_room_id: "room-old".into(),
            relay_refresh_token: "refresh-old".into(),
        },
    )
    .await
    .unwrap();
    write_test_public_identity(
        registration_path.to_str().expect("identity path"),
        &control_url,
        [4_u8; 32],
    )
    .await;

    let outcome =
        crate::broker::access_release::release_cloud_access(&control_url, &registration_path).await;
    assert_eq!(
        outcome,
        crate::broker::access_release::ReleaseOutcome::Released
    );
    assert!(only_public_relay_registration(&registration_path)
        .unwrap()
        .is_none());

    let locked = enroll_public_relay_if_absent(&pending, || async {
        Ok(PublicRelayRegistration {
            relay_id: "relay-new".into(),
            broker_room_id: "room-new".into(),
            relay_refresh_token: "refresh-new-independent".into(),
        })
    })
    .await
    .unwrap();
    assert_eq!(locked.disposition, EnrollmentDisposition::Enrolled);
    let persisted = stored_registration_text(&registration_path);
    assert!(persisted.contains("refresh-new-independent"));
    assert!(!persisted.contains("refresh-old"));
}

#[tokio::test]
async fn already_linked_discards_oneshot_file_input() {
    let _guard = cloud_env_lock().lock().unwrap();
    let control_url = spawn_public_control_mock().await;
    let registration_path = temp_registration_path("agent-relay-discard-file-reg");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).unwrap(),
        state_db: std::path::PathBuf::from(&registration_path),
    };
    perform_public_relay_enrollment(&reqwest::Client::new(), &pending, None)
        .await
        .expect("enroll");

    let dir = tempfile::tempdir().unwrap();
    let oneshot = dir.path().join("oneshot.key");
    crate::broker::activation::write_token_file_0600(&oneshot, "must-be-unlinked\n").unwrap();

    std::env::set_var(crate::broker::activation::CLOUD_ACTIVATION_ENV, "1");
    std::env::set_var(
        crate::broker::auth::RELAY_BROKER_CONTROL_URL_ENV,
        &control_url,
    );
    std::env::set_var("RELAY_STATE_DB", &registration_path);
    std::env::set_var(
        crate::broker::activation::CLOUD_ACCESS_KEY_FILE_ENV,
        &oneshot,
    );

    let code = crate::broker::run_cloud_activate().await;

    std::env::remove_var(crate::broker::activation::CLOUD_ACTIVATION_ENV);
    std::env::remove_var(crate::broker::auth::RELAY_BROKER_CONTROL_URL_ENV);
    std::env::remove_var("RELAY_STATE_DB");
    std::env::remove_var(crate::broker::activation::CLOUD_ACCESS_KEY_FILE_ENV);

    assert_eq!(code, 1, "override while linked must fail");
    assert!(!oneshot.exists(), "oneshot file must be consumed/unlinked");
}

/// A phone paired earlier but not in the room now, next to an online surface that is
/// still mid-pairing: history and presence alone, with no live approved target.
async fn snapshot_publish_state(security: SecurityProfile) -> AppState {
    let (change_tx, _) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        "/tmp/broker-snapshot-publish".to_string(),
        change_tx.clone(),
        security,
    )));
    relay.write().await.paired_devices.insert(
        "phone-1".to_string(),
        crate::state::PairedDevice {
            device_id: "phone-1".to_string(),
            label: "phone-1".to_string(),
            payload_secret: "secret".to_string(),
            device_verify_key: test_phone_verify_key(),
            created_at: 1,
            last_seen_at: Some(1),
            last_peer_id: Some("surface-yesterday".to_string()),
            broker_join_ticket_expires_at: None,
            path_scope: Vec::new(),
            pairing_broker: None,
        },
    );
    seed_test_request_sessions(&mut *relay.write().await);
    let state = AppState::from_parts(relay, HashMap::new(), change_tx);
    state
        .replace_online_surface_peers(["surface-pairing".to_string()])
        .await;
    state
}

async fn bring_paired_phone_online(state: &AppState) {
    state
        .replace_online_surface_peers(["surface-pairing".to_string(), "surface-a".to_string()])
        .await;
    state
        .mark_remote_device_seen("phone-1", "surface-a", None)
        .await
        .expect("paired phone should bind to its peer");
}

async fn published_snapshot_payloads(state: &AppState) -> Vec<serde_json::Value> {
    let (writer, mut now_rx, _train_rx) = super::writer::test_writer();
    publish_snapshot(&writer, state)
        .await
        .expect("snapshot publish should succeed");
    let mut payloads = Vec::new();
    while let Ok(message) = now_rx.try_recv() {
        let Message::Text(text) = message else {
            panic!("broker frames are text, got {message:?}");
        };
        let frame: serde_json::Value = serde_json::from_str(&text).expect("frame is json");
        assert_eq!(frame["type"], "publish");
        payloads.push(frame["payload"].clone());
    }
    payloads
}

#[tokio::test]
async fn private_snapshot_is_not_published_without_a_live_paired_surface() {
    let state = snapshot_publish_state(SecurityProfile::private()).await;

    let payloads = published_snapshot_payloads(&state).await;

    assert!(
        payloads.is_empty(),
        "nobody live can open a private snapshot, so none may be sent; got {payloads:?}"
    );
}

#[tokio::test]
async fn private_snapshot_is_sealed_for_the_live_paired_surface_only() {
    let state = snapshot_publish_state(SecurityProfile::private()).await;
    bring_paired_phone_online(&state).await;

    let payloads = published_snapshot_payloads(&state).await;

    assert_eq!(payloads.len(), 1, "expected one frame, got {payloads:?}");
    assert_eq!(payloads[0]["kind"], "targeted_messages");
    let messages = payloads[0]["messages"]
        .as_array()
        .expect("targeted frame carries messages");
    assert_eq!(messages.len(), 1, "only the live phone is a target");
    let message = &messages[0];
    assert_eq!(message["target_peer_id"], "surface-a");
    assert_eq!(message["payload"]["kind"], "encrypted_session_snapshot");
    assert_eq!(message["payload"]["target_peer_id"], "surface-a");
    assert_eq!(message["payload"]["device_id"], "phone-1");
    let envelope: EncryptedEnvelope =
        serde_json::from_value(message["payload"]["envelope"].clone())
            .expect("envelope deserializes");
    let snapshot: serde_json::Value =
        decrypt_json("secret", &envelope).expect("the phone's own secret opens the snapshot");
    assert_eq!(snapshot["broker_can_read_content"], false);
}

fn canonical(dir: &tempfile::TempDir) -> String {
    std::fs::canonicalize(dir.path())
        .expect("tempdir canonicalizes")
        .to_string_lossy()
        .to_string()
}

/// An online phone limited to `phone_dir`, while the active session runs in
/// `session_dir` with a reply on screen and a command waiting for approval.
pub(super) async fn folder_limited_phone_state(phone_dir: &str, session_dir: &str) -> AppState {
    let (change_tx, _) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        "/tmp/broker-folder-limit".to_string(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    {
        let mut relay = relay.write().await;
        relay.paired_devices.insert(
            "phone-1".to_string(),
            crate::state::PairedDevice {
                device_id: "phone-1".to_string(),
                label: "phone-1".to_string(),
                payload_secret: "secret".to_string(),
                device_verify_key: test_phone_verify_key(),
                created_at: 1,
                last_seen_at: Some(1),
                last_peer_id: None,
                broker_join_ticket_expires_at: None,
                path_scope: vec![phone_dir.to_string()],
                pairing_broker: None,
            },
        );
        seed_test_request_sessions(&mut relay);
        relay.activate_thread(
            crate::protocol::ThreadSummaryView {
                workspace_trusted: false,
                id: "session-1".to_string(),
                name: Some("Session".to_string()),
                preview: String::new(),
                cwd: session_dir.to_string(),
                updated_at: 1,
                source: "codex".to_string(),
                status: "active".to_string(),
                model_provider: "codex".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
                renamed: false,
                flagged: false,
            },
            session_dir,
            "gpt-5",
            "untrusted",
            "workspace-write",
            "medium",
            "local-browser",
        );
        relay.append_agent_delta("reply-1", "the secret reply", "turn-1");
        relay.add_pending_approval(crate::state::PendingApproval {
            request_id: "approval-1".to_string(),
            raw_request_id: serde_json::json!("approval-1"),
            kind: crate::state::ApprovalKind::Command,
            thread_id: "session-1".to_string(),
            summary: "Run command".to_string(),
            detail: None,
            command: Some("cat secrets.txt".to_string()),
            cwd: Some(session_dir.to_string()),
            context_preview: None,
            requested_permissions: None,
            available_decisions: vec!["approve".to_string(), "deny".to_string()],
            supports_session_scope: false,
        });
    }
    let state = AppState::from_parts(relay, HashMap::new(), change_tx);
    state
        .replace_online_surface_peers(["surface-a".to_string()])
        .await;
    state
        .mark_remote_device_seen("phone-1", "surface-a", None)
        .await
        .expect("paired phone should bind to its peer");
    state
}

async fn published_snapshot_for_phone(state: &AppState) -> serde_json::Value {
    let payloads = published_snapshot_payloads(state).await;
    let message = &payloads[0]["messages"][0];
    assert_eq!(message["payload"]["device_id"], "phone-1");
    let envelope: EncryptedEnvelope =
        serde_json::from_value(message["payload"]["envelope"].clone())
            .expect("envelope deserializes");
    decrypt_json("secret", &envelope).expect("the phone's own secret opens the snapshot")
}

#[tokio::test]
async fn a_folder_limited_phone_gets_nothing_from_a_session_outside_its_folder() {
    let phone_dir = tempfile::TempDir::new().expect("phone tempdir");
    let session_dir = tempfile::TempDir::new().expect("session tempdir");
    let session_cwd = canonical(&session_dir);
    let state = folder_limited_phone_state(&canonical(&phone_dir), &session_cwd).await;

    let snapshot = published_snapshot_for_phone(&state).await;

    let text = snapshot.to_string();
    assert!(!text.contains("the secret reply"), "transcript leaked");
    assert!(!text.contains("cat secrets.txt"), "approval leaked");
    assert!(!text.contains(&session_cwd), "session folder leaked");
    assert_eq!(snapshot["pending_approvals"], serde_json::json!([]));
}

#[tokio::test]
async fn a_folder_limited_phone_still_sees_a_session_inside_its_folder() {
    let session_dir = tempfile::TempDir::new().expect("session tempdir");
    let session_cwd = canonical(&session_dir);
    let state = folder_limited_phone_state(&session_cwd, &session_cwd).await;

    let snapshot = published_snapshot_for_phone(&state).await;

    let text = snapshot.to_string();
    assert!(text.contains("the secret reply"), "transcript missing");
    assert_eq!(snapshot["pending_approvals"][0]["request_id"], "approval-1");
    assert_eq!(snapshot["current_cwd"], session_cwd);
}

// Targets are read before the snapshot is scoped, so a phone revoked in between is no
// longer on record. It must get what a limited phone gets, not everything.
#[tokio::test]
async fn a_phone_no_longer_on_record_gets_nothing_outside_its_folder() {
    let phone_dir = tempfile::TempDir::new().expect("phone tempdir");
    let session_dir = tempfile::TempDir::new().expect("session tempdir");
    let state = folder_limited_phone_state(&canonical(&phone_dir), &canonical(&session_dir)).await;
    let snapshot = state.snapshot().await;

    let scoped = state
        .snapshot_for_device(&snapshot, "revoked-phone")
        .await
        .expect("an unknown device is scoped, not waved through");

    let text = serde_json::to_string(&scoped).expect("snapshot serializes");
    assert!(!text.contains("the secret reply"), "transcript leaked");
    assert!(scoped.pending_approvals.is_empty(), "approval leaked");
}

#[test]
fn plaintext_remote_actions_are_rejected() {
    for request in [
        serde_json::json!({"type":"list_threads"}),
        serde_json::json!({"type":"claim_challenge","proof":"proof"}),
    ] {
        let error = parse_inbound_payload(serde_json::json!({
            "kind":"remote_action", "protocol_version":RELAY_PROTOCOL_VERSION,
            "action_id":"plain", "device_id":"phone-1", "request":request
        }))
        .expect_err("plaintext must never be accepted");
        assert!(error.contains("plaintext"));
    }
}

fn open_encrypted_request_json(action_id: &str, request: serde_json::Value) -> RemoteActionRequest {
    let action = parse_inbound_payload(serde_json::json!({
        "kind": "encrypted_remote_action",
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "action_id": action_id,
        "device_id": "phone-1",
        "envelope": bound_action_envelope("secret", action_id, &request).expect("request encrypts"),
    }))
    .expect("payload parses")
    .expect("payload is handled");
    match action {
        InboundBrokerPayload::EncryptedRemoteAction {
            action_id: parsed_id,
            device_id,
            request_sid,
            envelope,
            ..
        } => {
            assert_eq!(parsed_id, action_id);
            assert_eq!(device_id.as_deref(), Some("phone-1"));
            assert!(request_sid.is_none());
            remote_actions::decrypt_remote_action_with_secret("secret", &parsed_id, &envelope)
                .expect("request JSON parses")
        }
        other => panic!("unexpected payload: {other:?}"),
    }
}

#[test]
fn parse_encrypted_send_message_json() {
    match open_encrypted_request_json(
        "act-message",
        serde_json::json!({
            "type": "send_message", "input": { "text": "hello", "thread_id": "thread-1" }
        }),
    ) {
        RemoteActionRequest::SendMessage { input, skill } => {
            assert_eq!(input.text, "hello");
            assert_eq!(input.thread_id, "thread-1");
            assert!(skill.is_none());
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_encrypted_list_threads_json() {
    match open_encrypted_request_json(
        "act-threads",
        serde_json::json!({
            "type": "list_threads", "query": { "limit": 40 }
        }),
    ) {
        RemoteActionRequest::ListThreads { query } => assert_eq!(query.limit, Some(40)),
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_encrypted_claim_challenge_json() {
    match open_encrypted_request_json(
        "claim-start",
        serde_json::json!({
            "type": "claim_challenge", "proof": "claim-init-proof"
        }),
    ) {
        RemoteActionRequest::ClaimChallenge { proof } => assert_eq!(proof, "claim-init-proof"),
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_encrypted_claim_device_json() {
    match open_encrypted_request_json(
        "claim-finish",
        serde_json::json!({
            "type": "claim_device",
            "challenge_id": "challenge-1",
            "challenge": "nonce-1",
            "proof": "signed-proof"
        }),
    ) {
        RemoteActionRequest::ClaimDevice {
            challenge_id,
            challenge,
            proof,
        } => {
            assert_eq!(challenge_id, "challenge-1");
            assert_eq!(challenge, "nonce-1");
            assert_eq!(proof, "signed-proof");
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

async fn next_encrypted_action_reply(
    replies: &mut tokio::sync::mpsc::Receiver<Message>,
) -> (serde_json::Value, serde_json::Value) {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(2), replies.recv())
            .await
            .expect("reply arrives")
            .expect("writer remains open");
        let Message::Text(text) = message else {
            continue;
        };
        let frame: serde_json::Value = serde_json::from_str(&text).expect("reply frame");
        let payload = &frame["payload"];
        if payload["kind"] != "encrypted_remote_action_result" {
            continue;
        }
        let envelope = serde_json::from_value(payload["envelope"].clone()).expect("reply envelope");
        let result = decrypt_json("secret", &envelope).expect("reply decrypts");
        return (payload.clone(), result);
    }
}

/// Hand a scripted frame's payload to the relay, as the broker said it came from `peer`.
async fn deliver_scripted(
    state: &AppState,
    writer: &super::writer::BrokerWriter,
    origin: FrameOrigin,
    peer: &str,
    frame: &str,
) {
    let frame: serde_json::Value = serde_json::from_str(frame).expect("frame");
    let Some(InboundBrokerPayload::EncryptedRemoteAction {
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
    }) = parse_inbound_payload(frame["payload"].clone()).expect("payload parses")
    else {
        panic!("not an action frame");
    };
    Box::pin(handle_encrypted_remote_action(
        state,
        writer,
        origin,
        peer.to_string(),
        action_id,
        device_id,
        remote_actions::signed_attempt_from_parts(
            action,
            request_sid,
            request_boot,
            request_seq,
            request_time,
            op_boot,
            op_t0,
            request_signature,
        ),
        envelope,
    ))
    .await
    .expect("the room remains connected");
}

fn no_more_replies(replies: &mut tokio::sync::mpsc::Receiver<Message>) {
    if let Ok(Message::Text(text)) = replies.try_recv() {
        panic!("expected no answer, got {text}");
    }
}

#[tokio::test]
async fn bound_action_retries_wait_and_replay_without_reexecuting_the_provider() {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let entered = Arc::new(tokio::sync::Notify::new());
    let released = Arc::new(tokio::sync::Notify::new());
    let entries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut providers: HashMap<String, Arc<dyn crate::provider::ProviderBridge>> = HashMap::new();
    providers.insert(
        "gated".to_string(),
        Arc::new(GatedThreadsProvider {
            entered_list_threads: entered.clone(),
            released: released.clone(),
            entries: entries.clone(),
        }),
    );
    let (state, relay) =
        encrypted_broker_state_parts(&dir.path().to_string_lossy(), providers).await;
    let (origin, retry_origin) = {
        let mut relay = relay.write().await;
        relay.mark_surface_peer_online("surface-a");
        relay.mark_surface_peer_online("surface-b");
        (
            FrameOrigin {
                ingress: crate::state::next_relay_ingress(),
                lease: relay.current_surface_lease("surface-a").unwrap(),
            },
            FrameOrigin {
                ingress: crate::state::next_relay_ingress(),
                lease: relay.current_surface_lease("surface-b").unwrap(),
            },
        )
    };
    let list = serde_json::json!({"type": "list_threads", "query": {"limit": 5}});
    let original = encrypted_action_frame("surface-a", "original", list.clone());
    let (writer, mut replies, _trains) = super::writer::test_writer_with_identity();
    let first = {
        let state = state.clone();
        let writer = writer.clone();
        let original = original.clone();
        tokio::spawn(async move {
            deliver_scripted(&state, &writer, origin, "surface-a", &original).await;
        })
    };
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .expect("provider entered");
    // The reconnected phone asks again: same operation, new connection, new signature.
    deliver_scripted(
        &state,
        &writer,
        retry_origin,
        "surface-b",
        &encrypted_action_frame("surface-b", "original", list.clone()),
    )
    .await;
    let pending = tokio::time::timeout(Duration::from_secs(2), replies.recv())
        .await
        .expect("in-flight notice arrives")
        .expect("writer open");
    let Message::Text(pending) = pending else {
        panic!("notice must be text")
    };
    let pending: serde_json::Value = serde_json::from_str(&pending).expect("notice JSON");
    assert_eq!(pending["payload"]["kind"], "remote_action_pending");
    assert_eq!(pending["payload"]["action_id"], "original");

    // The broker re-labels the original frame under another action id: refused unheard.
    let mut relabelled: serde_json::Value = serde_json::from_str(&original).unwrap();
    relabelled["payload"]["action_id"] = serde_json::json!("changed");
    deliver_scripted(
        &state,
        &writer,
        origin,
        "surface-a",
        &relabelled.to_string(),
    )
    .await;
    assert!(relay
        .read()
        .await
        .completed_remote_action("phone-1", "changed")
        .is_none());
    released.notify_one();
    first.await.expect("handler joins");
    for _ in 0..2 {
        let (payload, result) = next_encrypted_action_reply(&mut replies).await;
        assert_eq!(payload["action_id"], "original");
        assert_eq!(result["ok"], true);
    }
    no_more_replies(&mut replies);
    deliver_scripted(
        &state,
        &writer,
        retry_origin,
        "surface-b",
        &encrypted_action_frame("surface-b", "original", list),
    )
    .await;
    let (payload, result) = next_encrypted_action_reply(&mut replies).await;
    assert_eq!(payload["action_id"], "original");
    assert_eq!(result["ok"], true);
    deliver_scripted(
        &state,
        &writer,
        origin,
        "surface-a",
        &relabelled.to_string(),
    )
    .await;
    no_more_replies(&mut replies);
    assert_eq!(entries.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(matches!(
        state
            .reserve_remote_action("phone-1", "changed", "list_threads")
            .await,
        Ok(crate::state::RemoteActionReplayDecision::Execute)
    ));
}

#[tokio::test]
async fn an_unsigned_send_message_is_dropped_before_reservation() {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let (state, relay) =
        encrypted_broker_state_parts(&dir.path().to_string_lossy(), HashMap::new()).await;
    let (writer, mut replies, _trains) = super::writer::test_writer_with_identity();
    let origin = {
        let mut relay = relay.write().await;
        relay.mark_surface_peer_online("surface-a");
        FrameOrigin {
            ingress: crate::state::next_relay_ingress(),
            lease: relay.current_surface_lease("surface-a").unwrap(),
        }
    };
    let mut unsigned: serde_json::Value = serde_json::from_str(&encrypted_action_frame(
        "surface-a",
        "send-unsigned",
        serde_json::json!({
            "type": "send_message", "input": {"text": "hello", "thread_id": "thread-1"},
        }),
    ))
    .unwrap();
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
        unsigned["payload"].as_object_mut().unwrap().remove(field);
    }
    deliver_scripted(&state, &writer, origin, "surface-a", &unsigned.to_string()).await;
    no_more_replies(&mut replies);
    {
        let relay = relay.read().await;
        assert_eq!(relay.paired_devices["phone-1"].last_peer_id, None);
        assert_eq!(relay.paired_devices["phone-1"].last_seen_at, Some(1));
        assert!(relay
            .completed_remote_action("phone-1", "send-unsigned")
            .is_none());
    }
    assert!(matches!(
        state
            .reserve_remote_action("phone-1", "send-unsigned", "send_message")
            .await,
        Ok(crate::state::RemoteActionReplayDecision::Execute)
    ));
}

#[tokio::test]
async fn invalid_action_binding_cannot_change_device_or_claim_state() {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let (state, relay) =
        encrypted_broker_state_parts(&dir.path().to_string_lossy(), HashMap::new()).await;
    let (writer, mut replies, _trains) = super::writer::test_writer_with_identity();
    let origin = {
        let mut relay = relay.write().await;
        relay.mark_surface_peer_online("surface-a");
        FrameOrigin {
            ingress: crate::state::next_relay_ingress(),
            lease: relay.current_surface_lease("surface-a").unwrap(),
        }
    };
    let assert_untouched = |relay: &RelayState| {
        assert_eq!(relay.paired_devices["phone-1"].last_peer_id, None);
        assert_eq!(relay.paired_devices["phone-1"].last_seen_at, Some(1));
        assert!(relay.pending_claim_challenges.is_empty());
        assert!(relay
            .completed_remote_action("phone-1", "changed")
            .is_none());
        assert!(!relay.any_device_watches_thread("t1"));
    };
    // Claim steps travel unsigned and are answered with their refusal, as before.
    for request in [
        serde_json::json!({"type": "claim_challenge", "proof": "proof"}),
        serde_json::json!({"type": "claim_device", "challenge_id": "challenge", "challenge": "nonce", "proof": "proof"}),
    ] {
        for envelope in [
            bound_action_envelope("secret", "original", &request).expect("bound request"),
            encrypt_json("secret", &request).expect("old unbound request"),
        ] {
            let frame = serde_json::json!({"payload": {
                "kind": "encrypted_remote_action",
                "protocol_version": RELAY_PROTOCOL_VERSION,
                "action_id": "changed",
                "device_id": "phone-1",
                "envelope": envelope,
            }});
            deliver_scripted(&state, &writer, origin, "surface-a", &frame.to_string()).await;
            let (_, result) = next_encrypted_action_reply(&mut replies).await;
            assert_eq!(result["ok"], false);
            assert!(result["session_claim"].is_null());
            assert_untouched(&*relay.read().await);
        }
    }
    // Everything else is signed; a re-labelled or unbound one is dropped unheard.
    for request in [
        serde_json::json!({"type": "heartbeat", "input": {}}),
        serde_json::json!({"type": "watch_threads", "input": {"thread_ids": ["t1"]}}),
    ] {
        let mut relabelled: serde_json::Value = serde_json::from_str(&encrypted_action_frame(
            "surface-a",
            "original",
            request.clone(),
        ))
        .unwrap();
        relabelled["payload"]["action_id"] = serde_json::json!("changed");
        let mut unbound: serde_json::Value = serde_json::from_str(&encrypted_action_frame(
            "surface-a",
            "changed",
            request.clone(),
        ))
        .unwrap();
        unbound["payload"]["envelope"] =
            serde_json::to_value(encrypt_json("secret", &request).unwrap()).unwrap();
        for frame in [relabelled, unbound] {
            deliver_scripted(&state, &writer, origin, "surface-a", &frame.to_string()).await;
            no_more_replies(&mut replies);
            assert_untouched(&*relay.read().await);
        }
    }
}

#[tokio::test]
async fn an_invalid_encrypted_request_does_not_end_the_session() {
    let mut unbound: serde_json::Value = serde_json::from_str(&encrypted_action_frame_versioned(
        "surface-a",
        "unbound",
        serde_json::json!({"type": "list_threads"}),
        RELAY_PROTOCOL_VERSION,
    ))
    .expect("frame");
    unbound["payload"]["envelope"] = serde_json::to_value(
        encrypt_json(
            "secret",
            &serde_json::json!({
                "type": "list_threads", "query": {"limit": 5},
            }),
        )
        .expect("unbound request"),
    )
    .expect("envelope");
    let mut changed = unbound.clone();
    changed["payload"]["action_id"] = serde_json::json!("changed");
    changed["payload"]["envelope"] = serde_json::to_value(
        bound_action_envelope(
            "secret",
            "original",
            &serde_json::json!({
                "type": "list_threads", "query": {"limit": 5},
            }),
        )
        .expect("bound request"),
    )
    .expect("envelope");
    let kinds = observe_relay_session_for_frames(vec![
        unbound.to_string(),
        changed.to_string(),
        encrypted_action_frame_versioned(
            "surface-a",
            "malformed",
            serde_json::json!({"type": "unknown_action"}),
            RELAY_PROTOCOL_VERSION,
        ),
        encrypted_action_frame_versioned(
            "surface-a",
            "valid",
            serde_json::json!({"type": "list_threads", "query": {"limit": 5}}),
            RELAY_PROTOCOL_VERSION,
        ),
    ])
    .await;
    assert!(
        kinds
            .iter()
            .any(|kind| kind == "encrypted_remote_action_result:valid"),
        "saw {kinds:?}"
    );
}

fn signed_pairing_request(
    pairing_id: &str,
    pairing_secret: &str,
    key_seed: u8,
    device_id: &str,
) -> EncryptedEnvelope {
    let signing_key = SigningKey::from_bytes(&[key_seed; 32]);
    encrypt_json(
        pairing_secret,
        &PairingRequestPlaintext {
            device_id: Some(device_id.to_string()),
            device_label: Some(device_id.to_string()),
            device_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            pairing_proof: STANDARD.encode(
                signing_key
                    .sign(pairing_proof_message(pairing_id, Some(device_id)).as_bytes())
                    .to_bytes(),
            ),
        },
    )
    .expect("pairing request encrypts")
}

// The first key to reach a QR keeps it, so the operator approves one device only. The
// second phone used to get no answer at all and sat on "waiting for approval" forever.
#[tokio::test]
async fn a_second_phone_on_a_taken_pairing_qr_is_told_to_use_a_new_one() {
    let (change_tx, _) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        "/tmp/pairing-second-phone".to_string(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    let ticket = {
        let mut relay = relay.write().await;
        let ticket = relay
            .prepare_pairing_ticket(Some(600), Vec::new())
            .expect("QR prepares");
        relay
            .install_pairing_ticket(&ticket, unix_now())
            .expect("QR installs");
        ticket
    };
    let state = AppState::from_parts(relay.clone(), HashMap::new(), change_tx);
    let (writer, mut now_rx, _train_rx) = super::writer::test_writer();

    for (peer, seed, device) in [
        ("surface-first", 1_u8, "phone-first"),
        ("surface-second", 2_u8, "phone-second"),
    ] {
        handle_pairing_request(
            &state,
            &writer,
            peer.to_string(),
            ticket.pairing_id.clone(),
            signed_pairing_request(&ticket.pairing_id, &ticket.pairing_secret, seed, device),
        )
        .await
        .expect("pairing request is handled");
    }

    let mut answers = Vec::new();
    while let Ok(message) = now_rx.try_recv() {
        let Message::Text(text) = message else {
            continue;
        };
        let frame: serde_json::Value = serde_json::from_str(&text).expect("frame is json");
        for message in frame["payload"]["messages"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if message["payload"]["kind"] != "encrypted_pairing_result" {
                continue;
            }
            let envelope: EncryptedEnvelope =
                serde_json::from_value(message["payload"]["envelope"].clone())
                    .expect("envelope deserializes");
            let result: serde_json::Value =
                decrypt_json(&ticket.pairing_secret, &envelope).expect("result decrypts");
            answers.push((message["target_peer_id"].clone(), result));
        }
    }
    assert_eq!(
        answers.len(),
        1,
        "exactly the second phone is answered: {answers:?}"
    );
    let (target, result) = &answers[0];
    assert_eq!(target, "surface-second");
    assert_eq!(result["ok"], false);
    assert!(result["device"].is_null() && result["payload_secret"].is_null());
    assert!(
        result["error"]
            .as_str()
            .unwrap_or_default()
            .contains("new QR"),
        "{result}"
    );
    let relay = relay.read().await;
    let waiting = relay
        .pending_pairing_requests
        .get(&ticket.pairing_id)
        .expect("the first phone is still waiting");
    assert_eq!(waiting.broker_peer_id, "surface-first");
}

fn pairing_results(
    now_rx: &mut tokio::sync::mpsc::Receiver<Message>,
    pairing_secret: &str,
) -> Vec<(serde_json::Value, serde_json::Value)> {
    let mut answers = Vec::new();
    while let Ok(message) = now_rx.try_recv() {
        let Message::Text(text) = message else {
            continue;
        };
        let frame: serde_json::Value = serde_json::from_str(&text).expect("frame is json");
        for message in frame["payload"]["messages"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if message["payload"]["kind"] != "encrypted_pairing_result" {
                continue;
            }
            let envelope: EncryptedEnvelope =
                serde_json::from_value(message["payload"]["envelope"].clone())
                    .expect("envelope deserializes");
            let result: serde_json::Value =
                decrypt_json(pairing_secret, &envelope).expect("result decrypts");
            answers.push((message["target_peer_id"].clone(), result));
        }
    }
    answers
}

// A Cloud join ticket outlives the decision, so a second phone can still scan the QR
// after the first was approved or rejected; it used to wait forever then too.
#[tokio::test]
async fn a_second_phone_on_a_decided_pairing_qr_is_told_to_use_a_new_one() {
    for approved in [true, false] {
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            "/tmp/pairing-decided-qr".to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let ticket = {
            let mut relay = relay.write().await;
            let ticket = relay
                .prepare_pairing_ticket(Some(600), Vec::new())
                .expect("QR prepares");
            relay
                .install_pairing_ticket(&ticket, unix_now())
                .expect("QR installs");
            ticket
        };
        let state = AppState::from_parts(relay.clone(), HashMap::new(), change_tx);
        let (writer, mut now_rx, _train_rx) = super::writer::test_writer();
        let request = |seed, device| {
            signed_pairing_request(&ticket.pairing_id, &ticket.pairing_secret, seed, device)
        };

        handle_pairing_request(
            &state,
            &writer,
            "surface-first".to_string(),
            ticket.pairing_id.clone(),
            request(1, "phone-first"),
        )
        .await
        .expect("first request is handled");
        relay
            .write()
            .await
            .decide_pairing_request(&ticket.pairing_id, approved, None, unix_now())
            .expect("the operator decides");
        handle_pairing_request(
            &state,
            &writer,
            "surface-second".to_string(),
            ticket.pairing_id.clone(),
            request(2, "phone-second"),
        )
        .await
        .expect("second request is handled");
        handle_pairing_request(
            &state,
            &writer,
            "surface-first-again".to_string(),
            ticket.pairing_id.clone(),
            request(1, "phone-first"),
        )
        .await
        .expect("the first phone's resend is handled");

        let answers = pairing_results(&mut now_rx, &ticket.pairing_secret);
        assert_eq!(answers.len(), 2, "approved={approved}: {answers:?}");
        let (target, refusal) = &answers[0];
        assert_eq!(target, "surface-second");
        assert_eq!(refusal["ok"], false);
        assert!(refusal["payload_secret"].is_null() && refusal["device"].is_null());
        assert!(
            refusal["error"]
                .as_str()
                .unwrap_or_default()
                .contains("new QR"),
            "{refusal}"
        );
        let (target, replay) = &answers[1];
        assert_eq!(
            target, "surface-first-again",
            "the decided phone still gets its answer"
        );
        assert_eq!(replay["ok"], approved, "{replay}");
    }
}
mod request_replay;
