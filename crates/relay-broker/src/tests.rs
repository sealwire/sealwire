use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::*;
use crate::auth::BrokerAuthMode;
use crate::join_ticket::{JoinTicketClaims, JoinTicketKey};
use crate::public_control::{
    ClientGrantRequest, ClientGrantResponse, ClientIdentityRevokeResponse,
    ClientIdentityRotateResponse, ClientRelaysResponse, ClientSessionResponse,
    DeviceGrantBulkRevokeRequest, DeviceGrantBulkRevokeResponse, DeviceGrantRequest,
    DeviceGrantResponse, DeviceGrantRevokeRequest, DeviceGrantRevokeResponse,
    DeviceSessionResponse, DeviceWsTokenResponse, PairingWsTokenRequest, PairingWsTokenResponse,
    PublicControlPlane, RelayEnrollmentChallengeRequest, RelayEnrollmentChallengeResponse,
    RelayEnrollmentCompleteRequest, RelayEnrollmentResponse, RelayWsTokenRequest,
    RelayWsTokenResponse,
};

async fn spawn_app() -> SocketAddr {
    spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await
}

async fn spawn_app_with(
    join_verifier: BrokerJoinVerifier,
    hardening: BrokerHardeningConfig,
    security_headers: SecurityHeadersConfig,
) -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let app = app_with_web_root_and_verifier_and_hardening(
        BrokerState::default(),
        test_web_root(),
        join_verifier,
        hardening,
        security_headers,
    );
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("broker should serve");
    });
    address
}

async fn spawn_public_mode_app() -> SocketAddr {
    spawn_public_mode_app_with(
        test_public_control_plane().await,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await
}

async fn spawn_public_mode_app_with(
    public_control: PublicControlPlane,
    hardening: BrokerHardeningConfig,
    security_headers: SecurityHeadersConfig,
) -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let app = app_with_web_root_and_verifier_and_hardening(
        BrokerState::default(),
        test_web_root(),
        BrokerJoinVerifier::PublicControlPlane(public_control),
        hardening,
        security_headers,
    );
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("broker should serve");
    });
    address
}

async fn next_server_message(
    stream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> ServerMessage {
    let frame = stream
        .next()
        .await
        .expect("socket should stay open")
        .expect("frame should decode");
    let text = frame.into_text().expect("frame should be text");
    serde_json::from_str(&text).expect("server message should parse")
}

async fn http_get(address: SocketAddr, path: &str) -> String {
    http_get_with_headers(address, path, &[]).await
}

async fn http_get_with_headers(
    address: SocketAddr,
    path: &str,
    headers: &[(&str, &str)],
) -> String {
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("tcp stream should connect");
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("request should write");

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .await
        .expect("response should read");
    response
}

async fn public_post<TReq, TResp>(
    address: SocketAddr,
    path: &str,
    bearer_token: &str,
    request: &TReq,
) -> TResp
where
    TReq: serde::Serialize + ?Sized,
    TResp: serde::de::DeserializeOwned,
{
    reqwest::Client::new()
        .post(format!("http://{address}{path}"))
        .bearer_auth(bearer_token)
        .json(request)
        .send()
        .await
        .expect("request should succeed")
        .error_for_status()
        .expect("response should be successful")
        .json::<TResp>()
        .await
        .expect("response should decode")
}

async fn public_post_response<TReq>(
    address: SocketAddr,
    path: &str,
    bearer_token: &str,
    request: &TReq,
) -> reqwest::Response
where
    TReq: serde::Serialize + ?Sized,
{
    reqwest::Client::new()
        .post(format!("http://{address}{path}"))
        .bearer_auth(bearer_token)
        .json(request)
        .send()
        .await
        .expect("request should succeed")
}

async fn public_post_with_cookie<TReq, TResp>(
    address: SocketAddr,
    path: &str,
    cookie: &str,
    request: &TReq,
) -> TResp
where
    TReq: serde::Serialize + ?Sized,
    TResp: serde::de::DeserializeOwned,
{
    reqwest::Client::new()
        .post(format!("http://{address}{path}"))
        .header(reqwest::header::COOKIE, cookie)
        .json(request)
        .send()
        .await
        .expect("request should succeed")
        .error_for_status()
        .expect("response should be successful")
        .json::<TResp>()
        .await
        .expect("response should decode")
}

async fn public_get<TResp>(address: SocketAddr, path: &str, bearer_token: &str) -> TResp
where
    TResp: serde::de::DeserializeOwned,
{
    reqwest::Client::new()
        .get(format!("http://{address}{path}"))
        .bearer_auth(bearer_token)
        .send()
        .await
        .expect("request should succeed")
        .error_for_status()
        .expect("response should be successful")
        .json::<TResp>()
        .await
        .expect("response should decode")
}

fn set_cookie_name_value(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::to_string)
        .expect("set-cookie header should include a name=value pair")
}

