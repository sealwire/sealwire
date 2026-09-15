use std::time::Duration;

use relay_broker::{
    auth::BrokerAuthMode,
    join_ticket::{unix_now, JoinTicketClaims, JoinTicketKey, JOIN_TICKET_SECRET_ENV},
    public_control::{
        ClientGrantRequest, ClientGrantResponse, DeviceGrantBulkRevokeRequest,
        DeviceGrantBulkRevokeResponse, DeviceGrantRequest, DeviceGrantResponse,
        DeviceGrantRevokeRequest, DeviceGrantRevokeResponse, PairingWsTokenRequest,
        PairingWsTokenResponse, RelayEnrollmentChallengeRequest, RelayEnrollmentChallengeResponse,
        RelayEnrollmentResponse, RelayWsTokenRequest, RelayWsTokenResponse,
    },
};
use relay_util::trimmed_option_string;
use reqwest::{redirect::Policy, Client};
use serde::de::DeserializeOwned;
use serde::Serialize;
use url::Url;

pub(crate) const RELAY_BROKER_CONTROL_URL_ENV: &str = "RELAY_BROKER_CONTROL_URL";
pub(crate) const RELAY_BROKER_RELAY_ID_ENV: &str = "RELAY_BROKER_RELAY_ID";
pub(crate) const RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV: &str = "RELAY_BROKER_RELAY_REFRESH_TOKEN";
pub(crate) const RELAY_BROKER_REGISTRATION_PATH_ENV: &str = "RELAY_BROKER_REGISTRATION_PATH";
pub(crate) const RELAY_BROKER_DEVICE_JOIN_TTL_SECS_ENV: &str = "RELAY_BROKER_DEVICE_JOIN_TTL_SECS";

const CONTROL_PLANE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CONTROL_PLANE_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct PublicRelayRegistration {
    pub(crate) relay_id: String,
    pub(crate) broker_room_id: String,
    pub(crate) relay_refresh_token: String,
}

impl std::fmt::Debug for PublicRelayRegistration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PublicRelayRegistration")
            .field("relay_id", &self.relay_id)
            .field("broker_room_id", &self.broker_room_id)
            .field("relay_refresh_token", &"<redacted>")
            .finish()
    }
}

#[derive(Clone)]
pub(crate) struct BrokerJoinCredential {
    pub(crate) token: String,
    pub(crate) expires_at: Option<u64>,
}

impl std::fmt::Debug for BrokerJoinCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrokerJoinCredential")
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Clone)]
pub(crate) struct DeviceBrokerCredential {
    pub(crate) join_credential: BrokerJoinCredential,
    pub(crate) refresh_token: Option<String>,
}

impl std::fmt::Debug for DeviceBrokerCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceBrokerCredential")
            .field("join_credential", &self.join_credential)
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[derive(Clone, Debug)]
/// A relay's attestation that a client key may reach it.
///
/// Deliberately holds **no client credential**. The relay forwards this to the
/// device inside the sealed pairing result; the device signs the nonce and
/// redeems it against the broker itself, so the client token never transits a
/// relay. Before this split, every relay a browser had ever paired with held a
/// credential that authenticated that browser across all its other relays.
pub(crate) struct ClientBrokerGrant {
    pub(crate) claim_id: String,
    pub(crate) claim_nonce: String,
    pub(crate) claim_expires_at: u64,
    pub(crate) relay_id: String,
    pub(crate) relay_label: Option<String>,
}

#[derive(Clone)]
pub(crate) enum BrokerAuthConfig {
    SelfHostedSharedSecret {
        join_ticket_key: JoinTicketKey,
        device_join_ttl_secs: Option<u64>,
    },
    PublicControlPlane {
        control_url: Url,
        relay_id: String,
        relay_refresh_token: String,
        client: Client,
    },
}

impl std::fmt::Debug for BrokerAuthConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SelfHostedSharedSecret {
                device_join_ttl_secs,
                ..
            } => f
                .debug_struct("SelfHostedSharedSecret")
                .field("join_ticket_key", &"<redacted>")
                .field("device_join_ttl_secs", device_join_ttl_secs)
                .finish(),
            Self::PublicControlPlane {
                control_url,
                relay_id,
                ..
            } => f
                .debug_struct("PublicControlPlane")
                .field("control_url", control_url)
                .field("relay_id", relay_id)
                .field("relay_refresh_token", &"<redacted>")
                .field("client", &"<client>")
                .finish(),
        }
    }
}

