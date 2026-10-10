use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::BTreeMap;

const MAX_CREDENTIAL_BYTES: usize = 1024;

#[derive(Clone)]
pub(super) struct CredentialKey([u8; 32]);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum CredentialSubject {
    Relay(String),
    Client(String),
}

#[derive(Clone)]
pub(crate) enum CredentialAdmission {
    Relay(String),
    Client(Option<String>),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(super) struct LegacyCredentials {
    tokens: BTreeMap<String, CredentialSubject>,
    clients: BTreeMap<String, String>,
}

impl CredentialKind {
    fn prefix(self) -> &'static str {
        match self {
            Self::Relay => "rref-v1",
            Self::Device => "dref-v1",
            Self::Client => "cref-v1",
            Self::ClientId => "client-v1",
        }
    }

    fn lookup_key(self, value: &str) -> String {
        format!("{}:{value}", self.prefix())
    }
}

impl CredentialKey {
    pub(super) fn new(secret: &[u8]) -> Self {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key size");
        mac.update(b"sealwire/public-credentials/v1");
        Self(mac.finalize().into_bytes().into())
    }

    fn seal(&self, kind: CredentialKind, payload: &[u8]) -> String {
        let signed = format!("{}.{}", kind.prefix(), URL_SAFE_NO_PAD.encode(payload));
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).expect("32-byte HMAC key");
        mac.update(signed.as_bytes());
        format!(
            "{signed}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    fn open(&self, kind: CredentialKind, token: &str) -> Option<Vec<u8>> {
        if token.len() > MAX_CREDENTIAL_BYTES {
            return None;
        }
        let (signed, tag) = token.rsplit_once('.')?;
        let (prefix, payload) = signed.split_once('.')?;
        if prefix != kind.prefix() {
            return None;
        }
        let tag = URL_SAFE_NO_PAD.decode(tag).ok()?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).ok()?;
        mac.update(signed.as_bytes());
        mac.verify_slice(&tag).ok()?;
        URL_SAFE_NO_PAD.decode(payload).ok()
    }

    pub(super) fn mint(&self, kind: CredentialKind, subject: &str) -> String {
        let payload = format!("{}:{subject}", random_token(40));
        self.seal(kind, payload.as_bytes())
    }

    pub(super) fn client_id(&self, verify_key: &str) -> String {
        self.seal(CredentialKind::ClientId, verify_key.as_bytes())
    }

    fn client_key(&self, client_id: &str) -> Option<String> {
        let key = String::from_utf8(self.open(CredentialKind::ClientId, client_id)?).ok()?;
        parse_relay_verifying_key(&key).ok()?;
        Some(key)
    }

    fn subject(&self, kind: CredentialKind, token: &str) -> Option<CredentialSubject> {
        if matches!(kind, CredentialKind::ClientId) {
            self.client_key(token)?;
            return Some(CredentialSubject::Client(token.to_string()));
        }
        let payload = String::from_utf8(self.open(kind, token)?).ok()?;
        let (nonce, subject) = payload.split_once(':')?;
        if nonce.len() != 40 || subject.is_empty() || subject.len() > MAX_ID_BYTES {
            return None;
        }
        Some(match kind {
            CredentialKind::Relay | CredentialKind::Device => {
                CredentialSubject::Relay(subject.to_string())
            }
            CredentialKind::Client => CredentialSubject::Client(subject.to_string()),
            CredentialKind::ClientId => unreachable!(),
        })
    }
}

impl LegacyCredentials {
    pub(super) fn from_state(store: &PublicControlStateStore) -> Self {
        let mut known = Self::default();
        for relay in store.relay_registrations_by_hash.values() {
            known.tokens.insert(
                CredentialKind::Relay.lookup_key(&relay.refresh_token_hash),
                CredentialSubject::Relay(relay.relay_id.clone()),
            );
        }
        for device in store.grants_by_hash.values() {
            let subject = CredentialSubject::Relay(device.relay_id.clone());
            known.tokens.insert(
                CredentialKind::Device.lookup_key(&device.refresh_token_hash),
                subject.clone(),
            );
            for previous in &device.superseded {
                if previous.expires_at > unix_now() {
                    known.tokens.insert(
                        CredentialKind::Device.lookup_key(&previous.refresh_token_hash),
                        subject.clone(),
                    );
                }
            }
        }
        for client in store.client_registrations_by_hash.values() {
            let subject = CredentialSubject::Client(client.client_id.clone());
            known
                .clients
                .insert(client.client_id.clone(), client.client_verify_key.clone());
            known.tokens.insert(
                CredentialKind::Client.lookup_key(&client.refresh_token_hash),
                subject.clone(),
            );
            for previous in &client.superseded {
                if previous.expires_at > unix_now() {
                    known.tokens.insert(
                        CredentialKind::Client.lookup_key(&previous.refresh_token_hash),
                        subject.clone(),
                    );
                }
            }
        }
        known
    }