async fn public_post_expect_status<TReq>(
    address: SocketAddr,
    path: &str,
    bearer_token: &str,
    request: &TReq,
    expected_status: reqwest::StatusCode,
) -> String
where
    TReq: serde::Serialize + ?Sized,
{
    let response = reqwest::Client::new()
        .post(format!("http://{address}{path}"))
        .bearer_auth(bearer_token)
        .json(request)
        .send()
        .await
        .expect("request should complete");
    assert_eq!(response.status(), expected_status);
    response.text().await.expect("error body should read")
}

fn test_web_root() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough for tests")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("agent-relay-broker-web-{unique}"));
    let assets = root.join("assets");
    fs::create_dir_all(&assets).expect("test asset directory should be created");
    fs::write(
        root.join("remote.html"),
        r#"<!doctype html><html><body>Remote Broker Surface<script type="module" src="/static/assets/remote-test.js"></script></body></html>"#,
    )
    .expect("remote html should write");
    fs::write(
        root.join("remote-manifest.webmanifest"),
        r#"{"display":"standalone","src":"/icon.svg"}"#,
    )
    .expect("manifest should write");
    fs::write(
        root.join("remote-sw.js"),
        r#"self.addEventListener("install", () => {}); const CACHE = "agent-relay-remote-v1";"#,
    )
    .expect("service worker should write");
    fs::write(
        root.join("icon.svg"),
        r#"<svg xmlns="http://www.w3.org/2000/svg"></svg>"#,
    )
    .expect("icon should write");
    fs::write(assets.join("remote-test.js"), "console.log('remote');").expect("asset should write");
    root
}

fn test_join_ticket_key() -> JoinTicketKey {
    JoinTicketKey::from_secret("broker-test-secret".as_bytes())
        .expect("test join-ticket key should construct")
}

async fn test_public_control_plane() -> PublicControlPlane {
    test_public_control_plane_with_parts(None, Some("300"), Some("300")).await
}

async fn test_public_control_plane_with_parts(
    state_path: Option<String>,
    relay_ws_ttl_secs: Option<&str>,
    device_ws_ttl_secs: Option<&str>,
) -> PublicControlPlane {
    PublicControlPlane::from_parts(
        Some("public-broker-issuer-secret".to_string()),
        Some(
            serde_json::to_string(&vec![serde_json::json!({
                "relay_id": "relay-1",
                "broker_room_id": "room-a",
                "refresh_token": "relay-refresh-1"
            })])
            .expect("relay registrations should encode"),
        ),
        state_path,
        relay_ws_ttl_secs.map(str::to_string),
        device_ws_ttl_secs.map(str::to_string),
    )
    .await
    .expect("public control plane should configure")
}

fn temp_state_path(prefix: &str) -> String {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough for tests")
        .as_nanos();
    std::env::temp_dir()
        .join(format!("{prefix}-{unique}.json"))
        .display()
        .to_string()
}

fn websocket_url(
    address: SocketAddr,
    channel_id: &str,
    role: protocol::PeerRole,
    peer_id: Option<&str>,
    claims: JoinTicketClaims,
) -> String {
    let role = match role {
        protocol::PeerRole::Relay => "relay",
        protocol::PeerRole::Surface => "surface",
    };
    let join_ticket = test_join_ticket_key()
        .mint(&claims)
        .expect("join ticket should mint");
    let mut url = format!("ws://{address}/ws/{channel_id}?role={role}&join_ticket={join_ticket}");
    if let Some(peer_id) = peer_id {
        url.push_str("&peer_id=");
        url.push_str(peer_id);
    }
    url
}

#[tokio::test]
async fn root_serves_remote_surface_html() {
    let address = spawn_app().await;
    let response = http_get(address, "/").await;

    assert!(response.contains("200 OK"));
    assert!(response.contains("Remote Broker Surface"));
    assert!(response.contains("/static/assets/remote-"));
}

#[tokio::test]
async fn manifest_route_serves_remote_pwa_manifest() {
    let address = spawn_app().await;
    let response = http_get(address, "/manifest.webmanifest").await;

    assert!(response.contains("200 OK"));
    assert!(response.contains("\"display\":\"standalone\""));
    assert!(response.contains("\"src\":\"/icon.svg\""));
}

#[tokio::test]
async fn service_worker_route_serves_remote_cache_script() {
    let address = spawn_app().await;
    let response = http_get(address, "/sw.js").await;

    assert!(response.contains("200 OK"));
    assert!(response.contains("agent-relay-remote-v1"));
    assert!(response.contains("self.addEventListener(\"install\""));
}

