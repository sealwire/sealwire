use super::*;

impl AppState {
    pub async fn start_pairing(
        &self,
        input: PairingStartInput,
    ) -> Result<PairingTicketView, String> {
        let broker = BrokerConfig::from_env().await?.ok_or_else(|| {
            "broker pairing is unavailable because RELAY_BROKER_URL is not configured".to_string()
        })?;
        let path_scope = normalize_allowed_roots(input.path_scope.unwrap_or_default())?;
        {
            let relay = self.relay.read().await;
            for root in &path_scope {
                ensure_path_within_allowed_roots(root, &relay.allowed_roots).map_err(|err| {
                    format!("pairing path scope {root} cannot exceed relay allowed roots: {err}")
                })?;
            }
        }
        let prepared = {
            let mut relay = self.relay.write().await;
            relay.prepare_pairing_ticket(input.expires_in_seconds, path_scope)?
        };
        let pairing_credential = match broker
            .pairing_join_credential(&prepared.pairing_id, prepared.expires_at)
            .await
        {
            Ok(credential) => credential,
            Err(error) => {
                let mut relay = self.relay.write().await;
                relay.pending_pairings.remove(&prepared.pairing_id);
                return Err(error);
            }
        };
        let mut relay = self.relay.write().await;
        let ticket = relay.render_pairing_ticket_view(
            &prepared,
            broker.public_base_url(),
            broker.broker_room_id(),
            &pairing_credential.token,
            broker.relay_peer_id(),
        );
        relay.push_log(
            "info",
            format!(
                "Started pairing ticket {} for broker channel {}.",
                ticket.pairing_id, ticket.broker_channel_id
            ),
        );
        relay.notify();
        Ok(ticket)
    }

    pub async fn revoke_device(&self, device_id: &str) -> Result<RevokeDeviceReceipt, String> {
        let broker = BrokerConfig::from_env().await?;
        let mut relay = self.relay.write().await;
        let revoked = relay.revoke_paired_device(device_id, unix_now());
        if revoked {
            relay.push_log("info", format!("Revoked paired device {device_id}."));
            relay.notify();
        }
        drop(relay);
        if revoked {
            if let Some(broker) = broker {
                if let Err(error) = broker.revoke_device_credential(device_id).await {
                    self.push_runtime_log(
                        "warn",
                        format!(
                            "Local revoke for {device_id} succeeded, but broker credential revoke failed: {error}"
                        ),
                    )
                    .await;
                }
            }
        }
        Ok(RevokeDeviceReceipt {
            device_id: device_id.to_string(),
            revoked,
        })
    }

    pub async fn revoke_other_devices(
        &self,
        keep_device_id: &str,
    ) -> Result<BulkRevokeDevicesReceipt, String> {
        let broker = BrokerConfig::from_env().await?;
        let mut relay = self.relay.write().await;
        let revoked_device_ids =
            relay.revoke_all_other_paired_devices(keep_device_id, unix_now())?;
        if !revoked_device_ids.is_empty() {
            relay.push_log(
                "info",
                format!(
                    "Revoked {} paired device(s) and kept {}.",
                    revoked_device_ids.len(),
                    keep_device_id
                ),
            );
            relay.notify();
        }
        drop(relay);
        if !revoked_device_ids.is_empty() {
            if let Some(broker) = broker {
                if let Err(error) = broker.revoke_other_device_credentials(keep_device_id).await {
                    self.push_runtime_log(
                        "warn",
                        format!(
                            "Local bulk revoke kept {keep_device_id}, but broker credential revoke failed: {error}"
                        ),
                    )
                    .await;
                }
            }
        }
        Ok(BulkRevokeDevicesReceipt {
            kept_device_id: keep_device_id.to_string(),
            revoked_count: revoked_device_ids.len(),
            revoked_device_ids,
        })
    }

