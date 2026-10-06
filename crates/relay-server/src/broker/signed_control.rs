//! The relay's half of a privileged public-control call. Each caller keeps its own transport
//! and error classes; what is checked and signed, and which bytes are sent, is decided here.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use relay_broker::public_control::{
    relay_control_message, relay_control_request_sha256, RelayControlChallengeRequest,
    RelayControlChallengeResponse, RELAY_CONTROL_CHALLENGE_HEADER, RELAY_CONTROL_SIGNATURE_HEADER,
};
use relay_util::sha256_hex;
use reqwest::{Client, RequestBuilder};
use serde::Serialize;
use url::Url;

pub(super) const CONTROL_CHALLENGE_PATH: &str = "/api/public/relay/control/challenge";

/// One call, fixed before its challenge is asked for: the body is serialized once, and the
/// bytes the challenge hashes are the bytes the signed request carries.
pub(super) struct SignedControlRequest {
    url: Url,
    operation: String,
    relay_id: String,
    broker_room_id: String,
    body: Vec<u8>,
    request_sha256: String,
}

#[derive(Debug)]
pub(super) enum SignedControlError {
    /// The challenge was issued for a different call, relay, room, body or token.
    ChallengeMismatch,
    Message(String),
}

impl SignedControlRequest {
    pub(super) fn new<T: Serialize + ?Sized>(
        control_url: &Url,
        path: &str,
        relay_id: &str,
        broker_room_id: &str,
        body: &T,
    ) -> Result<Self, serde_json::Error> {
        let body = serde_json::to_vec(body)?;
        let mut url = control_url.clone();
        url.set_path(path);
        url.set_query(None);
        Ok(Self {
            url,
            operation: format!("POST {path}"),
            relay_id: relay_id.to_string(),
            broker_room_id: broker_room_id.to_string(),
            request_sha256: relay_control_request_sha256(&body),
            body,
        })
    }

    pub(super) fn url(&self) -> &Url {
        &self.url
    }

    pub(super) fn challenge_request(&self) -> RelayControlChallengeRequest {
        RelayControlChallengeRequest {
            operation: self.operation.clone(),
            relay_id: self.relay_id.clone(),
            broker_room_id: self.broker_room_id.clone(),
            request_sha256: self.request_sha256.clone(),
        }
    }

    /// The request to send, signed over `challenge` once it is known to be for this call.
    /// The body goes out as the serialized bytes; re-encoding it would break the hash.
    pub(super) fn sign(
        self,
        client: &Client,
        bearer_token: &str,
        signing_key: &SigningKey,
        challenge: RelayControlChallengeResponse,
    ) -> Result<RequestBuilder, SignedControlError> {
        if challenge.operation != self.operation
            || challenge.relay_id != self.relay_id
            || challenge.broker_room_id != self.broker_room_id
            || challenge.request_sha256 != self.request_sha256
            || challenge.refresh_token_hash != sha256_hex(bearer_token.trim())
            || challenge.broker_origin.is_empty()
        {
            return Err(SignedControlError::ChallengeMismatch);
        }
        let message = relay_control_message(
            &challenge.broker_origin,
            &challenge.challenge_id,
            &challenge.challenge,
            &challenge.operation,
            &challenge.relay_id,
            &challenge.broker_room_id,
            &challenge.refresh_token_hash,
            &challenge.request_sha256,
        )
        .map_err(SignedControlError::Message)?;
        let signature = STANDARD.encode(signing_key.sign(&message).to_bytes());
        Ok(client
            .post(self.url)
            .bearer_auth(bearer_token)
            .header(RELAY_CONTROL_CHALLENGE_HEADER, challenge.challenge_id)
            .header(RELAY_CONTROL_SIGNATURE_HEADER, signature)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(self.body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "relay-refresh";

    fn call() -> SignedControlRequest {
        let url = Url::parse("http://127.0.0.1:9/ignored?q=1").expect("url");
        SignedControlRequest::new(
            &url,
            "/api/public/devices/d1/revoke",
            "relay-1",
            "room-1",
            &serde_json::json!({ "relay_id": "relay-1", "broker_room_id": "room-1" }),
        )
        .expect("body encodes")
    }

    fn issued_for(call: &SignedControlRequest) -> RelayControlChallengeResponse {
        let asked = call.challenge_request();
        RelayControlChallengeResponse {
            challenge_id: "cch-1".to_string(),
            challenge: "ct-1".to_string(),
            operation: asked.operation,
            relay_id: asked.relay_id,
            broker_room_id: asked.broker_room_id,
            broker_origin: "sealwire-broker".to_string(),
            refresh_token_hash: sha256_hex(TOKEN),
            request_sha256: asked.request_sha256,
            expires_at: 4_000_000_000,
        }
    }

    #[test]
    fn signs_its_own_bytes_under_a_matching_challenge() {
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let call = call();
        assert_eq!(
            call.url().as_str(),
            "http://127.0.0.1:9/api/public/devices/d1/revoke"
        );
        let challenge = issued_for(&call);
        let expected_body = call.body.clone();
        let request = call
            .sign(&Client::new(), TOKEN, &key, challenge.clone())
            .expect("a matching challenge signs")
            .build()
            .expect("request builds");
        assert_eq!(
            request.body().and_then(|body| body.as_bytes()),
            Some(&expected_body[..])
        );
        assert_eq!(
            relay_control_request_sha256(&expected_body),
            challenge.request_sha256
        );
        let signature = request.headers()[RELAY_CONTROL_SIGNATURE_HEADER]
            .to_str()
            .expect("signature header");
        let message = relay_control_message(
            &challenge.broker_origin,
            &challenge.challenge_id,
            &challenge.challenge,
            &challenge.operation,
            &challenge.relay_id,
            &challenge.broker_room_id,
            &challenge.refresh_token_hash,
            &challenge.request_sha256,
        )
        .expect("message");
        let signature = ed25519_dalek::Signature::from_slice(
            &STANDARD.decode(signature).expect("signature decodes"),
        )
        .expect("signature parses");
        key.verifying_key()
            .verify_strict(&message, &signature)
            .expect("signed with the enrollment key over this challenge");
        assert_eq!(request.headers()[RELAY_CONTROL_CHALLENGE_HEADER], "cch-1");
    }

    #[test]
    fn refuses_a_challenge_issued_for_any_other_call() {
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let tampered: [fn(&mut RelayControlChallengeResponse); 6] = [
            |c| c.operation = "POST /api/public/devices/d2/revoke".to_string(),
            |c| c.relay_id = "relay-2".to_string(),
            |c| c.broker_room_id = "room-2".to_string(),
            |c| c.request_sha256 = relay_control_request_sha256(b"{}"),
            |c| c.refresh_token_hash = sha256_hex("another-token"),
            |c| c.broker_origin.clear(),
        ];
        for tamper in tampered {
            let call = call();
            let mut challenge = issued_for(&call);
            tamper(&mut challenge);
            assert!(matches!(
                call.sign(&Client::new(), TOKEN, &key, challenge),
                Err(SignedControlError::ChallengeMismatch)
            ));
        }
    }
}