#[tokio::test]
async fn websocket_relays_messages_between_peers() {
    let address = spawn_app().await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );
    let surface_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        Some("phone-1"),
        JoinTicketClaims::pairing_surface_join("room-a", "pair-1", u64::MAX),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let welcome = next_server_message(&mut relay).await;
    match welcome {
        ServerMessage::Welcome { peers, .. } => assert!(peers.is_empty()),
        other => panic!("unexpected welcome frame: {other:?}"),
    }

    let (mut surface, _) = connect_async(&surface_url)
        .await
        .expect("surface should connect");
    let welcome = next_server_message(&mut surface).await;
    match welcome {
        ServerMessage::Welcome { peers, .. } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    }

    let presence = next_server_message(&mut relay).await;
    match presence {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
            assert_eq!(peer.peer_id, "phone-1");
        }
        other => panic!("unexpected presence frame: {other:?}"),
    }

    relay
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Publish {
                payload: json!({"ciphertext":"abc"}),
            })
            .expect("client frame should serialize"),
        ))
        .await
        .expect("publish should send");

    let relayed = next_server_message(&mut surface).await;
    match relayed {
        ServerMessage::Message {
            from_peer_id,
            from_role,
            payload,
            ..
        } => {
            assert_eq!(from_peer_id, "relay-1");
            assert_eq!(from_role, protocol::PeerRole::Relay);
            assert_eq!(payload, json!({"ciphertext":"abc"}));
        }
        other => panic!("unexpected relayed frame: {other:?}"),
    }
}

#[tokio::test]
async fn surface_connections_can_use_broker_assigned_peer_ids() {
    let address = spawn_app().await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );
    let surface_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-2", u64::MAX),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let _welcome = next_server_message(&mut relay).await;

    let (mut surface, _) = connect_async(&surface_url)
        .await
        .expect("surface should connect");
    let welcome = next_server_message(&mut surface).await;
    let assigned_peer_id = match welcome {
        ServerMessage::Welcome { peer_id, peers, .. } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
            assert!(peer_id.starts_with("surface-"));
            peer_id
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    };

    let presence = next_server_message(&mut relay).await;
    match presence {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
            assert_eq!(peer.peer_id, assigned_peer_id);
        }
        other => panic!("unexpected presence frame: {other:?}"),
    }
}

#[tokio::test]
async fn duplicate_peers_get_error_frame() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        Some("dup-1"),
        JoinTicketClaims::pairing_surface_join("room-a", "pair-3", u64::MAX),
    );

    let (_first, _) = connect_async(&url)
        .await
        .expect("first peer should connect");
    let (mut duplicate, _) = connect_async(&url).await.expect("duplicate should connect");

    let error = next_server_message(&mut duplicate).await;
    match error {
        ServerMessage::Error { code, .. } => assert_eq!(code, "join_rejected"),
        other => panic!("unexpected error frame: {other:?}"),
    }
}

#[tokio::test]
async fn missing_join_ticket_gets_error_frame() {
    let address = spawn_app().await;
    let url = format!("ws://{address}/ws/room-a?role=surface");

    let (mut socket, _) = connect_async(&url).await.expect("socket should connect");
    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "join_rejected");
            assert_eq!(message, "broker join rejected");
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

#[tokio::test]
async fn expired_join_ticket_gets_error_frame() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-expired", 1),
    );

    let (mut socket, _) = connect_async(&url).await.expect("socket should connect");
    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "join_rejected");
            assert_eq!(message, "broker join rejected");
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

#[tokio::test]
async fn device_join_ticket_can_reconnect() {
    let address = spawn_app().await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );
    let surface_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::device_surface_join("room-a", "device-1", None),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let _welcome = next_server_message(&mut relay).await;

    let (mut first_surface, _) = connect_async(&surface_url)
        .await
        .expect("first surface should connect");
    let _welcome = next_server_message(&mut first_surface).await;
    first_surface
        .close(None)
        .await
        .expect("surface should close");
    let _left = next_server_message(&mut relay).await;

    let (mut second_surface, _) = connect_async(&surface_url)
        .await
        .expect("second surface should connect");
    let welcome = next_server_message(&mut second_surface).await;
    match welcome {
        ServerMessage::Welcome { peer_id, peers, .. } => {
            assert!(peer_id.starts_with("surface-"));
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    }
}

#[tokio::test]
async fn health_route_reports_ok() {
    let address = spawn_app().await;
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("tcp stream should connect");
    stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .expect("request should send");

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("response should read");
    let response = String::from_utf8(response).expect("response should be utf8");
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .expect("response should contain body");
    assert!(headers.starts_with("HTTP/1.1 200"));
    let parsed: HealthResponse =
        serde_json::from_str(body.trim()).expect("health body should parse");
    assert_eq!(parsed.status, "ok");
    assert_eq!(parsed.service, "relay-broker");
    assert_eq!(parsed.broker_auth_mode, "self_hosted");
    assert!(parsed.join_auth_ready);
    assert!(parsed.message.is_none());
}

#[tokio::test]
async fn public_auth_plane_health_reports_ready() {
    assert_eq!(BrokerAuthMode::PublicControlPlane.as_str(), "public");

    let address = spawn_public_mode_app().await;
    let response = http_get(address, "/api/health").await;

    assert!(response.contains("200 OK"));
    let (_, body) = response
        .split_once("\r\n\r\n")
        .expect("response should contain body");
    let parsed: HealthResponse =
        serde_json::from_str(body.trim()).expect("health body should parse");
    assert_eq!(parsed.status, "ok");
    assert_eq!(parsed.broker_auth_mode, "public");
    assert!(parsed.join_auth_ready);
    assert!(parsed
        .message
        .as_deref()
        .is_some_and(|message| message.contains("RELAY_BROKER_PUBLIC_STATE_PATH")));
}