impl BrokerAuthConfig {
    pub(crate) fn from_parts(
        auth_mode: Option<String>,
        join_ticket_secret: Option<String>,
        control_url: Option<String>,
        relay_id: Option<String>,
        relay_refresh_token: Option<String>,
        device_join_ttl_secs: Option<String>,
    ) -> Result<Self, String> {
        match BrokerAuthMode::parse(auth_mode)? {
            BrokerAuthMode::SelfHostedSharedSecret => {
                let join_ticket_secret =
                    trimmed_option_string(join_ticket_secret).ok_or_else(|| {
                        format!(
                            "{JOIN_TICKET_SECRET_ENV} is required in self-hosted broker auth mode"
                        )
                    })?;
                let join_ticket_key = JoinTicketKey::from_secret(join_ticket_secret.as_bytes())?;
                Ok(Self::SelfHostedSharedSecret {
                    join_ticket_key,
                    device_join_ttl_secs: parse_optional_u64_env(
                        RELAY_BROKER_DEVICE_JOIN_TTL_SECS_ENV,
                        device_join_ttl_secs,
                    )?,
                })
            }
            BrokerAuthMode::PublicControlPlane => {
                let control_url = trimmed_option_string(control_url).ok_or_else(|| {
                    format!("{RELAY_BROKER_CONTROL_URL_ENV} is required in public broker auth mode")
                })?;
                let relay_id = trimmed_option_string(relay_id).ok_or_else(|| {
                    format!("{RELAY_BROKER_RELAY_ID_ENV} is required in public broker auth mode")
                })?;
                let relay_refresh_token =
                    trimmed_option_string(relay_refresh_token).ok_or_else(|| {
                    format!(
                        "{RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV} is required in public broker auth mode"
                    )
                })?;
                let control_url = parse_control_plane_url(&control_url)?;
                Ok(Self::PublicControlPlane {
                    control_url,
                    relay_id,
                    relay_refresh_token,
                    client: build_control_plane_client()?,
                })
            }
        }
    }

    pub(crate) fn mode(&self) -> BrokerAuthMode {
        match self {
            Self::SelfHostedSharedSecret { .. } => BrokerAuthMode::SelfHostedSharedSecret,
            Self::PublicControlPlane { .. } => BrokerAuthMode::PublicControlPlane,
        }
    }

    pub(crate) async fn relay_connect_credential(
        &self,
        broker_room_id: &str,
        relay_peer_id: &str,
    ) -> Result<BrokerJoinCredential, String> {
        match self {
            Self::SelfHostedSharedSecret {
                join_ticket_key, ..
            } => Ok(BrokerJoinCredential {
                token: join_ticket_key
                    .mint(&JoinTicketClaims::relay_join(broker_room_id, relay_peer_id))?,
                expires_at: None,
            }),
            Self::PublicControlPlane {
                control_url,
                relay_id,
                relay_refresh_token,
                client,
            } => {
                let response: RelayWsTokenResponse = post_control_plane(
                    client,
                    control_url,
                    "/api/public/relay/ws-token",
                    relay_refresh_token,
                    &RelayWsTokenRequest {
                        relay_id: relay_id.clone(),
                        broker_room_id: broker_room_id.to_string(),
                        relay_peer_id: relay_peer_id.to_string(),
                    },
                )
                .await?;
                ensure_room_binding(broker_room_id, &response.broker_room_id)?;
                ensure_relay_binding(relay_id, &response.relay_id)?;
                Ok(BrokerJoinCredential {
                    token: response.relay_ws_token,
                    expires_at: Some(response.relay_ws_token_expires_at),
                })
            }
        }
    }

