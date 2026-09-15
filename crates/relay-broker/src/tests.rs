use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use relay_http::build_content_security_policy;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use super::*;
use crate::auth::BrokerAuthMode;
use crate::join_ticket::{JoinTicketClaims, JoinTicketKey};
use crate::public_control::{
    client_claim_message, AccessReleaseRequest, AccessReleaseResponse, ClientClaimRequest,
    ClientClaimResponse, ClientGrantRequest, ClientGrantResponse, ClientIdentityRevokeResponse,
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

async fn assert_ws_closed_after_access_released(
    label: &str,
    stream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    match next_server_message(stream).await {
        ServerMessage::Error { code, .. } => assert_eq!(code, "access_released", "{label}"),
        other => panic!("{label}: expected access_released, got {other:?}"),
    }
    match stream.next().await {
        None | Some(Ok(Message::Close(_))) | Some(Err(_)) => {}
        Some(Ok(other)) => {
            panic!("{label}: expected socket end after access_released, got {other:?}")
        }
    }
}

async fn http_get(address: SocketAddr, path: &str) -> String {
    http_get_with_headers(address, path, &[]).await
}

async fn broker_health(address: SocketAddr) -> HealthResponse {
    let response = http_get(address, "/api/health").await;
    let (_, body) = response
        .split_once("\r\n\r\n")
        .expect("response should contain body");
    serde_json::from_str(body.trim()).expect("health body should parse")
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

/// Drive a full client pairing over HTTP: the relay attests the key, then the
/// key holder redeems the attestation on its own (no bearer — the signature is
/// the authentication). Returns the credential the *client* receives; the relay
/// never sees one.
async fn public_client_pair(
    address: SocketAddr,
    relay_bearer: &str,
    signing_key: &SigningKey,
    request: &ClientGrantRequest,
) -> ClientClaimResponse {
    let relay_id = request.relay_id.clone();
    let attestation: ClientGrantResponse =
        public_post(address, "/api/public/clients/grants", relay_bearer, request).await;
    let message = client_claim_message(&attestation.claim_id, &attestation.claim_nonce, &relay_id);
    let claim_signature = STANDARD.encode(signing_key.sign(message.as_bytes()).to_bytes());

    reqwest::Client::new()
        .post(format!("http://{address}/api/public/client/claim"))
        .json(&ClientClaimRequest {
            claim_id: attestation.claim_id,
            claim_signature,
        })
        .send()
        .await
        .expect("claim request should succeed")
        .error_for_status()
        .expect("claim response should be successful")
        .json::<ClientClaimResponse>()
        .await
        .expect("claim response should decode")
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

async fn public_get_with_headers<TResp>(
    address: SocketAddr,
    path: &str,
    bearer_token: &str,
    headers: &[(&str, &str)],
) -> TResp
where
    TResp: serde::de::DeserializeOwned,
{
    let mut request = reqwest::Client::new()
        .get(format!("http://{address}{path}"))
        .bearer_auth(bearer_token);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request
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

fn set_cookie_values(response: &reqwest::Response) -> Vec<String> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(str::to_string)
        .collect()
}

async fn public_post_with_cookie_response<TReq>(
    address: SocketAddr,
    path: &str,
    cookie: &str,
    request: &TReq,
) -> reqwest::Response
where
    TReq: serde::Serialize + ?Sized,
{
    reqwest::Client::new()
        .post(format!("http://{address}{path}"))
        .header(reqwest::header::COOKIE, cookie)
        .json(request)
        .send()
        .await
        .expect("request should succeed")
}

async fn public_delete_with_cookie_response(
    address: SocketAddr,
    path: &str,
    cookie: &str,
) -> reqwest::Response {
    reqwest::Client::new()
        .delete(format!("http://{address}{path}"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .expect("request should succeed")
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
    fs::write(assets.join("remote-test.js"), "console.log('remote');").expect("asset should write");
    // A non-hashed static file served from the web root (not /static/assets/):
    // the frontend fetches this at runtime to detect new builds, so it must
    // revalidate rather than be cached immutable.
    fs::write(root.join("build-meta.json"), r#"{"build":"test"}"#)
        .expect("build meta should write");
    root
}

fn test_join_ticket_key() -> JoinTicketKey {
    JoinTicketKey::from_secret("broker-test-secret".as_bytes())
        .expect("test join-ticket key should construct")
}

async fn test_public_control_plane() -> PublicControlPlane {
    test_public_control_plane_with_parts(None, Some("300"), Some("300")).await
}

async fn test_public_control_plane_with_room(room: &str) -> PublicControlPlane {
    PublicControlPlane::from_parts(
        Some("public-broker-issuer-secret".to_string()),
        Some(
            serde_json::to_string(&vec![serde_json::json!({
                "relay_id": "relay-1",
                "broker_room_id": room,
                "refresh_token": "relay-refresh-1"
            })])
            .expect("relay registrations should encode"),
        ),
        None,
        Some("300".to_string()),
        Some("300".to_string()),
    )
    .await
    .expect("public control plane should configure")
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
async fn websocket_rejects_mismatched_origin_when_present() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-origin", u64::MAX),
    );
    let mut request = url
        .into_client_request()
        .expect("websocket request should build");
    request.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("http://evil.example"),
    );

    let error = connect_async(request)
        .await
        .expect_err("mismatched origin should fail the websocket handshake");
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
        }
        other => panic!("unexpected websocket error: {other:?}"),
    }
}

#[tokio::test]
async fn websocket_allows_same_origin_when_origin_is_present() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-origin-ok", u64::MAX),
    );
    let mut request = url
        .into_client_request()
        .expect("websocket request should build");
    request.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_str(&format!("http://{address}")).expect("origin header should build"),
    );

    let (mut socket, _) = connect_async(request)
        .await
        .expect("same-origin websocket should connect");
    let welcome = next_server_message(&mut socket).await;
    match welcome {
        ServerMessage::Welcome { peer_id, .. } => assert!(peer_id.starts_with("surface-")),
        other => panic!("unexpected welcome frame: {other:?}"),
    }
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
    // Surfaces do not name themselves — the broker assigns the id (see
    // `a_surface_cannot_squat_the_relays_peer_id`), so read it back out of Welcome.
    let surface_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
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
    let surface_peer_id = match welcome {
        ServerMessage::Welcome {
            peers,
            peer_id: assigned_peer_id,
            ..
        } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
            assert_eq!(peers[0].device_id, None);
            assigned_peer_id
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    };

    let presence = next_server_message(&mut relay).await;
    match presence {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
            assert_eq!(peer.peer_id, surface_peer_id);
            assert_eq!(peer.device_id, None);
        }
        other => panic!("unexpected presence frame: {other:?}"),
    }

    relay
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Publish {
                protocol_version: protocol::BROKER_PROTOCOL_VERSION,
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
async fn a_surface_cannot_squat_the_relays_peer_id() {
    // SECURITY: surface tickets carry no peer_id, so `lib.rs` falls back to the
    // client-supplied query parameter unchecked. A surface can therefore claim the
    // relay's own peer_id, and because a relay's ticket PINS its peer_id the
    // no-peer_id retry loop never fires for it — the relay is locked out of its own
    // room until the squatter drops the socket.
    let address = spawn_app().await;
    let squatter_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        Some("relay-1"),
        JoinTicketClaims::pairing_surface_join("room-a", "pair-squat", u64::MAX),
    );
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );

    let squatter = connect_async(&squatter_url).await;
    let Ok((mut squatter, _)) = squatter else {
        // Already hardened: a surface may not name itself after a relay.
        return;
    };
    let seated = next_server_message(&mut squatter).await;

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("the real relay should still be able to connect");
    let relay_welcome = next_server_message(&mut relay).await;

    assert!(
        matches!(relay_welcome, ServerMessage::Welcome { .. }),
        "a surface holding a pairing ticket must not be able to lock the relay out \
         of its own room; squatter got {seated:?}, relay got {relay_welcome:?}"
    );
}

#[tokio::test]
async fn a_bare_pairing_result_is_refused_while_other_directed_payloads_still_flow() {
    // SECURITY: `encrypted_pairing_result` carries the new device's payload_secret
    // and refresh tokens, sealed with the pairing_secret from the QR. It shipped
    // for a while with a `target_peer_id` field but WITHOUT the
    // `targeted_messages` wrapper, and the broker's fanout routes on the wrapper
    // alone — so it went to the whole room, handing the sealed credentials to any
    // bystander replaying the same QR join ticket. The wrapper must be the only
    // way to address one peer: a bare payload that names a recipient is refused
    // outright, so the next one that forgets it fails loudly instead of leaking.
    let address = spawn_app().await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );
    let intended_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        Some("phone-intended"),
        JoinTicketClaims::pairing_surface_join("room-a", "pair-target", u64::MAX),
    );
    // A distinct pairing id, so the two surfaces stay seated together — one ticket
    // holds only one seat (see `a_second_join_on_one_pairing_ticket_supersedes_the_first`),
    // and this test is about the fanout, not the seat.
    let bystander_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        Some("phone-bystander"),
        JoinTicketClaims::pairing_surface_join("room-a", "pair-bystander", u64::MAX),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let _ = next_server_message(&mut relay).await;
    let (mut intended, _) = connect_async(&intended_url)
        .await
        .expect("intended surface should connect");
    let _ = next_server_message(&mut intended).await;
    let (mut bystander, _) = connect_async(&bystander_url)
        .await
        .expect("bystander surface should connect");
    let _ = next_server_message(&mut bystander).await;
    // The bystander's arrival notifies everyone already seated; drain it so the
    // only frame that could still show up is the publish under test.
    let _ = next_server_message(&mut intended).await;

    relay
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Publish {
                protocol_version: protocol::BROKER_PROTOCOL_VERSION,
                payload: json!({
                    "kind": "encrypted_pairing_result",
                    "pairing_id": "pair-target",
                    "target_peer_id": "phone-intended",
                    "envelope": {"nonce": "n", "ciphertext": "c"},
                }),
            })
            .expect("client frame should serialize"),
        ))
        .await
        .expect("publish should send");

    // Every OTHER directed payload keeps its existing broadcast + client-side
    // filter behaviour. Treating `target_peer_id` itself as a routing directive
    // would silently drop every remote action response, so pin that here: this
    // frame must still be delivered.
    relay
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Publish {
                protocol_version: protocol::BROKER_PROTOCOL_VERSION,
                payload: json!({
                    "kind": "encrypted_remote_action_result",
                    "action_id": "action-1",
                    "target_peer_id": "phone-intended",
                    "device_id": "device-1",
                    "envelope": {"nonce": "n", "ciphertext": "c"},
                }),
            })
            .expect("client frame should serialize"),
        ))
        .await
        .expect("publish should send");

    match next_server_message(&mut intended).await {
        ServerMessage::Message { payload, .. } => assert_eq!(
            payload["kind"], "encrypted_remote_action_result",
            "a remote action result must still reach the room; the pairing-result \
             guard must not generalise to every payload naming a peer"
        ),
        other => panic!("remote action result should be delivered: {other:?}"),
    }
    let _ = next_server_message(&mut bystander).await;

    for (label, socket) in [
        ("the named target", &mut intended),
        ("a bystander", &mut bystander),
    ] {
        let received = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            next_server_message(socket),
        )
        .await;
        assert!(
            received.is_err(),
            "a payload naming one peer but published without the \
             `targeted_messages` wrapper must reach nobody; {label} got {received:?}"
        );
    }
}

#[tokio::test]
async fn a_second_join_on_one_pairing_ticket_supersedes_the_first() {
    // SECURITY: the pairing join_ticket is what the QR code hands out, and
    // verification is stateless HMAC + expiry — nothing stops the same ticket from
    // being replayed. Every replay used to become an independent room member, so a
    // bystander who photographed the QR could sit in the room alongside the device
    // being paired and read what the relay published. One ticket must hold exactly
    // one seat: a later join supersedes the earlier holder rather than joining it.
    //
    // Supersede (not reject) is deliberate — the remote client re-presents the
    // pairing ticket automatically after a network blip, and that reconnect has to
    // be able to reclaim its own seat.
    let address = spawn_app().await;
    let ticket = test_join_ticket_key()
        .mint(&JoinTicketClaims::pairing_surface_join(
            "room-a",
            "pair-shared",
            u64::MAX,
        ))
        .expect("pairing join ticket should mint");

    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );
    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let _ = next_server_message(&mut relay).await;

    let surface_url = format!("ws://{address}/ws/room-a?role=surface&join_ticket={ticket}");

    let (mut first, _) = connect_async(&surface_url)
        .await
        .expect("the first surface should connect");
    let first_peer_id = match next_server_message(&mut first).await {
        ServerMessage::Welcome { peer_id, .. } => peer_id,
        other => panic!("unexpected welcome frame: {other:?}"),
    };

    let (mut second, _) = connect_async(&surface_url)
        .await
        .expect("a reconnect on the same ticket should be admitted");
    match next_server_message(&mut second).await {
        ServerMessage::Welcome { peers, peer_id, .. } => {
            assert_ne!(peer_id, first_peer_id, "the seat should be a fresh peer");
            assert!(
                !peers.iter().any(|peer| peer.peer_id == first_peer_id),
                "the superseded holder must already be gone from the room; saw {peers:?}"
            );
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    }

    match next_server_message(&mut first).await {
        ServerMessage::Error { code, .. } => assert_eq!(code, "pairing_ticket_superseded"),
        other => panic!("the first holder should be told it lost its seat: {other:?}"),
    }
}

#[tokio::test]
async fn unsupported_broker_protocol_version_gets_error_frame() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-protocol-version", u64::MAX),
    );

    let (mut socket, _) = connect_async(&url).await.expect("surface should connect");
    let _welcome = next_server_message(&mut socket).await;
    socket
        .send(Message::Text(
            json!({
                "type": "publish",
                "protocol_version": protocol::BROKER_PROTOCOL_VERSION + 1,
                "payload": {}
            })
            .to_string(),
        ))
        .await
        .expect("publish should send");

    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "unsupported_protocol_version");
            assert!(message.contains("unsupported broker protocol_version"));
        }
        other => panic!("unexpected protocol version response: {other:?}"),
    }
}

#[tokio::test]
async fn missing_broker_protocol_version_gets_error_frame() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-missing-version", u64::MAX),
    );

    let (mut socket, _) = connect_async(&url).await.expect("surface should connect");
    let _welcome = next_server_message(&mut socket).await;
    socket
        .send(Message::Text(
            json!({
                "type": "publish",
                "payload": {}
            })
            .to_string(),
        ))
        .await
        .expect("publish should send");

    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "invalid_client_frame");
            assert!(message.contains("protocol_version"));
        }
        other => panic!("unexpected missing protocol version response: {other:?}"),
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
async fn surfaces_asking_for_the_same_peer_id_get_distinct_assigned_ids() {
    // This used to assert the second surface was rejected for reusing `dup-1`.
    // Surfaces no longer name themselves at all — honoring the query parameter let
    // one squat the relay's id and lock it out of its own room — so a requested id
    // is ignored and the broker hands out a fresh one instead. Two surfaces asking
    // for the same id must therefore both be seated, under different ids.
    let address = spawn_app().await;
    // Distinct pairing ids on purpose: one ticket seats only one peer, so sharing a
    // ticket here would evict the first connection and the test would prove nothing
    // about two surfaces coexisting.
    let url = |pairing_id: &str| {
        websocket_url(
            address,
            "room-a",
            protocol::PeerRole::Surface,
            Some("dup-1"),
            JoinTicketClaims::pairing_surface_join("room-a", pairing_id, u64::MAX),
        )
    };

    let (mut first, _) = connect_async(url("pair-3a"))
        .await
        .expect("first peer should connect");
    let (mut second, _) = connect_async(url("pair-3b"))
        .await
        .expect("second should connect");

    let assigned = |message: ServerMessage| match message {
        ServerMessage::Welcome { peer_id, peers, .. } => (peer_id, peers),
        other => panic!("unexpected welcome frame: {other:?}"),
    };
    let (first_peer_id, _) = assigned(next_server_message(&mut first).await);
    let (second_peer_id, second_sees) = assigned(next_server_message(&mut second).await);

    assert_ne!(
        first_peer_id, second_peer_id,
        "each surface must get its own broker-assigned peer id"
    );
    // Both are genuinely seated at once — the second peer's Welcome lists the first,
    // which is what makes this a statement about coexistence and not about eviction.
    assert!(
        second_sees.iter().any(|peer| peer.peer_id == first_peer_id),
        "the second surface should see the first still seated; saw {second_sees:?}"
    );
    for peer_id in [&first_peer_id, &second_peer_id] {
        assert_ne!(
            peer_id, "dup-1",
            "a client-requested surface peer id must be ignored"
        );
    }
}

