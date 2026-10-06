use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::protocol::PeerRole;

const JOIN_TICKET_VERSION: u32 = 1;
pub const JOIN_TICKET_SECRET_ENV: &str = "RELAY_BROKER_TICKET_SECRET";
const MIN_SECRET_BYTES: usize = 32;
const MAX_SECRET_BYTES: usize = 512;
const MIN_SECRET_DISTINCT_BYTES: usize = 10;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct JoinTicketKey {
    secret: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JoinTicketKind {
    RelayJoin,
    PairingSurfaceJoin,
    DeviceSurfaceJoin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JoinTicketClaims {
    pub version: u32,
    pub kind: JoinTicketKind,
    pub channel_id: String,
    pub role: PeerRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairing_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    /// HMAC-authenticated relay identity. Required for relay joins. The socket
    /// cannot substitute a different key at proof time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_verify_key: Option<String>,
    pub nonce: String,
}

impl JoinTicketKey {
    pub fn from_secret(secret: impl AsRef<[u8]>) -> Result<Self, String> {
        let secret = secret.as_ref();
        if !(MIN_SECRET_BYTES..=MAX_SECRET_BYTES).contains(&secret.len()) {
            return Err(format!(
                "join_ticket secret must be {MIN_SECRET_BYTES}-{MAX_SECRET_BYTES} bytes; generate one with `openssl rand -base64 48`"
            ));
        }
        let mut seen = [false; 256];
        let distinct = secret
            .iter()
            .filter(|byte| !std::mem::replace(&mut seen[**byte as usize], true))
            .count();
        let placeholder = String::from_utf8_lossy(secret).to_ascii_lowercase();
        if distinct < MIN_SECRET_DISTINCT_BYTES
            || ["change-me", "change_me", "replace-me", "replace_me"]
                .iter()
                .any(|prefix| placeholder.starts_with(prefix))
        {
            return Err(
                "join_ticket secret looks like a placeholder; generate one with `openssl rand -base64 48`"
                    .to_string(),
            );
        }
        Ok(Self {
            secret: secret.to_vec(),
        })
    }

    pub fn from_env_var(name: &str) -> Result<Option<Self>, String> {
        match std::env::var(name) {
            Ok(secret) => Self::from_secret(secret.trim().as_bytes())
                .map(Some)
                .map_err(|error| format!("{name}: {error}")),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid utf-8")),
        }
    }

    pub fn mint(&self, claims: &JoinTicketClaims) -> Result<String, String> {
        claims.validate()?;
        let payload = serde_json::to_vec(claims)
            .map_err(|error| format!("failed to encode join_ticket claims: {error}"))?;
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload);
        let signature_b64 = self.sign(&payload_b64)?;
        Ok(format!("{payload_b64}.{signature_b64}"))
    }

    pub fn verify(&self, token: &str) -> Result<JoinTicketClaims, String> {
        let (payload_b64, signature_b64) = token
            .split_once('.')
            .ok_or_else(|| "join_ticket is malformed".to_string())?;
        self.verify_signature(payload_b64, signature_b64)?;
        let payload = URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|_| "join_ticket payload is invalid".to_string())?;
        let claims: JoinTicketClaims = serde_json::from_slice(&payload)
            .map_err(|_| "join_ticket payload is invalid".to_string())?;
        claims.validate()?;
        if let Some(expires_at) = claims.expires_at {
            if unix_now() > expires_at {
                return Err("join_ticket has expired".to_string());
            }
        }
        Ok(claims)
    }

    fn sign(&self, payload_b64: &str) -> Result<String, String> {
        let mut mac = HmacSha256::new_from_slice(&self.secret)
            .map_err(|_| "join_ticket secret is invalid".to_string())?;
        mac.update(payload_b64.as_bytes());
        Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
    }

    fn verify_signature(&self, payload_b64: &str, signature_b64: &str) -> Result<(), String> {
        let signature = URL_SAFE_NO_PAD
            .decode(signature_b64)
            .map_err(|_| "join_ticket signature is invalid".to_string())?;
        let mut mac = HmacSha256::new_from_slice(&self.secret)
            .map_err(|_| "join_ticket secret is invalid".to_string())?;
        mac.update(payload_b64.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| "join_ticket signature is invalid".to_string())
    }
}

impl JoinTicketClaims {
    pub fn relay_join(channel_id: &str, peer_id: &str, relay_verify_key: &str) -> Self {
        Self::relay_join_with_expiry(channel_id, peer_id, relay_verify_key, None)
    }

