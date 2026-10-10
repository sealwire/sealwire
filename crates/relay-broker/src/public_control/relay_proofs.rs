use std::collections::HashMap;

use ed25519_dalek::{Signature, Verifier};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::{
    check_id_length, decode_base64_array, enrolled_relay_verify_key, parse_relay_verifying_key,
    random_token, sha256_hex, trimmed_option_string, unix_now, JoinTicketClaims,
    PublicControlPlane, RelayControlChallengeRequest, RelayControlChallengeResponse,
    RelayWsTokenChallengeRequest, RelayWsTokenChallengeResponse, RelayWsTokenRequest,
    RelayWsTokenResponse, DEFAULT_RELAY_WS_TICKET_ORIGIN,
    MAX_PENDING_RELAY_CONTROL_CHALLENGES_PER_RELAY,
    MAX_PENDING_RELAY_WS_TICKET_CHALLENGES_PER_RELAY, MAX_TICKET_ORIGIN_BYTES, PUBLIC_ORIGIN_ENV,
};

#[derive(Clone, PartialEq, Eq)]
struct RelayProofIdentity {
    refresh_token_hash: String,
    relay_id: String,
    broker_room_id: String,
    broker_origin: String,
    relay_verify_key: String,
}

#[derive(Clone, PartialEq, Eq)]
enum RelayProofTarget {
    WsTicket {
        peer_id: String,
    },
    Control {
        operation: String,
        request_sha256: String,
    },
}