#[tokio::test]
async fn duplicate_relay_connection_replaces_stale_socket() {
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

    let (mut stale_relay, _) = connect_async(&relay_url)
        .await
        .expect("stale relay should connect");
    let _welcome = next_server_message(&mut stale_relay).await;

    let (mut replacement_relay, _) = connect_async(&relay_url)
        .await
        .expect("replacement relay websocket should connect");
    match next_server_message(&mut replacement_relay).await {
        ServerMessage::Welcome { peer_id, peers, .. } => {
            assert_eq!(peer_id, "relay-1");
            assert!(peers.is_empty());
        }
        other => panic!("replacement relay should receive welcome, got: {other:?}"),
    }

    let stale_event = tokio::time::timeout(Duration::from_secs(1), stale_relay.next())
        .await
        .expect("stale relay socket should be closed after replacement");
    match stale_event {
        None => {}
        Some(Ok(Message::Close(_))) => {}
        Some(Err(_)) => {}
        Some(other) => panic!("stale relay should close, got: {other:?}"),
    }

    let (mut surface, _) = connect_async(&surface_url)
        .await
        .expect("surface should connect after relay replacement");
    match next_server_message(&mut surface).await {
        ServerMessage::Welcome { peers, .. } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
            assert_eq!(peers[0].role, protocol::PeerRole::Relay);
        }
        other => panic!("surface should see replacement relay, got: {other:?}"),
    }

    let _presence = next_server_message(&mut replacement_relay).await;
    replacement_relay
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Publish {
                protocol_version: protocol::BROKER_PROTOCOL_VERSION,
                payload: json!({"kind":"session_snapshot"}),
            })
            .expect("client frame should serialize"),
        ))
        .await
        .expect("replacement relay publish should send");
    match next_server_message(&mut surface).await {
        ServerMessage::Message {
            from_peer_id,
            payload,
            ..
        } => {
            assert_eq!(from_peer_id, "relay-1");
            assert_eq!(payload, json!({"kind":"session_snapshot"}));
        }
        other => panic!("surface should receive replacement relay publish, got: {other:?}"),
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
    let welcome = next_server_message(&mut first_surface).await;
    let first_peer_id = match welcome {
        ServerMessage::Welcome { peer_id, peers, .. } => {
            assert!(peer_id.starts_with("surface-"));
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
            assert_eq!(peers[0].device_id, None);
            peer_id
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    };
    let joined = next_server_message(&mut relay).await;
    match joined {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
            assert_eq!(peer.peer_id, first_peer_id);
            assert_eq!(peer.device_id.as_deref(), Some("device-1"));
        }
        other => panic!("unexpected presence frame: {other:?}"),
    }
    first_surface
        .close(None)
        .await
        .expect("surface should close");
    let left = next_server_message(&mut relay).await;
    match left {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Left);
            assert_eq!(peer.peer_id, first_peer_id);
            assert_eq!(peer.device_id.as_deref(), Some("device-1"));
        }
        other => panic!("unexpected presence frame: {other:?}"),
    }

    let (mut second_surface, _) = connect_async(&surface_url)
        .await
        .expect("second surface should connect");
    let welcome = next_server_message(&mut second_surface).await;
    match welcome {
        ServerMessage::Welcome { peer_id, peers, .. } => {
            assert!(peer_id.starts_with("surface-"));
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
            assert_eq!(peers[0].device_id, None);
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    }
    let joined = next_server_message(&mut relay).await;
    match joined {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
            assert_eq!(peer.device_id.as_deref(), Some("device-1"));
        }
        other => panic!("unexpected presence frame: {other:?}"),
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
    let parsed = broker_health(address).await;
    assert_eq!(parsed.status, "ok");
    assert_eq!(parsed.broker_auth_mode, "public");
    assert!(parsed.join_auth_ready);
    assert!(parsed
        .message
        .as_deref()
        .is_some_and(|message| message.contains("RELAY_BROKER_PUBLIC_STATE_PATH")));
    assert!(parsed
        .message
        .as_deref()
        .is_some_and(|message| message.contains("RELAY_BROKER_PUBLIC_POSTGRES_URL")));
    assert_eq!(
        parsed.public_monitoring,
        Some(PublicBrokerMonitoring::default())
    );
}

#[tokio::test]
async fn public_control_plane_rejects_multiple_persistence_backends() {
    let result = PublicControlPlane::from_parts_with_postgres(
        Some("public-broker-issuer-secret".to_string()),
        None,
        Some(temp_state_path("public-control-conflict")),
        Some("postgres://localhost/agent_relay".to_string()),
        Some("300".to_string()),
        Some("300".to_string()),
    )
    .await;

    let error = match result {
        Ok(_) => panic!("multiple persistence backends should be rejected"),
        Err(error) => error,
    };
    assert!(error.contains("RELAY_BROKER_PUBLIC_STATE_PATH"));
    assert!(error.contains("RELAY_BROKER_PUBLIC_POSTGRES_URL"));
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

// Regression test for the "broker feels like it's still serving the old UI"
// bug: without an explicit Cache-Control, browsers heuristically cache the
// HTML shell (and sw.js), pinning them to stale content-hashed asset
// filenames after a redeploy — a fresh/incognito profile (no cached entry)
// always looked fine, masking the bug. relay-server already carries this
// fix (see `cache_control_for` there); the broker never got it even though
// it serves the actual remote/PWA surface users hit.
#[tokio::test]
async fn cache_control_headers_are_set_across_the_broker_surface() {
    let address = spawn_app().await;

    let root = http_get(address, "/").await.to_ascii_lowercase();
    assert!(
        root.contains("cache-control: no-cache"),
        "expected the HTML shell to always revalidate, got: {root}"
    );

    let sw = http_get(address, "/sw.js").await.to_ascii_lowercase();
    assert!(
        sw.contains("cache-control: no-cache"),
        "expected sw.js to always revalidate, got: {sw}"
    );

    let asset = http_get(address, "/static/assets/remote-test.js")
        .await
        .to_ascii_lowercase();
    assert!(
        asset.contains("cache-control: public, max-age=31536000, immutable"),
        "expected a content-hashed asset to be cached forever, got: {asset}"
    );

    // A non-hashed static file (served from the web root, not /static/assets/)
    // must revalidate too, so a redeploy is picked up.
    let build_meta = http_get(address, "/static/build-meta.json")
        .await
        .to_ascii_lowercase();
    assert!(
        build_meta.contains("cache-control: no-cache"),
        "expected a non-hashed static file to always revalidate, got: {build_meta}"
    );

    // A missing hashed asset (404) must be no-store — not stamped immutable, and
    // not left bare (a bare 404 can be heuristically negative-cached).
    let missing = http_get(address, "/static/assets/does-not-exist-deadbeef.js")
        .await
        .to_ascii_lowercase();
    assert!(
        missing.contains("404"),
        "expected a missing asset to 404, got: {missing}"
    );
    assert!(
        missing.contains("cache-control: no-store"),
        "expected a 404 asset to be no-store, got: {missing}"
    );

    // API responses are client-specific / cookie-authenticated — never cache.
    let health = http_get(address, "/api/health").await.to_ascii_lowercase();
    assert!(
        health.contains("cache-control: no-store"),
        "expected /api/* to be no-store, got: {health}"
    );
}

// A conditional request for a static asset comes back 304 Not Modified. Per
// RFC 9110 §15.4.5 the 304 must carry the same Cache-Control the 200 would,
// otherwise a revalidating cache can lose the policy. tower-http's
// ServeDir/ServeFile emit 304s without any Cache-Control, so the middleware has
// to supply it.
#[tokio::test]
async fn conditional_static_request_304_keeps_cache_policy() {
    let address = spawn_app().await;

    // Learn the validator from the first (200) fetch.
    let first = http_get(address, "/static/assets/remote-test.js").await;
    assert!(
        first.starts_with("HTTP/1.1 200"),
        "expected first asset fetch to be 200, got: {first}"
    );
    let last_modified =
        raw_header_value(&first, "last-modified").expect("asset 200 should carry Last-Modified");

    // Revalidate → 304, which must still be immutable.
    let revalidated = http_get_with_headers(
        address,
        "/static/assets/remote-test.js",
        &[("If-Modified-Since", &last_modified)],
    )
    .await;
    assert!(
        revalidated.starts_with("HTTP/1.1 304"),
        "expected a conditional asset request to 304, got: {revalidated}"
    );
    assert!(
        revalidated
            .to_ascii_lowercase()
            .contains("cache-control: public, max-age=31536000, immutable"),
        "expected the 304 to keep the immutable policy, got: {revalidated}"
    );
}

/// Extract a single header value (case-insensitive name) from a raw HTTP/1.1
/// response string, returning the trimmed value with its original casing.
fn raw_header_value(raw_response: &str, name: &str) -> Option<String> {
    raw_response
        .split("\r\n")
        .take_while(|line| !line.is_empty())
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
}

// Pins the security-critical asymmetry in `with_cache_headers`: for `/api/*` it
// FORCES `no-store` over whatever the handler set (so a handler can never leave
// private data cacheable, even by mistake), while for the static surface it
// PRESERVES a handler's own `Cache-Control`. Without this, a future refactor
// collapsing the two branches into a uniform "don't overwrite" would silently
// reopen the private-API caching hole with every existing test still green.
#[tokio::test]
async fn with_cache_headers_forces_no_store_over_a_handler_set_api_policy() {
    async fn cacheable_api() -> impl IntoResponse {
        // A misbehaving API handler trying to make a private response cacheable.
        ([(header::CACHE_CONTROL, "public, max-age=999")], "secret")
    }
    async fn opinionated_static() -> impl IntoResponse {
        ([(header::CACHE_CONTROL, "public, max-age=42")], "asset")
    }

    let app = Router::new()
        .route("/api/misconfigured", get(cacheable_api))
        .route("/static/opinionated", get(opinionated_static))
        .layer(middleware::from_fn(with_cache_headers));

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service())
            .await
            .expect("test router should serve");
    });

    // API: the handler's `public` policy is overridden with the forced no-store.
    let api = http_get(address, "/api/misconfigured")
        .await
        .to_ascii_lowercase();
    assert!(
        api.contains("cache-control: no-store"),
        "expected /api/* to be forced to no-store, got: {api}"
    );
    assert!(
        !api.contains("max-age=999"),
        "expected the handler's cacheable policy to be dropped, got: {api}"
    );

    // Static: the middleware leaves a handler's explicit policy intact.
    let stat = http_get(address, "/static/opinionated")
        .await
        .to_ascii_lowercase();
    assert!(
        stat.contains("cache-control: public, max-age=42"),
        "expected a static handler's own policy to be preserved, got: {stat}"
    );
}

#[test]
fn cache_control_policy_for_static_surface() {
    // Hashed bundles are immutable on success...
    assert_eq!(
        cache_control_for("/static/assets/remote-deadbeef.js", StatusCode::OK),
        Some("public, max-age=31536000, immutable")
    );
    // ...and a 304 Not Modified on revalidation must carry the SAME policy the
    // 200 would (RFC 9110 §15.4.5), so a conditional request doesn't drop it.
    assert_eq!(
        cache_control_for(
            "/static/assets/remote-deadbeef.js",
            StatusCode::NOT_MODIFIED
        ),
        Some("public, max-age=31536000, immutable")
    );
    // A missing hashed asset must NOT be cached at all — not immutable (a
    // year-long positive-then-negative cache) and not heuristically (RFC 9110
    // §15.5.5 lets a 404 be heuristically cached). `no-store` forbids both.
    assert_eq!(
        cache_control_for("/static/assets/remote-deadbeef.js", StatusCode::NOT_FOUND),
        Some("no-store")
    );
    // The HTML shell, sw.js, and other non-hashed static files revalidate —
    // on both the 200 and its 304.
    assert_eq!(cache_control_for("/", StatusCode::OK), Some("no-cache"));
    assert_eq!(
        cache_control_for("/", StatusCode::NOT_MODIFIED),
        Some("no-cache")
    );
    assert_eq!(
        cache_control_for("/sw.js", StatusCode::OK),
        Some("no-cache")
    );
    // Any other non-success static response is no-store, never left unset.
    assert_eq!(
        cache_control_for("/missing", StatusCode::NOT_FOUND),
        Some("no-store")
    );
    // Every API response is no-store — client-specific and often
    // cookie-authenticated, so it must never be cached by a browser or a shared
    // intermediary. This holds even for error statuses.
    assert_eq!(
        cache_control_for("/api/health", StatusCode::OK),
        Some("no-store")
    );
    assert_eq!(
        cache_control_for("/api/public/relays", StatusCode::OK),
        Some("no-store")
    );
    assert_eq!(
        cache_control_for("/api/public/relays", StatusCode::UNAUTHORIZED),
        Some("no-store")
    );
}

#[tokio::test]
async fn strict_transport_security_is_only_sent_for_secure_requests_when_enabled() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::from_parts(
            true,
            None,
            Some("max-age=86400".to_string()),
            CSP_CONNECT_SRC_ENV,
            HSTS_VALUE_ENV,
        )
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
        SecurityHeadersConfig::from_parts(
            false,
            Some(connect_src.to_string()),
            None,
            CSP_CONNECT_SRC_ENV,
            HSTS_VALUE_ENV,
        )
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
        SecurityHeadersConfig::from_parts(
            true,
            None,
            Some("max-age=86400".to_string()),
            CSP_CONNECT_SRC_ENV,
            HSTS_VALUE_ENV,
        )
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
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
    .expect_err("invalid broker CSP override should fail");
    assert!(csp_error.contains(CSP_CONNECT_SRC_ENV));

    let hsts_error = SecurityHeadersConfig::from_parts(
        true,
        None,
        Some("max-age=86400\r\nx".to_string()),
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
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
            enrollment_token: None,
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

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
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

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
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

// Regression test: the cookie-authenticated relay directory is client-specific
// private data. If the origin sends no `Cache-Control`, a browser or shared
// intermediary is free to store and reuse it, risking stale data or
// cross-client disclosure. Every `/api/*` response must be `no-store` so
// authenticated JSON is never cached.
#[tokio::test]
async fn cookie_authenticated_relay_directory_is_no_store() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[24_u8; 32]);

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-no-store".to_string(),
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

    let response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .expect("cookie relay directory request should complete")
        .error_for_status()
        .expect("cookie relay directory request should succeed");

    let cache_control = response
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .map(str::to_ascii_lowercase);
    assert_eq!(
        cache_control.as_deref(),
        Some("no-store"),
        "cookie-authenticated relay directory must not be cacheable"
    );
}

#[tokio::test]
async fn public_client_refresh_token_can_rotate() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
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

    // The rotated-away token stays valid within the rotation grace window, so a
    // client that never received the fresh credential is not locked out (explicit
    // revocation still cuts access immediately — covered by the revoke tests).
    let old_token_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .bearer_auth(&grant.client_refresh_token)
        .send()
        .await
        .expect("old token request should complete");
    assert_eq!(old_token_response.status(), reqwest::StatusCode::OK);

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

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
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

    // The pre-rotation cookie stays valid within the rotation grace window (a
    // browser that missed the Set-Cookie must not be locked out); revocation
    // tests cover the immediate-cutoff path.
    let old_cookie_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, original_cookie)
        .send()
        .await
        .expect("old cookie request should complete");
    assert_eq!(old_cookie_response.status(), reqwest::StatusCode::OK);

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

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
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
async fn public_device_session_scoped_round_trips_per_room_cookie() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-scoped".to_string(),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/device/room-a/session",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("scoped device session request should succeed");
    let cookie = set_cookie_name_value(&session_response);
    assert!(
        cookie.starts_with(&format!("{}=", device_session_cookie_name("room-a"))),
        "expected a per-room cookie name, got {cookie}"
    );

    let refreshed: DeviceWsTokenResponse = public_post_with_cookie(
        address,
        "/api/public/device/room-a/ws-token",
        &cookie,
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(refreshed.device_id, "device-scoped");
}

#[tokio::test]
async fn public_device_session_scoped_round_trips_static_room_with_slash() {
    let address = spawn_public_mode_app_with(
        test_public_control_plane_with_room("team/prod").await,
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
            broker_room_id: "team/prod".to_string(),
            device_id: "device-static-slash".to_string(),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/device/team%2Fprod/session",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("scoped device session request should succeed");
    let cookie = set_cookie_name_value(&session_response);
    let expected_cookie_name = device_session_cookie_name("team/prod");
    assert!(
        cookie.starts_with(&format!("{expected_cookie_name}=")),
        "static rooms must get their own hashed scoped cookie name, got {cookie}"
    );
    assert!(
        !cookie.starts_with("agent_relay_device_session="),
        "static room must not degrade to the shared legacy cookie, got {cookie}"
    );

    let refreshed: DeviceWsTokenResponse = public_post_with_cookie(
        address,
        "/api/public/device/team%2Fprod/ws-token",
        &cookie,
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(refreshed.device_id, "device-static-slash");
    assert_eq!(refreshed.broker_room_id, "team/prod");
}

#[tokio::test]
async fn public_device_ws_token_scoped_rejects_room_mismatch() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-mismatch".to_string(),
        },
    )
    .await;

    // A room-a token presented (as a bearer) to room-b's endpoint must be rejected,
    // and the error must not reveal the real room.
    let body = public_post_expect_status(
        address,
        "/api/public/device/room-b/ws-token",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    assert!(
        !body.contains("room-a"),
        "error must not leak the real room"
    );
}

#[tokio::test]
async fn public_device_ws_token_scoped_upgrades_legacy_cookie_on_match_only() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-legacy".to_string(),
        },
    )
    .await;

    // A not-yet-migrated device: the legacy origin-wide cookie carrying room-a's
    // token, presented to the new room-a route → upgrade on use.
    let legacy = format!(
        "agent_relay_device_session={}",
        device_grant.device_refresh_token
    );
    let response = public_post_with_cookie_response(
        address,
        "/api/public/device/room-a/ws-token",
        &legacy,
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let set_cookies = set_cookie_values(&response);
    assert!(
        set_cookies.iter().any(|c| c
            .starts_with(&format!("{}=", device_session_cookie_name("room-a")))
            && !c.contains("Max-Age=0")),
        "upgrade must set the per-room cookie: {set_cookies:?}"
    );
    assert!(
        set_cookies
            .iter()
            .any(|c| c.starts_with("agent_relay_device_session=") && c.contains("Max-Age=0")),
        "upgrade must clear the legacy cookie: {set_cookies:?}"
    );

    // The SAME legacy cookie presented to a DIFFERENT room must 401 and must NOT
    // clear the legacy cookie — a sibling relay may still need it to migrate.
    let response_b = public_post_with_cookie_response(
        address,
        "/api/public/device/room-b/ws-token",
        &legacy,
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(response_b.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(
        set_cookie_values(&response_b).is_empty(),
        "room mismatch must not emit any Set-Cookie"
    );
}

#[tokio::test]
async fn public_device_session_scoped_delete_clears_matching_legacy_cookie_only() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-legacy-forget".to_string(),
        },
    )
    .await;

    let legacy = format!(
        "agent_relay_device_session={}",
        device_grant.device_refresh_token
    );
    let response =
        public_delete_with_cookie_response(address, "/api/public/device/room-a/session", &legacy)
            .await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let set_cookies = set_cookie_values(&response);
    assert!(
        set_cookies.iter().any(|c| c
            .starts_with(&format!("{}=", device_session_cookie_name("room-a")))
            && c.contains("Max-Age=0")),
        "forget must clear the room-a per-room cookie: {set_cookies:?}"
    );
    assert!(
        set_cookies
            .iter()
            .any(|c| c.starts_with("agent_relay_device_session=") && c.contains("Max-Age=0")),
        "forget must clear the legacy cookie when it belongs to room-a: {set_cookies:?}"
    );

    let mismatch =
        public_delete_with_cookie_response(address, "/api/public/device/room-b/session", &legacy)
            .await;
    assert_eq!(mismatch.status(), reqwest::StatusCode::OK);
    let mismatch_cookies = set_cookie_values(&mismatch);
    assert!(
        mismatch_cookies.iter().any(|c| c
            .starts_with(&format!("{}=", device_session_cookie_name("room-b")))
            && c.contains("Max-Age=0")),
        "forget must clear the requested room-b per-room cookie: {mismatch_cookies:?}"
    );
    assert!(
        !mismatch_cookies
            .iter()
            .any(|c| c.starts_with("agent_relay_device_session=") && c.contains("Max-Age=0")),
        "wrong-room forget must not clear a sibling's legacy cookie: {mismatch_cookies:?}"
    );
}