    pub async fn decide_pairing_request(
        &self,
        pairing_id: &str,
        input: PairingDecisionInput,
    ) -> Result<PairingDecisionReceipt, String> {
        let broker = BrokerConfig::from_env().await?.ok_or_else(|| {
            "broker pairing is unavailable because RELAY_BROKER_URL is not configured".to_string()
        })?;
        let now = unix_now();
        let approved = matches!(input.decision, PairingDecision::Approve);
        // Claim the request atomically BEFORE issuing any broker credential. The
        // broker calls below take seconds; an overlapping second approval
        // (double-tap, retry) that also passed a mere existence check would issue
        // a second credential — rotating the winner's freshly-delivered tokens —
        // and then, losing the decide race, revoke the winner's grant outright.
        // With the claim, the loser fails fast here having issued nothing.
        let claimed_request = if approved {
            let mut relay = self.relay.write().await;
            Some(relay.claim_pairing_request(pairing_id, now)?)
        } else {
            None
        };
        let restore_claim = |claimed: Option<_>| async {
            if let Some(request) = claimed {
                self.relay.write().await.restore_pairing_request(request);
            }
        };
        let broker_credential = if let Some(request) = claimed_request.as_ref() {
            match broker
                .device_broker_credential(
                    &request.device_id,
                    broker.predicted_device_join_expires_at(now),
                )
                .await
            {
                Ok(credential) => Some(credential),
                Err(error) => {
                    // Nothing durable was issued; release the claim so the
                    // operator can retry the approval.
                    restore_claim(claimed_request).await;
                    return Err(error);
                }
            }
        } else {
            None
        };
        let client_grant = if let Some(request) = claimed_request.as_ref() {
            match broker
                .client_broker_grant(
                    &request.device_id,
                    &request.device_verify_key,
                    Some(request.label.clone()),
                )
                .await
            {
                Ok(grant) => grant,
                Err(error) => {
                    // Roll back THIS attempt's device credential (exclusive by
                    // claim, so it cannot be anyone else's) and release the claim.
                    if let Some(request) = claimed_request.as_ref() {
                        let _ = broker.revoke_device_credential(&request.device_id).await;
                    }
                    restore_claim(claimed_request).await;
                    return Err(error);
                }
            }
        } else {
            None
        };
        let mut relay = self.relay.write().await;
        // Hand the claim back under the SAME write guard that runs the decide, so
        // no other flow can steal it in between.
        let claimed_device_id = claimed_request.as_ref().map(|req| req.device_id.clone());
        if let Some(request) = claimed_request {
            relay.restore_pairing_request(request);
        }
        let mut result = match relay.decide_pairing_request(
            pairing_id,
            approved,
            broker_credential
                .as_ref()
                .and_then(|credential| credential.join_credential.expires_at),
            now,
        ) {
            Ok(result) => result,
            Err(error) => {
                drop(relay);
                // The pairing itself failed (e.g. ticket expired); revoke THIS
                // attempt's freshly-issued credential — the claim guarantees it
                // is not some other approval's live grant.
                if let Some(device_id) = claimed_device_id.as_ref() {
                    let _ = broker.revoke_device_credential(device_id).await;
                }
                return Err(error);
            }
        };
        if let Some(credential) = broker_credential {
            relay.attach_pairing_broker_credential(
                pairing_id,
                credential.refresh_token.clone(),
                credential.join_credential.token.clone(),
                credential.join_credential.expires_at,
                now,
            )?;
            result.device_refresh_token = credential.refresh_token;
            result.device_join_ticket = Some(credential.join_credential.token);
            result.device_join_ticket_expires_at = credential.join_credential.expires_at;
        }
        if let Some(grant) = client_grant {
            relay.attach_pairing_client_grant(
                pairing_id,
                Some(grant.relay_id.clone()),
                grant.relay_label.clone(),
                Some(grant.client_id.clone()),
                Some(grant.refresh_token.clone()),
            )?;
            result.relay_id = Some(grant.relay_id);
            result.relay_label = grant.relay_label;
            result.client_id = Some(grant.client_id);
            result.client_refresh_token = Some(grant.refresh_token);
        }
        let message = match input.decision {
            PairingDecision::Approve => {
                relay.push_log(
                    "info",
                    format!(
                        "Approved pairing request {pairing_id} for {}.",
                        result
                            .device
                            .as_ref()
                            .map(|device| device.device_id.as_str())
                            .unwrap_or("unknown-device")
                    ),
                );
                "Pairing request approved on the local relay.".to_string()
            }
            PairingDecision::Reject => {
                relay.push_log("info", format!("Rejected pairing request {pairing_id}."));
                "Pairing request rejected on the local relay.".to_string()
            }
        };
        relay
            .pending_broker_messages
            .push(super::BrokerPendingMessage::PairingResult(result));
        relay.notify();
        Ok(PairingDecisionReceipt {
            pairing_id: pairing_id.to_string(),
            decision: input.decision,
            resulting_state: match input.decision {
                PairingDecision::Approve => "approved".to_string(),
                PairingDecision::Reject => "rejected".to_string(),
            },
            message,
        })
    }