    pub(crate) async fn pairing_join_credential(
        &self,
        broker_room_id: &str,
        pairing_id: &str,
        expires_at: u64,
    ) -> Result<BrokerJoinCredential, String> {
        match self {
            Self::SelfHostedSharedSecret {
                join_ticket_key, ..
            } => Ok(BrokerJoinCredential {
                token: join_ticket_key.mint(&JoinTicketClaims::pairing_surface_join(
                    broker_room_id,
                    pairing_id,
                    expires_at,
                ))?,
                expires_at: Some(expires_at),
            }),
            Self::PublicControlPlane {
                control_url,
                relay_id,
                relay_refresh_token,
                client,
            } => {
                let response: PairingWsTokenResponse = post_control_plane(
                    client,
                    control_url,
                    "/api/public/pairing/ws-token",
                    relay_refresh_token,
                    &PairingWsTokenRequest {
                        relay_id: relay_id.clone(),
                        broker_room_id: broker_room_id.to_string(),
                        pairing_id: pairing_id.to_string(),
                        expires_at,
                    },
                )
                .await?;
                ensure_room_binding(broker_room_id, &response.broker_room_id)?;
                ensure_relay_binding(relay_id, &response.relay_id)?;
                Ok(BrokerJoinCredential {
                    token: response.pairing_join_ticket,
                    expires_at: Some(response.pairing_join_ticket_expires_at),
                })
            }
        }
    }

    pub(crate) async fn device_broker_credential(
        &self,
        broker_room_id: &str,
        device_id: &str,
        expires_at_override: Option<u64>,
    ) -> Result<DeviceBrokerCredential, String> {
        match self {
            Self::SelfHostedSharedSecret {
                join_ticket_key,
                device_join_ttl_secs,
            } => {
                let expires_at = expires_at_override.or_else(|| {
                    device_join_ttl_secs
                        .map(|ttl| unix_now().saturating_add(ttl))
                        .filter(|expires_at| *expires_at > 0)
                });
                Ok(DeviceBrokerCredential {
                    join_credential: BrokerJoinCredential {
                        token: join_ticket_key.mint(&JoinTicketClaims::device_surface_join(
                            broker_room_id,
                            device_id,
                            expires_at,
                        ))?,
                        expires_at,
                    },
                    refresh_token: None,
                })
            }
            Self::PublicControlPlane {
                control_url,
                relay_id,
                relay_refresh_token,
                client,
            } => {
                let response: DeviceGrantResponse = post_control_plane(
                    client,
                    control_url,
                    "/api/public/devices",
                    relay_refresh_token,
                    &DeviceGrantRequest {
                        relay_id: relay_id.clone(),
                        broker_room_id: broker_room_id.to_string(),
                        device_id: device_id.to_string(),
                    },
                )
                .await?;
                ensure_room_binding(broker_room_id, &response.broker_room_id)?;
                ensure_relay_binding(relay_id, &response.relay_id)?;
                ensure_device_binding(device_id, &response.device_id)?;
                Ok(DeviceBrokerCredential {
                    join_credential: BrokerJoinCredential {
                        token: response.device_ws_token,
                        expires_at: Some(response.device_ws_token_expires_at),
                    },
                    refresh_token: Some(response.device_refresh_token),
                })
            }
        }
    }

    pub(crate) async fn client_broker_grant(
        &self,
        broker_room_id: &str,
        device_id: &str,
        client_verify_key: &str,
        device_label: Option<String>,
    ) -> Result<Option<ClientBrokerGrant>, String> {
        match self {
            Self::SelfHostedSharedSecret { .. } => Ok(None),
            Self::PublicControlPlane {
                control_url,
                relay_id,
                relay_refresh_token,
                client,
            } => {
                let response: ClientGrantResponse = post_control_plane(
                    client,
                    control_url,
                    "/api/public/clients/grants",
                    relay_refresh_token,
                    &ClientGrantRequest {
                        relay_id: relay_id.clone(),
                        broker_room_id: broker_room_id.to_string(),
                        device_id: device_id.to_string(),
                        client_verify_key: client_verify_key.to_string(),
                        client_label: device_label.clone(),
                        device_label,
                    },
                )
                .await?;
                ensure_room_binding(broker_room_id, &response.broker_room_id)?;
                ensure_relay_binding(relay_id, &response.relay_id)?;
                ensure_device_binding(device_id, &response.device_id)?;
                Ok(Some(ClientBrokerGrant {
                    claim_id: response.claim_id,
                    claim_nonce: response.claim_nonce,
                    claim_expires_at: response.claim_expires_at,
                    relay_id: response.relay_id,
                    relay_label: response.relay_label,
                }))
            }
        }
    }