    pub fn relay_join_with_expiry(
        channel_id: &str,
        peer_id: &str,
        relay_verify_key: &str,
        expires_at: Option<u64>,
    ) -> Self {
        Self {
            version: JOIN_TICKET_VERSION,
            kind: JoinTicketKind::RelayJoin,
            channel_id: channel_id.to_string(),
            role: PeerRole::Relay,
            peer_id: Some(peer_id.to_string()),
            pairing_id: None,
            device_id: None,
            relay_verify_key: Some(relay_verify_key.to_string()),
            expires_at,
            nonce: random_nonce(),
        }
    }

    pub fn pairing_surface_join(channel_id: &str, pairing_id: &str, expires_at: u64) -> Self {
        Self {
            version: JOIN_TICKET_VERSION,
            kind: JoinTicketKind::PairingSurfaceJoin,
            channel_id: channel_id.to_string(),
            role: PeerRole::Surface,
            peer_id: None,
            pairing_id: Some(pairing_id.to_string()),
            device_id: None,
            relay_verify_key: None,
            expires_at: Some(expires_at),
            nonce: random_nonce(),
        }
    }

    pub fn device_surface_join(channel_id: &str, device_id: &str, expires_at: Option<u64>) -> Self {
        Self {
            version: JOIN_TICKET_VERSION,
            kind: JoinTicketKind::DeviceSurfaceJoin,
            channel_id: channel_id.to_string(),
            role: PeerRole::Surface,
            peer_id: None,
            pairing_id: None,
            device_id: Some(device_id.to_string()),
            relay_verify_key: None,
            expires_at,
            nonce: random_nonce(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.version != JOIN_TICKET_VERSION {
            return Err(format!("unsupported join_ticket version: {}", self.version));
        }
        if self.channel_id.trim().is_empty() {
            return Err("join_ticket channel_id is required".to_string());
        }
        if self.nonce.trim().is_empty() {
            return Err("join_ticket nonce is required".to_string());
        }

        match self.kind {
            JoinTicketKind::RelayJoin => {
                if self.role != PeerRole::Relay {
                    return Err("relay join_ticket must use relay role".to_string());
                }
                if self
                    .peer_id
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    return Err("relay join_ticket peer_id is required".to_string());
                }
                if self.pairing_id.is_some() || self.device_id.is_some() {
                    return Err(
                        "relay join_ticket cannot include pairing_id or device_id".to_string()
                    );
                }
                let verify_key = self
                    .relay_verify_key
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("");
                crate::public_control::validate_relay_verify_key(verify_key)
                    .map_err(|_| "relay join_ticket relay_verify_key is required".to_string())?;
            }
            JoinTicketKind::PairingSurfaceJoin => {
                if self.role != PeerRole::Surface {
                    return Err("pairing surface join_ticket must use surface role".to_string());
                }
                if self
                    .pairing_id
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    return Err("pairing surface join_ticket pairing_id is required".to_string());
                }
                if self.device_id.is_some() || self.relay_verify_key.is_some() {
                    return Err(
                        "pairing surface join_ticket cannot include device_id or relay_verify_key"
                            .to_string(),
                    );
                }
                if self.expires_at.is_none() {
                    return Err("pairing surface join_ticket expires_at is required".to_string());
                }
            }
            JoinTicketKind::DeviceSurfaceJoin => {
                if self.role != PeerRole::Surface {
                    return Err("device surface join_ticket must use surface role".to_string());
                }
                if self
                    .device_id
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    return Err("device surface join_ticket device_id is required".to_string());
                }
                if self.pairing_id.is_some() || self.relay_verify_key.is_some() {
                    return Err(
                        "device surface join_ticket cannot include pairing_id or relay_verify_key"
                            .to_string(),
                    );
                }
            }
        }

        Ok(())
    }
}

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_nonce() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_weak_and_placeholder_secrets_without_echoing_them() {
        for secret in [
            "",
            "change-me",
            "short-ticket-secret",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "01234567012345670123456701234567",
            "change-me-dev-broker-ticket-secret",
            "replace-me-with-a-long-production-secret",
        ] {
            let error = JoinTicketKey::from_secret(secret).expect_err("weak secret");
            if !secret.is_empty() {
                assert!(!error.contains(secret));
            }
        }
        assert!(JoinTicketKey::from_secret(vec![b'a'; MAX_SECRET_BYTES + 1]).is_err());
    }

    #[test]
    fn accepts_a_random_key_and_verifies_its_tickets() {
        let mut secret = [0_u8; 48];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut secret);
        let key = JoinTicketKey::from_secret(secret).expect("random key");
        let verify_key = base64::engine::general_purpose::STANDARD.encode(
            ed25519_dalek::SigningKey::from_bytes(&[7_u8; 32])
                .verifying_key()
                .to_bytes(),
        );
        let claims = JoinTicketClaims::relay_join("room", "relay", &verify_key);
        let ticket = key.mint(&claims).expect("ticket");
        assert_eq!(key.verify(&ticket).expect("verified"), claims);
    }
}