#[tokio::test]
async fn public_device_ws_token_scoped_prefers_bearer_over_stale_room_cookie() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-bearer".to_string(),
        },
    )
    .await;

    // The frontend falls back to Authorization bearer if cookie establishment
    // fails, but browsers may still attach a stale per-room cookie. The bearer
    // must win or the fallback is masked by the stale cookie and returns 401.
    let response = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/device/room-a/ws-token"
        ))
        .header(
            reqwest::header::COOKIE,
            format!(
                "{}=stale-refresh-token",
                device_session_cookie_name("room-a")
            ),
        )
        .bearer_auth(&device_grant.device_refresh_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("request should succeed")
        .error_for_status()
        .expect("bearer should authenticate despite a stale per-room cookie");
    let refreshed: DeviceWsTokenResponse = response.json().await.expect("response should decode");
    assert_eq!(refreshed.device_id, "device-bearer");
}

#[tokio::test]
async fn public_device_scoped_accepts_non_prefixed_static_room() {
    // Static registrations allow arbitrary non-empty room ids. validate_room_id
    // must accept URL-sensitive but non-control ids and proceed to token
    // resolution (401 for a bogus token) instead of rejecting the room as invalid
    // (400).
    let address = spawn_public_mode_app().await;
    public_post_expect_status(
        address,
        "/api/public/device/team.prod/ws-token",
        "bogus-token",
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    public_post_expect_status(
        address,
        "/api/public/device/team%2Fprod/ws-token",
        "bogus-token",
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    public_post_expect_status(
        address,
        "/api/public/device/room-%3Bevil/ws-token",
        "bogus-token",
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
}

#[tokio::test]
async fn public_device_scoped_rejects_invalid_room() {
    let address = spawn_public_mode_app().await;
    // Control characters are not valid static broker_room_id values in a URL
    // path, and are rejected before they can reach cookie/header handling.
    public_post_expect_status(
        address,
        "/api/public/device/room-%0Aevil/ws-token",
        "any-token",
        &serde_json::json!({}),
        reqwest::StatusCode::BAD_REQUEST,
    )
    .await;
    let long_room = "a".repeat(DEVICE_SESSION_ROOM_MAX_BYTES + 1);
    let long_path = format!("/api/public/device/{long_room}/ws-token");
    public_post_expect_status(
        address,
        &long_path,
        "any-token",
        &serde_json::json!({}),
        reqwest::StatusCode::BAD_REQUEST,
    )
    .await;
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

    let health = broker_health(address).await;
    let monitoring = health
        .public_monitoring
        .expect("public health should expose monitoring");
    assert_eq!(monitoring.device_ws_token_refresh_failures, 1);
    assert_eq!(monitoring.invalid_refresh_token_uses, 1);
    assert_eq!(monitoring.repeated_invalid_refresh_token_uses, 0);
}

#[tokio::test]
async fn repeated_invalid_device_refresh_token_use_is_tracked() {
    let address = spawn_public_mode_app().await;
    let revoked: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-reused-invalid-token".to_string(),
        },
    )
    .await;

    let _: DeviceGrantRevokeResponse = public_post(
        address,
        "/api/public/devices/device-reused-invalid-token/revoke",
        "relay-refresh-1",
        &DeviceGrantRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
        },
    )
    .await;

    for _ in 0..2 {
        let response = reqwest::Client::new()
            .post(format!("http://{address}/api/public/device/ws-token"))
            .bearer_auth(&revoked.device_refresh_token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect("invalid refresh request should complete");
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    }

    let health = broker_health(address).await;
    let monitoring = health
        .public_monitoring
        .expect("public health should expose monitoring");
    assert_eq!(monitoring.device_ws_token_refresh_failures, 2);
    assert_eq!(monitoring.invalid_refresh_token_uses, 2);
    assert_eq!(monitoring.repeated_invalid_refresh_token_uses, 1);
}

#[tokio::test]
async fn client_environment_mutations_are_tracked() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[12_u8; 32]);

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-env-mutation".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Env Watcher".to_string()),
            device_label: Some("Env Watcher".to_string()),
        },
    )
    .await;

    let _: ClientRelaysResponse = public_get_with_headers(
        address,
        "/api/public/relays",
        &grant.client_refresh_token,
        &[("User-Agent", "EnvProbe/1.0")],
    )
    .await;
    let _: ClientRelaysResponse = public_get_with_headers(
        address,
        "/api/public/relays",
        &grant.client_refresh_token,
        &[("User-Agent", "EnvProbe/2.0")],
    )
    .await;

    let health = broker_health(address).await;
    let monitoring = health
        .public_monitoring
        .expect("public health should expose monitoring");
    assert_eq!(monitoring.environment_mutation_events, 1);
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
async fn websocket_publish_rate_limit_rejects_messages_without_closing_socket() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            // This peer joins as a relay, so it is the relay budget that has to be
            // squeezed to provoke the limit — surfaces and relays have separate
            // allowances (see `DEFAULT_RELAY_PUBLISH_RATE_LIMIT_PER_MINUTE`).
            publish_rate_limit_per_minute: 1,
            relay_publish_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay socket should connect");
    let _welcome = next_server_message(&mut relay).await;

    let publish_frame = serde_json::to_string(&ClientMessage::Publish {
        protocol_version: protocol::BROKER_PROTOCOL_VERSION,
        payload: json!({"ciphertext":"abc"}),
    })
    .expect("client frame should serialize");

    relay
        .send(Message::Text(publish_frame.clone()))
        .await
        .expect("first publish should send");
    relay
        .send(Message::Text(publish_frame.clone()))
        .await
        .expect("second publish should send");

    let error = next_server_message(&mut relay).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "rate_limited");
            assert!(message.contains("rate limit"));
        }
        other => panic!("unexpected publish rate limit response: {other:?}"),
    }

    relay
        .send(Message::Text(publish_frame))
        .await
        .expect("third publish should still send on same socket");
    let second_error = next_server_message(&mut relay).await;
    match second_error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "rate_limited");
            assert!(message.contains("rate limit"));
        }
        other => panic!("unexpected repeated publish rate limit response: {other:?}"),
    }
}

/// Oversized frames are still refused — at the floor, which is now the smallest cap a
/// deployment can actually have.
///
/// This used to configure a 64-BYTE cap. `MIN_MAX_TEXT_FRAME_BYTES` makes that
/// unreachable: a cap below what relay-server is compiled to emit rejects frames it cannot
/// shrink, so the floor raises it. The rejection itself is unchanged — it just takes a
/// genuinely oversized frame to trigger.
#[tokio::test]
async fn oversized_client_frames_are_rejected() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            // Below the floor on purpose: the effective cap is MIN_MAX_TEXT_FRAME_BYTES.
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
        .send(Message::Text("x".repeat(MIN_MAX_TEXT_FRAME_BYTES + 1)))
        .await
        .expect("oversized frame should send");

    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "frame_too_large");
            assert!(
                message.contains(&MIN_MAX_TEXT_FRAME_BYTES.to_string()),
                "the message must quote the EFFECTIVE cap, not the configured one, or an \
                 operator debugging this chases a number the broker is not using: {message}"
            );
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

#[test]
fn summarize_published_payload_reports_transcript_page_stats() {
    let summary = summarize_published_payload(&json!({
        "kind": "remote_action_result",
        "action": "fetch_thread_transcript",
        "ok": true,
        "thread_transcript": {
            "thread_id": "thread-1",
            "entries": [
                {
                    "entry_index": 0,
                    "parts": [
                        {"part_index": 0, "text": "a"},
                        {"part_index": 1, "text": "b"}
                    ]
                },
                {
                    "entry_index": 1,
                    "parts": [
                        {"part_index": 0, "text": "c"}
                    ]
                }
            ],
            "next_cursor": 12,
            "prev_cursor": 4
        }
    }));

    assert!(summary.contains("kind=remote_action_result"));
    assert!(summary.contains("action=fetch_thread_transcript"));
    assert!(summary.contains("ok=true"));
    assert!(summary.contains("entries=2"));
    assert!(summary.contains("parts=3"));
    assert!(summary.contains("next_cursor=12"));
    assert!(summary.contains("prev_cursor=4"));
}

async fn spawn_app_with_guard(guard: BanGuard) -> SocketAddr {
    spawn_app_with_guard_and_hardening(guard, BrokerHardeningConfig::default()).await
}

async fn spawn_app_with_guard_and_hardening(
    guard: BanGuard,
    hardening: BrokerHardeningConfig,
) -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let app = app_with_web_root_and_verifier_and_hardening(
        BrokerState::default(),
        test_web_root(),
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        hardening,
        SecurityHeadersConfig::default(),
    )
    .layer(middleware::from_fn_with_state(guard, reject_banned_ips));
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