impl RelayProofTarget {
    fn label(&self) -> &'static str {
        match self {
            Self::WsTicket { .. } => "relay ws ticket",
            Self::Control { .. } => "relay control",
        }
    }

    fn challenge_parameters(&self) -> (&'static str, &'static str, usize) {
        match self {
            Self::WsTicket { .. } => (
                "wch",
                "wt",
                MAX_PENDING_RELAY_WS_TICKET_CHALLENGES_PER_RELAY,
            ),
            Self::Control { .. } => ("cch", "ct", MAX_PENDING_RELAY_CONTROL_CHALLENGES_PER_RELAY),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct RelayProofContext {
    identity: RelayProofIdentity,
    target: RelayProofTarget,
}

impl RelayProofContext {
    fn message(&self, id: &str, nonce: &str) -> Result<Vec<u8>, String> {
        let identity = &self.identity;
        match &self.target {
            RelayProofTarget::WsTicket { peer_id } => relay_ws_ticket_message(
                &identity.broker_origin,
                id,
                nonce,
                &identity.relay_id,
                &identity.broker_room_id,
                peer_id,
                &identity.refresh_token_hash,
            ),
            RelayProofTarget::Control {
                operation,
                request_sha256,
            } => relay_control_message(
                &identity.broker_origin,
                id,
                nonce,
                operation,
                &identity.relay_id,
                &identity.broker_room_id,
                &identity.refresh_token_hash,
                request_sha256,
            ),
        }
    }
}

pub(super) struct PendingRelayProofChallenge {
    context: RelayProofContext,
    challenge: String,
    expires_at: u64,
}

struct IssuedRelayProofChallenge {
    challenge_id: String,
    challenge: String,
    expires_at: u64,
}

type RelayProofChallenges = Mutex<HashMap<String, PendingRelayProofChallenge>>;

impl PublicControlPlane {
    async fn relay_proof_identity(
        &self,
        bearer: &str,
        relay_id: &str,
        room: &str,
    ) -> Result<RelayProofIdentity, String> {
        let registration = self.authenticate_relay(bearer, relay_id, room).await?;
        Ok(RelayProofIdentity {
            refresh_token_hash: sha256_hex(bearer.trim()),
            relay_verify_key: enrolled_relay_verify_key(&registration)?,
            relay_id: registration.relay_id,
            broker_room_id: registration.broker_room_id,
            broker_origin: self.inner.ticket_origin.clone(),
        })
    }

    async fn create_relay_proof_challenge(
        &self,
        challenges: &RelayProofChallenges,
        context: &RelayProofContext,
    ) -> Result<IssuedRelayProofChallenge, String> {
        let now = unix_now();
        let expires_at = now.saturating_add(self.inner.relay_ws_ticket_challenge_ttl_secs);
        let (id_prefix, nonce_prefix, capacity) = context.target.challenge_parameters();
        let issued = IssuedRelayProofChallenge {
            challenge_id: format!("{id_prefix}-{}", random_token(24).to_ascii_lowercase()),
            challenge: format!("{nonce_prefix}-{}", random_token(40).to_ascii_lowercase()),
            expires_at,
        };
        let mut pending = challenges.lock().await;
        pending.retain(|_, item| item.expires_at > now);
        if pending
            .values()
            .filter(|entry| entry.context.identity.relay_id == context.identity.relay_id)
            .count()
            >= capacity
        {
            return Err(format!(
                "too many pending {} challenges; retry shortly",
                context.target.label()
            ));
        }
        pending.insert(
            issued.challenge_id.clone(),
            PendingRelayProofChallenge {
                context: context.clone(),
                challenge: issued.challenge.clone(),
                expires_at,
            },
        );
        Ok(issued)
    }

    async fn consume_relay_proof_challenge(
        &self,
        challenges: &RelayProofChallenges,
        expected: &RelayProofContext,
        challenge_id: &str,
        signature: &str,
    ) -> Result<(), String> {
        let label = expected.target.label();
        let mut challenges = challenges.lock().await;
        let Some(pending) = challenges.get(challenge_id) else {
            return Err(format!("{label} challenge was not found"));
        };
        if pending.expires_at <= unix_now() {
            challenges.remove(challenge_id);
            return Err(format!("{label} challenge has expired"));
        }
        if &pending.context != expected {
            return Err(format!("{label} challenge was not issued for this request"));
        }
        let message = pending.context.message(challenge_id, &pending.challenge)?;
        // Invalid proofs leave the challenge usable; verification and consumption share a lock.
        verify_relay_signature(
            &expected.identity.relay_verify_key,
            &message,
            signature,
            &format!("{label} proof was rejected"),
        )?;
        challenges.remove(challenge_id);
        Ok(())
    }

    pub async fn create_relay_ws_ticket_challenge(
        &self,
        bearer: &str,
        request: RelayWsTokenChallengeRequest,
    ) -> Result<RelayWsTokenChallengeResponse, String> {
        let identity = self
            .relay_proof_identity(bearer, &request.relay_id, &request.broker_room_id)
            .await?;
        let peer_id = trimmed_option_string(Some(request.relay_peer_id))
            .ok_or_else(|| "relay peer id is required".to_string())?;
        check_id_length("relay peer id", &peer_id)?;
        let context = RelayProofContext {
            identity,
            target: RelayProofTarget::WsTicket {
                peer_id: peer_id.clone(),
            },
        };
        let issued = self
            .create_relay_proof_challenge(&self.inner.relay_ws_ticket_challenges, &context)
            .await?;
        let identity = context.identity;
        Ok(RelayWsTokenChallengeResponse {
            challenge_id: issued.challenge_id,
            challenge: issued.challenge,
            expires_at: issued.expires_at,
            relay_id: identity.relay_id,
            broker_room_id: identity.broker_room_id,
            relay_peer_id: peer_id,
            broker_origin: identity.broker_origin,
            refresh_token_hash: identity.refresh_token_hash,
        })
    }

    pub async fn issue_relay_ws_token(
        &self,
        bearer: &str,
        request: RelayWsTokenRequest,
    ) -> Result<RelayWsTokenResponse, String> {
        let identity = self
            .relay_proof_identity(bearer, &request.relay_id, &request.broker_room_id)
            .await?;
        let challenge_id = trimmed_option_string(Some(request.challenge_id))
            .ok_or_else(|| "relay ws ticket challenge id is required".to_string())?;
        let signature = trimmed_option_string(Some(request.challenge_signature))
            .ok_or_else(|| "relay ws ticket challenge signature is required".to_string())?;
        let peer_id = trimmed_option_string(Some(request.relay_peer_id))
            .ok_or_else(|| "relay peer id is required".to_string())?;
        check_id_length("relay peer id", &peer_id)?;
        check_id_length("relay ws ticket challenge id", &challenge_id)?;
        let context = RelayProofContext {
            identity,
            target: RelayProofTarget::WsTicket {
                peer_id: peer_id.clone(),
            },
        };
        self.consume_relay_proof_challenge(
            &self.inner.relay_ws_ticket_challenges,
            &context,
            &challenge_id,
            &signature,
        )
        .await?;
        let identity = context.identity;
        let expires_at = unix_now().saturating_add(self.inner.relay_ws_ttl_secs);
        Ok(RelayWsTokenResponse {
            relay_id: identity.relay_id.clone(),
            broker_room_id: identity.broker_room_id.clone(),
            relay_ws_token: self.inner.issuer_key.mint(
                &JoinTicketClaims::relay_join_with_expiry(
                    &identity.broker_room_id,
                    &peer_id,
                    &identity.relay_verify_key,
                    Some(expires_at),
                ),
            )?,
            relay_ws_token_expires_at: expires_at,
        })
    }

    pub async fn create_relay_control_challenge(
        &self,
        bearer: &str,
        request: RelayControlChallengeRequest,
    ) -> Result<RelayControlChallengeResponse, String> {
        let operation = request.operation.trim();
        validate_relay_control_operation(operation)?;
        let hash = request.request_sha256.trim();
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("relay control request hash is required".to_string());
        }
        let identity = self
            .relay_proof_identity(bearer, &request.relay_id, &request.broker_room_id)
            .await?;
        let request_sha256 = hash.to_ascii_lowercase();
        let context = RelayProofContext {
            identity,
            target: RelayProofTarget::Control {
                operation: operation.to_string(),
                request_sha256: request_sha256.clone(),
            },
        };
        let issued = self
            .create_relay_proof_challenge(&self.inner.relay_control_challenges, &context)
            .await?;
        let identity = context.identity;
        Ok(RelayControlChallengeResponse {
            challenge_id: issued.challenge_id,
            challenge: issued.challenge,
            expires_at: issued.expires_at,
            operation: operation.to_string(),
            request_sha256,
            relay_id: identity.relay_id,
            broker_room_id: identity.broker_room_id,
            broker_origin: identity.broker_origin,
            refresh_token_hash: identity.refresh_token_hash,
        })
    }

    pub async fn consume_relay_control_proof(
        &self,
        bearer: &str,
        operation: &str,
        body: &[u8],
        challenge_id: &str,
        signature: &str,
    ) -> Result<(), String> {
        let value: serde_json::Value = serde_json::from_slice(body)
            .map_err(|_| "relay control body is not json".to_string())?;
        let relay_id = value
            .get("relay_id")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .trim();
        let room = value
            .get("broker_room_id")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .trim();
        let identity = self.relay_proof_identity(bearer, relay_id, room).await?;
        let challenge_id = challenge_id.trim();
        let signature = signature.trim();
        if challenge_id.is_empty() || signature.is_empty() {
            return Err("relay control proof is required".to_string());
        }
        let operation = operation.trim();
        validate_relay_control_operation(operation)?;
        self.consume_relay_proof_challenge(
            &self.inner.relay_control_challenges,
            &RelayProofContext {
                identity,
                target: RelayProofTarget::Control {
                    operation: operation.to_string(),
                    request_sha256: relay_control_request_sha256(body),
                },
            },
            challenge_id,
            signature,
        )
        .await
    }
}

fn length_prefixed_message(domain: &[u8], fields: &[&str], error: &str) -> Result<Vec<u8>, String> {
    let mut out = domain.to_vec();
    for field in fields {
        let bytes = field.as_bytes();
        let len = u32::try_from(bytes.len()).map_err(|_| error.to_string())?;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(bytes);
    }
    Ok(out)
}

pub fn relay_ws_ticket_message(
    origin: &str,
    id: &str,
    nonce: &str,
    relay: &str,
    room: &str,
    peer: &str,
    token_hash: &str,
) -> Result<Vec<u8>, String> {
    length_prefixed_message(
        b"agent-relay:relay-ws-ticket-v1\0",
        &[origin, id, nonce, relay, room, peer, token_hash],
        "relay ws ticket challenge field is too long",
    )
}

pub fn relay_join_message(
    origin: &str,
    id: &str,
    nonce: &str,
    ticket_hash: &str,
    relay: &str,
    room: &str,
    peer: &str,
) -> Result<Vec<u8>, String> {
    length_prefixed_message(
        b"agent-relay:relay-join-v1\0",
        &[origin, id, nonce, ticket_hash, relay, room, peer],
        "relay join challenge field is too long",
    )
}

pub fn relay_control_message(
    origin: &str,
    id: &str,
    nonce: &str,
    operation: &str,
    relay: &str,
    room: &str,
    token_hash: &str,
    body_hash: &str,
) -> Result<Vec<u8>, String> {
    length_prefixed_message(
        b"agent-relay:relay-control-v1\0",
        &[
            origin, id, nonce, operation, relay, room, token_hash, body_hash,
        ],
        "relay control challenge field is too long",
    )
}

fn verify_relay_signature(
    key: &str,
    message: &[u8],
    signature: &str,
    error: &str,
) -> Result<(), String> {
    let bytes = decode_base64_array::<64>(signature, error)?;
    let key = parse_relay_verifying_key(key).map_err(|_| error.to_string())?;
    key.verify(message, &Signature::from_bytes(&bytes))
        .map_err(|_| error.to_string())
}

pub(crate) fn verify_relay_control_signature(
    key: &str,
    message: &[u8],
    signature: &str,
) -> Result<(), String> {
    verify_relay_signature(key, message, signature, "relay control proof was rejected")
}

pub fn relay_control_request_sha256(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

pub fn relay_control_operation(method: &str, path: &str) -> String {
    format!("{method} {path}")
}

fn validate_relay_control_operation(operation: &str) -> Result<(), String> {
    const EXACT: &[&str] = &[
        "POST /api/public/devices",
        "POST /api/public/clients/grants",
        "POST /api/public/pairing/ws-token",
        "POST /api/public/devices/revoke-others",
        "POST /api/public/relay/access/release",
    ];
    if EXACT.contains(&operation) {
        return Ok(());
    }
    let Some(device_id) = operation
        .strip_prefix("POST /api/public/devices/")
        .and_then(|rest| rest.strip_suffix("/revoke"))
    else {
        return Err("relay control operation is not allowed".to_string());
    };
    if device_id.is_empty() || device_id.contains('/') {
        return Err("relay control operation is not allowed".to_string());
    }
    check_id_length("device id", device_id)
}

pub(super) fn configured_ticket_origin() -> Result<String, String> {
    let Ok(value) = std::env::var(PUBLIC_ORIGIN_ENV) else {
        return Ok(DEFAULT_RELAY_WS_TICKET_ORIGIN.to_string());
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(DEFAULT_RELAY_WS_TICKET_ORIGIN.to_string());
    }
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .ok_or_else(|| format!("{PUBLIC_ORIGIN_ENV} must use http:// or https://"))?;
    if rest.is_empty()
        || rest.contains('@')
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains(' ')
        || rest.bytes().any(|byte| byte.is_ascii_control())
        || value.len() > MAX_TICKET_ORIGIN_BYTES
    {
        return Err(format!(
            "{PUBLIC_ORIGIN_ENV} must be an http(s) origin with a host and no path, query, or userinfo"
        ));
    }
    Ok(value.to_string())
}