    pub(crate) async fn revoke_device_credential(
        &self,
        broker_room_id: &str,
        device_id: &str,
    ) -> Result<Option<DeviceGrantRevokeResponse>, String> {
        match self {
            Self::SelfHostedSharedSecret { .. } => Ok(None),
            Self::PublicControlPlane {
                control_url,
                relay_id,
                relay_refresh_token,
                client,
            } => {
                let path = format!("/api/public/devices/{device_id}/revoke");
                let response: DeviceGrantRevokeResponse = post_control_plane(
                    client,
                    control_url,
                    &path,
                    relay_refresh_token,
                    &DeviceGrantRevokeRequest {
                        relay_id: relay_id.clone(),
                        broker_room_id: broker_room_id.to_string(),
                    },
                )
                .await?;
                ensure_room_binding(broker_room_id, &response.broker_room_id)?;
                ensure_relay_binding(relay_id, &response.relay_id)?;
                ensure_device_binding(device_id, &response.device_id)?;
                Ok(Some(response))
            }
        }
    }

    pub(crate) async fn revoke_other_device_credentials(
        &self,
        broker_room_id: &str,
        keep_device_id: &str,
    ) -> Result<Option<DeviceGrantBulkRevokeResponse>, String> {
        match self {
            Self::SelfHostedSharedSecret { .. } => Ok(None),
            Self::PublicControlPlane {
                control_url,
                relay_id,
                relay_refresh_token,
                client,
            } => {
                let response: DeviceGrantBulkRevokeResponse = post_control_plane(
                    client,
                    control_url,
                    "/api/public/devices/revoke-others",
                    relay_refresh_token,
                    &DeviceGrantBulkRevokeRequest {
                        relay_id: relay_id.clone(),
                        broker_room_id: broker_room_id.to_string(),
                        keep_device_id: keep_device_id.to_string(),
                    },
                )
                .await?;
                ensure_room_binding(broker_room_id, &response.broker_room_id)?;
                ensure_relay_binding(relay_id, &response.relay_id)?;
                ensure_device_binding(keep_device_id, &response.kept_device_id)?;
                Ok(Some(response))
            }
        }
    }

    pub(crate) fn device_join_ttl_secs(&self) -> Option<u64> {
        match self {
            Self::SelfHostedSharedSecret {
                device_join_ttl_secs,
                ..
            } => *device_join_ttl_secs,
            Self::PublicControlPlane { .. } => None,
        }
    }