#[tokio::test]
async fn banned_socket_ip_gets_403_on_health() {
    let guard = BanGuard {
        blocklist: Blocklist::from_entries(&["127.0.0.1"]),
        trusted_ip_header: None,
    };
    let address = spawn_app_with_guard(guard).await;
    let response = reqwest::get(format!("http://{address}/api/health"))
        .await
        .expect("request should complete");
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn unbanned_socket_ip_reaches_health() {
    let guard = BanGuard {
        blocklist: Blocklist::from_entries(&["9.9.9.9"]),
        trusted_ip_header: None,
    };
    let address = spawn_app_with_guard(guard).await;
    let response = reqwest::get(format!("http://{address}/api/health"))
        .await
        .expect("request should complete");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn banned_ip_rejects_websocket_upgrade() {
    let guard = BanGuard {
        blocklist: Blocklist::from_entries(&["127.0.0.1"]),
        trusted_ip_header: None,
    };
    let address = spawn_app_with_guard(guard).await;
    let result = connect_async(format!("ws://{address}/ws/room-a?role=relay")).await;
    assert!(
        result.is_err(),
        "banned ip must not be able to upgrade the websocket"
    );
}

#[tokio::test]
async fn banned_client_via_trusted_forwarded_header_gets_403() {
    let guard = BanGuard {
        blocklist: Blocklist::from_entries(&["203.0.113.9"]),
        trusted_ip_header: Some("x-forwarded-for".parse().expect("valid header name")),
    };
    let address = spawn_app_with_guard(guard).await;
    let client = reqwest::Client::new();

    // The banned client IP arrives via the trusted forwarded header -> 403,
    // even though the socket IP (127.0.0.1) is not itself banned.
    let banned = client
        .get(format!("http://{address}/api/health"))
        .header("x-forwarded-for", "203.0.113.9")
        .send()
        .await
        .expect("request should complete");
    assert_eq!(banned.status(), reqwest::StatusCode::FORBIDDEN);

    // No forwarded header -> falls back to the socket IP (127.0.0.1), not banned.
    let allowed = client
        .get(format!("http://{address}/api/health"))
        .send()
        .await
        .expect("request should complete");
    assert_eq!(allowed.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn duplicate_forwarded_headers_use_the_proxy_appended_value() {
    let real = "203.0.113.9"; // appended by the trusted proxy (last field)
    let spoof = "9.9.9.9"; // client-supplied earlier field

    let mut headers = reqwest::header::HeaderMap::new();
    headers.append("x-forwarded-for", spoof.parse().unwrap());
    headers.append("x-forwarded-for", real.parse().unwrap());

    // Banning the real (last) IP -> 403 despite the spoofed first field.
    let address = spawn_app_with_guard(BanGuard {
        blocklist: Blocklist::from_entries(&[real]),
        trusted_ip_header: Some("x-forwarded-for".parse().unwrap()),
    })
    .await;
    let banned = reqwest::Client::new()
        .get(format!("http://{address}/api/health"))
        .headers(headers.clone())
        .send()
        .await
        .expect("request should complete");
    assert_eq!(banned.status(), reqwest::StatusCode::FORBIDDEN);

    // Banning only the spoofed (first) IP -> not blocked; we key on the last value.
    let address2 = spawn_app_with_guard(BanGuard {
        blocklist: Blocklist::from_entries(&[spoof]),
        trusted_ip_header: Some("x-forwarded-for".parse().unwrap()),
    })
    .await;
    let allowed = reqwest::Client::new()
        .get(format!("http://{address2}/api/health"))
        .headers(headers)
        .send()
        .await
        .expect("request should complete");
    assert_eq!(allowed.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn per_ip_rate_limit_keys_on_forwarded_client_ip() {
    let guard = BanGuard {
        blocklist: Blocklist::disabled(),
        trusted_ip_header: Some("x-forwarded-for".parse().unwrap()),
    };
    let address = spawn_app_with_guard_and_hardening(
        guard,
        BrokerHardeningConfig {
            public_api_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
    )
    .await;

    let client = reqwest::Client::new();
    let url = format!("http://{address}/api/public/relay/ws-token");
    let body = RelayWsTokenRequest {
        relay_id: "relay-1".to_string(),
        broker_room_id: "room-a".to_string(),
        relay_peer_id: "relay-1".to_string(),
    };

    // Same forwarded client IP twice: the second exceeds the per-IP limit. (The
    // rate limiter runs before the auth-mode check, so self-hosted mode is fine —
    // we only care whether the status is 429.)
    let first = client
        .post(&url)
        .header("x-forwarded-for", "203.0.113.5")
        .json(&body)
        .send()
        .await
        .expect("request 1")
        .status();
    let second = client
        .post(&url)
        .header("x-forwarded-for", "203.0.113.5")
        .json(&body)
        .send()
        .await
        .expect("request 2")
        .status();
    // A different forwarded IP gets its own bucket, so it is not rate-limited —
    // proving the limit keys on the forwarded client IP, not the shared socket IP.
    let other = client
        .post(&url)
        .header("x-forwarded-for", "203.0.113.6")
        .json(&body)
        .send()
        .await
        .expect("request 3")
        .status();

    assert_ne!(first, reqwest::StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(second, reqwest::StatusCode::TOO_MANY_REQUESTS);
    assert_ne!(other, reqwest::StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn websocket_join_rate_limit_keys_on_forwarded_client_ip() {
    let guard = BanGuard {
        blocklist: Blocklist::disabled(),
        trusted_ip_header: Some("x-forwarded-for".parse().unwrap()),
    };
    let address = spawn_app_with_guard_and_hardening(
        guard,
        BrokerHardeningConfig {
            join_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
    )
    .await;

    // A ws upgrade request carrying the forwarded client IP the proxy would add.
    let join_request = |pairing_id: &str, xff: &str| {
        let url = websocket_url(
            address,
            "room-a",
            protocol::PeerRole::Surface,
            None,
            JoinTicketClaims::pairing_surface_join("room-a", pairing_id, u64::MAX),
        );
        let mut request = url.into_client_request().expect("ws request builds");
        request
            .headers_mut()
            .append("x-forwarded-for", xff.parse().unwrap());
        request
    };

    // Same forwarded IP: first join is welcomed, the second hits the per-IP join limit.
    let (mut a1, _) = connect_async(join_request("pair-a-1", "203.0.113.5"))
        .await
        .expect("a1 connects");
    assert!(matches!(
        next_server_message(&mut a1).await,
        ServerMessage::Welcome { .. }
    ));

    let (mut a2, _) = connect_async(join_request("pair-a-2", "203.0.113.5"))
        .await
        .expect("a2 connects");
    match next_server_message(&mut a2).await {
        ServerMessage::Error { code, .. } => assert_eq!(code, "rate_limited"),
        other => panic!("expected rate_limited, got {other:?}"),
    }

    // A different forwarded IP has its own bucket -> welcomed, proving the WS join
    // limit keys on the forwarded client IP, not the shared 127.0.0.1 socket.
    let (mut b1, _) = connect_async(join_request("pair-b-1", "203.0.113.6"))
        .await
        .expect("b1 connects");
    assert!(matches!(
        next_server_message(&mut b1).await,
        ServerMessage::Welcome { .. }
    ));
}

// ---------------------------------------------------------------------------
// Access-strategy helpers + Round 4A regressions (no public LicenseStore)
// ---------------------------------------------------------------------------

async fn spawn_public_mode_app_full(admin_token: Option<std::sync::Arc<str>>) -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let app = app_with_access_strategy_parts(
        BrokerState::default(),
        test_web_root(),
        BrokerJoinVerifier::PublicControlPlane(test_public_control_plane().await),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
        std::sync::Arc::new(OpenAccessStrategy),
        admin_token,
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

/// Enroll a relay against the test public control-plane, optionally supplying an
/// enrollment token. `seed_label` derives a unique deterministic ed25519 key.
async fn enroll_relay(
    address: SocketAddr,
    seed_label: &str,
    enrollment_token: Option<&str>,
) -> Result<RelayEnrollmentResponse, (reqwest::StatusCode, String)> {
    let seed: [u8; 32] = {
        let b = seed_label.as_bytes();
        let mut s = [0xABu8; 32];
        for (i, byte) in b.iter().take(32).enumerate() {
            s[i] = *byte;
        }
        s
    };
    let signing_key = SigningKey::from_bytes(&seed);
    let verify_key_b64 = STANDARD.encode(signing_key.verifying_key().to_bytes());

    let challenge_resp = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/relay-enrollment/challenge"
        ))
        .json(&RelayEnrollmentChallengeRequest {
            relay_verify_key: verify_key_b64.clone(),
            relay_label: None,
        })
        .send()
        .await
        .expect("challenge request should complete");
    if !challenge_resp.status().is_success() {
        let status = challenge_resp.status();
        let body = challenge_resp.text().await.unwrap_or_default();
        return Err((status, format!("challenge failed: {body}")));
    }
    let challenge: RelayEnrollmentChallengeResponse = challenge_resp
        .json()
        .await
        .expect("challenge response should parse");

    let msg = format!(
        "agent-relay:relay-enroll:{}:{}",
        challenge.challenge_id, challenge.challenge
    );
    let sig_b64 = STANDARD.encode(signing_key.sign(msg.as_bytes()).to_bytes());

    let response = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/relay-enrollment/complete"
        ))
        .json(&RelayEnrollmentCompleteRequest {
            relay_verify_key: verify_key_b64,
            challenge_id: challenge.challenge_id,
            challenge_signature: sig_b64,
            relay_label: None,
            enrollment_token: enrollment_token.map(ToString::to_string),
        })
        .send()
        .await
        .expect("enroll request should complete");

    let status = response.status();
    let body = response.text().await.expect("body should read");
    if status.is_success() {
        Ok(serde_json::from_str(&body).expect("enrollment response should parse"))
    } else {
        Err((status, body))
    }
}

/// Fake required-token strategy: tracks binds for conflict/idempotence/race tests.
struct FakeTokenAccessStrategy {
    tokens: std::sync::Mutex<std::collections::HashMap<String, String>>,
    device_limit: Option<u32>,
    deny_device_after_bind: std::sync::atomic::AtomicBool,
}

impl FakeTokenAccessStrategy {
    fn new(device_limit: Option<u32>) -> Self {
        Self {
            tokens: std::sync::Mutex::new(std::collections::HashMap::new()),
            device_limit,
            deny_device_after_bind: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn force_deny_device(&self) {
        self.deny_device_after_bind
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl BrokerAccessStrategy for FakeTokenAccessStrategy {
    async fn authorize_enrollment(
        &self,
        _ctx: &AccessRequestContext,
        enrollment_token: Option<&str>,
        existing_relay_id: Option<&str>,
    ) -> Result<EnrollmentBindDecision, AccessDenial> {
        let Some(token) = enrollment_token.map(str::trim).filter(|t| !t.is_empty()) else {
            return Err(AccessDenial::bad_request("enrollment token is required"));
        };
        let map = self.tokens.lock().expect("tokens");
        match map.get(token) {
            Some(bound) if existing_relay_id == Some(bound.as_str()) => {
                Ok(EnrollmentBindDecision::AlreadyBound)
            }
            Some(_) => Err(AccessDenial::conflict("enrollment token is already bound")),
            None => Ok(EnrollmentBindDecision::Bind),
        }
    }

    async fn bind_enrollment(
        &self,
        _ctx: &AccessRequestContext,
        enrollment_token: &str,
        relay_id: &str,
        _existing_relay_id: Option<&str>,
    ) -> Result<(), AccessDenial> {
        let mut map = self.tokens.lock().expect("tokens");
        match map.get(enrollment_token) {
            Some(bound) if bound == relay_id => Ok(()),
            Some(_) => Err(AccessDenial::conflict("enrollment token is already bound")),
            None => {
                map.insert(enrollment_token.to_string(), relay_id.to_string());
                Ok(())
            }
        }
    }

    async fn authorize_relay(
        &self,
        _ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<(), AccessDenial> {
        Ok(())
    }

    async fn authorize_device(
        &self,
        _ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<DeviceAccessDecision, AccessDenial> {
        if self
            .deny_device_after_bind
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(AccessDenial::forbidden("access denied for this relay"));
        }
        Ok(DeviceAccessDecision {
            device_limit: self.device_limit,
        })
    }
}

#[tokio::test]
async fn standard_public_app_stays_open_despite_removed_legacy_env() {
    // Removed commercial env must never flip the standard public app closed.
    let prev_req = std::env::var("RELAY_BROKER_REQUIRE_LICENSE_CODE").ok();
    let prev_tier = std::env::var("RELAY_BROKER_TIER_DEVICE_LIMITS").ok();
    let prev_legacy = std::env::var("RELAY_LICENSE_CODE").ok();
    std::env::set_var("RELAY_BROKER_REQUIRE_LICENSE_CODE", "1");
    std::env::set_var("RELAY_BROKER_TIER_DEVICE_LIMITS", "free:2,pro:10");
    std::env::set_var("RELAY_LICENSE_CODE", "must-not-activate");

    let address = spawn_public_mode_app_full(None).await;
    enroll_relay(address, "legacy-env-open", None)
        .await
        .expect("standard public app must stay open when legacy commercial env is set");

    match prev_req {
        Some(v) => std::env::set_var("RELAY_BROKER_REQUIRE_LICENSE_CODE", v),
        None => std::env::remove_var("RELAY_BROKER_REQUIRE_LICENSE_CODE"),
    }
    match prev_tier {
        Some(v) => std::env::set_var("RELAY_BROKER_TIER_DEVICE_LIMITS", v),
        None => std::env::remove_var("RELAY_BROKER_TIER_DEVICE_LIMITS"),
    }
    match prev_legacy {
        Some(v) => std::env::set_var("RELAY_LICENSE_CODE", v),
        None => std::env::remove_var("RELAY_LICENSE_CODE"),
    }
}

#[tokio::test]
async fn required_injected_unavailable_remains_fail_closed() {
    let address =
        spawn_public_mode_app_with_access(std::sync::Arc::new(UnavailableAccessStrategy::new()))
            .await;
    let (status, body) = enroll_relay(address, "req-unavail", None)
        .await
        .expect_err("unavailable strategy must fail closed");
    assert_eq!(status, reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let json: serde_json::Value = serde_json::from_str(&body).expect("error JSON");
    assert_eq!(json["error"], "unavailable");
}

#[tokio::test]
async fn enrollment_rejects_legacy_license_code_wire_field() {
    let address = spawn_public_mode_app_with_access(std::sync::Arc::new(OpenAccessStrategy)).await;
    let seed_label = "legacy-wire";
    let seed: [u8; 32] = {
        let b = seed_label.as_bytes();
        let mut s = [0xABu8; 32];
        for (i, byte) in b.iter().take(32).enumerate() {
            s[i] = *byte;
        }
        s
    };
    let signing_key = SigningKey::from_bytes(&seed);
    let verify_key_b64 = STANDARD.encode(signing_key.verifying_key().to_bytes());
    let challenge_resp = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/relay-enrollment/challenge"
        ))
        .json(&RelayEnrollmentChallengeRequest {
            relay_verify_key: verify_key_b64.clone(),
            relay_label: None,
        })
        .send()
        .await
        .expect("challenge");
    let challenge: RelayEnrollmentChallengeResponse =
        challenge_resp.json().await.expect("challenge json");
    let msg = format!(
        "agent-relay:relay-enroll:{}:{}",
        challenge.challenge_id, challenge.challenge
    );
    let sig_b64 = STANDARD.encode(signing_key.sign(msg.as_bytes()).to_bytes());
    let resp = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/relay-enrollment/complete"
        ))
        .json(&serde_json::json!({
            "relay_verify_key": verify_key_b64,
            "challenge_id": challenge.challenge_id,
            "challenge_signature": sig_b64,
            "license_code": "legacy-only-payload"
        }))
        .send()
        .await
        .expect("complete");
    assert!(
        resp.status().is_client_error(),
        "legacy license_code-only payload must be rejected, got {}",
        resp.status()
    );
    // Also prove enrollment_token still serializes without the legacy alias.
    let encoded = serde_json::to_value(&RelayEnrollmentCompleteRequest {
        relay_verify_key: "k".into(),
        challenge_id: "c".into(),
        challenge_signature: "s".into(),
        relay_label: None,
        enrollment_token: Some("tok".into()),
    })
    .unwrap();
    assert!(encoded.get("enrollment_token").is_some());
    assert!(encoded.get("license_code").is_none());
    let via_alias = serde_json::from_value::<RelayEnrollmentCompleteRequest>(serde_json::json!({
        "relay_verify_key": "k",
        "challenge_id": "c",
        "challenge_signature": "s",
        "license_code": "tok-legacy"
    }));
    assert!(
        via_alias.is_err(),
        "license_code must not deserialize as enrollment_token"
    );
}

#[tokio::test]
async fn injected_required_token_and_conflict_idempotence_race() {
    let access = std::sync::Arc::new(FakeTokenAccessStrategy::new(None));
    let address = spawn_public_mode_app_with_access(access.clone()).await;

    let (status, body) = enroll_relay(address, "tok-missing", None)
        .await
        .expect_err("required token strategy must reject missing token");
    assert!(status.is_client_error());
    assert!(body.contains("required"));

    enroll_relay(address, "tok-valid", Some("TOKEN-A"))
        .await
        .expect("valid token enrolls");
    enroll_relay(address, "tok-valid", Some("TOKEN-A"))
        .await
        .expect("same relay + token re-enroll is idempotent (AlreadyBound)");

    let (status, _) = enroll_relay(address, "tok-other", Some("TOKEN-A"))
        .await
        .expect_err("token cannot bind a second relay");
    assert_eq!(status, reqwest::StatusCode::CONFLICT);

    // Concurrent same-verify-key enrollments: enrollment lock + AlreadyBound/Bind.
    let a = address;
    let t1 = tokio::spawn(async move { enroll_relay(a, "tok-race", Some("TOKEN-RACE")).await });
    let t2 = tokio::spawn(async move { enroll_relay(a, "tok-race", Some("TOKEN-RACE")).await });
    let r1 = t1.await.expect("join1");
    let r2 = t2.await.expect("join2");
    assert!(
        r1.is_ok() || r2.is_ok(),
        "at least one concurrent enrollment must succeed, got {r1:?} / {r2:?}"
    );
    // Follow-up enroll with the same verify key must remain idempotent.
    enroll_relay(address, "tok-race", Some("TOKEN-RACE"))
        .await
        .expect("post-race re-enroll must succeed");
}

#[tokio::test]
async fn injected_device_limit_enforced_through_endpoint() {
    let access = std::sync::Arc::new(FakeTokenAccessStrategy::new(Some(1)));
    let address = spawn_public_mode_app_with_access(access).await;
    let enrolled = enroll_relay(address, "cap-seed", Some("CAP-TOKEN"))
        .await
        .expect("enroll");

    let _first: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        &enrolled.relay_refresh_token,
        &DeviceGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: "d1".to_string(),
        },
    )
    .await;

    let response = public_post_response(
        address,
        "/api/public/devices",
        &enrolled.relay_refresh_token,
        &DeviceGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: "d2".to_string(),
        },
    )
    .await;
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
    let body: serde_json::Value = response.json().await.expect("error body");
    assert_eq!(body["error"], "device_limit_reached");
    let message = body["message"].as_str().unwrap_or_default();
    assert!(
        !message.contains("license"),
        "device-limit message must stay product-neutral: {message}"
    );
}

#[tokio::test]
async fn device_grant_invalid_bearer_hides_access_state() {
    let access = std::sync::Arc::new(FakeTokenAccessStrategy::new(None));
    let address = spawn_public_mode_app_with_access(access.clone()).await;
    let active = enroll_relay(address, "leak-active", Some("ACTIVE-T"))
        .await
        .expect("enroll active");
    let denied = enroll_relay(address, "leak-denied", Some("DENIED-T"))
        .await
        .expect("enroll denied-path relay");
    access.force_deny_device();

    let bad_bearer = "totally-not-a-valid-refresh-token";
    let against_active = public_post_response(
        address,
        "/api/public/devices",
        bad_bearer,
        &DeviceGrantRequest {
            relay_id: active.relay_id.clone(),
            broker_room_id: active.broker_room_id.clone(),
            device_id: "x".to_string(),
        },
    )
    .await;
    let against_denied = public_post_response(
        address,
        "/api/public/devices",
        bad_bearer,
        &DeviceGrantRequest {
            relay_id: denied.relay_id.clone(),
            broker_room_id: denied.broker_room_id.clone(),
            device_id: "x".to_string(),
        },
    )
    .await;
    assert_eq!(against_active.status(), against_denied.status());
    assert_eq!(against_active.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn ws_token_access_check_requires_auth_first() {
    let access = std::sync::Arc::new(FakeTokenAccessStrategy::new(None));
    let address = spawn_public_mode_app_with_access(access).await;
    let response = reqwest::Client::new()
        .post(format!("http://{address}/api/public/relay/ws-token"))
        .json(&RelayWsTokenRequest {
            relay_id: "no-such-relay".to_string(),
            broker_room_id: "room".to_string(),
            relay_peer_id: "peer".to_string(),
        })
        .send()
        .await
        .expect("ws-token");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "unauthenticated ws-token must 401 before access strategy"
    );
}

#[tokio::test]
async fn failed_bind_does_not_persist_relay_registration() {
    let access = std::sync::Arc::new(FakeTokenAccessStrategy::new(None));
    // Pre-bind so a different verify key hits conflict at bind/authorize.
    {
        let mut map = access.tokens.lock().expect("tokens");
        map.insert("RACE-001".to_string(), "relay-already-enrolled".to_string());
    }
    let address = spawn_public_mode_app_with_access(access).await;
    let (status, _) = enroll_relay(address, "verify-key-6", Some("RACE-001"))
        .await
        .expect_err("pre-bound token must fail");
    assert!(status.is_client_error());
}

#[tokio::test]
async fn admin_stats_contain_no_commercial_attribution() {
    let token: std::sync::Arc<str> = std::sync::Arc::from("s3cret-operator-token");
    let address = spawn_public_mode_app_full(Some(token.clone())).await;
    let enrolled = enroll_relay(address, "admin-neutral", None)
        .await
        .expect("enroll");
    let ok = reqwest::Client::new()
        .get(format!("http://{address}/api/admin/stats"))
        .bearer_auth(token.as_ref())
        .send()
        .await
        .expect("stats");
    assert_eq!(ok.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = ok.json().await.expect("json");
    let relays = body["relays"].as_array().expect("relays");
    let row = relays
        .iter()
        .find(|r| r["relay_id"] == serde_json::json!(enrolled.relay_id))
        .expect("enrolled row");
    assert!(
        row.get("license").is_none(),
        "admin stats must not include license attribution: {row}"
    );
    let dumped = body.to_string();
    for forbidden in ["tier", "grant_days", "pepper", "Plus", "Pro"] {
        assert!(
            !dumped.contains(forbidden),
            "admin stats must not mention {forbidden}: {dumped}"
        );
    }
}

// ---------------------------------------------------------------------------
// Injected BrokerAccessStrategy handler tests
// ---------------------------------------------------------------------------
// These go through the real HTTP stack with a caller-supplied strategy so the
// public seam (not only the license adapter) is proven end-to-end.

async fn spawn_public_mode_app_with_access(
    access: std::sync::Arc<dyn BrokerAccessStrategy>,
) -> SocketAddr {
    spawn_public_mode_app_with_access_and_state(access, BrokerState::default())
        .await
        .0
}

async fn spawn_public_mode_app_with_access_and_state(
    access: std::sync::Arc<dyn BrokerAccessStrategy>,
    broker: BrokerState,
) -> (SocketAddr, BrokerState, PublicControlPlane) {
    spawn_public_mode_app_with_access_hardening(access, broker, BrokerHardeningConfig::default())
        .await
}

async fn spawn_public_mode_app_with_access_hardening(
    access: std::sync::Arc<dyn BrokerAccessStrategy>,
    broker: BrokerState,
    hardening: BrokerHardeningConfig,
) -> (SocketAddr, BrokerState, PublicControlPlane) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let control_plane = test_public_control_plane().await;
    let app = app_with_access_strategy_parts(
        broker.clone(),
        test_web_root(),
        BrokerJoinVerifier::PublicControlPlane(control_plane.clone()),
        hardening,
        SecurityHeadersConfig::default(),
        access,
        None,
    );
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("broker should serve");
    });
    (address, broker, control_plane)
}

/// Test double: optional typed denials per gate; otherwise open. Records every
/// request context so tests can assert operation + ConnectInfo IP.
struct ScriptedAccessStrategy {
    deny_enrollment: Option<AccessDenial>,
    deny_relay: Option<AccessDenial>,
    deny_relay_socket: Option<AccessDenial>,
    deny_device: Option<AccessDenial>,
    deny_device_socket: Option<AccessDenial>,
    deny_release: Option<AccessDenial>,
    device_limit: Option<u32>,
    /// Optional pause before returning from authorize_* (for TOCTOU tests).
    authorize_hook: Option<std::sync::Arc<dyn Fn(&AccessRequestContext) + Send + Sync>>,
    seen: std::sync::Mutex<Vec<AccessRequestContext>>,
}

impl ScriptedAccessStrategy {
    fn allow() -> Self {
        Self {
            deny_enrollment: None,
            deny_relay: None,
            deny_relay_socket: None,
            deny_device: None,
            deny_device_socket: None,
            deny_release: None,
            device_limit: None,
            authorize_hook: None,
            seen: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn seen_contexts(&self) -> Vec<AccessRequestContext> {
        self.seen.lock().expect("seen lock").clone()
    }

    fn record(&self, ctx: &AccessRequestContext) {
        self.seen.lock().expect("seen lock").push(ctx.clone());
        if let Some(hook) = &self.authorize_hook {
            hook(ctx);
        }
    }
}

#[async_trait::async_trait]
impl BrokerAccessStrategy for ScriptedAccessStrategy {
    async fn authorize_enrollment(
        &self,
        ctx: &AccessRequestContext,
        _enrollment_token: Option<&str>,
        _existing_relay_id: Option<&str>,
    ) -> Result<EnrollmentBindDecision, AccessDenial> {
        self.record(ctx);
        match &self.deny_enrollment {
            Some(denial) => Err(denial.clone()),
            None => Ok(EnrollmentBindDecision::Skip),
        }
    }

    async fn bind_enrollment(
        &self,
        ctx: &AccessRequestContext,
        _enrollment_token: &str,
        _relay_id: &str,
        _existing_relay_id: Option<&str>,
    ) -> Result<(), AccessDenial> {
        self.record(ctx);
        Ok(())
    }

    async fn authorize_relay(
        &self,
        ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<(), AccessDenial> {
        self.record(ctx);
        if ctx.operation == AccessOperation::RelaySocketJoin {
            if let Some(denial) = &self.deny_relay_socket {
                return Err(denial.clone());
            }
        }
        match &self.deny_relay {
            Some(denial) => Err(denial.clone()),
            None => Ok(()),
        }
    }

    async fn authorize_device(
        &self,
        ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<DeviceAccessDecision, AccessDenial> {
        self.record(ctx);
        if ctx.operation == AccessOperation::DeviceSocketJoin {
            if let Some(denial) = &self.deny_device_socket {
                return Err(denial.clone());
            }
        }
        match &self.deny_device {
            Some(denial) => Err(denial.clone()),
            None => Ok(DeviceAccessDecision {
                device_limit: self.device_limit,
            }),
        }
    }

    async fn release_access(
        &self,
        ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<(), AccessDenial> {
        self.record(ctx);
        match &self.deny_release {
            Some(denial) => Err(denial.clone()),
            None => Ok(()),
        }
    }
}

fn parse_api_error(body: &str) -> (String, String, Option<u64>) {
    let json: serde_json::Value = serde_json::from_str(body).expect("error JSON");
    (
        json["error"].as_str().unwrap_or_default().to_string(),
        json["message"].as_str().unwrap_or_default().to_string(),
        json["retry_after_secs"].as_u64(),
    )
}

#[tokio::test]
async fn injected_open_strategy_allows_enrollment_without_token() {
    let address = spawn_public_mode_app_with_access(std::sync::Arc::new(OpenAccessStrategy)).await;
    enroll_relay(address, "access-open", None)
        .await
        .expect("open/self-host strategy must allow enrollment without a token");
}

#[tokio::test]
async fn injected_conflict_denial_returns_409_with_machine_code() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy {
        deny_enrollment: Some(AccessDenial::conflict("enrollment token is already bound")),
        ..ScriptedAccessStrategy::allow()
    });
    let address = spawn_public_mode_app_with_access(access.clone()).await;
    let (status, body) = enroll_relay(address, "access-conflict", None)
        .await
        .expect_err("conflict must reject enrollment");
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    let (error, message, _) = parse_api_error(&body);
    assert_eq!(error, "conflict");
    assert!(message.contains("already bound"));
    let seen = access.seen_contexts();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].operation, AccessOperation::EnrollmentComplete);
    assert_eq!(
        seen[0].remote_ip,
        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
    );
}

#[tokio::test]
async fn injected_rate_limited_denial_returns_429_with_retry_metadata() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy {
        deny_enrollment: Some(AccessDenial::rate_limited(
            "too many enrollment attempts",
            Some(42),
        )),
        ..ScriptedAccessStrategy::allow()
    });
    let address = spawn_public_mode_app_with_access(access).await;
    let (status, body) = enroll_relay(address, "access-rate", None)
        .await
        .expect_err("rate limit must reject enrollment");
    assert_eq!(status, reqwest::StatusCode::TOO_MANY_REQUESTS);
    let (error, message, retry) = parse_api_error(&body);
    assert_eq!(error, "rate_limited");
    assert!(message.contains("too many"));
    assert_eq!(retry, Some(42));
}

#[tokio::test]
async fn injected_unavailable_strategy_is_fail_closed_on_enrollment() {
    let access = std::sync::Arc::new(UnavailableAccessStrategy::new());
    let address = spawn_public_mode_app_with_access(access).await;
    let (status, body) = enroll_relay(address, "access-unavailable", None)
        .await
        .expect_err("unavailable strategy must fail closed");
    assert_eq!(status, reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let (error, message, _) = parse_api_error(&body);
    assert_eq!(error, "unavailable");
    assert!(message.contains("unavailable"));
}

#[tokio::test]
async fn injected_forbidden_denial_blocks_relay_ws_token_after_auth() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy {
        deny_relay: Some(AccessDenial::forbidden(
            "relay lease denied by injected policy",
        )),
        ..ScriptedAccessStrategy::allow()
    });
    let address = spawn_public_mode_app_with_access(access.clone()).await;
    let enrolled = enroll_relay(address, "access-deny-relay", None)
        .await
        .expect("enrollment should succeed under allow-enroll script");
    let resp = reqwest::Client::new()
        .post(format!("http://{address}/api/public/relay/ws-token"))
        .header(
            "Authorization",
            format!("Bearer {}", enrolled.relay_refresh_token),
        )
        .json(&RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer".to_string(),
        })
        .send()
        .await
        .expect("ws-token request");
    assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN);
    let body = resp.text().await.unwrap_or_default();
    let (error, message, _) = parse_api_error(&body);
    assert_eq!(error, "forbidden");
    assert!(message.contains("relay lease denied"));
    let ops: Vec<_> = access
        .seen_contexts()
        .into_iter()
        .map(|c| c.operation)
        .collect();
    assert!(ops.contains(&AccessOperation::EnrollmentComplete));
    assert!(ops.contains(&AccessOperation::RelayLease));
}

#[tokio::test]
async fn injected_forbidden_denial_blocks_device_grant_after_auth() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy {
        deny_device: Some(AccessDenial::forbidden(
            "device grant denied by injected policy",
        )),
        ..ScriptedAccessStrategy::allow()
    });
    let address = spawn_public_mode_app_with_access(access.clone()).await;
    let enrolled = enroll_relay(address, "access-deny-device", None)
        .await
        .expect("enrollment should succeed");
    let resp = reqwest::Client::new()
        .post(format!("http://{address}/api/public/devices"))
        .header(
            "Authorization",
            format!("Bearer {}", enrolled.relay_refresh_token),
        )
        .json(&DeviceGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: "phone".to_string(),
        })
        .send()
        .await
        .expect("device grant request");
    assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN);
    let body = resp.text().await.unwrap_or_default();
    let (error, message, _) = parse_api_error(&body);
    assert_eq!(error, "forbidden");
    assert!(message.contains("device grant denied"));
    assert!(
        !body.contains("sql") && !body.contains("postgres"),
        "must not leak backend text: {body}"
    );
    let seen = access.seen_contexts();
    assert!(seen
        .iter()
        .any(|c| c.operation == AccessOperation::DeviceGrant
            && c.remote_ip == std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)));
}