    pub(super) async fn load_or_create(
        persistence: &PublicControlPersistence,
        state: &mut PublicControlStateStore,
    ) -> Result<Self, String> {
        let mut known = match persistence {
            PublicControlPersistence::Postgres { pool, .. } => {
                // Freeze the old issuance set so a later broker also recognizes restored registrations.
                sqlx::query("CREATE TABLE IF NOT EXISTS public_legacy_credentials (id INTEGER PRIMARY KEY CHECK (id = 1), credentials TEXT NOT NULL)")
                    .execute(pool).await.map_err(|e| format!("failed to initialize credential migration: {e}"))?;
                let snapshot =
                    serde_json::to_string(&Self::from_state(state)).map_err(|e| e.to_string())?;
                sqlx::query("INSERT INTO public_legacy_credentials (id, credentials) VALUES (1, $1) ON CONFLICT (id) DO NOTHING")
                    .bind(snapshot).execute(pool).await.map_err(|e| format!("failed to save credential migration: {e}"))?;
                let snapshot: String = sqlx::query_scalar(
                    "SELECT credentials FROM public_legacy_credentials WHERE id = 1",
                )
                .fetch_one(pool)
                .await
                .map_err(|e| format!("failed to load credential migration: {e}"))?;
                serde_json::from_str(&snapshot)
                    .map_err(|e| format!("invalid credential migration: {e}"))?
            }
            _ => {
                if state.legacy_credentials.is_none() {
                    state.legacy_credentials = Some(Self::from_state(state));
                    persistence.save(state).await?;
                }
                state.legacy_credentials.clone().unwrap_or_default()
            }
        };
        let initial = Self::from_state(state);
        known.tokens.extend(initial.tokens);
        known.clients.extend(initial.clients);
        Ok(known)
    }
}

impl PublicControlPlane {
    pub(crate) async fn cached_credential_admission(
        &self,
        kind: CredentialKind,
        value: &str,
    ) -> Option<CredentialAdmission> {
        let store = self.inner.state.lock().await;
        store.credential_admission(kind, value)
    }

    pub(crate) async fn load_credential_admission(
        &self,
        kind: CredentialKind,
        value: &str,
    ) -> Result<Option<CredentialAdmission>, String> {
        Ok(self
            .find_credential(kind, value, |store| store.credential_admission(kind, value))
            .await?
            .map(|(_, admission)| admission))
    }

    pub(crate) async fn claim_admission(
        &self,
        request: &ClientClaimRequest,
    ) -> Option<CredentialAdmission> {
        let CredentialSubject::Relay(relay) = self.claim_subject(request).await? else {
            return None;
        };
        let store = self.inner.state.lock().await;
        store
            .relay_registrations_by_hash
            .values()
            .any(|entry| entry.relay_id == relay)
            .then_some(CredentialAdmission::Client(Some(relay)))
    }

    pub(crate) async fn scoped_admission(
        &self,
        admission: &CredentialAdmission,
        client_id: &str,
        room: Option<&str>,
    ) -> Result<CredentialAdmission, String> {
        let Some(room) = room else {
            return Ok(admission.clone());
        };
        let store = self.inner.state.lock().await;
        let (_, relay) = refresh_device_for_client(&store, client_id, room)?;
        Ok(CredentialAdmission::Client(Some(relay.relay_id)))
    }

    pub(crate) async fn pending_refresh_room(&self, challenge_id: &str) -> Option<String> {
        self.inner
            .pending_credential_refreshes
            .lock()
            .await
            .get(challenge_id)
            .and_then(|entry| entry.challenge.broker_room_id.clone())
    }

