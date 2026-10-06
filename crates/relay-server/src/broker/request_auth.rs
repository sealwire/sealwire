//! The device signature on every remote action attempt. The broker sees the session id and
//! may hold the payload secret, so only the device key may authorize. Mirrored in crypto.js.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

use super::{crypto::EncryptedEnvelope, remote_actions::RemoteActionKind, RELAY_PROTOCOL_VERSION};

const REQUEST_DOMAIN: &[u8] = b"agent-relay:remote-request-v1\0";
const ENVELOPE_DOMAIN: &[u8] = b"agent-relay:remote-request-envelope-v1\0";

/// Who the relay is, as the phone pinned it. Taken from the relay's own config, never
/// from the frame.
#[derive(Debug, Clone)]
pub(crate) struct RelayRequestBinding {
    pub(crate) relay_verify_key: String,
    pub(crate) broker_room_id: String,
    pub(crate) relay_peer_id: String,
}

/// The attempt fields the phone sends beside the envelope.
#[derive(Debug, Clone)]
pub(crate) struct SignedAttempt {
    pub(crate) action: RemoteActionKind,
    pub(crate) sid: String,
    pub(crate) boot_id: String,
    pub(crate) seq: u64,
    pub(crate) sent_ms: u64,
    pub(crate) op_boot: String,
    pub(crate) op_t0: u64,
    pub(crate) signature: String,
}

fn length_prefixed(domain: &[u8], fields: &[&[u8]]) -> Result<Vec<u8>, String> {
    let mut out = domain.to_vec();
    for field in fields {
        let len = u32::try_from(field.len()).map_err(|_| "request field is too long")?;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(field);
    }
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// SHA-256 over the decoded nonce and ciphertext, so two spellings of the same base64
/// cannot differ here while decrypting the same.
pub(crate) fn envelope_digest(envelope: &EncryptedEnvelope) -> Result<String, String> {
    let nonce = STANDARD
        .decode(&envelope.nonce)
        .map_err(|_| "request envelope nonce is not base64".to_string())?;
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| "request envelope ciphertext is not base64".to_string())?;
    Ok(hex(&Sha256::digest(length_prefixed(
        ENVELOPE_DOMAIN,
        &[&nonce, &ciphertext],
    )?)))
}

pub(crate) fn remote_request_message(
    binding: &RelayRequestBinding,
    device_id: &str,
    peer_id: &str,
    action_id: &str,
    attempt: &SignedAttempt,
    envelope_digest: &str,
) -> Result<Vec<u8>, String> {
    let version = RELAY_PROTOCOL_VERSION.to_string();
    let seq = attempt.seq.to_string();
    let sent_ms = attempt.sent_ms.to_string();
    let op_t0 = attempt.op_t0.to_string();
    length_prefixed(
        REQUEST_DOMAIN,
        &[
            version.as_bytes(),
            binding.relay_verify_key.as_bytes(),
            binding.broker_room_id.as_bytes(),
            binding.relay_peer_id.as_bytes(),
            device_id.as_bytes(),
            peer_id.as_bytes(),
            attempt.sid.as_bytes(),
            attempt.boot_id.as_bytes(),
            seq.as_bytes(),
            sent_ms.as_bytes(),
            action_id.as_bytes(),
            attempt.action.as_str().as_bytes(),
            attempt.op_boot.as_bytes(),
            op_t0.as_bytes(),
            envelope_digest.as_bytes(),
        ],
    )
}

pub(crate) fn verify_remote_request(
    verify_key_b64: &str,
    message: &[u8],
    signature_b64: &str,
) -> Result<(), String> {
    let key: [u8; 32] = STANDARD
        .decode(verify_key_b64)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| "device verify key is invalid".to_string())?;
    let signature: [u8; 64] = STANDARD
        .decode(signature_b64)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| "request signature is invalid".to_string())?;
    VerifyingKey::from_bytes(&key)
        .map_err(|_| "device verify key is invalid".to_string())?
        .verify_strict(message, &Signature::from_bytes(&signature))
        .map_err(|_| "request signature is invalid".to_string())
}