#[tokio::test]
async fn injected_strategy_observes_connect_info_ip_on_enrollment() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy::allow());
    let address = spawn_public_mode_app_with_access(access.clone()).await;
    enroll_relay(address, "access-ctx-ip", None)
        .await
        .expect("open script allows enrollment");
    let seen = access.seen_contexts();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].operation, AccessOperation::EnrollmentComplete);
    // axum ConnectInfo for loopback clients is 127.0.0.1 today.
    assert_eq!(
        seen[0].remote_ip,
        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
    );
}

#[tokio::test]
async fn access_release_orders_auth_before_strategy_and_revokes_on_success() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy::allow());
    let (address, broker, control) =
        spawn_public_mode_app_with_access_and_state(access.clone(), BrokerState::default()).await;
    let enrolled = enroll_relay(address, "release-ok", None)
        .await
        .expect("enroll");

    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer".to_string(),
        },
    )
    .await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        &enrolled.relay_refresh_token,
        &DeviceGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: "device-1".to_string(),
        },
    )
    .await;
    assert!(
        control
            .device_grant_count_for_test(&enrolled.relay_id, &enrolled.broker_room_id)
            .await
            >= 1
    );

    let client_signing = SigningKey::from_bytes(&[0xC1_u8; 32]);
    let _client = public_client_pair(
        address,
        &enrolled.relay_refresh_token,
        &client_signing,
        &ClientGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: "device-1".to_string(),
            client_verify_key: STANDARD.encode(client_signing.verifying_key().to_bytes()),
            client_label: Some("Phone".to_string()),
            device_label: Some("Phone".to_string()),
        },
    )
    .await;
    assert!(
        control
            .client_relay_grant_count_for_test(&enrolled.relay_id, &enrolled.broker_room_id)
            .await
            > 0,
        "client grant must exist before release so cleanup is proven"
    );

    let (mut relay_ws, _) = connect_async(format!(
        "ws://{address}/ws/{}?role=relay&peer_id=relay-peer&join_ticket={}",
        enrolled.broker_room_id, relay_token.relay_ws_token
    ))
    .await
    .expect("relay should join");
    let _ = next_server_message(&mut relay_ws).await;

    let (mut device_ws, _) = connect_async(format!(
        "ws://{address}/ws/{}?role=surface&join_ticket={}",
        enrolled.broker_room_id, device_grant.device_ws_token
    ))
    .await
    .expect("device should join");
    let _ = next_server_message(&mut device_ws).await;
    // Relay sees the surface join; drain so force-close is the next message.
    match next_server_message(&mut relay_ws).await {
        ServerMessage::Presence { kind, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
        }
        other => panic!("expected surface presence on relay, got {other:?}"),
    }
    assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 2);

    let released: AccessReleaseResponse = public_post(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert!(released.released);
    assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 0);

    assert_ws_closed_after_access_released("relay", &mut relay_ws).await;
    assert_ws_closed_after_access_released("device", &mut device_ws).await;

    assert!(
        !control
            .has_relay_registration(&enrolled.relay_id, &enrolled.broker_room_id)
            .await
    );
    assert_eq!(
        control
            .device_grant_count_for_test(&enrolled.relay_id, &enrolled.broker_room_id)
            .await,
        0
    );
    assert_eq!(
        control
            .client_relay_grant_count_for_test(&enrolled.relay_id, &enrolled.broker_room_id)
            .await,
        0
    );

    let ops: Vec<_> = access
        .seen_contexts()
        .into_iter()
        .map(|c| c.operation)
        .collect();
    assert!(ops.contains(&AccessOperation::AccessRelease));

    let again = public_post_response(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert_eq!(again.status(), reqwest::StatusCode::UNAUTHORIZED);

    for (role, peer, ticket) in [
        (
            "relay",
            Some("relay-peer"),
            relay_token.relay_ws_token.as_str(),
        ),
        ("surface", None, device_grant.device_ws_token.as_str()),
    ] {
        let url = match peer {
            Some(peer_id) => format!(
                "ws://{address}/ws/{}?role={role}&peer_id={peer_id}&join_ticket={ticket}",
                enrolled.broker_room_id
            ),
            None => format!(
                "ws://{address}/ws/{}?role={role}&join_ticket={ticket}",
                enrolled.broker_room_id
            ),
        };
        let (mut ws, _) = connect_async(url).await.expect("tcp");
        match next_server_message(&mut ws).await {
            ServerMessage::Error { code, .. } => assert_eq!(code, "join_rejected"),
            other => panic!("expected join_rejected for {role}, got {other:?}"),
        }
        assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 0);
    }
}

#[tokio::test]
async fn access_release_strategy_denial_preserves_registration_and_sockets() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy {
        deny_release: Some(AccessDenial::forbidden("release denied by policy")),
        ..ScriptedAccessStrategy::allow()
    });
    let (address, broker, control) =
        spawn_public_mode_app_with_access_and_state(access.clone(), BrokerState::default()).await;
    let enrolled = enroll_relay(address, "release-deny", None)
        .await
        .expect("enroll");
    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer".to_string(),
        },
    )
    .await;
    let (mut relay_ws, _) = connect_async(format!(
        "ws://{address}/ws/{}?role=relay&peer_id=relay-peer&join_ticket={}",
        enrolled.broker_room_id, relay_token.relay_ws_token
    ))
    .await
    .expect("relay should join");
    let _ = next_server_message(&mut relay_ws).await;
    assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 1);

    let denied = public_post_response(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
    assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 1);
    assert!(
        control
            .has_relay_registration(&enrolled.relay_id, &enrolled.broker_room_id)
            .await
    );

    let _still: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer-2".to_string(),
        },
    )
    .await;
}

#[tokio::test]
async fn access_release_wrong_room_and_wrong_relay_cannot_target_victim() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy::allow());
    let address = spawn_public_mode_app_with_access(access.clone()).await;
    let a = enroll_relay(address, "release-a", None).await.expect("a");
    let b = enroll_relay(address, "release-b", None).await.expect("b");

    let wrong_room = public_post_response(
        address,
        "/api/public/relay/access/release",
        &a.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: a.relay_id.clone(),
            broker_room_id: b.broker_room_id.clone(),
        },
    )
    .await;
    assert_eq!(wrong_room.status(), reqwest::StatusCode::UNAUTHORIZED);

    let wrong_relay = public_post_response(
        address,
        "/api/public/relay/access/release",
        &a.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: b.relay_id.clone(),
            broker_room_id: a.broker_room_id.clone(),
        },
    )
    .await;
    assert_eq!(wrong_relay.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(
        !access
            .seen_contexts()
            .iter()
            .any(|c| c.operation == AccessOperation::AccessRelease),
        "strategy must not run before auth succeeds"
    );

    let _ok: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &b.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: b.relay_id.clone(),
            broker_room_id: b.broker_room_id.clone(),
            relay_peer_id: "relay-b".to_string(),
        },
    )
    .await;
}

#[tokio::test]
async fn unavailable_strategy_fails_closed_on_access_release() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy {
        deny_release: Some(AccessDenial::unavailable()),
        ..ScriptedAccessStrategy::allow()
    });
    let address = spawn_public_mode_app_with_access(access).await;
    let enrolled = enroll_relay(address, "release-unavail", None)
        .await
        .expect("enroll");
    let denied = public_post_response(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert_eq!(denied.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let _ok: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer".to_string(),
        },
    )
    .await;
}