#[tokio::test]
async fn security_headers_are_present_on_static_and_api_routes() {
    let address = spawn_app().await;
    let root_response = http_get(address, "/").await.to_ascii_lowercase();
    let health_response = http_get(address, "/api/health").await.to_ascii_lowercase();

    for response in [root_response, health_response] {
        assert!(response.contains("content-security-policy:"));
        assert!(response.contains("permissions-policy:"));
        assert!(response.contains("referrer-policy: no-referrer"));
        assert!(response.contains("x-content-type-options: nosniff"));
        assert!(!response.contains("strict-transport-security:"));
    }
}

#[tokio::test]
async fn strict_transport_security_is_only_sent_for_secure_requests_when_enabled() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::from_parts(true, None, Some("max-age=86400".to_string()))
            .expect("custom broker HSTS config should parse"),
    )
    .await;

    let insecure = http_get(address, "/api/health").await.to_ascii_lowercase();
    assert!(!insecure.contains("strict-transport-security:"));

    let secure = http_get_with_headers(address, "/api/health", &[("X-Forwarded-Proto", "https")])
        .await
        .to_ascii_lowercase();
    assert!(secure.contains("strict-transport-security: max-age=86400"));
}

#[tokio::test]
async fn content_security_policy_can_override_connect_src() {
    let connect_src = "'self' https://relay.example.com wss://broker.example.com";
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::from_parts(false, Some(connect_src.to_string()), None)
            .expect("custom broker CSP config should parse"),
    )
    .await;

    let response = http_get(address, "/api/health").await.to_ascii_lowercase();
    assert!(response.contains(&format!(
        "content-security-policy: {}",
        build_content_security_policy(connect_src).to_ascii_lowercase()
    )));
}

#[tokio::test]
async fn forwarded_and_forwarded_ssl_headers_are_treated_as_secure() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::from_parts(true, None, Some("max-age=86400".to_string()))
            .expect("custom broker HSTS config should parse"),
    )
    .await;

    let forwarded = http_get_with_headers(
        address,
        "/api/health",
        &[("Forwarded", "for=203.0.113.9;proto=https")],
    )
    .await
    .to_ascii_lowercase();
    assert!(forwarded.contains("strict-transport-security: max-age=86400"));

    let forwarded_ssl = http_get_with_headers(address, "/api/health", &[("X-Forwarded-Ssl", "on")])
        .await
        .to_ascii_lowercase();
    assert!(forwarded_ssl.contains("strict-transport-security: max-age=86400"));
}

#[test]
fn invalid_security_header_overrides_are_rejected() {
    let csp_error = SecurityHeadersConfig::from_parts(
        false,
        Some("https://broker.example.com\r\nx".to_string()),
        None,
    )
    .expect_err("invalid broker CSP override should fail");
    assert!(csp_error.contains(CSP_CONNECT_SRC_ENV));

    let hsts_error =
        SecurityHeadersConfig::from_parts(true, None, Some("max-age=86400\r\nx".to_string()))
            .expect_err("invalid broker HSTS override should fail");
    assert!(hsts_error.contains(HSTS_VALUE_ENV));
}

#[tokio::test]
async fn public_relay_challenge_enrollment_can_issue_registration_and_relay_tokens() {
    let control_plane = PublicControlPlane::from_parts(
        Some("public-broker-issuer-secret".to_string()),
        None,
        None,
        Some("300".to_string()),
        Some("300".to_string()),
    )
    .await
    .expect("public control plane should allow challenge bootstrap");
    let address = spawn_public_mode_app_with(
        control_plane,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;

    let signing_key = SigningKey::from_bytes(&[11_u8; 32]);
    let relay_verify_key = STANDARD.encode(signing_key.verifying_key().to_bytes());
    let challenge: RelayEnrollmentChallengeResponse = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/relay-enrollment/challenge"
        ))
        .json(&RelayEnrollmentChallengeRequest {
            relay_verify_key: relay_verify_key.clone(),
            relay_label: Some("Laptop".to_string()),
        })
        .send()
        .await
        .expect("challenge request should complete")
        .error_for_status()
        .expect("challenge request should succeed")
        .json()
        .await
        .expect("challenge response should decode");

    let challenge_signature = STANDARD.encode(
        signing_key
            .sign(
                format!(
                    "agent-relay:relay-enroll:{}:{}",
                    challenge.challenge_id, challenge.challenge
                )
                .as_bytes(),
            )
            .to_bytes(),
    );

    let enrollment: RelayEnrollmentResponse = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/relay-enrollment/complete"
        ))
        .json(&RelayEnrollmentCompleteRequest {
            relay_verify_key,
            challenge_id: challenge.challenge_id,
            challenge_signature,
            relay_label: Some("Laptop".to_string()),
        })
        .send()
        .await
        .expect("complete request should complete")
        .error_for_status()
        .expect("complete should succeed")
        .json()
        .await
        .expect("complete response should decode");

    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrollment.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrollment.relay_id.clone(),
            broker_room_id: enrollment.broker_room_id.clone(),
            relay_peer_id: "relay-challenge".to_string(),
        },
    )
    .await;

    let url = format!(
        "ws://{address}/ws/{}?role=relay&peer_id=relay-challenge&join_ticket={}",
        relay_token.broker_room_id, relay_token.relay_ws_token
    );
    let (mut socket, _) = connect_async(&url)
        .await
        .expect("challenge-enrolled relay should connect");
    let welcome = next_server_message(&mut socket).await;
    match welcome {
        ServerMessage::Welcome { peer_id, .. } => assert_eq!(peer_id, "relay-challenge"),
        other => panic!("unexpected response: {other:?}"),
    }
}

