use relay_broker::{
    auth::BrokerAuthMode,
    join_ticket::{unix_now, JoinTicketClaims, JoinTicketKey, JOIN_TICKET_SECRET_ENV},
    public_control::{
        ClientGrantRequest, ClientGrantResponse, DeviceGrantBulkRevokeRequest,
        DeviceGrantBulkRevokeResponse, DeviceGrantRequest, DeviceGrantResponse,
        DeviceGrantRevokeRequest, DeviceGrantRevokeResponse, PairingWsTokenRequest,
        PairingWsTokenResponse, RelayEnrollmentChallengeRequest, RelayEnrollmentChallengeResponse,
        RelayEnrollmentCompleteRequest, RelayEnrollmentResponse, RelayWsTokenRequest,
        RelayWsTokenResponse,
    },
};
use relay_util::trimmed_option_string;
use reqwest::Client;
use serde::de::DeserializeOwned;
use url::Url;

pub(crate) const RELAY_BROKER_CONTROL_URL_ENV: &str = "RELAY_BROKER_CONTROL_URL";
pub(crate) const RELAY_BROKER_RELAY_ID_ENV: &str = "RELAY_BROKER_RELAY_ID";
pub(crate) const RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV: &str = "RELAY_BROKER_RELAY_REFRESH_TOKEN";
pub(crate) const RELAY_BROKER_REGISTRATION_PATH_ENV: &str = "RELAY_BROKER_REGISTRATION_PATH";
pub(crate) const RELAY_BROKER_DEVICE_JOIN_TTL_SECS_ENV: &str = "RELAY_BROKER_DEVICE_JOIN_TTL_SECS";

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct PublicRelayRegistration {
    pub(crate) relay_id: String,
    pub(crate) broker_room_id: String,
    pub(crate) relay_refresh_token: String,
}

#[derive(Clone, Debug)]
pub(crate) struct BrokerJoinCredential {
    pub(crate) token: String,
    pub(crate) expires_at: Option<u64>,
}

#[derive(Clone, Debug)]
pub(crate) struct DeviceBrokerCredential {
    pub(crate) join_credential: BrokerJoinCredential,
    pub(crate) refresh_token: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ClientBrokerGrant {
    pub(crate) client_id: String,
    pub(crate) refresh_token: String,
    pub(crate) relay_id: String,
    pub(crate) relay_label: Option<String>,
}

#[derive(Clone, Debug)]
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
                let control_url = Url::parse(&control_url).map_err(|error| {
                    format!("invalid {RELAY_BROKER_CONTROL_URL_ENV} `{control_url}`: {error}")
                })?;
                let scheme = control_url.scheme().to_ascii_lowercase();
                if scheme != "http" && scheme != "https" {
                    return Err(format!(
                        "{RELAY_BROKER_CONTROL_URL_ENV} must use http:// or https://"
                    ));
                }
                Ok(Self::PublicControlPlane {
                    control_url,
                    relay_id,
                    relay_refresh_token,
                    client: Client::new(),
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
                    client_id: response.client_id,
                    refresh_token: response.client_refresh_token,
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

#[derive(Debug, serde::Deserialize)]
struct ControlPlaneErrorResponse {
    message: Option<String>,
    error: Option<String>,
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
) -> Result<PublicRelayRegistration, String> {
    let response: RelayEnrollmentResponse = post_control_plane_without_auth(
        client,
        control_url,
        "/api/public/relay-enrollment/complete",
        &RelayEnrollmentCompleteRequest {
            relay_verify_key,
            challenge_id,
            challenge_signature,
            relay_label,
        },
    )
    .await?;
    Ok(PublicRelayRegistration {
        relay_id: response.relay_id,
        broker_room_id: response.broker_room_id,
        relay_refresh_token: response.relay_refresh_token,
    })
}

async fn post_control_plane<TReq, TResp>(
    client: &Client,
    base_url: &Url,
    path: &str,
    bearer_token: &str,
    request: &TReq,
) -> Result<TResp, String>
where
    TReq: serde::Serialize + ?Sized,
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
    TReq: serde::Serialize + ?Sized,
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
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if let Ok(parsed) = serde_json::from_str::<ControlPlaneErrorResponse>(&body) {
            if let Some(message) = parsed.message.or(parsed.error) {
                return Err(scrub_sensitive_control_plane_message(&message));
            }
        }
        return Err(format!("broker control-plane {url} returned {status}"));
    }

    response.json::<TResp>().await.map_err(|error| {
        format!("failed to decode broker control-plane response from {url}: {error}")
    })
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

fn scrub_sensitive_control_plane_message(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if [
        "pairing_secret",
        "refresh_token",
        "join_ticket",
        "ws_token",
        "authorization",
        "bearer ",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return "broker control-plane request failed".to_string();
    }
    message.to_string()
}
