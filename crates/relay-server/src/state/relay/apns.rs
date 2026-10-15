use std::sync::Mutex;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    pkcs8::DecodePrivateKey,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{debug, info, warn};

use super::{
    push::{PushJob, PushKind, SendOutcome},
    RelayState,
};

const APNS_TOPIC: &str = "dev.sealwire.mobile";
const TOKEN_REFRESH_SECS: u64 = 45 * 60;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApnsEnvironment {
    Development,
    Production,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApnsToken {
    pub token: String,
    pub environment: ApnsEnvironment,
    pub topic: String,
    pub device_id: String,
    pub relay_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApnsTokenInput {
    pub token: String,
    pub environment: ApnsEnvironment,
    pub topic: String,
    pub relay_id: String,
    #[serde(default)]
    pub device_id: Option<String>,
}

impl RelayState {
    pub(crate) fn register_apns_token(&mut self, input: ApnsTokenInput) -> Result<(), String> {
        let device_id = input.device_id.ok_or("APNs token is missing a device id")?;
        if !self.paired_devices.contains_key(&device_id) {
            return Err("device is not paired".into());
        }
        if input.token.is_empty()
            || input.token.len() > 1024
            || input.token.len() % 2 != 0
            || !input.token.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("APNs token must be a hexadecimal device token".into());
        }
        if input.topic != APNS_TOPIC {
            return Err("APNs topic must be dev.sealwire.mobile".into());
        }
        if input.relay_id.trim().is_empty() || input.relay_id.len() > 512 {
            return Err("APNs token is missing a valid relay id".into());
        }
        let token = ApnsToken {
            token: input.token.to_ascii_lowercase(),
            environment: input.environment,
            topic: input.topic,
            device_id: device_id.clone(),
            relay_id: input.relay_id,
        };
        if self.apns_tokens.get(&device_id) == Some(&token) {
            return Ok(());
        }
        // One install owns this device identity; registering again replaces its rotated token.
        self.apns_tokens.insert(device_id.clone(), token);
        self.push_subscriptions.remove(&device_id);
        self.notify();
        Ok(())
    }

    pub(crate) fn unregister_apns_token(&mut self, device_id: &str) {
        if self.apns_tokens.remove(device_id).is_some() {
            self.notify();
        }
    }
}

pub(super) struct ApnsSender {
    signing_key: SigningKey,
    key_id: String,
    team_id: String,
    jwt: Mutex<Option<(u64, String)>>,
}

impl ApnsSender {
    pub(super) fn new(signing_key: SigningKey, key_id: String, team_id: String) -> Self {
        Self {
            signing_key,
            key_id,
            team_id,
            jwt: Mutex::new(None),
        }
    }

    pub(super) fn from_env() -> Option<Self> {
        let config = [
            "RELAY_APNS_KEY_PATH",
            "RELAY_APNS_KEY_ID",
            "RELAY_APNS_TEAM_ID",
        ]
        .map(|name| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        });
        let [Some(path), Some(key_id), Some(team_id)] = config else {
            info!(
                "APNs disabled: set RELAY_APNS_KEY_PATH, RELAY_APNS_KEY_ID and RELAY_APNS_TEAM_ID"
            );
            return None;
        };
        let key = std::fs::read_to_string(path)
            .map_err(|error| error.to_string())
            .and_then(|pem| SigningKey::from_pkcs8_pem(&pem).map_err(|error| error.to_string()));
        match key {
            Ok(key) => Some(Self::new(key, key_id, team_id)),
            Err(error) => {
                warn!(%error, "APNs disabled: could not load the signing key");
                None
            }
        }
    }

    fn authorization(&self, now: u64) -> String {
        let mut cached = self.jwt.lock().expect("APNs JWT lock poisoned");
        if let Some((issued_at, jwt)) = cached.as_ref() {
            if now >= *issued_at && now - issued_at < TOKEN_REFRESH_SECS {
                return jwt.clone();
            }
        }
        let header = serde_json::json!({"alg": "ES256", "kid": self.key_id});
        let claims = serde_json::json!({"iss": self.team_id, "iat": now});
        let unsigned = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let signature: Signature = self.signing_key.sign(unsigned.as_bytes());
        let jwt = format!(
            "bearer {unsigned}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        );
        *cached = Some((now, jwt.clone()));
        jwt
    }

    fn request(
        &self,
        http: &reqwest::Client,
        token: &ApnsToken,
        job: &PushJob,
        now: u64,
    ) -> Result<reqwest::Request, reqwest::Error> {
        let host = match token.environment {
            ApnsEnvironment::Development => "api.sandbox.push.apple.com",
            ApnsEnvironment::Production => "api.push.apple.com",
        };
        // Apple sees the alert payload, so session names and provider errors must stay out.
        let (title, body) = match job.kind {
            PushKind::NeedsInput => (
                "Agent needs your input",
                "A session is waiting for your input.",
            ),
            PushKind::Completed => ("Agent finished", "A session completed its turn."),
            PushKind::Error => ("Agent stopped", "A session stopped unexpectedly."),
        };
        let mut collapse = Sha256::new();
        for part in [
            token.relay_id.as_str(),
            job.thread_id.as_str(),
            job.kind.tag_slug(),
        ] {
            collapse.update((part.len() as u64).to_be_bytes());
            collapse.update(part.as_bytes());
        }
        http.post(format!("https://{host}/3/device/{}", token.token))
            .version(reqwest::Version::HTTP_2)
            .header(reqwest::header::AUTHORIZATION, self.authorization(now))
            .header("apns-topic", &token.topic)
            .header("apns-push-type", "alert")
            .header("apns-collapse-id", URL_SAFE_NO_PAD.encode(collapse.finalize()))
            .header("apns-expiration", (now + 6 * 60 * 60).to_string())
            .json(&serde_json::json!({
                "aps": { "alert": {"title": title, "body": body},
                    "sound": "default", "thread-id": job.thread_id },
                "thread_id": job.thread_id, "device_id": token.device_id, "relay_id": token.relay_id,
            }))
            .build()
    }

    pub(super) async fn send(
        &self,
        http: &reqwest::Client,
        token: &ApnsToken,
        job: &PushJob,
    ) -> SendOutcome {
        let request = match self.request(http, token, job, crate::state::unix_now()) {
            Ok(request) => request,
            Err(error) => {
                warn!(%error, "APNs request could not be built");
                return SendOutcome::Failed;
            }
        };
        match http.execute(request).await {
            Ok(response) => {
                let status = response.status().as_u16();
                if status == 200 {
                    debug!(device_id = %token.device_id, "APNs push delivered");
                    return SendOutcome::Delivered;
                }
                let reason = response
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|body| body["reason"].as_str().map(str::to_owned))
                    .unwrap_or_default();
                warn!(device_id = %token.device_id, status, %reason, "APNs rejected push");
                apns_outcome(status, &reason)
            }
            Err(error) => {
                warn!(?error, "APNs request failed");
                SendOutcome::Failed
            }
        }
    }
}