    pub(crate) fn predicted_device_join_expires_at(&self, now: u64) -> Option<u64> {
        match self {
            Self::SelfHostedSharedSecret {
                device_join_ttl_secs,
                ..
            } => device_join_ttl_secs.map(|ttl| now.saturating_add(ttl)),
            Self::PublicControlPlane { .. } => None,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PublicRelayEnrollmentChallenge {
    pub(crate) challenge_id: String,
    pub(crate) challenge: String,
    pub(crate) expires_at: u64,
}

pub(crate) async fn request_public_relay_enrollment_challenge(
    client: &Client,
    control_url: &Url,
    relay_verify_key: String,
    relay_label: Option<String>,
) -> Result<PublicRelayEnrollmentChallenge, String> {
    let response: RelayEnrollmentChallengeResponse = post_control_plane_without_auth(
        client,
        control_url,
        "/api/public/relay-enrollment/challenge",
        &RelayEnrollmentChallengeRequest {
            relay_verify_key,
            relay_label,
        },
    )
    .await?;
    Ok(PublicRelayEnrollmentChallenge {
        challenge_id: response.challenge_id,
        challenge: response.challenge,
        expires_at: response.expires_at,
    })
}

pub(crate) async fn complete_public_relay_enrollment(
    client: &Client,
    control_url: &Url,
    relay_verify_key: String,
    challenge_id: String,
    challenge_signature: String,
    relay_label: Option<String>,
    enrollment_token: Option<&str>,
) -> Result<PublicRelayRegistration, String> {
    #[derive(Serialize)]
    struct CompleteBody<'a> {
        relay_verify_key: &'a str,
        challenge_id: &'a str,
        challenge_signature: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        relay_label: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        enrollment_token: Option<&'a str>,
    }

    let response: RelayEnrollmentResponse = post_control_plane_without_auth(
        client,
        control_url,
        "/api/public/relay-enrollment/complete",
        &CompleteBody {
            relay_verify_key: &relay_verify_key,
            challenge_id: &challenge_id,
            challenge_signature: &challenge_signature,
            relay_label: relay_label.as_deref(),
            enrollment_token,
        },
    )
    .await?;
    Ok(PublicRelayRegistration {
        relay_id: response.relay_id,
        broker_room_id: response.broker_room_id,
        relay_refresh_token: response.relay_refresh_token,
    })
}

pub(crate) fn build_control_plane_client() -> Result<Client, String> {
    build_control_plane_client_with_timeout(CONTROL_PLANE_TIMEOUT)
}

pub(crate) fn build_control_plane_client_with_timeout(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|error| format!("failed to build broker control-plane client: {error}"))
}

pub(crate) fn parse_control_plane_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| {
        format!("invalid {RELAY_BROKER_CONTROL_URL_ENV}: could not parse control URL")
    })?;
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "{RELAY_BROKER_CONTROL_URL_ENV} must use http:// or https://"
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!(
            "{RELAY_BROKER_CONTROL_URL_ENV} must not include userinfo credentials"
        ));
    }
    Ok(url)
}

async fn post_control_plane<TReq, TResp>(
    client: &Client,
    base_url: &Url,
    path: &str,
    bearer_token: &str,
    request: &TReq,
) -> Result<TResp, String>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    let mut url = base_url.clone();
    url.set_path(path);
    url.set_query(None);

    let response = client
        .post(url.clone())
        .bearer_auth(bearer_token)
        .json(request)
        .send()
        .await
        .map_err(|error| format!("failed to reach broker control-plane {url}: {error}"))?;
    decode_control_plane_response(url, response).await
}

async fn post_control_plane_without_auth<TReq, TResp>(
    client: &Client,
    base_url: &Url,
    path: &str,
    request: &TReq,
) -> Result<TResp, String>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    let mut url = base_url.clone();
    url.set_path(path);
    url.set_query(None);

    let response = client
        .post(url.clone())
        .json(request)
        .send()
        .await
        .map_err(|error| format!("failed to reach broker control-plane {url}: {error}"))?;

    decode_control_plane_response(url, response).await
}

async fn decode_control_plane_response<TResp>(
    url: Url,
    response: reqwest::Response,
) -> Result<TResp, String>
where
    TResp: DeserializeOwned,
{
    let status = response.status();
    if status.is_redirection() {
        return Err(format!(
            "broker control-plane {url} refused a redirect (HTTP {status})"
        ));
    }

    if let Some(len) = response.content_length() {
        if len > MAX_CONTROL_PLANE_RESPONSE_BYTES as u64 {
            return Err(format!(
                "broker control-plane response exceeded {MAX_CONTROL_PLANE_RESPONSE_BYTES} bytes"
            ));
        }
    }

    let bytes = read_body_bounded(response, MAX_CONTROL_PLANE_RESPONSE_BYTES).await?;

    if !status.is_success() {
        let code = serde_json::from_slice::<ControlPlaneErrorResponse>(&bytes)
            .ok()
            .and_then(|parsed| parsed.error)
            .unwrap_or_else(|| "unavailable".to_string());
        return Err(map_control_plane_failure(status.as_u16(), &code));
    }

    serde_json::from_slice::<TResp>(&bytes).map_err(|error| {
        format!("failed to decode broker control-plane response from {url}: {error}")
    })
}