#[tokio::test]
async fn public_relay_ws_token_can_join_broker() {
    let address = spawn_public_mode_app().await;
    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        "relay-refresh-1",
        &RelayWsTokenRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            relay_peer_id: "relay-1".to_string(),
        },
    )
    .await;

    assert_eq!(relay_token.relay_id, "relay-1");
    assert_eq!(relay_token.broker_room_id, "room-a");

    let url = format!(
        "ws://{address}/ws/room-a?role=relay&peer_id=relay-1&join_ticket={}",
        relay_token.relay_ws_token
    );
    let (mut socket, _) = connect_async(&url).await.expect("relay should connect");
    let welcome = next_server_message(&mut socket).await;
    match welcome {
        ServerMessage::Welcome { peer_id, .. } => assert_eq!(peer_id, "relay-1"),
        other => panic!("unexpected response: {other:?}"),
    }
}

#[tokio::test]
async fn public_pairing_and_device_tokens_work_end_to_end() {
    let address = spawn_public_mode_app().await;

    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        "relay-refresh-1",
        &RelayWsTokenRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            relay_peer_id: "relay-1".to_string(),
        },
    )
    .await;
    let relay_url = format!(
        "ws://{address}/ws/room-a?role=relay&peer_id=relay-1&join_ticket={}",
        relay_token.relay_ws_token
    );
    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let _welcome = next_server_message(&mut relay).await;

    let pairing_token: PairingWsTokenResponse = public_post(
        address,
        "/api/public/pairing/ws-token",
        "relay-refresh-1",
        &PairingWsTokenRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            pairing_id: "pair-1".to_string(),
            expires_at: u64::MAX - 1,
        },
    )
    .await;
    let pairing_url = format!(
        "ws://{address}/ws/room-a?role=surface&join_ticket={}",
        pairing_token.pairing_join_ticket
    );
    let (mut pairing_surface, _) = connect_async(&pairing_url)
        .await
        .expect("pairing surface should connect");
    let _welcome = next_server_message(&mut pairing_surface).await;
    pairing_surface
        .close(None)
        .await
        .expect("pairing surface should close");
    let _left = next_server_message(&mut relay).await;

    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-1".to_string(),
        },
    )
    .await;
    assert_eq!(device_grant.device_id, "device-1");

    let first_device_url = format!(
        "ws://{address}/ws/room-a?role=surface&join_ticket={}",
        device_grant.device_ws_token
    );
    let (mut device_surface, _) = connect_async(&first_device_url)
        .await
        .expect("device surface should connect");
    let _welcome = next_server_message(&mut device_surface).await;
    device_surface
        .close(None)
        .await
        .expect("device surface should close");
    let _left = next_server_message(&mut relay).await;

    let refreshed: DeviceWsTokenResponse = reqwest::Client::new()
        .post(format!("http://{address}/api/public/device/ws-token"))
        .bearer_auth(&device_grant.device_refresh_token)
        .send()
        .await
        .expect("refresh request should send")
        .error_for_status()
        .expect("refresh should succeed")
        .json()
        .await
        .expect("refresh response should parse");
    assert_eq!(refreshed.device_id, "device-1");

    let second_device_url = format!(
        "ws://{address}/ws/room-a?role=surface&join_ticket={}",
        refreshed.device_ws_token
    );
    let (mut second_surface, _) = connect_async(&second_device_url)
        .await
        .expect("refreshed surface should connect");
    let _welcome = next_server_message(&mut second_surface).await;
    second_surface
        .close(None)
        .await
        .expect("refreshed surface should close");
    let _left = next_server_message(&mut relay).await;

    let revoke: DeviceGrantRevokeResponse = public_post(
        address,
        "/api/public/devices/device-1/revoke",
        "relay-refresh-1",
        &DeviceGrantRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
        },
    )
    .await;
    assert!(revoke.revoked);

    let error_body = public_post_expect_status(
        address,
        "/api/public/device/ws-token",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    assert!(error_body.contains("request failed"));
}