#[tokio::test]
async fn open_access_release_still_revokes_registration() {
    let open = spawn_public_mode_app_with_access(std::sync::Arc::new(OpenAccessStrategy)).await;
    let enrolled = enroll_relay(open, "release-open", None)
        .await
        .expect("enroll");
    let released: AccessReleaseResponse = public_post(
        open,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert!(released.released);
    let again = public_post_response(
        open,
        "/api/public/relay/ws-token",
        &enrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer".to_string(),
        },
    )
    .await;
    assert_eq!(again.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn socket_join_consults_strategy_after_ticket_verify() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy {
        deny_relay_socket: Some(
            AccessDenial::forbidden("relay socket denied")
                .with_internal("internal cause must be logged not serialized"),
        ),
        ..ScriptedAccessStrategy::allow()
    });
    let address = spawn_public_mode_app_with_access(access.clone()).await;
    let enrolled = enroll_relay(address, "sock-deny", None)
        .await
        .expect("enroll");
    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer".to_string(),
        },
    )
    .await;
    let (mut ws, _) = connect_async(format!(
        "ws://{address}/ws/{}?role=relay&peer_id=relay-peer&join_ticket={}",
        enrolled.broker_room_id, relay_token.relay_ws_token
    ))
    .await
    .expect("tcp connect");
    let msg = next_server_message(&mut ws).await;
    match msg {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "join_rejected");
            assert!(!message.contains("internal cause"));
        }
        other => panic!("expected join_rejected, got {other:?}"),
    }
    assert!(access
        .seen_contexts()
        .iter()
        .any(|c| c.operation == AccessOperation::RelaySocketJoin));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn released_ticket_cannot_seat_after_concurrent_access_release() {
    use std::sync::mpsc::sync_channel;

    let (at_auth_tx, at_auth_rx) = sync_channel::<()>(0);
    let (go_tx, go_rx) = sync_channel::<()>(0);
    let go_rx = std::sync::Mutex::new(go_rx);
    let once = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let once_h = std::sync::Arc::clone(&once);
    let access = std::sync::Arc::new(ScriptedAccessStrategy {
        authorize_hook: Some(std::sync::Arc::new(move |ctx: &AccessRequestContext| {
            if ctx.operation != AccessOperation::RelaySocketJoin {
                return;
            }
            if once_h.fetch_add(1, std::sync::atomic::Ordering::SeqCst) != 0 {
                return;
            }
            // Park off the runtime so release HTTP can still be served.
            tokio::task::block_in_place(|| {
                let _ = at_auth_tx.send(());
                let _ = go_rx.lock().unwrap().recv();
            });
        })),
        ..ScriptedAccessStrategy::allow()
    });
    let (address, broker, _) =
        spawn_public_mode_app_with_access_and_state(access, BrokerState::default()).await;
    let enrolled = enroll_relay(address, "release-toctou", None)
        .await
        .expect("enroll");
    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer".to_string(),
        },
    )
    .await;

    let join_url = format!(
        "ws://{address}/ws/{}?role=relay&peer_id=relay-peer&join_ticket={}",
        enrolled.broker_room_id, relay_token.relay_ws_token
    );
    let join_task = tokio::spawn(async move {
        let (mut ws, _) = connect_async(join_url).await.expect("tcp");
        next_server_message(&mut ws).await
    });

    tokio::task::spawn_blocking(move || at_auth_rx.recv())
        .await
        .unwrap()
        .unwrap();
    let released: AccessReleaseResponse = public_post(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert!(released.released);
    go_tx.send(()).unwrap();

    match join_task.await.unwrap() {
        ServerMessage::Error { code, .. } => assert_eq!(code, "join_rejected"),
        ServerMessage::Welcome { .. } => panic!("stale ticket must not Welcome after release"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn released_device_ticket_cannot_seat_after_concurrent_access_release() {
    use std::sync::mpsc::sync_channel;

    let (at_auth_tx, at_auth_rx) = sync_channel::<()>(0);
    let (go_tx, go_rx) = sync_channel::<()>(0);
    let go_rx = std::sync::Mutex::new(go_rx);
    let once = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let once_h = std::sync::Arc::clone(&once);
    let access = std::sync::Arc::new(ScriptedAccessStrategy {
        authorize_hook: Some(std::sync::Arc::new(move |ctx: &AccessRequestContext| {
            if ctx.operation != AccessOperation::DeviceSocketJoin {
                return;
            }
            if once_h.fetch_add(1, std::sync::atomic::Ordering::SeqCst) != 0 {
                return;
            }
            tokio::task::block_in_place(|| {
                let _ = at_auth_tx.send(());
                let _ = go_rx.lock().unwrap().recv();
            });
        })),
        ..ScriptedAccessStrategy::allow()
    });
    let (address, broker, _) =
        spawn_public_mode_app_with_access_and_state(access, BrokerState::default()).await;
    let enrolled = enroll_relay(address, "release-toctou-device", None)
        .await
        .expect("enroll");
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        &enrolled.relay_refresh_token,
        &DeviceGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: "device-race".to_string(),
        },
    )
    .await;

    let join_url = format!(
        "ws://{address}/ws/{}?role=surface&join_ticket={}",
        enrolled.broker_room_id, device_grant.device_ws_token
    );
    let join_task = tokio::spawn(async move {
        let (mut ws, _) = connect_async(join_url).await.expect("tcp");
        next_server_message(&mut ws).await
    });
    tokio::task::spawn_blocking(move || at_auth_rx.recv())
        .await
        .unwrap()
        .unwrap();
    let released: AccessReleaseResponse = public_post(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert!(released.released);
    go_tx.send(()).unwrap();
    match join_task.await.unwrap() {
        ServerMessage::Error { code, .. } => assert_eq!(code, "join_rejected"),
        ServerMessage::Welcome { .. } => panic!("device ticket must not Welcome after release"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 0);
}

#[tokio::test]
async fn access_release_cleanup_failpoint_closes_sockets_and_retries() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy::allow());
    let (address, broker, control) =
        spawn_public_mode_app_with_access_and_state(access, BrokerState::default()).await;
    let enrolled = enroll_relay(address, "release-failpoint", None)
        .await
        .expect("enroll");
    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer".to_string(),
        },
    )
    .await;
    let (mut relay_ws, _) = connect_async(format!(
        "ws://{address}/ws/{}?role=relay&peer_id=relay-peer&join_ticket={}",
        enrolled.broker_room_id, relay_token.relay_ws_token
    ))
    .await
    .expect("join");
    let _ = next_server_message(&mut relay_ws).await;

    control.arm_save_failpoint_for_test(1);
    let failed = public_post_response(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert_eq!(failed.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = failed.json().await.expect("json");
    assert_eq!(body["error"], "unavailable");
    let body_text = body.to_string();
    assert!(!body_text.to_ascii_lowercase().contains("sql"));
    assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 0);
    assert!(
        control
            .has_relay_registration(&enrolled.relay_id, &enrolled.broker_room_id)
            .await
    );

    let retried: AccessReleaseResponse = public_post(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert!(retried.released);
    assert!(
        !control
            .has_relay_registration(&enrolled.relay_id, &enrolled.broker_room_id)
            .await
    );
}

#[tokio::test]
async fn access_release_reload_uncertain_returns_503_even_when_memory_target_cleared() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy::allow());
    let (address, broker, control) =
        spawn_public_mode_app_with_access_and_state(access, BrokerState::default()).await;
    let enrolled = enroll_relay(address, "release-reload-uncertain", None)
        .await
        .expect("enroll");
    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer".to_string(),
        },
    )
    .await;
    let (mut relay_ws, _) = connect_async(format!(
        "ws://{address}/ws/{}?role=relay&peer_id=relay-peer&join_ticket={}",
        enrolled.broker_room_id, relay_token.relay_ws_token
    ))
    .await
    .expect("join");
    let _ = next_server_message(&mut relay_ws).await;

    // Simulate Postgres save+reload failure: memory is target-cleared but durable
    // outcome is unknown — must be 503, never released=true.
    control.arm_reload_uncertain_failpoint_for_test(1);
    let failed = public_post_response(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert_eq!(failed.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = failed.json().await.expect("json");
    assert_eq!(body["error"], "unavailable");
    assert_eq!(
        body["access_released"],
        true,
        "post-strategy cleanup failure must signal access_released so clients can commit a pending-release marker"
    );
    assert!(!body.to_string().to_ascii_lowercase().contains("sql"));
    assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 0);
    assert_ws_closed_after_access_released("relay", &mut relay_ws).await;

    // Memory was left target-cleared without a confirmed durable commit; a
    // follow-up with the same bearer is Unauthorized (ambiguous 503→Unauthorized
    // = treat as already released for clients).
    let again = public_post_response(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert_eq!(again.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn access_release_rate_limit_runs_before_auth_and_strategy() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy::allow());
    let mut hardening = BrokerHardeningConfig::default();
    hardening.public_api_rate_limit_per_minute = 1;
    let (address, _, _) = spawn_public_mode_app_with_access_hardening(
        access.clone(),
        BrokerState::default(),
        hardening,
    )
    .await;
    let enrolled = enroll_relay(address, "release-limit", None)
        .await
        .expect("enroll");
    // First release succeeds and consumes the single per-route budget.
    let released: AccessReleaseResponse = public_post(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert!(released.released);
    assert_eq!(
        access
            .seen_contexts()
            .iter()
            .filter(|c| c.operation == AccessOperation::AccessRelease)
            .count(),
        1
    );

    // Second call is rate-limited before auth/strategy (would otherwise be 401
    // because the refresh chain is already gone).
    let limited = public_post_response(
        address,
        "/api/public/relay/access/release",
        &enrolled.relay_refresh_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert_eq!(limited.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        access
            .seen_contexts()
            .iter()
            .filter(|c| c.operation == AccessOperation::AccessRelease)
            .count(),
        1,
        "spam rejection must never call release_access again"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_access_release_force_closes_stale_join_seated_during_cleanup() {
    use std::sync::mpsc::sync_channel;

    let (at_cleanup_tx, at_cleanup_rx) = sync_channel::<()>(0);
    let (go_tx, go_rx) = sync_channel::<()>(0);
    let go_rx = std::sync::Mutex::new(go_rx);
    let (address, broker, control) = spawn_public_mode_app_with_access_and_state(
        std::sync::Arc::new(OpenAccessStrategy),
        BrokerState::default(),
    )
    .await;
    let enrolled = enroll_relay(address, "open-cleanup-race", None)
        .await
        .expect("enroll");
    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "relay-peer".to_string(),
        },
    )
    .await;

    control.arm_cleanup_pause_for_test(std::sync::Arc::new(move || {
        tokio::task::block_in_place(|| {
            let _ = at_cleanup_tx.send(());
            let _ = go_rx.lock().unwrap().recv();
        });
    }));

    let release_url = format!("http://{address}/api/public/relay/access/release");
    let release_token = enrolled.relay_refresh_token.clone();
    let release_body = AccessReleaseRequest {
        relay_id: enrolled.relay_id.clone(),
        broker_room_id: enrolled.broker_room_id.clone(),
    };
    let release_task = tokio::spawn(async move {
        reqwest::Client::new()
            .post(release_url)
            .bearer_auth(release_token)
            .json(&release_body)
            .send()
            .await
            .expect("release request")
    });

    tokio::task::spawn_blocking(move || at_cleanup_rx.recv())
        .await
        .unwrap()
        .unwrap();

    // Registration still exists during the pause; OpenAccess allows seating.
    // Peer id must match the ticket pin or join is rejected before seating.
    let join_url = format!(
        "ws://{address}/ws/{}?role=relay&peer_id=relay-peer&join_ticket={}",
        enrolled.broker_room_id, relay_token.relay_ws_token
    );
    let (mut stale_ws, _) = connect_async(join_url).await.expect("stale join tcp");
    match next_server_message(&mut stale_ws).await {
        ServerMessage::Welcome { .. } => {}
        other => panic!("stale ticket must Welcome during cleanup pause, got {other:?}"),
    }
    assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 1);

    go_tx.send(()).unwrap();
    let response = release_task.await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: AccessReleaseResponse = response.json().await.expect("json");
    assert!(body.released);
    // Final force-close must have cleared the seat before released=true returned.
    assert_eq!(broker.room_peer_count(&enrolled.broker_room_id).await, 0);
    assert_ws_closed_after_access_released("stale", &mut stale_ws).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn release_and_same_identity_reenrollment_serialize_on_lifecycle_lock() {
    use std::sync::mpsc::sync_channel;

    // Case A: release holds the lock; re-enrollment waits; old bearer dies; new works.
    let (at_release_tx, at_release_rx) = sync_channel::<()>(0);
    let (go_tx, go_rx) = sync_channel::<()>(0);
    let go_rx = std::sync::Mutex::new(go_rx);
    let once = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let once_h = std::sync::Arc::clone(&once);
    let access = std::sync::Arc::new(ScriptedAccessStrategy {
        authorize_hook: Some(std::sync::Arc::new(move |ctx: &AccessRequestContext| {
            if ctx.operation != AccessOperation::AccessRelease {
                return;
            }
            if once_h.fetch_add(1, std::sync::atomic::Ordering::SeqCst) != 0 {
                return;
            }
            tokio::task::block_in_place(|| {
                let _ = at_release_tx.send(());
                let _ = go_rx.lock().unwrap().recv();
            });
        })),
        ..ScriptedAccessStrategy::allow()
    });
    let (address, _, _) =
        spawn_public_mode_app_with_access_and_state(access.clone(), BrokerState::default()).await;
    let enrolled = enroll_relay(address, "release-vs-reenroll", None)
        .await
        .expect("enroll");
    let old_token = enrolled.relay_refresh_token.clone();

    let release_url = format!("http://{address}/api/public/relay/access/release");
    let release_body = AccessReleaseRequest {
        relay_id: enrolled.relay_id.clone(),
        broker_room_id: enrolled.broker_room_id.clone(),
    };
    let release_task = tokio::spawn({
        let old_token = old_token.clone();
        async move {
            reqwest::Client::new()
                .post(release_url)
                .bearer_auth(old_token)
                .json(&release_body)
                .send()
                .await
                .expect("release")
        }
    });
    tokio::task::spawn_blocking(move || at_release_rx.recv())
        .await
        .unwrap()
        .unwrap();

    let reenroll_task =
        tokio::spawn(async move { enroll_relay(address, "release-vs-reenroll", None).await });
    // Give re-enroll a moment to block on the lifecycle lock.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    go_tx.send(()).unwrap();

    let release_response = release_task.await.unwrap();
    assert_eq!(release_response.status(), reqwest::StatusCode::OK);
    let reenrolled = reenroll_task
        .await
        .unwrap()
        .expect("re-enrollment must succeed after release");
    assert_ne!(reenrolled.relay_refresh_token, old_token);

    let old_denied = public_post_response(
        address,
        "/api/public/relay/ws-token",
        &old_token,
        &RelayWsTokenRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            relay_peer_id: "old".to_string(),
        },
    )
    .await;
    assert_eq!(old_denied.status(), reqwest::StatusCode::UNAUTHORIZED);

    let _new_ok: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &reenrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: reenrolled.relay_id.clone(),
            broker_room_id: reenrolled.broker_room_id.clone(),
            relay_peer_id: "new".to_string(),
        },
    )
    .await;
}

#[tokio::test]
async fn release_after_reenroll_fails_reauth_before_strategy() {
    let access = std::sync::Arc::new(ScriptedAccessStrategy::allow());
    let address = spawn_public_mode_app_with_access(access.clone()).await;
    let enrolled = enroll_relay(address, "reenroll-wins", None)
        .await
        .expect("enroll");
    let old_token = enrolled.relay_refresh_token.clone();
    let reenrolled = enroll_relay(address, "reenroll-wins", None)
        .await
        .expect("re-enroll");
    assert_ne!(reenrolled.relay_refresh_token, old_token);

    let denied = public_post_response(
        address,
        "/api/public/relay/access/release",
        &old_token,
        &AccessReleaseRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
        },
    )
    .await;
    assert_eq!(denied.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(
        !access
            .seen_contexts()
            .iter()
            .any(|c| c.operation == AccessOperation::AccessRelease),
        "stale bearer must fail re-auth before strategy; must not unbind the new identity"
    );

    let _still: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &reenrolled.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: reenrolled.relay_id.clone(),
            broker_room_id: reenrolled.broker_room_id.clone(),
            relay_peer_id: "still".to_string(),
        },
    )
    .await;
}

#[tokio::test]
async fn required_public_control_plane_from_env_rejects_self_hosted_and_missing_issuer() {
    use std::sync::{Mutex, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();

    let prev_auth = std::env::var(crate::auth::BROKER_AUTH_MODE_ENV).ok();
    let prev_issuer = std::env::var(PUBLIC_ISSUER_SECRET_ENV).ok();
    let prev_state = std::env::var(crate::public_control::PUBLIC_STATE_PATH_ENV).ok();
    let prev_pg = std::env::var(crate::public_control::PUBLIC_POSTGRES_URL_ENV).ok();

    fn restore(key: &str, prev: Option<String>) {
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }

    std::env::remove_var(crate::auth::BROKER_AUTH_MODE_ENV);
    assert!(
        require_public_auth_mode_from_env().is_err(),
        "default self_hosted (no I/O)"
    );
    assert!(
        required_public_control_plane_from_env().await.is_err(),
        "default self_hosted"
    );

    std::env::set_var(crate::auth::BROKER_AUTH_MODE_ENV, "self_hosted");
    let err = match required_public_control_plane_from_env().await {
        Ok(_) => panic!("explicit self_hosted must fail"),
        Err(e) => e,
    };
    assert!(err.contains("public control plane is required"));

    std::env::set_var(crate::auth::BROKER_AUTH_MODE_ENV, "public");
    std::env::remove_var(PUBLIC_ISSUER_SECRET_ENV);
    std::env::remove_var(crate::public_control::PUBLIC_STATE_PATH_ENV);
    std::env::remove_var(crate::public_control::PUBLIC_POSTGRES_URL_ENV);
    let err = match required_public_control_plane_from_env().await {
        Ok(_) => panic!("public without issuer must fail"),
        Err(e) => e,
    };
    assert!(
        err.contains("public control plane is required but invalid")
            || err.contains("RELAY_BROKER_PUBLIC_ISSUER_SECRET"),
        "{err}"
    );

    // Valid public config constructs once without binding a listener.
    let dir = tempfile_dir("required-public-ok");
    let state_path = dir.join("public-control.json");
    std::env::set_var(PUBLIC_ISSUER_SECRET_ENV, "unit-test-issuer-secret");
    std::env::set_var(
        crate::public_control::PUBLIC_STATE_PATH_ENV,
        state_path.to_str().unwrap(),
    );
    let plane = required_public_control_plane_from_env()
        .await
        .expect("valid public config");
    assert!(plane.has_persistent_state());

    restore(crate::auth::BROKER_AUTH_MODE_ENV, prev_auth);
    restore(PUBLIC_ISSUER_SECRET_ENV, prev_issuer);
    restore(crate::public_control::PUBLIC_STATE_PATH_ENV, prev_state);
    restore(crate::public_control::PUBLIC_POSTGRES_URL_ENV, prev_pg);
}

fn tempfile_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "relay-broker-{label}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn admin_auth_outcome_disabled_when_no_token_configured() {
    // No configured token → endpoint disabled regardless of what is presented.
    assert_eq!(
        admin_auth_outcome(None, None),
        AdminAuthOutcome::Disabled,
        "unset admin token disables the endpoint"
    );
    assert_eq!(
        admin_auth_outcome(None, Some("anything")),
        AdminAuthOutcome::Disabled,
        "a presented token cannot enable a disabled endpoint"
    );
}

#[test]
fn admin_auth_outcome_requires_exact_token() {
    assert_eq!(
        admin_auth_outcome(Some("s3cret"), None),
        AdminAuthOutcome::Unauthorized,
        "missing token is unauthorized"
    );
    assert_eq!(
        admin_auth_outcome(Some("s3cret"), Some("wrong")),
        AdminAuthOutcome::Unauthorized,
        "wrong token is unauthorized"
    );
    assert_eq!(
        admin_auth_outcome(Some("s3cret"), Some("s3cret")),
        AdminAuthOutcome::Authorized,
        "exact token is authorized"
    );
}

#[test]
fn constant_time_eq_matches_only_identical_bytes() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(
        !constant_time_eq(b"abc", b"ab"),
        "length mismatch is not equal"
    );
    assert!(constant_time_eq(b"", b""), "empty equals empty");
}

// --- HTTP-level /api/admin/stats coverage -----------------------------------

#[tokio::test]
async fn admin_stats_disabled_is_indistinguishable_from_missing_route() {
    // With no admin token configured the route is not mounted, so hitting it must
    // look exactly like any other unknown path (same 404, same body) — no telltale.
    let address = spawn_public_mode_app_full(None).await;
    let client = reqwest::Client::new();

    let admin = client
        .get(format!("http://{address}/api/admin/stats"))
        .send()
        .await
        .expect("admin request");
    let missing = client
        .get(format!("http://{address}/api/definitely-not-a-route"))
        .send()
        .await
        .expect("missing request");

    assert_eq!(admin.status(), reqwest::StatusCode::NOT_FOUND);
    assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);
    let admin_body = admin.text().await.expect("admin body");
    let missing_body = missing.text().await.expect("missing body");
    assert_eq!(
        admin_body, missing_body,
        "a disabled admin endpoint must not be distinguishable by its body"
    );
}

#[tokio::test]
async fn admin_stats_requires_valid_token_and_returns_stats() {
    let token: std::sync::Arc<str> = std::sync::Arc::from("s3cret-operator-token");
    let address = spawn_public_mode_app_full(Some(token.clone())).await;
    let client = reqwest::Client::new();

    // Missing token → 401.
    let no_token = client
        .get(format!("http://{address}/api/admin/stats"))
        .send()
        .await
        .expect("no-token request");
    assert_eq!(no_token.status(), reqwest::StatusCode::UNAUTHORIZED);

    // Wrong token → 401.
    let wrong = client
        .get(format!("http://{address}/api/admin/stats"))
        .bearer_auth("not-the-token")
        .send()
        .await
        .expect("wrong-token request");
    assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);

    // Enroll a relay so the stats are non-trivial.
    let enrolled = enroll_relay(address, "admin-http", None)
        .await
        .expect("enroll should succeed");

    // Correct token → 200 with a stats payload reflecting the enrolled relay.
    let ok = client
        .get(format!("http://{address}/api/admin/stats"))
        .bearer_auth(token.as_ref())
        .send()
        .await
        .expect("valid-token request");
    assert_eq!(ok.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = ok.json().await.expect("stats json");
    assert!(
        body["totals"]["relays"].as_u64().unwrap_or(0) >= 1,
        "totals should count at least the enrolled relay, got {body}"
    );
    let relays = body["relays"].as_array().expect("relays is an array");
    assert!(
        relays
            .iter()
            .any(|r| r["relay_id"] == serde_json::json!(enrolled.relay_id)),
        "the enrolled relay must appear in the stats rows"
    );

    // Every publish-allowance counter must actually reach the wire. A metric that exists
    // only in the struct is not a metric an operator has — and these are the numbers the
    // observe-only global egress policy asks them to watch before deciding on enforcement.
    let publish_limits = &body["publish_limits"];
    for field in [
        "frame_limit_exceeded",
        "byte_limit_exceeded",
        "published_bytes",
        "egress_bytes",
        "peak_egress_bytes_per_minute",
        "global_egress_warnings",
    ] {
        assert!(
            publish_limits[field].is_u64(),
            "publish_limits.{field} must be present and numeric in the admin stats \
             payload, got {publish_limits}"
        );
    }
}

/// A relay publishing at the cadence it is *designed* for must not be throttled.
///
/// The relay's own constants put it well past the shared 240/minute allowance:
/// `TRANSCRIPT_DELTA_PUBLISH_WINDOW_MILLIS = 100` is up to 10 publishes a second during
/// streaming, plus up to 2 snapshots a second, plus a chunked action reply's 4 a second.
/// The allowance is 4 a second in total.
///
/// Exceeding it is not a soft failure: the broker drops the frame and keeps the socket
/// open, and the relay only slows its *snapshots* in response — transcript deltas keep
/// being sent and keep being discarded. A client then waits on content that was thrown
/// away. Chunked action replies are worse, because a client resolves one only after
/// every chunk lands, so a single dropped chunk costs it the full 15-second timeout.
///
/// The allowance exists to stop an abusive peer, and a relay is a first-party peer whose
/// legitimate traffic is an order of magnitude above a surface's. So the two get
/// separate budgets rather than the relay being squeezed into the surface's.
#[tokio::test]
async fn a_relays_designed_publish_cadence_is_not_rate_limited() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay socket should connect");
    let _welcome = next_server_message(&mut relay).await;

    let publish_frame = serde_json::to_string(&ClientMessage::Publish {
        protocol_version: protocol::BROKER_PROTOCOL_VERSION,
        payload: json!({"ciphertext":"abc"}),
    })
    .expect("client frame should serialize");

    // Comfortably past the surface allowance, and still under a minute of the relay's
    // real streaming rate.
    for _ in 0..300 {
        relay
            .send(Message::Text(publish_frame.clone()))
            .await
            .expect("publish should send");
    }

    // Nobody else is in the room, so the only thing that can come back is an error.
    let unexpected = tokio::time::timeout(
        std::time::Duration::from_millis(400),
        next_server_message(&mut relay),
    )
    .await;
    assert!(
        unexpected.is_err(),
        "the relay was rate limited at its own designed cadence: {unexpected:?}. The \
         broker drops those frames silently, so this is lost transcript content and \
         chunked replies the client can only time out on."
    );
}