async fn read_body_bounded(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buf = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("failed to read control-plane body: {error}"))?;
        if buf.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!(
                "broker control-plane response exceeded {max_bytes} bytes"
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

#[derive(Debug, serde::Deserialize)]
struct ControlPlaneErrorResponse {
    error: Option<String>,
}

fn map_control_plane_failure(status: u16, code: &str) -> String {
    if let Some(message) = known_control_plane_error_code(code) {
        return message.to_string();
    }
    match status {
        429 => "broker control-plane rate-limited; try again later".to_string(),
        403 => "broker control-plane request forbidden".to_string(),
        409 => "broker enrollment conflict or already bound".to_string(),
        401 => "cloud access key is invalid, expired, or revoked".to_string(),
        503 => "broker control-plane temporarily unavailable".to_string(),
        _ => "broker control-plane request failed".to_string(),
    }
}

fn known_control_plane_error_code(code: &str) -> Option<&'static str> {
    match code {
        "device_limit_reached" => Some("device limit reached"),
        "rate_limited" => Some("broker control-plane rate-limited; try again later"),
        "forbidden" => Some("broker control-plane request forbidden"),
        "unavailable" => Some("broker control-plane temporarily unavailable"),
        "conflict" => Some("broker enrollment conflict or already bound"),
        "unauthorized" | "invalid" | "expired" | "revoked" => {
            Some("cloud access key is invalid, expired, or revoked")
        }
        _ => None,
    }
}

fn ensure_room_binding(expected: &str, actual: &str) -> Result<(), String> {
    if actual == expected {
        return Ok(());
    }
    Err(format!(
        "broker control-plane returned broker_room_id `{actual}`, expected `{expected}`"
    ))
}

fn ensure_relay_binding(expected: &str, actual: &str) -> Result<(), String> {
    if actual == expected {
        return Ok(());
    }
    Err(format!(
        "broker control-plane returned relay_id `{actual}`, expected `{expected}`"
    ))
}

fn ensure_device_binding(expected: &str, actual: &str) -> Result<(), String> {
    if actual == expected {
        return Ok(());
    }
    Err(format!(
        "broker control-plane returned device_id `{actual}`, expected `{expected}`"
    ))
}

fn parse_optional_u64_env(name: &str, value: Option<String>) -> Result<Option<u64>, String> {
    let Some(value) = trimmed_option_string(value) else {
        return Ok(None);
    };
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| format!("{name} must be a positive integer: {error}"))
}

#[cfg(test)]
mod control_plane_tests {
    use super::*;

    #[test]
    fn public_relay_registration_debug_redacts_refresh_token() {
        let reg = PublicRelayRegistration {
            relay_id: "r1".into(),
            broker_room_id: "room".into(),
            relay_refresh_token: "secret-refresh".into(),
        };
        let rendered = format!("{reg:?}");
        assert!(!rendered.contains("secret-refresh"));
        assert!(rendered.contains("redacted"));
    }

    #[test]
    fn parse_control_plane_url_rejects_userinfo() {
        let err = parse_control_plane_url("https://user:pass@broker.example/").unwrap_err();
        assert!(err.contains("userinfo"));
        assert!(!err.contains("pass"));
        assert!(!err.contains("user:"));
    }

    #[test]
    fn parse_control_plane_url_malformed_secret_is_not_echoed() {
        let secret = "exact-secret-in-malformed-url";
        let err = parse_control_plane_url(&format!("not a url {secret}")).unwrap_err();
        assert!(!err.contains(secret), "got: {err}");
        assert!(err.contains("could not parse"));
    }

    #[test]
    fn map_control_plane_status_never_echoes_remote_prose() {
        let msg = map_control_plane_failure(400, "invalid");
        assert!(!msg.contains("bad "));
        assert!(msg.contains("invalid") || msg.contains("expired") || msg.contains("revoked"));
    }

    #[test]
    fn map_control_plane_preserves_device_limit_code() {
        let msg = map_control_plane_failure(403, "device_limit_reached");
        assert!(msg.contains("device limit"));
        assert!(!msg.contains("license allows"));
    }

    #[test]
    fn map_control_plane_never_interpolates_unknown_remote_code() {
        let secret = "exact-secret-as-error-code";
        let msg = map_control_plane_failure(400, secret);
        assert!(!msg.contains(secret));
        assert_eq!(msg, "broker control-plane request failed");
    }
}