/// The operation's logical content, independent of which attempt carried it: the parsed
/// request re-serialized, so key order, whitespace and the envelope nonce do not count.
pub(crate) fn request_digest<T: serde::Serialize>(request: &T) -> Result<String, String> {
    let bytes = serde_json::to_vec(request)
        .map_err(|error| format!("request could not be encoded: {error}"))?;
    Ok(hex(&Sha256::digest(bytes)))
}

/// A signed attempt the way the phone builds one, for tests that need a valid request
/// rather than a check of the encoding itself.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn test_signed_request(
    key: &ed25519_dalek::SigningKey,
    binding: &RelayRequestBinding,
    device_id: &str,
    peer_id: &str,
    sid: &str,
    seq: u64,
    action_id: &str,
    request: &serde_json::Value,
    secret: &str,
) -> serde_json::Value {
    use ed25519_dalek::Signer;
    // An unknown type still gets a valid signature, so a test can show it is refused
    // for what it is rather than for how it was signed.
    let action: RemoteActionKind =
        serde_json::from_value(request["type"].clone()).unwrap_or(RemoteActionKind::ListThreads);
    let envelope = super::crypto::encrypt_json(
        secret,
        &serde_json::json!({"action_id": action_id, "request": request}),
    )
    .expect("request encrypts");
    let now = crate::state::relay_clock_ms();
    let boot_id = crate::state::relay_boot_id().to_string();
    let attempt = SignedAttempt {
        action,
        sid: sid.to_string(),
        boot_id: boot_id.clone(),
        seq,
        sent_ms: now,
        op_boot: boot_id,
        op_t0: now,
        signature: String::new(),
    };
    let digest = envelope_digest(&envelope).unwrap();
    let message =
        remote_request_message(binding, device_id, peer_id, action_id, &attempt, &digest).unwrap();
    serde_json::json!({
        "kind": "encrypted_remote_action",
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "target_peer_id": binding.relay_peer_id,
        "action_id": action_id,
        "device_id": device_id,
        "action": action.as_str(),
        "request_sid": attempt.sid,
        "request_boot": attempt.boot_id,
        "request_seq": seq,
        "request_time": now,
        "op_boot": attempt.op_boot,
        "op_t0": now,
        "request_signature": STANDARD.encode(key.sign(&message).to_bytes()),
        "envelope": envelope,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// Pinned on the phone side by `remote request signature matches the relay vector`
    /// in `frontend/remote/crypto.test.mjs`.
    #[test]
    fn the_request_signature_matches_the_shared_vector() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let envelope = EncryptedEnvelope {
            nonce: STANDARD.encode([1_u8; 24]),
            ciphertext: STANDARD.encode(b"sealed request"),
        };
        let digest = envelope_digest(&envelope).unwrap();
        assert_eq!(
            digest, "707827ac2928d80b36037da2b3855230bf1f1e5997c4c53d0d350b35921341ee",
            "update the phone's vector together with this one"
        );
        let binding = RelayRequestBinding {
            relay_verify_key: "relay-key".into(),
            broker_room_id: "room-1".into(),
            relay_peer_id: "relay-peer".into(),
        };
        let attempt = SignedAttempt {
            action: RemoteActionKind::SendMessage,
            sid: "sid-1".into(),
            boot_id: "boot-1".into(),
            seq: 7,
            sent_ms: 1_000_000_123,
            op_boot: "boot-1".into(),
            op_t0: 1_000_000_100,
            signature: String::new(),
        };
        let message =
            remote_request_message(&binding, "phone-1", "peer-1", "act-1", &attempt, &digest)
                .unwrap();
        let signature = STANDARD.encode(key.sign(&message).to_bytes());
        assert_eq!(
            signature,
            "GZX0jO5Ur0l3NBTcSkR30osavd3LKYHWf+YBsqqVlCxtUmvmMCboHP05P7xTJ33GJMwznK+rP50jA6RHU++oAw=="
        );
        let verify_key = STANDARD.encode(key.verifying_key().to_bytes());
        verify_remote_request(&verify_key, &message, &signature).unwrap();
        let mut tampered = message.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(verify_remote_request(&verify_key, &tampered, &signature).is_err());
    }
}