fn apns_outcome(status: u16, reason: &str) -> SendOutcome {
    if status == 410 || reason == "BadDeviceToken" {
        SendOutcome::Gone
    } else if status == 200 {
        SendOutcome::Delivered
    } else {
        SendOutcome::Failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, Signature, SigningKey};

    #[test]
    fn apns_request_has_apple_headers_payload_and_a_verifiable_cached_jwt() {
        let key = SigningKey::from_slice(&[7; 32]).unwrap();
        let verify = *key.verifying_key();
        let sender = ApnsSender::new(key, "KEY123".into(), "TEAM123".into());
        let mut token = ApnsToken {
            token: "ab".repeat(32),
            environment: ApnsEnvironment::Development,
            topic: "dev.sealwire.mobile".into(),
            device_id: "phone".into(),
            relay_id: "relay-b".into(),
        };
        let job = super::super::push::PushJob::new(super::super::push::PushKind::NeedsInput, "t1")
            .with_name(Some("Test session".into()));
        let client = reqwest::Client::new();
        let request = sender.request(&client, &token, &job, 100).unwrap();
        assert_eq!(request.version(), reqwest::Version::HTTP_2);
        assert_eq!(
            request.url().as_str(),
            format!(
                "https://api.sandbox.push.apple.com/3/device/{}",
                token.token
            )
        );
        assert_eq!(request.headers()["apns-topic"], "dev.sealwire.mobile");
        assert_eq!(request.headers()["apns-push-type"], "alert");
        let authorization = request.headers()["authorization"].to_str().unwrap();
        let parts = authorization
            .strip_prefix("bearer ")
            .unwrap()
            .split('.')
            .collect::<Vec<_>>();
        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["kid"], "KEY123");
        assert_eq!(claims, serde_json::json!({"iss": "TEAM123", "iat": 100}));
        verify
            .verify(
                format!("{}.{}", parts[0], parts[1]).as_bytes(),
                &Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap(),
            )
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["aps"]["alert"]["title"], "Agent needs your input");
        assert_eq!(body["aps"]["sound"], "default");
        assert_eq!(body["aps"]["thread-id"], "t1");
        assert_eq!(body["thread_id"], "t1");
        assert_eq!(body["device_id"], "phone");
        assert_eq!(body["relay_id"], "relay-b");
        let cached = sender.request(&client, &token, &job, 101).unwrap();
        assert_eq!(cached.headers()["authorization"], authorization);
        let refreshed = sender
            .request(&client, &token, &job, 100 + 45 * 60)
            .unwrap();
        assert_ne!(refreshed.headers()["authorization"], authorization);
        token.environment = ApnsEnvironment::Production;
        assert_eq!(
            sender
                .request(&client, &token, &job, 3000)
                .unwrap()
                .url()
                .host_str(),
            Some("api.push.apple.com")
        );
    }

    #[test]
    fn apns_prunes_only_invalid_tokens() {
        assert!(matches!(
            apns_outcome(410, "Unregistered"),
            super::super::push::SendOutcome::Gone
        ));
        assert!(matches!(
            apns_outcome(400, "BadDeviceToken"),
            super::super::push::SendOutcome::Gone
        ));
        assert!(matches!(
            apns_outcome(403, "ExpiredProviderToken"),
            super::super::push::SendOutcome::Failed
        ));
        assert!(matches!(
            apns_outcome(429, "TooManyRequests"),
            super::super::push::SendOutcome::Failed
        ));
    }

    #[test]
    fn apns_alerts_never_include_session_names_or_provider_errors() {
        let sender = ApnsSender::new(
            SigningKey::from_slice(&[7; 32]).unwrap(),
            "KEY".into(),
            "TEAM".into(),
        );
        let token = ApnsToken {
            token: "ab".repeat(32),
            environment: ApnsEnvironment::Development,
            topic: APNS_TOPIC.into(),
            device_id: "phone".into(),
            relay_id: "relay-b".into(),
        };
        let http = reqwest::Client::new();
        for kind in [
            super::super::push::PushKind::NeedsInput,
            super::super::push::PushKind::Completed,
            super::super::push::PushKind::Error,
        ] {
            let job = PushJob::new(kind, "opaque-thread")
                .with_name(Some("SECRET first user message".into()))
                .with_reason("SECRET provider error with a private file path");
            let request = sender.request(&http, &token, &job, 100).unwrap();
            let body = std::str::from_utf8(request.body().unwrap().as_bytes().unwrap()).unwrap();
            assert!(
                !body.contains("SECRET"),
                "APNs sees the unencrypted alert: {body}"
            );
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(body).unwrap()["aps"]["alert"]["body"],
                match kind {
                    super::super::push::PushKind::NeedsInput =>
                        "A session is waiting for your input.",
                    super::super::push::PushKind::Completed => "A session completed its turn.",
                    super::super::push::PushKind::Error => "A session stopped unexpectedly.",
                }
            );
        }
    }

    #[test]
    fn apns_collapses_only_same_thread_and_kind_with_a_bounded_identifier() {
        let sender = ApnsSender::new(
            SigningKey::from_slice(&[7; 32]).unwrap(),
            "KEY".into(),
            "TEAM".into(),
        );
        let token = ApnsToken {
            token: "ab".repeat(32),
            environment: ApnsEnvironment::Development,
            topic: APNS_TOPIC.into(),
            device_id: "phone".into(),
            relay_id: "relay-b".into(),
        };
        let http = reqwest::Client::new();
        let job = PushJob::new(
            super::super::push::PushKind::Completed,
            "session".repeat(100),
        );
        let request = sender.request(&http, &token, &job, 100).unwrap();
        let collapse_id = request
            .headers()
            .get("apns-collapse-id")
            .expect("repeat alerts must merge");
        assert!(collapse_id.as_bytes().len() <= 64);
        assert_eq!(
            sender.request(&http, &token, &job, 101).unwrap().headers()["apns-collapse-id"],
            collapse_id
        );
        for other in [
            PushJob::new(super::super::push::PushKind::NeedsInput, &job.thread_id),
            PushJob::new(job.kind, "other-thread"),
        ] {
            assert_ne!(
                sender
                    .request(&http, &token, &other, 100)
                    .unwrap()
                    .headers()["apns-collapse-id"],
                collapse_id
            );
        }
        let other_relay = ApnsToken {
            relay_id: "another-relay".into(),
            ..token.clone()
        };
        assert_ne!(
            sender
                .request(&http, &other_relay, &job, 100)
                .unwrap()
                .headers()["apns-collapse-id"],
            collapse_id
        );
    }
}