    pub(crate) fn credential_subject(
        &self,
        kind: CredentialKind,
        value: &str,
    ) -> Option<CredentialSubject> {
        let value = value.trim();
        if value.is_empty() || value.len() > MAX_CREDENTIAL_BYTES {
            return None;
        }
        if let Some(subject) = self.inner.credential_key.subject(kind, value) {
            return Some(subject);
        }
        let legacy = &self.inner.legacy_credentials;
        if matches!(kind, CredentialKind::ClientId) {
            return legacy
                .clients
                .contains_key(value)
                .then(|| CredentialSubject::Client(value.to_string()));
        }
        legacy
            .tokens
            .get(&kind.lookup_key(&sha256_hex(value)))
            .cloned()
    }

    pub(crate) fn refresh_challenge_subject(
        &self,
        request: &CredentialRefreshChallengeRequest,
        origin: &str,
    ) -> Option<CredentialSubject> {
        let key = self
            .inner
            .credential_key
            .client_key(&request.client_id)
            .or_else(|| {
                self.inner
                    .legacy_credentials
                    .clients
                    .get(&request.client_id)
                    .cloned()
            })?;
        let signature =
            decode_base64_array::<64>(&request.signature, "credential refresh is invalid").ok()?;
        parse_relay_verifying_key(&key)
            .ok()?
            .verify(
                credential_refresh_init_message(request, origin).as_bytes(),
                &Signature::from_bytes(&signature),
            )
            .ok()?;
        Some(CredentialSubject::Client(request.client_id.clone()))
    }

    pub(crate) async fn claim_subject(
        &self,
        request: &ClientClaimRequest,
    ) -> Option<CredentialSubject> {
        let pending = self.inner.pending_client_claims.lock().await;
        let claim = pending.get(request.claim_id.trim())?;
        if claim.expires_at <= unix_now() {
            return None;
        }
        verify_client_claim_signature(
            &claim.client_verify_key,
            request.claim_id.trim(),
            &claim.nonce,
            &claim.relay_id,
            request.claim_signature.trim(),
        )
        .ok()?;
        Some(CredentialSubject::Relay(claim.relay_id.clone()))
    }

    pub(crate) async fn refresh_subject(
        &self,
        request: &CredentialRefreshRequest,
        origin: &str,
    ) -> Option<CredentialSubject> {
        let pending = self.inner.pending_credential_refreshes.lock().await;
        let entry = pending.get(&request.challenge_id)?;
        if entry.challenge.expires_at <= unix_now() || entry.challenge.broker_origin != origin {
            return None;
        }
        let signature =
            decode_base64_array::<64>(&request.signature, "credential refresh is invalid").ok()?;
        parse_relay_verifying_key(&entry.client_verify_key)
            .ok()?
            .verify(
                credential_refresh_message(&entry.challenge).as_bytes(),
                &Signature::from_bytes(&signature),
            )
            .ok()?;
        Some(CredentialSubject::Client(entry.challenge.client_id.clone()))
    }
}

impl PublicControlStateStore {
    fn credential_admission(
        &self,
        kind: CredentialKind,
        value: &str,
    ) -> Option<CredentialAdmission> {
        let relay_id = match kind {
            CredentialKind::Relay => Some(
                self.relay_registrations_by_hash
                    .get(&sha256_hex(value.trim()))?
                    .relay_id
                    .clone(),
            ),
            CredentialKind::Device => Some(
                find_device_grant_for_token(self, &sha256_hex(value.trim()), unix_now())?
                    .1
                    .relay_id,
            ),
            CredentialKind::Client => self.client_quota_relay(
                &find_client_identity_for_token(self, &sha256_hex(value.trim()), unix_now())?
                    .1
                    .client_id,
            ),
            CredentialKind::ClientId => {
                self.client_quota_relay(&self.client_identity_for_id(value)?.client_id)
            }
        };
        Some(match kind {
            CredentialKind::Relay => CredentialAdmission::Relay(relay_id?),
            _ => CredentialAdmission::Client(relay_id),
        })
    }

    pub(super) fn client_quota_relay(&self, client_id: &str) -> Option<String> {
        self.client_relay_grants_by_key
            .values()
            .filter(|grant| {
                grant.client_id == client_id
                    && self.relay_registrations_by_hash.values().any(|relay| {
                        relay.relay_id == grant.relay_id
                            && relay.broker_room_id == grant.broker_room_id
                    })
            })
            .min_by(|a, b| (a.granted_at, &a.relay_id).cmp(&(b.granted_at, &b.relay_id)))
            .map(|grant| grant.relay_id.clone())
    }
}