/// …and a surface is still held to the tighter budget, so the split above is a
/// separation of concerns rather than a way to switch the protection off.
#[tokio::test]
async fn a_surface_is_still_held_to_the_tighter_publish_budget() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            publish_rate_limit_per_minute: 2,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let surface_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::device_surface_join("room-a", "device-1", None),
    );

    let (mut surface, _) = connect_async(&surface_url)
        .await
        .expect("surface socket should connect");
    let _welcome = next_server_message(&mut surface).await;

    let publish_frame = serde_json::to_string(&ClientMessage::Publish {
        protocol_version: protocol::BROKER_PROTOCOL_VERSION,
        payload: json!({"ciphertext":"abc"}),
    })
    .expect("client frame should serialize");
    for _ in 0..4 {
        surface
            .send(Message::Text(publish_frame.clone()))
            .await
            .expect("publish should send");
    }

    match next_server_message(&mut surface).await {
        ServerMessage::Error { code, .. } => assert_eq!(code, "rate_limited"),
        other => panic!("a surface over its budget must still be limited, got {other:?}"),
    }
}

/// Splitting the publish allowance must not quietly widen a deployment that had
/// deliberately tightened it.
///
/// `RELAY_BROKER_PUBLISH_RATE_LIMIT_PER_MINUTE` used to govern every peer. An operator
/// who set it low did so on purpose, and an upgrade that promotes relays to the much
/// larger relay default would be a hardening setting weakening itself on their behalf.
/// So the generic limit keeps governing relays until they opt into the split.
#[test]
fn an_explicit_generic_publish_limit_still_governs_relays() {
    assert_eq!(
        resolve_relay_publish_rate_limit(None, Some("60")).expect("limit parses"),
        60,
        "an operator who tightened the generic limit must keep it for relays too"
    );
    assert_eq!(
        resolve_relay_publish_rate_limit(Some("900"), Some("60")).expect("limit parses"),
        900,
        "setting the relay limit is how they opt into the split"
    );
    assert_eq!(
        resolve_relay_publish_rate_limit(None, None).expect("limit parses"),
        DEFAULT_RELAY_PUBLISH_RATE_LIMIT_PER_MINUTE,
        "an untouched deployment gets the relay default"
    );
    assert!(
        resolve_relay_publish_rate_limit(None, Some("nonsense")).is_err(),
        "a malformed limit must fail loudly rather than fall back to a wider default"
    );
}

// ---------------------------------------------------------------------------
// Byte-rate limiting
//
// The frame allowance above bounds how MANY frames a peer may publish, and says
// nothing about how BIG they are. A relay's 36000 frames/minute at the 64KiB
// frame cap is ~2.2GiB a minute from one peer, and a non-targeted payload fans
// out to every peer in the room on top of that. These tests pin the byte
// dimension, and — just as importantly — pin that it stays far enough above real
// traffic to never fire on it. A `rate_limited` is fatal for a relay: it ends the
// session and resyncs (see `relay-server/src/broker.rs`, the `rate_limited` arm),
// so a byte budget set too tight is not a throttle, it is a reconnect loop.
// ---------------------------------------------------------------------------

/// Publish frames just under the 64KiB frame cap, so a peer inside its *frame*
/// budget is still moving a lot of bytes.
fn large_publish_frame(payload_bytes: usize) -> String {
    serde_json::to_string(&ClientMessage::Publish {
        protocol_version: protocol::BROKER_PROTOCOL_VERSION,
        payload: json!({ "ciphertext": "x".repeat(payload_bytes) }),
    })
    .expect("client frame should serialize")
}

/// Pump `frame` into `socket` `count` times while watching for a server error,
/// so a `rate_limited` reply is observed as soon as it lands instead of after the
/// whole run. Returns the first error code the broker sent, if any.
///
/// Reading concurrently matters: without it a broker that starts replying mid-run
/// can fill the socket buffer and stall the sender.
async fn publish_until_error(
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    frame: String,
    count: usize,
) -> Option<String> {
    let (mut writer, mut reader) = socket.split();
    let sender = tokio::spawn(async move {
        for _ in 0..count {
            if writer.send(Message::Text(frame.clone())).await.is_err() {
                break;
            }
        }
    });

    let observed = tokio::time::timeout(std::time::Duration::from_secs(20), async move {
        while let Some(Ok(frame)) = reader.next().await {
            let Ok(text) = frame.into_text() else {
                continue;
            };
            if let Ok(ServerMessage::Error { code, .. }) = serde_json::from_str(&text) {
                return Some(code);
            }
        }
        None
    })
    .await
    .unwrap_or(None);

    sender.abort();
    observed
}

/// The hole this exists to close: a relay inside its frame budget can still push
/// bytes without bound.
///
/// 600 frames is a rounding error against the 36000/minute frame allowance, so the
/// frame limiter cannot be what stops this. At ~56KiB each they are ~33MiB, which
/// is far past any defensible per-minute byte budget — and today nothing counts
/// them at all.
#[tokio::test]
async fn a_relay_cannot_publish_unbounded_bytes_inside_its_frame_budget() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay socket should connect");
    let _welcome = next_server_message(&mut relay).await;

    let observed = publish_until_error(relay, large_publish_frame(56 * 1024), 600).await;

    assert_eq!(
        observed.as_deref(),
        Some("rate_limited"),
        "a relay pushed ~33MiB in 600 frames and the broker never objected. The frame \
         allowance cannot catch this — 600 frames is far inside 36000/minute — so \
         without a byte budget one peer can move gigabytes a minute."
    );
}

/// …and the budget must still sit above the traffic the relay is *designed* to
/// send, because being refused is not a throttle for a relay — it ends the session
/// and resyncs.
///
/// The largest legitimate burst is a chunked action reply: a workspace diff can be ~4MiB,
/// sent as `REMOTE_ACTION_RESULT_CHUNK_TARGET_BYTES` (32KiB) chunks.
///
/// The frames here are ~56KiB, not 32KiB, deliberately. A chunk's *payload* target is
/// 32KiB, but what the budget charges is the frame on the wire, and encryption plus
/// base64 plus the JSON envelope expand that by roughly a third. Sizing the test off the
/// plaintext target would quietly test a lighter load than production sends. These frames
/// sit just under `max_text_frame_bytes`, so they are at least as heavy as any real chunk
/// can be.
///
/// It is harsher than production in two further ways: the whole reply goes out as fast as
/// the socket allows, where real pacing is 50ms apart and lets the bucket refill
/// throughout, and 128 such frames is ~7MiB against a ~4MiB diff.
#[tokio::test]
async fn a_relays_largest_designed_reply_is_not_byte_limited() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay socket should connect");
    let _welcome = next_server_message(&mut relay).await;

    // 128 wire-sized chunks = ~7MiB, unpaced.
    let observed = publish_until_error(relay, large_publish_frame(56 * 1024), 128).await;

    assert_eq!(
        observed, None,
        "the relay was byte limited while sending one large-but-ordinary chunked reply. \
         A refused publish is fatal for a relay (it reconnects and resyncs), so this \
         budget would turn every big workspace diff into a session teardown."
    );
}

/// Reconnecting must not hand a peer a fresh budget.
///
/// The bucket is keyed by `(channel, peer)` and lives on broker state, not on the
/// connection, so dropping the socket and coming back does not clear it. If it
/// did, the budget would be advisory: any peer could reset it at will, and a relay
/// that gets refused reconnects *by design*.
#[tokio::test]
async fn reconnecting_does_not_reset_the_byte_budget() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );

    // First connection: spend the budget until the broker refuses.
    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay socket should connect");
    let _welcome = next_server_message(&mut relay).await;
    let first = publish_until_error(relay, large_publish_frame(56 * 1024), 600).await;
    assert_eq!(
        first.as_deref(),
        Some("rate_limited"),
        "precondition: the first connection should have exhausted the byte budget"
    );

    // Reconnect as the same peer and send a modest amount. The budget is still
    // spent, so this must be refused too.
    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay socket should reconnect");
    let _welcome = next_server_message(&mut relay).await;
    let second = publish_until_error(relay, large_publish_frame(56 * 1024), 64).await;

    assert_eq!(
        second.as_deref(),
        Some("rate_limited"),
        "a reconnect handed the peer a fresh byte budget. The bucket must outlive the \
         connection, or a refused peer can reset it simply by doing what a refused \
         relay already does automatically: reconnect."
    );
}

/// Burst is a separate quota, not a slice of the rate.
///
/// A rate alone would refuse the first large reply after an idle period — exactly when one
/// is most likely, because a surface that just opened a tab is what asks for a workspace
/// diff. So an idle peer may spend up to `burst_bytes` back-to-back, and then is held to
/// the sustained rate.
#[tokio::test]
async fn an_idle_peer_may_spend_its_burst_then_drops_to_the_sustained_rate() {
    let limiter = ByteRateLimiter::default();
    // 60 bytes/minute = 1 byte/second sustained, with a 1000-byte burst. The two are
    // deliberately far apart so the test cannot pass by confusing one for the other.
    let budget = ByteBudget {
        bytes_per_minute: 60,
        burst_bytes: 1_000,
    };

    assert!(
        limiter.charge("peer".to_string(), 1_000, budget).await,
        "an idle peer must be able to spend its whole burst at once"
    );
    assert!(
        !limiter.charge("peer".to_string(), 1_000, budget).await,
        "a second full burst back-to-back must be refused: the burst is a one-off \
         allowance that refills at the sustained rate, not a per-call ceiling"
    );
}

/// A refused charge must not deduct anything.
///
/// A relay that gets refused reconnects and retries. If a refusal still spent the tokens
/// it could not afford, every retry would push the peer further under and the bucket would
/// never recover — a limiter that latches instead of throttling.
#[tokio::test]
async fn a_refused_charge_does_not_spend_the_budget() {
    let limiter = ByteRateLimiter::default();
    let budget = ByteBudget {
        bytes_per_minute: 60,
        burst_bytes: 1_000,
    };

    for _ in 0..5 {
        assert!(
            !limiter.charge("peer".to_string(), 5_000, budget).await,
            "a charge above the burst ceiling can never be afforded"
        );
    }
    assert!(
        limiter.charge("peer".to_string(), 1_000, budget).await,
        "after five refusals the bucket must still hold its full burst; a refusal that \
         deducted would leave the peer permanently short"
    );
}

/// Setting the byte budget to zero switches it off.
///
/// The escape hatch matters because the failure mode of a too-tight relay budget is a
/// flapping session, not a slow one. An operator who hits that needs a way to turn the
/// control off without redeploying a build.
#[tokio::test]
async fn a_zero_byte_budget_disables_the_limit() {
    let limiter = ByteRateLimiter::default();
    let budget = ByteBudget {
        bytes_per_minute: 0,
        burst_bytes: 0,
    };

    for _ in 0..100 {
        assert!(
            limiter.charge("peer".to_string(), usize::MAX, budget).await,
            "a zero budget must admit everything, including a charge no bucket could hold"
        );
    }
}

/// A burst smaller than the frame cap would refuse frames the broker itself accepts —
/// and refuse them forever, since the bucket could never hold enough to pay for one.
/// A misconfigured burst must throttle, not brick, so it is raised to the frame cap.
#[test]
fn a_burst_below_the_frame_cap_is_raised_to_it() {
    let config = BrokerHardeningConfig {
        relay_publish_burst_bytes: 1_024,
        publish_burst_bytes: 1_024,
        max_text_frame_bytes: 64 * 1024,
        ..BrokerHardeningConfig::default()
    };

    for role in [protocol::PeerRole::Relay, protocol::PeerRole::Surface] {
        assert_eq!(
            config.byte_budget(role).burst_bytes,
            64 * 1024,
            "a burst under the frame cap must be raised to it, or {role:?} frames that \
             pass the frame cap would be permanently unaffordable"
        );
    }
}

/// The shipped defaults must leave the relay's real traffic comfortably affordable.
///
/// This is the arithmetic behind `DEFAULT_RELAY_PUBLISH_BYTES_PER_MINUTE`, pinned so a
/// future edit to the constant has to confront it.
///
/// Bounded by the **frame cap**, not by the chunk payload target.
///
/// Two earlier revisions of this constant were sized from the relay's chunk *payload*
/// target (32KiB) and were both wrong, because this budget charges the frame and the frame
/// is bigger — how much bigger depends on encoding layers that have already changed once
/// (chunks used to be base64'd a second time inside the encrypted envelope). Modelling that
/// chain here would be a third guess that drifts the next time the encoding moves.
///
/// So this derives the ceiling from something the broker owns and the relay must obey: the
/// relay's chunk builders halve the chunk until the frame fits `MAX_BROKER_TEXT_FRAME_BYTES`,
/// which is this broker's `max_text_frame_bytes`. A chunk frame therefore cannot exceed the
/// cap regardless of how many encodings are layered inside it, and cap x cadence is a true
/// upper bound that no relay-server encoding change can invalidate.
#[test]
fn the_default_relay_byte_budget_sits_well_above_real_traffic() {
    let config = BrokerHardeningConfig::default();
    let budget = config.byte_budget(protocol::PeerRole::Relay);

    // `REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS` is 50ms → 20 frames a second,
    // each at most one full frame.
    let chunks_per_minute = (1_000 / 50) * 60;
    let chunk_train_ceiling_per_minute = config.max_text_frame_bytes * chunks_per_minute;

    assert_eq!(
        chunk_train_ceiling_per_minute,
        75 * 1024 * 1024,
        "sanity: the chunk train ceiling should be 75MiB/min. Every doc comment quoting \
         that figure is now wrong if this changed."
    );
    assert!(
        budget.bytes_per_minute >= chunk_train_ceiling_per_minute * 6,
        "the relay byte budget ({} B/min) must stay well above the chunked reply ceiling \
         alone ({chunk_train_ceiling_per_minute} B/min), with room left for transcript \
         deltas and snapshots running at the same time. Being refused ends a relay session \
         and resyncs, so a budget near real traffic is a reconnect loop that spends more \
         bandwidth than it saves.",
        budget.bytes_per_minute
    );
    assert!(
        budget.burst_bytes >= 2 * config.max_text_frame_bytes * 100,
        "the burst must swallow a whole large workspace diff in one go. A ~4MiB diff \
         becomes ~7MiB on the wire once both base64 layers are applied, so sizing the \
         burst off the plaintext figure would refuse the first big reply after an idle \
         period — exactly when one is most likely."
    );
}

/// The byte budget follows the same migration rule as the frame budget: an operator who
/// tightens the generic setting keeps it for relays until they opt into the split.
#[test]
fn an_explicit_generic_byte_budget_still_governs_relays() {
    let resolve = |relay, generic| {
        resolve_relay_byte_setting(
            relay,
            generic,
            RELAY_PUBLISH_BYTES_ENV,
            PUBLISH_BYTES_ENV,
            DEFAULT_RELAY_PUBLISH_BYTES_PER_MINUTE,
        )
    };

    assert_eq!(
        resolve(None, Some("1024")).expect("budget parses"),
        1024,
        "an operator who tightened the generic byte budget must keep it for relays too"
    );
    assert_eq!(
        resolve(Some("2048"), Some("1024")).expect("budget parses"),
        2048,
        "setting the relay byte budget is how they opt into the split"
    );
    assert_eq!(
        resolve(None, None).expect("budget parses"),
        DEFAULT_RELAY_PUBLISH_BYTES_PER_MINUTE,
        "an untouched deployment gets the relay default"
    );
    assert!(
        resolve(None, Some("nonsense")).is_err(),
        "a malformed budget must fail loudly rather than fall back to a wider default"
    );
}

/// The global egress view observes; it never refuses.
///
/// Refusing on a global condition would punish a peer for its neighbours' traffic, and for
/// a relay that means a session teardown whose resync sends a full snapshot — the control
/// would amplify the overload it fired on. So this records, warns, and admits.
#[tokio::test]
async fn global_egress_is_metered_without_ever_refusing() {
    let metrics = PublishMetrics::default();

    metrics.record_egress(GLOBAL_EGRESS_WARN_BYTES_PER_MINUTE * 4);
    metrics.record_published(4_096);

    let snapshot = metrics.snapshot();
    assert_eq!(
        snapshot.egress_bytes,
        GLOBAL_EGRESS_WARN_BYTES_PER_MINUTE * 4,
        "egress must be accumulated even far past the warning threshold"
    );
    assert_eq!(
        snapshot.byte_limit_exceeded, 0,
        "crossing the global egress threshold must not be recorded as a peer refusal: \
         nothing was refused, and a future enforcement decision needs these separable"
    );
    assert_eq!(snapshot.published_bytes, 4_096);
}

