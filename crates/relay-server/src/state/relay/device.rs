use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use qrcode::{render::svg, QrCode};
use rand::{distributions::Alphanumeric, Rng};
use relay_util::sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use url::Url;

use crate::protocol::{
    DeviceLifecycleState, DeviceRecordView, PairedDeviceView, PairingTicketView,
    PendingPairingRequestView,
};

use super::RelayState;

const DEFAULT_PAIRING_TTL_SECS: u64 = 90;
const MAX_PAIRING_TTL_SECS: u64 = 600;
const CLAIM_CHALLENGE_TTL_SECS: u64 = 60;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct PendingPairing {
    pub(crate) pairing_id: String,
    pub(crate) pairing_secret: String,
    pub(crate) secret_hash: String,
    pub(crate) created_at: u64,
    pub(crate) expires_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct PairedDevice {
    pub(crate) device_id: String,
    pub(crate) label: String,
    pub(crate) payload_secret: String,
    #[serde(default)]
    pub(crate) device_verify_key: String,
    pub(crate) created_at: u64,
    pub(crate) last_seen_at: Option<u64>,
    pub(crate) last_peer_id: Option<String>,
    #[serde(default)]
    pub(crate) broker_join_ticket_expires_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct DeviceRecord {
    pub(crate) device_id: String,
    pub(crate) label: String,
    pub(crate) lifecycle_state: DeviceLifecycleState,
    pub(crate) created_at: u64,
    pub(crate) state_changed_at: u64,
    pub(crate) last_seen_at: Option<u64>,
    pub(crate) last_peer_id: Option<String>,
    #[serde(default)]
    pub(crate) device_verify_key: String,
    #[serde(default)]
    pub(crate) broker_join_ticket_expires_at: Option<u64>,
}

impl PairedDevice {
    pub(crate) fn to_view(&self) -> PairedDeviceView {
        PairedDeviceView {
            device_id: self.device_id.clone(),
            label: self.label.clone(),
            lifecycle_state: DeviceLifecycleState::Approved,
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
            last_peer_id: self.last_peer_id.clone(),
            broker_join_ticket_expires_at: self.broker_join_ticket_expires_at,
            fingerprint: device_fingerprint(Some(&self.device_verify_key)),
        }
    }
}

impl DeviceRecord {
    pub(crate) fn approved_from(device: &PairedDevice) -> Self {
        Self {
            device_id: device.device_id.clone(),
            label: device.label.clone(),
            lifecycle_state: DeviceLifecycleState::Approved,
            created_at: device.created_at,
            state_changed_at: device.created_at,
            last_seen_at: device.last_seen_at,
            last_peer_id: device.last_peer_id.clone(),
            device_verify_key: device.device_verify_key.clone(),
            broker_join_ticket_expires_at: device.broker_join_ticket_expires_at,
        }
    }

    pub(crate) fn to_view(&self) -> DeviceRecordView {
        DeviceRecordView {
            device_id: self.device_id.clone(),
            label: self.label.clone(),
            lifecycle_state: self.lifecycle_state,
            created_at: self.created_at,
            state_changed_at: self.state_changed_at,
            last_seen_at: self.last_seen_at,
            last_peer_id: self.last_peer_id.clone(),
            broker_join_ticket_expires_at: self.broker_join_ticket_expires_at,
            fingerprint: device_fingerprint(Some(&self.device_verify_key)),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PendingPairingRequest {
    pub(crate) pairing_id: String,
    pub(crate) device_id: String,
    pub(crate) label: String,
    pub(crate) requested_at: u64,
    pub(crate) broker_peer_id: String,
    pub(crate) device_verify_key: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ClaimChallenge {
    pub(crate) challenge_id: String,
    pub(crate) device_id: String,
    pub(crate) peer_id: String,
    pub(crate) challenge: String,
    pub(crate) expires_at: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct IssuedClaimChallenge {
    pub(crate) challenge_id: String,
    pub(crate) challenge: String,
    pub(crate) expires_at: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct CompletedRemoteClaim;

impl PendingPairingRequest {
    pub(crate) fn to_view(&self) -> PendingPairingRequestView {
        PendingPairingRequestView {
            pairing_id: self.pairing_id.clone(),
            device_id: self.device_id.clone(),
            label: self.label.clone(),
            lifecycle_state: DeviceLifecycleState::Pending,
            requested_at: self.requested_at,
            broker_peer_id: self.broker_peer_id.clone(),
            fingerprint: device_fingerprint(Some(&self.device_verify_key)),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CompletedPairing {
    pub(crate) pairing_id: String,
    pub(crate) pairing_secret: String,
    pub(crate) expires_at: u64,
    pub(crate) device_verify_key: String,
    pub(crate) device: Option<PairedDeviceView>,
    pub(crate) payload_secret: Option<String>,
    pub(crate) relay_id: Option<String>,
    pub(crate) relay_label: Option<String>,
    pub(crate) client_id: Option<String>,
    pub(crate) client_refresh_token: Option<String>,
    pub(crate) device_refresh_token: Option<String>,
    pub(crate) device_join_ticket: Option<String>,
    pub(crate) device_join_ticket_expires_at: Option<u64>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum BrokerPendingMessage {
    PairingResult(PendingPairingResult),
    TranscriptDelta(PendingTranscriptDelta),
}

#[derive(Clone, Debug)]
pub(crate) struct PendingTranscriptDelta {
    pub(crate) thread_id: String,
    pub(crate) item_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) delta: String,
    pub(crate) kind: TranscriptDeltaKind,
}

#[derive(Clone, Debug)]
pub(crate) enum TranscriptDeltaKind {
    AgentText,
    CommandOutput,
}

#[derive(Clone, Debug)]
pub(crate) struct PendingPairingResult {
    pub(crate) pairing_id: String,
    pub(crate) target_peer_id: String,
    pub(crate) pairing_secret: String,
    pub(crate) device: Option<PairedDeviceView>,
    pub(crate) payload_secret: Option<String>,
    pub(crate) relay_id: Option<String>,
    pub(crate) relay_label: Option<String>,
    pub(crate) client_id: Option<String>,
    pub(crate) client_refresh_token: Option<String>,
    pub(crate) device_refresh_token: Option<String>,
    pub(crate) device_join_ticket: Option<String>,
    pub(crate) device_join_ticket_expires_at: Option<u64>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedPairingTicket {
    pub(crate) pairing_id: String,
    pub(crate) pairing_secret: String,
    pub(crate) expires_at: u64,
}

impl RelayState {
    pub fn prepare_pairing_ticket(
        &mut self,
        requested_ttl_secs: Option<u64>,
    ) -> Result<PreparedPairingTicket, String> {
        let now = super::super::unix_now();
        self.prune_expired_pairings(now);

        let ttl_secs = requested_ttl_secs
            .unwrap_or(DEFAULT_PAIRING_TTL_SECS)
            .clamp(30, MAX_PAIRING_TTL_SECS);
        let pairing_id = format!("pair-{}", random_token(10).to_ascii_lowercase());
        let pairing_secret = random_token(32);
        let expires_at = now.saturating_add(ttl_secs);

        self.pending_pairings.insert(
            pairing_id.clone(),
            PendingPairing {
                pairing_id: pairing_id.clone(),
                pairing_secret: pairing_secret.clone(),
                secret_hash: sha256_hex(&pairing_secret),
                created_at: now,
                expires_at,
            },
        );
        Ok(PreparedPairingTicket {
            pairing_id,
            pairing_secret,
            expires_at,
        })
    }

    pub fn render_pairing_ticket_view(
        &self,
        prepared: &PreparedPairingTicket,
        broker_url: &str,
        broker_room_id: &str,
        pairing_join_ticket: &str,
        relay_peer_id: &str,
    ) -> PairingTicketView {
        let pairing_payload = pairing_payload(
            &prepared.pairing_id,
            &prepared.pairing_secret,
            prepared.expires_at,
            broker_url,
            broker_room_id,
            pairing_join_ticket,
            relay_peer_id,
            self.security.mode(),
        );
        let pairing_url = pairing_url(broker_url, &pairing_payload);
        let pairing_qr_svg = pairing_qr_svg(&pairing_url);

        PairingTicketView {
            pairing_id: prepared.pairing_id.clone(),
            pairing_secret: prepared.pairing_secret.clone(),
            expires_at: prepared.expires_at,
            broker_url: broker_url.to_string(),
            broker_channel_id: broker_room_id.to_string(),
            pairing_join_ticket: pairing_join_ticket.to_string(),
            relay_peer_id: relay_peer_id.to_string(),
            security_mode: self.security.mode(),
            pairing_payload,
            pairing_url,
            pairing_qr_svg,
        }
    }

    pub fn consume_pairing_ticket(
        &mut self,
        pairing_id: &str,
        pairing_secret: &str,
        requested_device_id: Option<String>,
        device_label: Option<String>,
        device_verify_key: String,
        broker_join_ticket_expires_at: Option<u64>,
        peer_id: &str,
        now: u64,
    ) -> Result<(PairedDeviceView, String), String> {
        self.prune_expired_pairings(now);
        let pending = self
            .pending_pairings
            .get(pairing_id)
            .cloned()
            .ok_or_else(|| "pairing request is missing or expired".to_string())?;

        if pending.secret_hash != sha256_hex(pairing_secret) {
            return Err("pairing secret is invalid".to_string());
        }
        self.pending_pairings.remove(pairing_id);

        let device_id = normalize_remote_device_id(requested_device_id.as_deref())
            .filter(|candidate| !candidate.is_empty())
            .unwrap_or_else(|| format!("device-{}", random_token(8).to_ascii_lowercase()));
        let label_fallback = requested_device_id
            .as_deref()
            .or(Some(peer_id))
            .unwrap_or("Remote Device");
        let label = normalize_device_label(device_label, label_fallback);
        let payload_secret = random_token(40);

        let approved_device = {
            let device = self
                .paired_devices
                .entry(device_id.clone())
                .or_insert_with(|| PairedDevice {
                    device_id: device_id.clone(),
                    label: label.clone(),
                    payload_secret: payload_secret.clone(),
                    device_verify_key: device_verify_key.clone(),
                    created_at: now,
                    last_seen_at: Some(now),
                    last_peer_id: Some(peer_id.to_string()),
                    broker_join_ticket_expires_at,
                });

            device.label = label;
            device.payload_secret = payload_secret.clone();
            device.device_verify_key = device_verify_key;
            device.last_seen_at = Some(now);
            device.last_peer_id = Some(peer_id.to_string());
            device.broker_join_ticket_expires_at = broker_join_ticket_expires_at;
            device.clone()
        };
        self.bind_surface_peer_to_device(&approved_device.device_id, peer_id);
        self.sync_device_record_from_approved_device(&approved_device, now);

        Ok((approved_device.to_view(), payload_secret))
    }

    pub fn register_pairing_request(
        &mut self,
        pairing_id: &str,
        requested_device_id: Option<String>,
        device_label: Option<String>,
        peer_id: &str,
        device_verify_key: String,
        now: u64,
    ) -> Result<PendingPairingRequestView, String> {
        self.prune_expired_pairings(now);
        if !self.pending_pairings.contains_key(pairing_id) {
            return Err("pairing request is missing or expired".to_string());
        }
        if let Some(existing) = self.pending_pairing_requests.get_mut(pairing_id) {
            let label_fallback = requested_device_id
                .as_deref()
                .or(Some(peer_id))
                .unwrap_or("Remote Device");
            if let Some(device_id) = normalize_remote_device_id(requested_device_id.as_deref())
                .filter(|candidate| !candidate.is_empty())
            {
                existing.device_id = device_id;
            }
            existing.label = normalize_device_label(device_label, label_fallback);
            existing.broker_peer_id = peer_id.to_string();
            existing.device_verify_key = device_verify_key;
            return Ok(existing.to_view());
        }

        let device_id = normalize_remote_device_id(requested_device_id.as_deref())
            .filter(|candidate| !candidate.is_empty())
            .unwrap_or_else(|| format!("device-{}", random_token(8).to_ascii_lowercase()));
        let label_fallback = requested_device_id
            .as_deref()
            .or(Some(peer_id))
            .unwrap_or("Remote Device");
        let label = normalize_device_label(device_label, label_fallback);

        let request = PendingPairingRequest {
            pairing_id: pairing_id.to_string(),
            device_id,
            label,
            requested_at: now,
            broker_peer_id: peer_id.to_string(),
            device_verify_key,
        };
        let view = request.to_view();
        self.pending_pairing_requests
            .insert(pairing_id.to_string(), request);
        Ok(view)
    }

    pub fn decide_pairing_request(
        &mut self,
        pairing_id: &str,
        approved: bool,
        device_join_ticket_expires_at: Option<u64>,
        now: u64,
    ) -> Result<PendingPairingResult, String> {
        self.prune_expired_pairings(now);
        let request = self
            .pending_pairing_requests
            .remove(pairing_id)
            .ok_or_else(|| "pairing request is not waiting for approval".to_string())?;
        let pending = self
            .pending_pairings
            .get(pairing_id)
            .cloned()
            .ok_or_else(|| "pairing request is missing or expired".to_string())?;

        if approved {
            let device_verify_key = request.device_verify_key.clone();
            let (device, token) = self.consume_pairing_ticket(
                pairing_id,
                &pending.pairing_secret,
                Some(request.device_id),
                Some(request.label),
                device_verify_key.clone(),
                device_join_ticket_expires_at,
                &request.broker_peer_id,
                now,
            )?;
            self.completed_pairings.insert(
                pairing_id.to_string(),
                CompletedPairing {
                    pairing_id: pairing_id.to_string(),
                    pairing_secret: pending.pairing_secret.clone(),
                    expires_at: pending.expires_at,
                    device_verify_key,
                    device: Some(device.clone()),
                    payload_secret: Some(token.clone()),
                    relay_id: None,
                    relay_label: None,
                    client_id: None,
                    client_refresh_token: None,
                    device_refresh_token: None,
                    device_join_ticket: None,
                    device_join_ticket_expires_at,
                    error: None,
                },
            );
            return Ok(PendingPairingResult {
                pairing_id: pairing_id.to_string(),
                target_peer_id: request.broker_peer_id,
                pairing_secret: pending.pairing_secret,
                device: Some(device),
                payload_secret: Some(token),
                relay_id: None,
                relay_label: None,
                client_id: None,
                client_refresh_token: None,
                device_refresh_token: None,
                device_join_ticket: None,
                device_join_ticket_expires_at,
                error: None,
            });
        }

        self.pending_pairings.remove(pairing_id);
        self.record_rejected_device(
            &request.device_id,
            &request.label,
            &request.device_verify_key,
            &request.broker_peer_id,
            request.requested_at,
            now,
        );
        self.completed_pairings.insert(
            pairing_id.to_string(),
            CompletedPairing {
                pairing_id: pairing_id.to_string(),
                pairing_secret: pending.pairing_secret.clone(),
                expires_at: pending.expires_at,
                device_verify_key: request.device_verify_key,
                device: None,
                payload_secret: None,
                relay_id: None,
                relay_label: None,
                client_id: None,
                client_refresh_token: None,
                device_refresh_token: None,
                device_join_ticket: None,
                device_join_ticket_expires_at: None,
                error: Some("pairing request was rejected on the local relay".to_string()),
            },
        );
        Ok(PendingPairingResult {
            pairing_id: pairing_id.to_string(),
            target_peer_id: request.broker_peer_id,
            pairing_secret: pending.pairing_secret,
            device: None,
            payload_secret: None,
            relay_id: None,
            relay_label: None,
            client_id: None,
            client_refresh_token: None,
            device_refresh_token: None,
            device_join_ticket: None,
            device_join_ticket_expires_at: None,
            error: Some("pairing request was rejected on the local relay".to_string()),
        })
    }

    pub fn completed_pairing_result(
        &mut self,
        pairing_id: &str,
        device_verify_key: &str,
        peer_id: &str,
        now: u64,
    ) -> Result<Option<PendingPairingResult>, String> {
        self.prune_expired_pairings(now);
        let Some(completed) = self.completed_pairings.get(pairing_id).cloned() else {
            return Ok(None);
        };

        if completed.device_verify_key != device_verify_key {
            return Err("pairing request does not match the approved device".to_string());
        }

        Ok(Some(PendingPairingResult {
            pairing_id: completed.pairing_id,
            target_peer_id: peer_id.to_string(),
            pairing_secret: completed.pairing_secret,
            device: completed.device,
            payload_secret: completed.payload_secret,
            relay_id: completed.relay_id,
            relay_label: completed.relay_label,
            client_id: completed.client_id,
            client_refresh_token: completed.client_refresh_token,
            device_refresh_token: completed.device_refresh_token,
            device_join_ticket: completed.device_join_ticket,
            device_join_ticket_expires_at: completed.device_join_ticket_expires_at,
            error: completed.error,
        }))
    }

    pub fn revoke_paired_device(&mut self, device_id: &str, now: u64) -> bool {
        let Some(device) = self.paired_devices.remove(device_id) else {
            return false;
        };
        self.record_revoked_device(&device, now);
        if self.active_controller_device_id.as_deref() == Some(device_id) {
            self.active_controller_device_id = None;
            self.active_controller_last_seen_at = None;
        }
        true
    }

    pub fn revoke_all_other_paired_devices(
        &mut self,
        keep_device_id: &str,
        now: u64,
    ) -> Result<Vec<String>, String> {
        if !self.paired_devices.contains_key(keep_device_id) {
            return Err("device is not paired".to_string());
        }

        let revoked_device_ids = self
            .paired_devices
            .keys()
            .filter(|device_id| device_id.as_str() != keep_device_id)
            .cloned()
            .collect::<Vec<_>>();
        for device_id in &revoked_device_ids {
            let _ = self.revoke_paired_device(device_id, now);
        }
        Ok(revoked_device_ids)
    }

    pub fn pending_pairing_secret(&mut self, pairing_id: &str, now: u64) -> Result<String, String> {
        self.prune_expired_pairings(now);
        self.pending_pairings
            .get(pairing_id)
            .map(|pairing| pairing.pairing_secret.clone())
            .or_else(|| {
                self.completed_pairings
                    .get(pairing_id)
                    .map(|pairing| pairing.pairing_secret.clone())
            })
            .ok_or_else(|| "pairing request is missing or expired".to_string())
    }

    pub fn issue_claim_challenge(
        &mut self,
        device_id: &str,
        peer_id: &str,
        now: u64,
    ) -> Result<IssuedClaimChallenge, String> {
        self.prune_expired_claim_challenges(now);
        self.prune_claim_challenges_for_device(device_id, "");
        let challenge_id = format!("claim-{}", random_token(10).to_ascii_lowercase());
        let challenge = random_token(40);
        let expires_at = now.saturating_add(CLAIM_CHALLENGE_TTL_SECS);
        self.paired_devices
            .get(device_id)
            .ok_or_else(|| "device is not paired".to_string())?;
        self.pending_claim_challenges.insert(
            challenge_id.clone(),
            ClaimChallenge {
                challenge_id: challenge_id.clone(),
                device_id: device_id.to_string(),
                peer_id: peer_id.to_string(),
                challenge: challenge.clone(),
                expires_at,
            },
        );
        Ok(IssuedClaimChallenge {
            challenge_id,
            challenge,
            expires_at,
        })
    }

    pub fn claim_challenge(
        &mut self,
        device_id: &str,
        challenge_id: &str,
        peer_id: &str,
        now: u64,
    ) -> Result<ClaimChallenge, String> {
        self.prune_expired_claim_challenges(now);
        let challenge = self
            .pending_claim_challenges
            .get(challenge_id)
            .cloned()
            .ok_or_else(|| "claim challenge is missing or expired".to_string())?;
        if challenge.device_id != device_id {
            return Err("claim challenge does not belong to this device".to_string());
        }
        if challenge.peer_id != peer_id {
            return Err("claim challenge does not belong to this broker peer".to_string());
        }
        self.paired_devices
            .get_mut(device_id)
            .ok_or_else(|| "device is not paired".to_string())?;
        Ok(challenge)
    }

    pub fn complete_remote_claim(
        &mut self,
        device_id: &str,
        challenge_id: &str,
        peer_id: &str,
        now: u64,
    ) -> Result<CompletedRemoteClaim, String> {
        let challenge = self.claim_challenge(device_id, challenge_id, peer_id, now)?;
        self.pending_claim_challenges.remove(challenge_id);
        let device = self
            .paired_devices
            .get_mut(device_id)
            .ok_or_else(|| "device is not paired".to_string())?;
        device.last_seen_at = Some(now);
        device.last_peer_id = Some(peer_id.to_string());
        let approved_device = self
            .paired_devices
            .get(device_id)
            .cloned()
            .ok_or_else(|| "device is not paired".to_string())?;
        self.bind_surface_peer_to_device(device_id, peer_id);
        self.sync_device_record_from_approved_device(&approved_device, now);
        self.prune_claim_challenges_for_device(device_id, &challenge.challenge_id);

        Ok(CompletedRemoteClaim)
    }

    pub fn paired_device_payload_secret(&self, device_id: &str) -> Result<String, String> {
        self.paired_devices
            .get(device_id)
            .map(|device| device.payload_secret.clone())
            .ok_or_else(|| "device is not paired".to_string())
    }

    pub fn paired_device_verify_key(&self, device_id: &str) -> Result<String, String> {
        let verify_key = self
            .paired_devices
            .get(device_id)
            .map(|device| device.device_verify_key.clone())
            .ok_or_else(|| "device is not paired".to_string())?;
        if verify_key.trim().is_empty() {
            return Err("device verify key is missing; re-pair this device".to_string());
        }
        Ok(verify_key)
    }

    pub fn mark_paired_device_seen(
        &mut self,
        device_id: &str,
        peer_id: &str,
        now: u64,
    ) -> Result<(), String> {
        let device = self
            .paired_devices
            .get_mut(device_id)
            .ok_or_else(|| "device is not paired".to_string())?;
        device.last_seen_at = Some(now);
        device.last_peer_id = Some(peer_id.to_string());
        let approved_device = device.clone();
        self.bind_surface_peer_to_device(device_id, peer_id);
        self.sync_device_record_from_approved_device(&approved_device, now);
        Ok(())
    }

    pub fn attach_pairing_broker_credential(
        &mut self,
        pairing_id: &str,
        device_refresh_token: Option<String>,
        device_join_ticket: String,
        device_join_ticket_expires_at: Option<u64>,
        now: u64,
    ) -> Result<(), String> {
        let completed = self
            .completed_pairings
            .get_mut(pairing_id)
            .ok_or_else(|| "completed pairing result is missing".to_string())?;
        completed.device_refresh_token = device_refresh_token;
        completed.device_join_ticket = Some(device_join_ticket);
        completed.device_join_ticket_expires_at = device_join_ticket_expires_at;

        if let Some(device_id) = completed
            .device
            .as_ref()
            .map(|device| device.device_id.clone())
        {
            let approved_device = {
                let device = self
                    .paired_devices
                    .get_mut(&device_id)
                    .ok_or_else(|| "device is not paired".to_string())?;
                device.broker_join_ticket_expires_at = device_join_ticket_expires_at;
                device.clone()
            };
            self.sync_device_record_from_approved_device(&approved_device, now);
        }

        Ok(())
    }

    pub fn attach_pairing_client_grant(
        &mut self,
        pairing_id: &str,
        relay_id: Option<String>,
        relay_label: Option<String>,
        client_id: Option<String>,
        client_refresh_token: Option<String>,
    ) -> Result<(), String> {
        let completed = self
            .completed_pairings
            .get_mut(pairing_id)
            .ok_or_else(|| "completed pairing result is missing".to_string())?;
        completed.relay_id = relay_id;
        completed.relay_label = relay_label;
        completed.client_id = client_id;
        completed.client_refresh_token = client_refresh_token;
        Ok(())
    }

    pub fn prune_expired_pairings(&mut self, now: u64) {
        self.pending_pairings
            .retain(|_, pairing| pairing.expires_at > now);
        self.pending_pairing_requests
            .retain(|pairing_id, _| self.pending_pairings.contains_key(pairing_id));
        self.completed_pairings
            .retain(|_, pairing| pairing.expires_at > now);
    }

    pub fn prune_expired_claim_challenges(&mut self, now: u64) {
        self.pending_claim_challenges
            .retain(|_, challenge| challenge.expires_at > now);
    }

    fn sync_device_record_from_approved_device(&mut self, device: &PairedDevice, now: u64) {
        let record = self
            .device_records
            .entry(device.device_id.clone())
            .or_insert_with(|| DeviceRecord::approved_from(device));
        record.label = device.label.clone();
        record.lifecycle_state = DeviceLifecycleState::Approved;
        record.last_seen_at = device.last_seen_at;
        record.last_peer_id = device.last_peer_id.clone();
        record.device_verify_key = device.device_verify_key.clone();
        record.broker_join_ticket_expires_at = device.broker_join_ticket_expires_at;
        record.state_changed_at = now;
    }

    fn record_rejected_device(
        &mut self,
        device_id: &str,
        label: &str,
        device_verify_key: &str,
        last_peer_id: &str,
        created_at: u64,
        now: u64,
    ) {
        let record = self
            .device_records
            .entry(device_id.to_string())
            .or_insert_with(|| DeviceRecord {
                device_id: device_id.to_string(),
                label: label.to_string(),
                lifecycle_state: DeviceLifecycleState::Rejected,
                created_at,
                state_changed_at: now,
                last_seen_at: None,
                last_peer_id: Some(last_peer_id.to_string()),
                device_verify_key: device_verify_key.to_string(),
                broker_join_ticket_expires_at: None,
            });
        record.label = label.to_string();
        record.lifecycle_state = DeviceLifecycleState::Rejected;
        record.state_changed_at = now;
        record.last_peer_id = Some(last_peer_id.to_string());
        record.device_verify_key = device_verify_key.to_string();
        record.broker_join_ticket_expires_at = None;
    }

    fn record_revoked_device(&mut self, device: &PairedDevice, now: u64) {
        let record = self
            .device_records
            .entry(device.device_id.clone())
            .or_insert_with(|| DeviceRecord::approved_from(device));
        record.label = device.label.clone();
        record.lifecycle_state = DeviceLifecycleState::Revoked;
        record.state_changed_at = now;
        record.last_seen_at = device.last_seen_at;
        record.last_peer_id = device.last_peer_id.clone();
        record.device_verify_key = device.device_verify_key.clone();
        record.broker_join_ticket_expires_at = device.broker_join_ticket_expires_at;
    }

    fn prune_claim_challenges_for_device(&mut self, device_id: &str, except_challenge_id: &str) {
        self.pending_claim_challenges
            .retain(|challenge_id, challenge| {
                challenge.device_id != device_id || challenge_id == except_challenge_id
            });
    }
}

pub(crate) fn normalize_remote_device_id(value: Option<&str>) -> Option<String> {
    let input = value?.trim().to_ascii_lowercase();
    if input.is_empty() {
        return None;
    }

    let mut normalized = String::new();
    let mut previous_was_dash = false;

    for character in input.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character);
            previous_was_dash = false;
            continue;
        }

        if matches!(character, '-' | '_' | ' ' | '.')
            && !previous_was_dash
            && !normalized.is_empty()
        {
            normalized.push('-');
            previous_was_dash = true;
        }
    }

    while normalized.ends_with('-') {
        normalized.pop();
    }

    if normalized.is_empty() {
        None
    } else {
        normalized.truncate(48);
        Some(normalized)
    }
}

pub(crate) fn normalize_device_label(value: Option<String>, fallback: &str) -> String {
    let label = super::super::non_empty(value).unwrap_or_else(|| fallback.trim().to_string());
    let mut normalized = label.trim().to_string();
    if normalized.is_empty() {
        normalized = "Remote Device".to_string();
    }
    if normalized.chars().count() > 80 {
        normalized = normalized.chars().take(80).collect();
    }
    normalized
}

fn random_token(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn device_fingerprint(verify_key_b64: Option<&str>) -> Option<String> {
    let verify_key = verify_key_b64?.trim();
    if verify_key.is_empty() {
        return None;
    }
    let bytes = STANDARD
        .decode(verify_key)
        .unwrap_or_else(|_| verify_key.as_bytes().to_vec());
    let digest = Sha256::digest(&bytes);
    let mut fingerprint = String::new();
    for (index, byte) in digest.iter().take(8).enumerate() {
        if index > 0 {
            fingerprint.push(':');
        }
        use std::fmt::Write as _;
        let _ = write!(fingerprint, "{byte:02x}");
    }
    Some(fingerprint)
}

fn pairing_payload(
    pairing_id: &str,
    pairing_secret: &str,
    expires_at: u64,
    broker_url: &str,
    broker_channel_id: &str,
    pairing_join_ticket: &str,
    relay_peer_id: &str,
    security_mode: crate::protocol::SecurityMode,
) -> String {
    let payload = json!({
        "version": 1,
        "pairing_id": pairing_id,
        "pairing_secret": pairing_secret,
        "expires_at": expires_at,
        "broker_url": broker_url,
        "broker_channel_id": broker_channel_id,
        "pairing_join_ticket": pairing_join_ticket,
        "relay_peer_id": relay_peer_id,
        "security_mode": security_mode,
    });

    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("pairing payload should serialize"))
}

fn pairing_url(broker_url: &str, pairing_payload: &str) -> String {
    let mut url = browser_url(broker_url);
    url.query_pairs_mut()
        .clear()
        .append_pair("pairing", pairing_payload);
    url.to_string()
}

fn pairing_qr_svg(pairing_url: &str) -> String {
    QrCode::new(pairing_url.as_bytes())
        .expect("pairing url should always encode as qr")
        .render::<svg::Color<'_>>()
        .min_dimensions(240, 240)
        .dark_color(svg::Color("#10211b"))
        .light_color(svg::Color("#f7f4ea"))
        .build()
}

fn browser_url(broker_url: &str) -> Url {
    let mut url = Url::parse(broker_url).expect("broker url should parse");
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        other => other,
    }
    .to_string();
    let _ = url.set_scheme(&scheme);
    url.set_path("/");
    url.set_query(None);
    url
}