#[tokio::test]
async fn public_bulk_revoke_keeps_selected_device() {
    let address = spawn_public_mode_app().await;

    let _keep: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "keep-me".to_string(),
        },
    )
    .await;
    let revoked: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "revoke-me".to_string(),
        },
    )
    .await;

    let response: DeviceGrantBulkRevokeResponse = public_post(
        address,
        "/api/public/devices/revoke-others",
        "relay-refresh-1",
        &DeviceGrantBulkRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            keep_device_id: "keep-me".to_string(),
        },
    )
    .await;
    assert_eq!(response.kept_device_id, "keep-me");
    assert_eq!(response.revoked_device_ids, vec!["revoke-me".to_string()]);

    let error_body = public_post_expect_status(
        address,
        "/api/public/device/ws-token",
        &revoked.device_refresh_token,
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    assert!(error_body.contains("request failed"));
}

#[tokio::test]
async fn public_client_grants_list_relays_and_track_revoke() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);

    let grant: ClientGrantResponse = public_post(
        address,
        "/api/public/clients/grants",
        "relay-refresh-1",
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-1".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Phone".to_string()),
            device_label: Some("Phone".to_string()),
        },
    )
    .await;
    assert!(grant.client_id.starts_with("client-"));

    let relays: ClientRelaysResponse =
        public_get(address, "/api/public/relays", &grant.client_refresh_token).await;
    assert_eq!(relays.client_id, grant.client_id);
    assert_eq!(relays.relays.len(), 1);
    assert_eq!(relays.relays[0].relay_id, "relay-1");
    assert_eq!(relays.relays[0].broker_room_id, "room-a");
    assert_eq!(relays.relays[0].device_id, "device-1");
    assert_eq!(relays.relays[0].device_label.as_deref(), Some("Phone"));

    let _: DeviceGrantRevokeResponse = public_post(
        address,
        "/api/public/devices/device-1/revoke",
        "relay-refresh-1",
        &DeviceGrantRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
        },
    )
    .await;

    let relays_after_revoke: ClientRelaysResponse =
        public_get(address, "/api/public/relays", &grant.client_refresh_token).await;
    assert!(relays_after_revoke.relays.is_empty());
}

#[tokio::test]
async fn public_client_session_cookie_can_list_relays() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[8_u8; 32]);

    let grant: ClientGrantResponse = public_post(
        address,
        "/api/public/clients/grants",
        "relay-refresh-1",
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-client-cookie".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Tablet".to_string()),
            device_label: Some("Tablet".to_string()),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/client/session",
        &grant.client_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("client session request should succeed");
    let cookie = set_cookie_name_value(&session_response);
    let session: ClientSessionResponse = session_response
        .json()
        .await
        .expect("client session response should decode");
    assert_eq!(session.client_id, grant.client_id);

    let response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .expect("cookie relay directory request should complete")
        .error_for_status()
        .expect("cookie relay directory request should succeed");
    let relays: ClientRelaysResponse = response
        .json()
        .await
        .expect("relay directory response should decode");
    assert_eq!(relays.client_id, grant.client_id);
    assert_eq!(relays.relays.len(), 1);
    assert_eq!(relays.relays[0].relay_id, "relay-1");
}

#[tokio::test]
async fn public_client_refresh_token_can_rotate() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);

    let grant: ClientGrantResponse = public_post(
        address,
        "/api/public/clients/grants",
        "relay-refresh-1",
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-client-rotate".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Laptop".to_string()),
            device_label: Some("Laptop".to_string()),
        },
    )
    .await;

    let rotate_response = public_post_response(
        address,
        "/api/public/client/rotate",
        &grant.client_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("client rotate request should succeed");
    let rotated: ClientIdentityRotateResponse = rotate_response
        .json()
        .await
        .expect("rotate response should decode");
    assert_eq!(rotated.client_id, grant.client_id);
    assert!(rotated.rotated);
    let new_refresh_token = rotated
        .client_refresh_token
        .expect("bearer-auth rotate should return a fresh refresh token");
    assert_ne!(new_refresh_token, grant.client_refresh_token);

    let old_error = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .bearer_auth(&grant.client_refresh_token)
        .send()
        .await
        .expect("old token request should complete");
    assert_eq!(old_error.status(), reqwest::StatusCode::UNAUTHORIZED);

    let relays: ClientRelaysResponse =
        public_get(address, "/api/public/relays", &new_refresh_token).await;
    assert_eq!(relays.client_id, grant.client_id);
    assert_eq!(relays.relays.len(), 1);
    assert_eq!(relays.relays[0].relay_id, "relay-1");
}