    pub(crate) async fn complete_pairing(
        &self,
        pairing_id: &str,
        requested_device_id: Option<String>,
        device_label: Option<String>,
        device_verify_key: String,
        peer_id: &str,
    ) -> Result<crate::protocol::PendingPairingRequestView, String> {
        let mut relay = self.relay.write().await;
        let request = relay.register_pairing_request(
            pairing_id,
            requested_device_id,
            device_label,
            peer_id,
            device_verify_key,
            unix_now(),
        )?;
        relay.push_log(
            "info",
            format!(
                "Registered pending pairing request {} from broker peer {}.",
                pairing_id, peer_id
            ),
        );
        relay.notify();
        Ok(request)
    }

    pub(crate) async fn pending_pairing_secret(&self, pairing_id: &str) -> Result<String, String> {
        let mut relay = self.relay.write().await;
        relay.pending_pairing_secret(pairing_id, unix_now())
    }

    pub(crate) async fn completed_pairing_result(
        &self,
        pairing_id: &str,
        device_verify_key: &str,
        peer_id: &str,
    ) -> Result<Option<super::PendingPairingResult>, String> {
        let mut relay = self.relay.write().await;
        relay.completed_pairing_result(pairing_id, device_verify_key, peer_id, unix_now())
    }

    pub(crate) async fn paired_device_payload_secret(
        &self,
        device_id: &str,
    ) -> Result<String, String> {
        let relay = self.relay.read().await;
        relay.paired_device_payload_secret(device_id)
    }

    pub(crate) async fn paired_device_verify_key(&self, device_id: &str) -> Result<String, String> {
        let relay = self.relay.read().await;
        relay.paired_device_verify_key(device_id)
    }

    pub(crate) async fn issue_claim_challenge(
        &self,
        device_id: &str,
        peer_id: &str,
    ) -> Result<super::IssuedClaimChallenge, String> {
        let mut relay = self.relay.write().await;
        relay.issue_claim_challenge(device_id, peer_id, unix_now())
    }

    pub(crate) async fn claim_challenge(
        &self,
        device_id: &str,
        challenge_id: &str,
        peer_id: &str,
    ) -> Result<super::ClaimChallenge, String> {
        let mut relay = self.relay.write().await;
        relay.claim_challenge(device_id, challenge_id, peer_id, unix_now())
    }

    pub(crate) async fn complete_remote_claim(
        &self,
        device_id: &str,
        challenge_id: &str,
        peer_id: &str,
    ) -> Result<super::CompletedRemoteClaim, String> {
        let mut relay = self.relay.write().await;
        let claim = relay.complete_remote_claim(device_id, challenge_id, peer_id, unix_now())?;
        relay.notify();
        Ok(claim)
    }

    pub(crate) async fn mark_remote_device_seen(
        &self,
        device_id: &str,
        peer_id: &str,
    ) -> Result<(), String> {
        let mut relay = self.relay.write().await;
        relay.mark_paired_device_seen(device_id, peer_id, unix_now())?;
        Ok(())
    }
}