/// A surface must not get a fresh budget by reconnecting.
///
/// This is the abuse-facing case, and it is the one the relay reconnect test above does
/// **not** cover: a relay's ticket pins its `peer_id`, so its bucket key is stable by
/// accident of that. A surface ticket pins nothing — the broker assigns a random
/// `peer_id` on every join (see `generated_peer_id`) — so keying the bucket on `peer_id`
/// hands the same credential a brand new burst every time it reconnects. At the default
/// 40 joins/minute that converts an 8MiB/minute budget into ~80MiB/minute, and concurrent
/// sockets multiply it further.
///
/// The budget must therefore key on the authenticated identity from the join ticket
/// (`device_id` / `pairing_id`), which the peer cannot roll by reconnecting.
#[tokio::test]
async fn a_surface_cannot_reset_its_byte_budget_by_reconnecting() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            // Effectively no refill, so the test measures the burst and nothing else.
            // The burst floor raises this to `max_text_frame_bytes` (64KiB).
            publish_bytes_per_minute: 1,
            publish_burst_bytes: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;

    // Same device credential every time; only the broker-assigned peer_id changes.
    let surface_url = || {
        websocket_url(
            address,
            "room-a",
            protocol::PeerRole::Surface,
            None,
            JoinTicketClaims::device_surface_join("room-a", "device-1", None),
        )
    };
    let frame = large_publish_frame(56 * 1024);

    let (mut surface, _) = connect_async(&surface_url())
        .await
        .expect("surface socket should connect");
    let first_peer_id = match next_server_message(&mut surface).await {
        ServerMessage::Welcome { peer_id, .. } => peer_id,
        other => panic!("expected welcome, got {other:?}"),
    };
    let first = publish_until_error(surface, frame.clone(), 4).await;
    assert_eq!(
        first.as_deref(),
        Some("rate_limited"),
        "precondition: the first connection should have exhausted the 64KiB burst"
    );

    // Reconnect on the same credential. The broker hands out a different peer_id.
    let (mut surface, _) = connect_async(&surface_url())
        .await
        .expect("surface socket should reconnect");
    let second_peer_id = match next_server_message(&mut surface).await {
        ServerMessage::Welcome { peer_id, .. } => peer_id,
        other => panic!("expected welcome, got {other:?}"),
    };
    assert_ne!(
        first_peer_id, second_peer_id,
        "precondition: surfaces are meant to get a fresh broker-assigned peer_id per join; \
         if that ever changes this test is no longer testing what it thinks it is"
    );

    // Exactly ONE frame, which is smaller than a fresh 64KiB burst. That is what makes
    // this test able to tell the two outcomes apart: a reset budget affords it, a carried
    // -over budget does not. Sending more would be refused either way and the test would
    // pass without proving anything.
    let second = publish_until_error(surface, frame, 1).await;
    assert_eq!(
        second.as_deref(),
        Some("rate_limited"),
        "a surface reset its byte budget by reconnecting. The bucket must key on the \
         authenticated ticket identity, not on the peer_id the broker freshly assigns on \
         every join — otherwise the limit is advisory for exactly the peers it targets."
    );
}

/// The same bypass applies to the frame allowance, which is keyed the same way.
///
/// Pre-existing rather than introduced by the byte budget, but it is the same key and the
/// same credential, so fixing one and leaving the other would just move the hole.
#[tokio::test]
async fn a_surface_cannot_reset_its_frame_budget_by_reconnecting() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            publish_rate_limit_per_minute: 2,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let surface_url = || {
        websocket_url(
            address,
            "room-a",
            protocol::PeerRole::Surface,
            None,
            JoinTicketClaims::device_surface_join("room-a", "device-1", None),
        )
    };
    let frame = large_publish_frame(16);

    let (mut surface, _) = connect_async(&surface_url())
        .await
        .expect("surface socket should connect");
    let _welcome = next_server_message(&mut surface).await;
    assert_eq!(
        publish_until_error(surface, frame.clone(), 4)
            .await
            .as_deref(),
        Some("rate_limited"),
        "precondition: the first connection should have exhausted the 2-frame allowance"
    );

    let (mut surface, _) = connect_async(&surface_url())
        .await
        .expect("surface socket should reconnect");
    let _welcome = next_server_message(&mut surface).await;

    // One frame, for the same reason as the byte test above: a fresh 2-frame allowance
    // would afford it, an already-spent one would not.
    assert_eq!(
        publish_until_error(surface, frame, 1).await.as_deref(),
        Some("rate_limited"),
        "a surface reset its frame allowance by reconnecting, for the same reason as the \
         byte budget: a broker-assigned peer_id is not an identity a limit can rest on."
    );
}

/// Two live connections on one credential share a budget.
///
/// The reconnect test proves a *sequential* bypass is closed; this proves the concurrent
/// one is too. Opening a second socket must not double the allowance, or the fix would
/// only have made the bypass slightly less convenient.
#[tokio::test]
async fn concurrent_connections_on_one_credential_share_a_byte_budget() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            publish_bytes_per_minute: 1,
            publish_burst_bytes: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let surface_url = || {
        websocket_url(
            address,
            "room-a",
            protocol::PeerRole::Surface,
            None,
            JoinTicketClaims::device_surface_join("room-a", "device-1", None),
        )
    };
    let frame = large_publish_frame(56 * 1024);

    // Both sockets open at once, same credential.
    let (mut first, _) = connect_async(&surface_url())
        .await
        .expect("first surface should connect");
    let _welcome = next_server_message(&mut first).await;
    let (mut second, _) = connect_async(&surface_url())
        .await
        .expect("second surface should connect");
    let _welcome = next_server_message(&mut second).await;

    // The first spends the shared 64KiB burst.
    assert_eq!(
        publish_until_error(first, frame.clone(), 4)
            .await
            .as_deref(),
        Some("rate_limited"),
        "precondition: the first socket should have exhausted the shared burst"
    );

    assert_eq!(
        publish_until_error(second, frame, 1).await.as_deref(),
        Some("rate_limited"),
        "a second concurrent socket on the same credential got its own budget. The \
         credential is the peer, not the socket."
    );
}

/// A completed minute must show up even if traffic stops.
///
/// Rolling the window only when the *next* frame arrives means a burst followed by silence
/// is never folded into the peak and never warns — the two things an operator would act
/// on. Reading the metric has to close an elapsed window too.
#[tokio::test(start_paused = true)]
async fn an_idle_completed_minute_still_reports_its_peak_and_warning() {
    let metrics = PublishMetrics::default();
    let burst = GLOBAL_EGRESS_WARN_BYTES_PER_MINUTE + 1;

    metrics.record_egress(burst);
    // Traffic stops. The minute completes with nothing to trigger a rollover.
    tokio::time::advance(Duration::from_secs(RATE_LIMIT_WINDOW_SECS + 1)).await;

    let snapshot = metrics.snapshot();
    assert_eq!(
        snapshot.peak_egress_bytes_per_minute, burst,
        "a completed minute must appear in the peak even though no further frame arrived \
         to roll the window"
    );
    assert_eq!(
        snapshot.global_egress_warnings, 1,
        "and it must warn: a burst followed by silence is exactly the shape an operator \
         needs told about"
    );
}

/// Egress must equal the bytes that actually went out — including for a targeted batch
/// whose payloads are wildly different sizes.
///
/// This is the case that killed the previous approach. Egress used to be estimated at
/// publish time by scaling the inbound frame by `delivered / targets`, which assumes every
/// target's payload is about the same size. One large delivered payload beside one tiny
/// undelivered one reported **half** the real figure, and more tiny missing targets made
/// it arbitrarily worse. Counting at the socket removes the assumption rather than
/// tightening it, so this asserts exact equality, not a tolerance.
///
/// It also covers fan-out and the small-message case in the same measurement: the numbers
/// compared are whatever the clients genuinely received.
#[tokio::test]
async fn reported_egress_equals_the_bytes_clients_actually_received() {
    let token: std::sync::Arc<str> = std::sync::Arc::from("s3cret-operator-token");
    let address = spawn_public_mode_app_full(Some(token.clone())).await;
    let http = reqwest::Client::new();

    let egress_now = |http: reqwest::Client, token: std::sync::Arc<str>| async move {
        let body: serde_json::Value = http
            .get(format!("http://{address}/api/admin/stats"))
            .bearer_auth(token.as_ref())
            .send()
            .await
            .expect("stats request")
            .json()
            .await
            .expect("stats json");
        body["publish_limits"]["egress_bytes"]
            .as_u64()
            .expect("egress_bytes must be reported")
    };

    // Two peers in one room. Both join as relays purely because a relay ws token is the
    // cheapest credential to mint here; egress accounting does not depend on role.
    let mut sockets = Vec::new();
    for peer in ["sender", "receiver-1"] {
        let ws_token: RelayWsTokenResponse = public_post(
            address,
            "/api/public/relay/ws-token",
            "relay-refresh-1",
            &RelayWsTokenRequest {
                relay_id: "relay-1".to_string(),
                broker_room_id: "room-a".to_string(),
                relay_peer_id: peer.to_string(),
            },
        )
        .await;
        let url = format!(
            "ws://{address}/ws/room-a?role=relay&peer_id={peer}&join_ticket={}",
            ws_token.relay_ws_token
        );
        let (socket, _) = connect_async(&url).await.expect("peer should connect");
        sockets.push(socket);
    }
    let mut receiver = sockets.pop().expect("receiver socket");
    let mut sender = sockets.pop().expect("sender socket");

    // Drain the welcome and the join presence so the baseline below is quiet.
    let _ = next_server_message(&mut sender).await;
    let _ = next_server_message(&mut sender).await;
    let _ = next_server_message(&mut receiver).await;

    let baseline = egress_now(http.clone(), token.clone()).await;

    // One large payload to a peer that IS connected, one empty payload to a peer that is
    // not. The estimator reported ~half of this; the truth is one large frame.
    let publish = serde_json::to_string(&ClientMessage::Publish {
        protocol_version: protocol::BROKER_PROTOCOL_VERSION,
        payload: json!({
            "kind": "targeted_messages",
            "messages": [
                {"target_peer_id": "receiver-1", "payload": {"ciphertext": "x".repeat(32 * 1024)}},
                {"target_peer_id": "absent-peer", "payload": {"ciphertext": ""}},
            ],
        }),
    })
    .expect("publish frame serializes");
    sender
        .send(Message::Text(publish))
        .await
        .expect("publish should send");

    // Exactly what arrived on the wire.
    let delivered = receiver
        .next()
        .await
        .expect("receiver should get the targeted message")
        .expect("frame decodes")
        .into_text()
        .expect("frame is text")
        .len() as u64;

    let after = egress_now(http.clone(), token.clone()).await;

    assert_eq!(
        after - baseline,
        delivered,
        "reported egress ({}) must equal the bytes the client actually received \
         ({delivered}). A targeted batch with unequal payloads is precisely where a \
         scaled estimate goes wrong.",
        after - baseline
    );
    assert!(
        delivered > 32 * 1024,
        "sanity: the delivered frame should be the large payload, got {delivered} bytes"
    );
}

/// The pairing branch of the identity must hold too.
///
/// A pairing surface carries `pairing_id` and no `device_id`, so it exercises a different
/// arm of `publish_limit_identity` than the device reconnect test. It is also the branch
/// that matters most for abuse: a pairing ticket is the credential encoded in a QR code,
/// which is the one an attacker is most likely to have a copy of.
#[tokio::test]
async fn a_pairing_surface_cannot_reset_its_byte_budget_by_reconnecting() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            publish_bytes_per_minute: 1,
            publish_burst_bytes: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let expires_at = unix_now_secs() + 300;
    let surface_url = || {
        websocket_url(
            address,
            "room-a",
            protocol::PeerRole::Surface,
            None,
            JoinTicketClaims::pairing_surface_join("room-a", "pairing-1", expires_at),
        )
    };
    let frame = large_publish_frame(56 * 1024);

    let (mut surface, _) = connect_async(&surface_url())
        .await
        .expect("pairing surface should connect");
    let _welcome = next_server_message(&mut surface).await;
    assert_eq!(
        publish_until_error(surface, frame.clone(), 4)
            .await
            .as_deref(),
        Some("rate_limited"),
        "precondition: the first connection should have exhausted the burst"
    );

    let (mut surface, _) = connect_async(&surface_url())
        .await
        .expect("pairing surface should reconnect");
    let _welcome = next_server_message(&mut surface).await;

    // One frame: affordable from a fresh burst, not from a spent one.
    assert_eq!(
        publish_until_error(surface, frame, 1).await.as_deref(),
        Some("rate_limited"),
        "a pairing surface reset its byte budget by reconnecting. `pairing_id` is the \
         stable identity for this branch, and it is the credential most likely to be \
         copied — a QR code."
    );
}

/// The bucket refills at the sustained rate, not in a lump.
///
/// Everything else about the budget is tested at its ceiling; this pins the slope between
/// ceilings. Paused time rather than sleeping, so the assertion is exact instead of racy.
#[tokio::test(start_paused = true)]
async fn a_depleted_bucket_refills_at_the_sustained_rate() {
    let limiter = ByteRateLimiter::default();
    // 600 bytes/minute = 10 bytes/second, burst 100.
    let budget = ByteBudget {
        bytes_per_minute: 600,
        burst_bytes: 100,
    };

    assert!(limiter.charge("peer".to_string(), 100, budget).await);
    assert!(
        !limiter.charge("peer".to_string(), 10, budget).await,
        "precondition: the burst is spent"
    );

    tokio::time::advance(Duration::from_secs(5)).await;
    assert!(
        limiter.charge("peer".to_string(), 50, budget).await,
        "five seconds at 10 B/s must have refilled 50 bytes"
    );
    assert!(
        !limiter.charge("peer".to_string(), 10, budget).await,
        "...and not a byte more: refill is a rate, not a reset"
    );

    // Refill must also stop at the burst ceiling rather than accruing without bound.
    tokio::time::advance(Duration::from_secs(600)).await;
    assert!(
        limiter.charge("peer".to_string(), 100, budget).await,
        "a long idle must refill to the full burst"
    );
    assert!(
        !limiter.charge("peer".to_string(), 1, budget).await,
        "but must not accrue beyond it — ten minutes idle at 10 B/s would be 6000 bytes \
         if the ceiling were not applied, which would hand an idle peer a free flood"
    );
}

/// Pruning must never hand a peer that is still in debt a fresh budget.
///
/// The map is pruned once it grows past `BYTE_BUCKET_PRUNE_THRESHOLD`, and pruning the
/// wrong entry is indistinguishable from resetting that peer's allowance — the exact bypass
/// the identity fix closed. Only fully-refilled buckets may be dropped.
#[tokio::test(start_paused = true)]
async fn pruning_keeps_buckets_that_are_still_in_debt() {
    let limiter = ByteRateLimiter::default();
    // Slow refill so the victim stays in debt for the whole test.
    let budget = ByteBudget {
        bytes_per_minute: 60,
        burst_bytes: 1_000,
    };

    // A peer that spends its whole burst: 1000 bytes of debt at 1 B/s is ~1000s to refill.
    assert!(limiter.charge("victim".to_string(), 1_000, budget).await);

    // Push the map past the prune threshold with peers that spend almost nothing, so they
    // refill to full quickly and become legitimately prunable.
    for index in 0..(BYTE_BUCKET_PRUNE_THRESHOLD * 2) {
        assert!(limiter.charge(format!("filler-{index}"), 1, budget).await);
    }
    let before = limiter.buckets.lock().await.len();

    // Ten seconds: enough for a 1-byte deficit to refill, nowhere near enough for 1000.
    tokio::time::advance(Duration::from_secs(10)).await;
    // One more charge to run the prune pass.
    assert!(limiter.charge("trigger".to_string(), 1, budget).await);
    let after = limiter.buckets.lock().await.len();

    assert!(
        after < before,
        "precondition: the prune pass must actually have dropped the settled buckets \
         ({before} -> {after}), otherwise this test proves nothing about selectivity"
    );
    assert!(
        !limiter.charge("victim".to_string(), 1_000, budget).await,
        "pruning dropped a bucket that was still in debt, handing that peer a fresh burst. \
         A limit that a peer can clear by waiting for unrelated churn is not a limit."
    );
}

/// A rejected join's error frame counts as egress too.
///
/// `reject_socket` writes its `ServerMessage` on a path of its own, so it was invisible to
/// the metric while the documentation claimed to count client-socket egress. That is the
/// one path an abusive client drives hardest — a flood of bad joins is all rejections — so
/// exempting it would blind the metric to exactly the traffic it exists to show.
///
/// This drives a REAL rejected join and reads the REAL metric over HTTP. An earlier version
/// re-implemented `reject_socket`'s body in the test and called `record_egress` itself,
/// which proved only that addition works: deleting the accounting from the actual function
/// left it green.
#[tokio::test]
async fn a_rejected_join_counts_its_error_frame_as_egress() {
    let token: std::sync::Arc<str> = std::sync::Arc::from("s3cret-operator-token");
    let address = spawn_public_mode_app_full(Some(token.clone())).await;
    let http = reqwest::Client::new();

    let egress_now = |http: reqwest::Client, token: std::sync::Arc<str>| async move {
        let body: serde_json::Value = http
            .get(format!("http://{address}/api/admin/stats"))
            .bearer_auth(token.as_ref())
            .send()
            .await
            .expect("stats request")
            .json()
            .await
            .expect("stats json");
        body["publish_limits"]["egress_bytes"]
            .as_u64()
            .expect("egress_bytes must be reported")
    };

    let baseline = egress_now(http.clone(), token.clone()).await;

    // A real join the broker refuses: well-formed URL, unusable ticket.
    let (mut socket, _) = connect_async(&format!(
        "ws://{address}/ws/room-a?role=relay&peer_id=relay-1&join_ticket=not-a-valid-ticket"
    ))
    .await
    .expect("the socket connects before the join is judged");

    let rejection = socket
        .next()
        .await
        .expect("the broker should send a rejection")
        .expect("frame decodes")
        .into_text()
        .expect("frame is text");
    let received = rejection.len() as u64;
    assert!(
        rejection.contains("join_rejected"),
        "expected a join rejection, got {rejection}"
    );

    let after = egress_now(http, token).await;
    assert_eq!(
        after - baseline,
        received,
        "the rejection frame must be counted, and counted exactly: the client read \
         {received} bytes"
    );
}

/// A frame cap configured below what a relay can emit must not brick large replies.
///
/// The relay fits its chunks against a **fixed** 64KiB limit compiled into relay-server; it
/// does not learn this broker's configured cap. So a cap set below that turns ordinary
/// encrypted chunks into `frame_too_large`, and the broker CLOSES the socket on that — the
/// relay reconnects, replays the same cached result, and fails identically. A workspace
/// diff becomes permanently undeliverable from a single hardening knob.
///
/// The floor is raised rather than the deploy refused, matching how a too-small publish
/// burst is handled: a misconfigured limit should throttle, never brick.
#[tokio::test]
async fn a_frame_cap_below_the_relays_fixed_size_is_raised_to_it() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            max_text_frame_bytes: 16 * 1024,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay socket should connect");
    let _welcome = next_server_message(&mut relay).await;

    // A chunk the size the relay actually produces, just under its fixed 64KiB ceiling.
    relay
        .send(Message::Text(large_publish_frame(60 * 1024)))
        .await
        .expect("publish should send");

    let unexpected = tokio::time::timeout(
        std::time::Duration::from_millis(400),
        next_server_message(&mut relay),
    )
    .await;
    assert!(
        unexpected.is_err(),
        "a relay-sized frame was refused by a broker configured below the relay's fixed \
         64KiB fitting limit: {unexpected:?}. The relay cannot negotiate this cap, so the \
         reply is undeliverable and the reconnect replays the same failure."
    );
}