#[tokio::test]
async fn public_client_session_cookie_can_rotate() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[11_u8; 32]);

    let grant: ClientGrantResponse = public_post(
        address,
        "/api/public/clients/grants",
        "relay-refresh-1",
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-client-cookie-rotate".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Browser".to_string()),
            device_label: Some("Browser".to_string()),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/client/session",
        &grant.client_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("client session request should succeed");
    let original_cookie = set_cookie_name_value(&session_response);

    let rotate_response = reqwest::Client::new()
        .post(format!("http://{address}/api/public/client/rotate"))
        .header(reqwest::header::COOKIE, original_cookie.clone())
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("cookie rotate request should complete")
        .error_for_status()
        .expect("cookie rotate request should succeed");
    let rotated_cookie = set_cookie_name_value(&rotate_response);
    let rotated: ClientIdentityRotateResponse = rotate_response
        .json()
        .await
        .expect("cookie rotate response should decode");
    assert_eq!(rotated.client_id, grant.client_id);
    assert!(rotated.rotated);
    assert!(rotated.cookie_session);
    assert_eq!(rotated.client_refresh_token, None);
    assert_ne!(rotated_cookie, original_cookie);

    let old_cookie_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, original_cookie)
        .send()
        .await
        .expect("old cookie request should complete");
    assert_eq!(
        old_cookie_response.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let new_cookie_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, rotated_cookie)
        .send()
        .await
        .expect("rotated cookie request should complete")
        .error_for_status()
        .expect("rotated cookie request should succeed");
    let relays: ClientRelaysResponse = new_cookie_response
        .json()
        .await
        .expect("relay directory response should decode");
    assert_eq!(relays.client_id, grant.client_id);
    assert_eq!(relays.relays.len(), 1);
    assert_eq!(relays.relays[0].relay_id, "relay-1");
}

#[tokio::test]
async fn public_client_session_cookie_fails_after_revoke() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[10_u8; 32]);

    let grant: ClientGrantResponse = public_post(
        address,
        "/api/public/clients/grants",
        "relay-refresh-1",
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-client-revoke".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Desktop".to_string()),
            device_label: Some("Desktop".to_string()),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/client/session",
        &grant.client_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("client session request should succeed");
    let cookie = set_cookie_name_value(&session_response);

    let revoke_response = reqwest::Client::new()
        .delete(format!("http://{address}/api/public/client"))
        .header(reqwest::header::COOKIE, cookie.clone())
        .send()
        .await
        .expect("client revoke request should complete")
        .error_for_status()
        .expect("client revoke request should succeed");
    let revoke: ClientIdentityRevokeResponse = revoke_response
        .json()
        .await
        .expect("client revoke response should decode");
    assert_eq!(revoke.client_id, grant.client_id);
    assert!(revoke.revoked);
    assert_eq!(revoke.revoked_identity_count, 1);
    assert_eq!(revoke.revoked_grant_count, 1);

    let old_token_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .bearer_auth(&grant.client_refresh_token)
        .send()
        .await
        .expect("old token request should complete");
    assert_eq!(
        old_token_response.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let old_cookie_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .expect("old cookie request should complete");
    assert_eq!(
        old_cookie_response.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn public_device_ws_tokens_can_refresh_after_expiry() {
    let address = spawn_public_mode_app_with(
        test_public_control_plane_with_parts(None, Some("300"), Some("1")).await,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;

    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-expiring".to_string(),
        },
    )
    .await;

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let expired_url = format!(
        "ws://{address}/ws/room-a?role=surface&join_ticket={}",
        device_grant.device_ws_token
    );
    let (mut expired_socket, _) = connect_async(&expired_url)
        .await
        .expect("expired device surface should connect");
    let expired_error = next_server_message(&mut expired_socket).await;
    match expired_error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "join_rejected");
            assert_eq!(message, "broker join rejected");
        }
        other => panic!("unexpected expired token response: {other:?}"),
    }

    let refreshed: DeviceWsTokenResponse = public_post(
        address,
        "/api/public/device/ws-token",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await;
    let refreshed_url = format!(
        "ws://{address}/ws/room-a?role=surface&join_ticket={}",
        refreshed.device_ws_token
    );
    let (mut refreshed_socket, _) = connect_async(&refreshed_url)
        .await
        .expect("refreshed device surface should connect");
    let welcome = next_server_message(&mut refreshed_socket).await;
    match welcome {
        ServerMessage::Welcome { peer_id, .. } => assert!(peer_id.starts_with("surface-")),
        other => panic!("unexpected refreshed token response: {other:?}"),
    }
}

#[tokio::test]
async fn public_device_session_cookie_can_refresh_ws_tokens() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-cookie".to_string(),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/device/session",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("device session request should succeed");
    let cookie = set_cookie_name_value(&session_response);
    let session: DeviceSessionResponse = session_response
        .json()
        .await
        .expect("device session response should decode");
    assert_eq!(session.device_id, "device-cookie");

    let refreshed: DeviceWsTokenResponse = public_post_with_cookie(
        address,
        "/api/public/device/ws-token",
        &cookie,
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(refreshed.device_id, "device-cookie");
}

#[tokio::test]
async fn public_device_refresh_tokens_survive_control_plane_restart() {
    let state_path = temp_state_path("agent-relay-public-control");
    let first_address = spawn_public_mode_app_with(
        test_public_control_plane_with_parts(Some(state_path.clone()), Some("300"), Some("300"))
            .await,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;

    let device_grant: DeviceGrantResponse = public_post(
        first_address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-persisted".to_string(),
        },
    )
    .await;

    let restarted_address = spawn_public_mode_app_with(
        test_public_control_plane_with_parts(Some(state_path), Some("300"), Some("300")).await,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let refreshed: DeviceWsTokenResponse = public_post(
        restarted_address,
        "/api/public/device/ws-token",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await;

    assert_eq!(refreshed.device_id, "device-persisted");
    let url = format!(
        "ws://{restarted_address}/ws/room-a?role=surface&join_ticket={}",
        refreshed.device_ws_token
    );
    let (mut socket, _) = connect_async(&url)
        .await
        .expect("refreshed device surface should connect after restart");
    let welcome = next_server_message(&mut socket).await;
    match welcome {
        ServerMessage::Welcome { peer_id, .. } => assert!(peer_id.starts_with("surface-")),
        other => panic!("unexpected restart refresh response: {other:?}"),
    }
}

#[tokio::test]
async fn public_device_refresh_tokens_fail_after_revoke() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-revoked".to_string(),
        },
    )
    .await;

    let _: DeviceGrantRevokeResponse = public_post(
        address,
        "/api/public/devices/device-revoked/revoke",
        "relay-refresh-1",
        &DeviceGrantRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
        },
    )
    .await;

    let error_body = public_post_expect_status(
        address,
        "/api/public/device/ws-token",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    assert!(error_body.contains("request failed"));
}

#[tokio::test]
async fn public_device_session_cookie_fails_after_revoke() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-cookie-revoked".to_string(),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/device/session",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("device session request should succeed");
    let cookie = set_cookie_name_value(&session_response);

    let _: DeviceGrantRevokeResponse = public_post(
        address,
        "/api/public/devices/device-cookie-revoked/revoke",
        "relay-refresh-1",
        &DeviceGrantRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
        },
    )
    .await;

    let response = reqwest::Client::new()
        .post(format!("http://{address}/api/public/device/ws-token"))
        .header(reqwest::header::COOKIE, cookie)
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("cookie refresh request should complete");
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn public_api_rate_limit_is_enforced() {
    let address = spawn_public_mode_app_with(
        test_public_control_plane().await,
        BrokerHardeningConfig {
            public_api_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;

    let _: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        "relay-refresh-1",
        &RelayWsTokenRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            relay_peer_id: "relay-1".to_string(),
        },
    )
    .await;

    let error_body = public_post_expect_status(
        address,
        "/api/public/relay/ws-token",
        "relay-refresh-1",
        &RelayWsTokenRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            relay_peer_id: "relay-2".to_string(),
        },
        reqwest::StatusCode::TOO_MANY_REQUESTS,
    )
    .await;
    assert!(error_body.contains("rate limit"));
}

#[tokio::test]
async fn websocket_join_rate_limit_is_enforced() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            join_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let first_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-join-rate-1", u64::MAX),
    );
    let second_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-join-rate-2", u64::MAX),
    );

    let (mut first_socket, _) = connect_async(&first_url)
        .await
        .expect("first socket should connect");
    let _welcome = next_server_message(&mut first_socket).await;

    let (mut second_socket, _) = connect_async(&second_url)
        .await
        .expect("second socket should connect");
    let error = next_server_message(&mut second_socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "rate_limited");
            assert!(message.contains("rate limit"));
        }
        other => panic!("unexpected join rate limit response: {other:?}"),
    }
}

#[tokio::test]
async fn websocket_connection_limit_is_enforced_per_ip() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            max_connections_per_ip: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let first_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-connection-limit-1", u64::MAX),
    );
    let second_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-connection-limit-2", u64::MAX),
    );

    let (mut first_socket, _) = connect_async(&first_url)
        .await
        .expect("first socket should connect");
    let _welcome = next_server_message(&mut first_socket).await;

    let (mut second_socket, _) = connect_async(&second_url)
        .await
        .expect("second socket should connect");
    let error = next_server_message(&mut second_socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "rate_limited");
            assert!(message.contains("too many broker connections"));
        }
        other => panic!("unexpected connection limit response: {other:?}"),
    }
}

#[tokio::test]
async fn oversized_client_frames_are_rejected() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            max_text_frame_bytes: 64,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-frame-limit", u64::MAX),
    );

    let (mut socket, _) = connect_async(&url).await.expect("socket should connect");
    let _welcome = next_server_message(&mut socket).await;
    socket
        .send(Message::Text("x".repeat(65)))
        .await
        .expect("oversized frame should send");

    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "frame_too_large");
            assert!(message.contains("64"));
        }
        other => panic!("unexpected oversized frame response: {other:?}"),
    }
}

#[tokio::test]
async fn idle_connections_are_closed() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            idle_timeout: std::time::Duration::from_millis(100),
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-idle-timeout", u64::MAX),
    );

    let (mut socket, _) = connect_async(&url).await.expect("socket should connect");
    let _welcome = next_server_message(&mut socket).await;
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        next_server_message(&mut socket),
    )
    .await
    .expect("socket should receive an idle-timeout frame");
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "idle_timeout");
            assert!(message.contains("idle"));
        }
        other => panic!("unexpected idle-timeout response: {other:?}"),
    }
}
