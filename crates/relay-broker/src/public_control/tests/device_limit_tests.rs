use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

async fn in_memory_plane() -> PublicControlPlane {
    PublicControlPlane::from_parts(
        Some("device-limit-test-issuer-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("in-memory plane should build")
}

fn grant_request(enrolled: &RelayEnrollmentResponse, device_id: &str) -> DeviceGrantRequest {
    DeviceGrantRequest {
        relay_id: enrolled.relay_id.clone(),
        broker_room_id: enrolled.broker_room_id.clone(),
        device_id: device_id.to_string(),
    }
}

async fn enroll(plane: &PublicControlPlane, tag: &str) -> RelayEnrollmentResponse {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    plane
        .issue_relay_registration_for_verify_key(&format!("vk-{tag}-{unique}"), None)
        .await
        .expect("enroll should succeed")
}

fn test_client_verify_key(seed: u8) -> String {
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    STANDARD.encode(signing_key.verifying_key().to_bytes())
}

/// The exact bytes the browser signs. This literal is duplicated in
/// `frontend/remote/crypto.test.mjs`; both sides assert against it, so a
/// change to either format drifts loudly instead of silently rejecting
/// every pairing at runtime.
#[test]
fn the_client_claim_message_matches_the_frontend_contract() {
    assert_eq!(
        client_claim_message("ccl-abc", "cn-def", "relay-1"),
        "agent-relay:client-claim:ccl-abc:cn-def:relay-1"
    );
}

async fn attest(
    plane: &PublicControlPlane,
    enrolled: &RelayEnrollmentResponse,
    device_id: &str,
    seed: u8,
) -> ClientGrantResponse {
    plane
        .issue_client_grant(
            &enrolled.relay_refresh_token,
            client_grant_request(enrolled, device_id, &test_client_verify_key(seed)),
        )
        .await
        .expect("relay attests the client key")
}

/// A full pairing: the relay attests, then the key holder redeems. Most
/// tests only care about the resulting credential, not the two-step shape.
async fn attest_and_claim(
    plane: &PublicControlPlane,
    enrolled: &RelayEnrollmentResponse,
    device_id: &str,
    seed: u8,
) -> ClientClaimResponse {
    let claim = attest(plane, enrolled, device_id, seed).await;
    plane
        .claim_client_identity(ClientClaimRequest {
            claim_id: claim.claim_id.clone(),
            claim_signature: sign_client_claim(seed, &claim),
        })
        .await
        .expect("key holder redeems the attestation")
}

/// Sign a claim the way the browser does: over the domain-separated message
/// binding claim id, nonce and relay.
fn sign_client_claim(seed: u8, claim: &ClientGrantResponse) -> String {
    use ed25519_dalek::Signer;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let message = client_claim_message(&claim.claim_id, &claim.claim_nonce, &claim.relay_id);
    STANDARD.encode(signing_key.sign(message.as_bytes()).to_bytes())
}

fn client_grant_request(
    enrolled: &RelayEnrollmentResponse,
    device_id: &str,
    verify_key: &str,
) -> ClientGrantRequest {
    ClientGrantRequest {
        relay_id: enrolled.relay_id.clone(),
        broker_room_id: enrolled.broker_room_id.clone(),
        device_id: device_id.to_string(),
        client_verify_key: verify_key.to_string(),
        client_label: None,
        device_label: None,
    }
}

/// A client identity belongs to the key holder, never to a relay.
///
/// `client_id` is derived from the client key alone and is therefore global,
/// so a relay that merely *names* someone's public key must gain nothing by
/// it. Knowing the key is not a secret: every relay a browser pairs with
/// learns it. What separates them is proof of possession.
///
/// Three things this pins, in order of how much they cost if lost:
///   1. the attestation call hands back no credential at all,
///   2. an attestation cannot be redeemed without the key holder's signature,
///   3. no grant row exists until that signature lands, so a hostile relay
///      cannot insert itself into someone's relay directory.
#[tokio::test]
async fn a_relay_must_not_mint_a_credential_for_another_relays_client() {
    let plane = in_memory_plane().await;
    let victim_relay = enroll(&plane, "victim").await;
    let attacker_relay = enroll(&plane, "attacker").await;
    let client_seed = 77;
    let client_verify_key = test_client_verify_key(client_seed);

    // The legitimate pairing: attest, then the key holder redeems it.
    let victim_claim = plane
        .issue_client_grant(
            &victim_relay.relay_refresh_token,
            client_grant_request(&victim_relay, "victim-phone", &client_verify_key),
        )
        .await
        .expect("the victim relay attests its own phone");
    let victim = plane
        .claim_client_identity(ClientClaimRequest {
            claim_id: victim_claim.claim_id.clone(),
            claim_signature: sign_client_claim(client_seed, &victim_claim),
        })
        .await
        .expect("the key holder redeems its own attestation");

    // The attacker presents the SAME client verify key under its own bearer.
    // It gets an attestation — that much is unavoidable, anyone may attest a
    // public key — but it must be worthless without the private half.
    let stolen = plane
        .issue_client_grant(
            &attacker_relay.relay_refresh_token,
            client_grant_request(&attacker_relay, "attacker-phone", &client_verify_key),
        )
        .await
        .expect("attacker attestation call");

    // 1. Nothing usable came back.
    assert!(
        !stolen.claim_id.is_empty() && !stolen.claim_nonce.is_empty(),
        "an attestation is a claim reference, not a credential"
    );

    // 2. Redeeming it needs a signature the attacker cannot produce. A
    //    signature lifted from the victim's own claim must not transfer,
    //    which is why the message binds the claim id and the relay.
    let replayed = sign_client_claim(client_seed, &victim_claim);
    let forged = plane
        .claim_client_identity(ClientClaimRequest {
            claim_id: stolen.claim_id.clone(),
            claim_signature: replayed,
        })
        .await;
    assert!(
        forged.is_err(),
        "a signature bound to another claim must not redeem this one"
    );

    // 3. The victim's directory must be untouched: no grant row was created
    //    for the attacker's relay, because no key holder ever signed for it.
    let visible = plane
        .list_client_relays(&victim.client_refresh_token)
        .await
        .expect("the victim lists its own relays");
    assert!(
        !visible
            .relays
            .iter()
            .any(|entry| entry.relay_id == attacker_relay.relay_id),
        "an unredeemed attestation must not appear in the client's relay directory; saw {:?}",
        visible.relays
    );
    assert!(
        visible
            .relays
            .iter()
            .any(|entry| entry.relay_id == victim_relay.relay_id),
        "the legitimately claimed relay must still be listed"
    );
}

/// A claim reference is single-use: redeeming it twice must not mint a
/// second credential. Without this, an observer of the sealed pairing result
/// could re-run the claim and rotate the phone's token out from under it —
/// the same lockout shape as `reapprove_must_not_brick_previous_client_token`.
#[tokio::test]
async fn a_client_claim_reference_cannot_be_redeemed_twice() {
    let plane = in_memory_plane().await;
    let relay = enroll(&plane, "single-use").await;
    let seed = 88;
    let claim = plane
        .issue_client_grant(
            &relay.relay_refresh_token,
            client_grant_request(&relay, "phone", &test_client_verify_key(seed)),
        )
        .await
        .expect("attest");
    let signature = sign_client_claim(seed, &claim);

    plane
        .claim_client_identity(ClientClaimRequest {
            claim_id: claim.claim_id.clone(),
            claim_signature: signature.clone(),
        })
        .await
        .expect("first redemption succeeds");

    let replay = plane
        .claim_client_identity(ClientClaimRequest {
            claim_id: claim.claim_id.clone(),
            claim_signature: signature,
        })
        .await;
    assert!(replay.is_err(), "a claim reference must be single-use");
}

#[tokio::test]
async fn a_new_client_claim_cancels_only_the_same_relays_older_one() {
    let plane = in_memory_plane().await;
    let relay = enroll(&plane, "newest-claim").await;
    let other_relay = enroll(&plane, "newest-claim-other").await;
    let older = attest(&plane, &relay, "phone-1", 41).await;
    let other = attest(&plane, &other_relay, "phone", 43).await;
    let newer = attest(&plane, &relay, "phone-2", 42).await;
    let redeem = |seed: u8, claim: &ClientGrantResponse| {
        plane.claim_client_identity(ClientClaimRequest {
            claim_id: claim.claim_id.clone(),
            claim_signature: sign_client_claim(seed, claim),
        })
    };

    let cancelled = redeem(41, &older).await;
    assert_eq!(
        cancelled.err().as_deref(),
        Some("client claim is invalid"),
        "the same relay's older claim must be cancelled"
    );
    redeem(43, &other)
        .await
        .expect("another relay's claim is untouched");
    redeem(42, &newer)
        .await
        .expect("the newest claim is redeemable");
}

/// The signature must be over the broker's nonce, not merely *a* valid
/// signature by the right key. Guards against a verifier that checks the key
/// but forgets to bind the challenge.
#[tokio::test]
async fn a_client_claim_rejects_a_signature_over_the_wrong_message() {
    let plane = in_memory_plane().await;
    let relay = enroll(&plane, "wrong-message").await;
    let seed = 99;
    let claim = plane
        .issue_client_grant(
            &relay.relay_refresh_token,
            client_grant_request(&relay, "phone", &test_client_verify_key(seed)),
        )
        .await
        .expect("attest");

    use ed25519_dalek::Signer;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let wrong = STANDARD.encode(
        signing_key
            .sign(b"agent-relay:client-claim:whatever")
            .to_bytes(),
    );

    assert!(
        plane
            .claim_client_identity(ClientClaimRequest {
                claim_id: claim.claim_id,
                claim_signature: wrong,
            })
            .await
            .is_err(),
        "the signature must cover the broker's own nonce"
    );
}

/// Approving a pairing rotates the client identity token; the fresh token is
/// only delivered to the session that completes THAT pairing handshake. When a
/// relay re-approves (duplicate tap, stale request, "re-authorizing" a device
/// that seems broken), the already-paired phone never sees the new token — so
/// its stored credential must keep authenticating for a grace window instead
/// of getting bricked by the very action meant to restore its access.
#[tokio::test]
async fn reapprove_must_not_brick_previous_client_token() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "regrant-client").await;

    let first = attest_and_claim(&plane, &enrolled, "phone-1", 21).await;
    // The phone holds `first.client_refresh_token`. Pairing runs again — a
    // duplicate tap, a re-authorize — and rotates the identity. The phone
    // that completed the FIRST handshake never receives the new credential.
    attest_and_claim(&plane, &enrolled, "phone-1", 21).await;

    plane
        .issue_client_session(&first.client_refresh_token)
        .await
        .expect(
            "a client token superseded by a re-approve the client never received \
             must keep authenticating within the rotation grace window",
        );
}

/// Same invariant for the device chain: re-issuing a grant for the same
/// device_id rotates the device refresh token; the previous token must keep
/// working within the grace window.
#[tokio::test]
async fn reapprove_must_not_brick_previous_device_token() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "regrant-device").await;
    let bearer = &enrolled.relay_refresh_token;

    let first = plane
        .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
        .await
        .expect("first approve");
    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
        .await
        .expect("re-approve");

    plane
        .issue_device_session(&first.device_refresh_token)
        .await
        .expect(
            "a device token superseded by a re-approve the device never received \
             must keep authenticating within the rotation grace window",
        );
}

#[tokio::test]
async fn superseded_client_token_use_does_not_extend_grace() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "fixed-client-grace").await;
    let first = attest_and_claim(&plane, &enrolled, "phone-1", 24).await;
    let second = attest_and_claim(&plane, &enrolled, "phone-1", 24).await;
    let old_hash = sha256_hex(&first.client_refresh_token);
    let deadline = unix_now().saturating_add(3600);
    {
        let mut store = plane.inner.state.lock().await;
        for identity in store.client_registrations_by_hash.values_mut() {
            for token in &mut identity.superseded {
                token.expires_at = deadline;
            }
        }
    }

    for _ in 0..3 {
        plane
            .issue_client_session(&first.client_refresh_token)
            .await
            .expect("old token remains usable before its deadline");
        let store = plane.inner.state.lock().await;
        let (_, identity) = find_client_identity_for_token(&store, &old_hash, deadline - 1)
            .expect("old token remains usable until its deadline");
        assert_eq!(identity.superseded[0].expires_at, deadline);
        assert!(find_client_identity_for_token(&store, &old_hash, deadline).is_none());
        assert!(find_client_identity_for_token(
            &store,
            &sha256_hex(&second.client_refresh_token),
            deadline,
        )
        .is_some());
    }
}

#[tokio::test]
async fn superseded_device_session_use_does_not_extend_grace() {
    assert_device_token_use_does_not_extend_grace(false).await;
}

#[tokio::test]
async fn superseded_device_ws_token_use_does_not_extend_grace() {
    assert_device_token_use_does_not_extend_grace(true).await;
}

#[tokio::test]
async fn signed_refresh_cannot_restore_a_device_revoked_on_another_broker() {
    assert_signed_refresh_respects_shared_revocation(true).await;
}

#[tokio::test]
async fn signed_refresh_cannot_restore_a_client_revoked_on_another_broker() {
    assert_signed_refresh_respects_shared_revocation(false).await;
}

#[tokio::test]
async fn refresh_challenge_capacity_covers_the_default_api_budget() {
    use ed25519_dalek::Signer;
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "refresh-capacity").await;
    let client = attest_and_claim(&plane, &enrolled, "phone-1", 89).await;
    let key = ed25519_dalek::SigningKey::from_bytes(&[89; 32]);
    let origin = "https://broker.test";
    let mut request = CredentialRefreshChallengeRequest {
        client_id: client.client_id,
        broker_room_id: None,
        device_id: None,
        nonce: "refresh-capacity-init".into(),
        signature: String::new(),
    };
    request.signature = STANDARD.encode(
        key.sign(credential_refresh_init_message(&request, origin).as_bytes())
            .to_bytes(),
    );
    let challenge = plane
        .create_credential_refresh_challenge(request.clone(), origin)
        .await
        .unwrap();
    let budget = crate::DEFAULT_PUBLIC_API_GLOBAL_RATE_LIMIT_PER_MINUTE
        * DEFAULT_CLIENT_CLAIM_TTL_SECS.div_ceil(crate::RATE_LIMIT_WINDOW_SECS) as usize;
    {
        let mut pending = plane.inner.pending_credential_refreshes.lock().await;
        pending.clear();
        for index in 0..budget - 1 {
            let mut busy = challenge.clone();
            busy.challenge_id = format!("busy-challenge-{index}");
            busy.client_id = format!("busy-client-{}", index / MAX_PENDING_REFRESHES_PER_CLIENT);
            pending.insert(
                busy.challenge_id.clone(),
                PendingCredentialRefresh {
                    quota_key: "test-quota".into(),
                    challenge: busy,
                    client_verify_key: STANDARD.encode(key.verifying_key().to_bytes()),
                    request_nonce: format!("busy-nonce-{index}"),
                },
            );
        }
    }
    let result = plane
        .create_credential_refresh_challenge(request, origin)
        .await;
    assert!(
        result.is_ok(),
        "pending challenges within the API's default TTL budget must not block another client: {result:?}"
    );
}

#[tokio::test]
async fn signed_refresh_rejects_an_expired_challenge() {
    use ed25519_dalek::Signer;
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "expired-refresh").await;
    let client = attest_and_claim(&plane, &enrolled, "phone-1", 87).await;
    let key = ed25519_dalek::SigningKey::from_bytes(&[87; 32]);
    let origin = "https://broker.test";
    let mut request = CredentialRefreshChallengeRequest {
        client_id: client.client_id,
        broker_room_id: None,
        device_id: None,
        nonce: "expired-refresh-init".into(),
        signature: String::new(),
    };
    request.signature = STANDARD.encode(
        key.sign(credential_refresh_init_message(&request, origin).as_bytes())
            .to_bytes(),
    );
    let challenge = plane
        .create_credential_refresh_challenge(request, origin)
        .await
        .unwrap();
    plane
        .inner
        .pending_credential_refreshes
        .lock()
        .await
        .get_mut(&challenge.challenge_id)
        .unwrap()
        .challenge
        .expires_at = 0;
    let result = plane
        .refresh_credentials(
            CredentialRefreshRequest {
                challenge_id: challenge.challenge_id.clone(),
                signature: STANDARD.encode(
                    key.sign(credential_refresh_message(&challenge).as_bytes())
                        .to_bytes(),
                ),
            },
            origin,
        )
        .await;
    assert!(
        result.is_err(),
        "an expired challenge cannot issue credentials"
    );
    plane
        .issue_client_session(&client.client_refresh_token)
        .await
        .expect("rejected recovery leaves the current token intact");
}

async fn assert_signed_refresh_respects_shared_revocation(device: bool) {
    use ed25519_dalek::Signer;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("broker-refresh-revoke-{unique}.json"));
    let issuer = Some("shared-refresh-test-a3f76b4c2089d15e6b0fa873c4e9521d".into());
    let owner = PublicControlPlane::from_parts(
        issuer.clone(),
        None,
        Some(path.to_string_lossy().into_owned()),
        None,
        None,
    )
    .await
    .expect("owner plane");
    let enrolled = enroll(&owner, "shared-refresh-revoke").await;
    owner
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            grant_request(&enrolled, "phone-1"),
            None,
        )
        .await
        .expect("device grant");
    let client = attest_and_claim(&owner, &enrolled, "phone-1", 35).await;
    let mut peer = PublicControlPlane::from_parts(
        issuer,
        None,
        Some(path.to_string_lossy().into_owned()),
        None,
        None,
    )
    .await
    .expect("peer plane");
    Arc::get_mut(&mut peer.inner).unwrap().force_shared_backend = true;
    let origin = "http://broker.test";
    let key = ed25519_dalek::SigningKey::from_bytes(&[35; 32]);
    let mut request = CredentialRefreshChallengeRequest {
        client_id: client.client_id,
        broker_room_id: device.then(|| enrolled.broker_room_id.clone()),
        device_id: None,
        nonce: "shared-revoke-init".into(),
        signature: String::new(),
    };
    request.signature = STANDARD.encode(
        key.sign(credential_refresh_init_message(&request, origin).as_bytes())
            .to_bytes(),
    );
    let challenge = peer
        .create_credential_refresh_challenge(request, origin)
        .await
        .expect("challenge before revocation");
    if device {
        owner
            .revoke_device_grant(
                &enrolled.relay_refresh_token,
                "phone-1",
                DeviceGrantRevokeRequest {
                    relay_id: enrolled.relay_id,
                    broker_room_id: enrolled.broker_room_id,
                },
            )
            .await
            .expect("revoke device on owner");
    } else {
        owner
            .revoke_client_identity(&client.client_refresh_token)
            .await
            .expect("revoke client on owner");
    }
    let result = peer
        .refresh_credentials(
            CredentialRefreshRequest {
                challenge_id: challenge.challenge_id.clone(),
                signature: STANDARD.encode(
                    key.sign(credential_refresh_message(&challenge).as_bytes())
                        .to_bytes(),
                ),
            },
            origin,
        )
        .await;
    let _ = fs::remove_file(path).await;
    assert!(
        result.is_err(),
        "a stale broker must not restore a revoked credential"
    );
}

async fn assert_device_token_use_does_not_extend_grace(ws_token: bool) {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "fixed-device-grace").await;
    let first = plane
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            grant_request(&enrolled, "phone-1"),
            None,
        )
        .await
        .expect("first grant");
    let second = plane
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            grant_request(&enrolled, "phone-1"),
            None,
        )
        .await
        .expect("second grant");
    let old_hash = sha256_hex(&first.device_refresh_token);
    let deadline = unix_now().saturating_add(3600);
    {
        let mut store = plane.inner.state.lock().await;
        for grant in store.grants_by_hash.values_mut() {
            for token in &mut grant.superseded {
                token.expires_at = deadline;
            }
        }
    }

    for _ in 0..3 {
        if ws_token {
            plane
                .issue_device_ws_token(&first.device_refresh_token)
                .await
                .expect("old token remains usable before its deadline");
        } else {
            plane
                .issue_device_session(&first.device_refresh_token)
                .await
                .expect("old token remains usable before its deadline");
        }
        let store = plane.inner.state.lock().await;
        let (_, grant) = find_device_grant_for_token(&store, &old_hash, deadline - 1)
            .expect("old token remains usable until its deadline");
        assert_eq!(grant.superseded[0].expires_at, deadline);
        assert!(find_device_grant_for_token(&store, &old_hash, deadline).is_none());
        assert!(find_device_grant_for_token(
            &store,
            &sha256_hex(&second.device_refresh_token),
            deadline,
        )
        .is_some());
    }
}

/// A room-scoped ws-token must only authenticate against its OWN relay's room,
/// and a mismatch must have zero side effects (no `last_seen` touch) — this is
/// what keeps a legacy/sibling token from silently refreshing the wrong relay.
#[tokio::test]
async fn issue_device_ws_token_scoped_verifies_room_without_side_effects() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "scoped-room").await;
    let bearer = &enrolled.relay_refresh_token;
    let grant = plane
        .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
        .await
        .expect("device grant");
    let room = &enrolled.broker_room_id;

    let ok = plane
        .issue_device_ws_token_scoped(&grant.device_refresh_token, room)
        .await
        .expect("matching room must authenticate");
    assert_eq!(&ok.broker_room_id, room);

    {
        let mut store = plane.inner.state.lock().await;
        for grant in store.grants_by_hash.values_mut() {
            if grant.device_id == "phone-1" {
                grant.last_seen = Some(0);
            }
        }
    }
    let before = last_seen_for(&plane, "phone-1").await;
    let err = plane
        .issue_device_ws_token_scoped(&grant.device_refresh_token, "room-someone-else")
        .await
        .expect_err("mismatched room must be rejected");
    assert_eq!(err, "device refresh token is invalid");
    assert_eq!(
        last_seen_for(&plane, "phone-1").await,
        before,
        "a rejected room mismatch must not touch last_seen"
    );
}

/// A wrong-room request must not affect a sibling relay's credential.
#[tokio::test]
async fn issue_device_session_scoped_room_mismatch_does_not_renew_grace() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "scoped-session-grace").await;
    let bearer = &enrolled.relay_refresh_token;
    let first = plane
        .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
        .await
        .expect("first grant");
    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
        .await
        .expect("re-grant supersedes the first token");

    // Pin the superseded token's grace expiry to a known value.
    let pinned = unix_now().saturating_add(3600);
    {
        let mut store = plane.inner.state.lock().await;
        for grant in store.grants_by_hash.values_mut() {
            for token in &mut grant.superseded {
                token.expires_at = pinned;
            }
        }
    }

    let err = plane
        .issue_device_session_scoped(&first.device_refresh_token, "room-not-mine")
        .await
        .expect_err("wrong-room establish must be rejected");
    assert_eq!(err, "device refresh token is invalid");

    let after = {
        let store = plane.inner.state.lock().await;
        store
            .grants_by_hash
            .values()
            .flat_map(|grant| grant.superseded.iter())
            .map(|token| token.expires_at)
            .max()
    };
    assert_eq!(
        after,
        Some(pinned),
        "a wrong-room establish must not renew the grace window"
    );
}

/// The grace window is a window, not immortality: once a superseded token's
/// expiry passes, it must be rejected.
#[tokio::test]
async fn superseded_token_expires_after_grace_window() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "grace-expiry").await;
    let bearer = &enrolled.relay_refresh_token;

    let first = plane
        .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
        .await
        .expect("first approve");
    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "phone-1"), None)
        .await
        .expect("re-approve");
    {
        let mut store = plane.inner.state.lock().await;
        for grant in store.grants_by_hash.values_mut() {
            for token in &mut grant.superseded {
                token.expires_at = 0;
            }
        }
    }

    plane
        .issue_device_session(&first.device_refresh_token)
        .await
        .expect_err("an expired superseded token must be rejected");
}

/// Explicit revocation is the immediate-cutoff path: it must kill the
/// current token AND every superseded token in the same stroke.
#[tokio::test]
async fn revoke_kills_superseded_tokens_immediately() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "grace-revoke").await;

    let first = attest_and_claim(&plane, &enrolled, "phone-1", 23).await;
    let second = attest_and_claim(&plane, &enrolled, "phone-1", 23).await;

    plane
        .revoke_client_identity(&second.client_refresh_token)
        .await
        .expect("revoke with the current token");

    plane
        .issue_client_session(&first.client_refresh_token)
        .await
        .expect_err("a superseded token must not survive an explicit revoke");
    plane
        .issue_client_session(&second.client_refresh_token)
        .await
        .expect_err("the revoked current token must be rejected");
}

#[tokio::test]
async fn device_grant_rejected_once_limit_reached() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "cap").await;
    let bearer = &enrolled.relay_refresh_token;
    let limit = Some(2);

    for i in 1..=2 {
        plane
            .issue_device_grant(
                bearer,
                grant_request(&enrolled, &format!("device-{i}")),
                limit,
            )
            .await
            .unwrap_or_else(|error| panic!("device {i} under the cap should succeed: {error}"));
    }
    let error = plane
        .issue_device_grant(bearer, grant_request(&enrolled, "device-3"), limit)
        .await
        .expect_err("the third device must be rejected at the cap");
    assert!(
        error.contains("device limit"),
        "expected a device-limit error, got: {error}"
    );
}

#[tokio::test]
async fn admin_stats_counts_devices_per_relay_sorted() {
    let plane = in_memory_plane().await;

    // Busy relay: 3 devices.
    let busy = enroll(&plane, "busy").await;
    for device in ["d1", "d2", "d3"] {
        plane
            .issue_device_grant(
                &busy.relay_refresh_token,
                grant_request(&busy, device),
                None,
            )
            .await
            .expect("busy grant");
    }
    // Re-granting an existing device must NOT inflate the count.
    plane
        .issue_device_grant(&busy.relay_refresh_token, grant_request(&busy, "d1"), None)
        .await
        .expect("regrant");

    // Quiet relay: 1 device.
    let quiet = enroll(&plane, "quiet").await;
    plane
        .issue_device_grant(
            &quiet.relay_refresh_token,
            grant_request(&quiet, "only"),
            None,
        )
        .await
        .expect("quiet grant");

    let stats = plane.admin_stats(10).await.expect("admin_stats");

    assert_eq!(stats.totals.relays, 2, "two relays are registered");
    assert_eq!(stats.totals.devices, 4, "3 + 1 device grants total");
    assert_eq!(stats.relays.len(), 2);
    // Busiest relay first.
    assert_eq!(stats.relays[0].relay_id, busy.relay_id);
    assert_eq!(stats.relays[0].device_count, 3, "dedupe keeps it at 3");
    assert_eq!(stats.relays[1].relay_id, quiet.relay_id);
    assert_eq!(stats.relays[1].device_count, 1);
}

#[tokio::test]
async fn admin_stats_includes_client_only_orphan_relays() {
    // Regression: a relay with a dangling client_relay_grant but NO registration
    // and NO device grant must still surface (and count in totals), or the abuse
    // signal for orphaned grants is silently dropped.
    let plane = in_memory_plane().await;
    plane
        .seed_client_relay_grant_for_test("orphan-relay", "client-1")
        .await;

    let stats = plane.admin_stats(10).await.expect("admin_stats");
    assert_eq!(stats.totals.relays, 1, "the orphan relay must be counted");
    let row = stats
        .relays
        .iter()
        .find(|r| r.relay_id == "orphan-relay")
        .expect("orphan relay should appear in the rows");
    assert_eq!(row.device_count, 0, "it has no device grants");
    assert_eq!(row.client_count, 1, "its client grant is surfaced");
}

#[tokio::test]
async fn admin_stats_top_n_caps_rows() {
    let plane = in_memory_plane().await;
    for tag in ["a", "b", "c"] {
        let relay = enroll(&plane, tag).await;
        plane
            .issue_device_grant(&relay.relay_refresh_token, grant_request(&relay, "d"), None)
            .await
            .expect("grant");
    }
    let stats = plane.admin_stats(2).await.expect("admin_stats");
    assert_eq!(stats.totals.relays, 3, "totals count all relays");
    assert_eq!(stats.relays.len(), 2, "but only top_n rows are returned");
}

#[tokio::test]
async fn regrant_existing_device_at_limit_succeeds() {
    // Re-registering an EXISTING device_id while at the cap must succeed:
    // the same-device dedupe frees its slot before the count check runs.
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "regrant").await;
    let bearer = &enrolled.relay_refresh_token;
    let limit = Some(2);

    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "device-a"), limit)
        .await
        .expect("device-a");
    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "device-b"), limit)
        .await
        .expect("device-b");
    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "device-a"), limit)
        .await
        .expect("re-granting an existing device at the cap should succeed");
    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "device-c"), limit)
        .await
        .expect_err("a genuinely new third device is still rejected");
}

#[tokio::test]
async fn no_limit_means_unlimited() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "unlimited").await;
    let bearer = &enrolled.relay_refresh_token;
    for i in 0..5 {
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, &format!("d-{i}")), None)
            .await
            .expect("with no cap, every grant should succeed");
    }
}

#[tokio::test]
async fn downgrade_grandfathers_existing_devices_but_blocks_new_ones() {
    // Seed 3 devices with no cap (pre-downgrade state), then apply limit 2.
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "grandfather").await;
    let bearer = &enrolled.relay_refresh_token;
    for device in ["g1", "g2", "g3"] {
        plane
            .issue_device_grant(bearer, grant_request(&enrolled, device), None)
            .await
            .unwrap_or_else(|error| panic!("seed {device}: {error}"));
    }

    let limit = Some(2); // downgraded cap, already exceeded (3 > 2)

    // Re-registering an EXISTING device is grandfathered: no net seat, allowed
    // even while over-limit.
    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "g1"), limit)
        .await
        .expect("re-registering an existing device must be allowed over-limit");

    // A genuinely new device is rejected...
    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "g4"), limit)
        .await
        .expect_err("a new device over the cap must be rejected");

    // ...and that rejection must NOT have dropped any existing grant.
    let count = plane
        .lock_state()
        .await
        .expect("lock")
        .count_device_grants_for_relay(&enrolled.relay_id);
    assert_eq!(
        count, 3,
        "grandfathered grants must survive a re-register and a rejected new grant"
    );
}

#[tokio::test]
async fn revoking_a_device_frees_a_slot() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "revoke").await;
    let bearer = &enrolled.relay_refresh_token;
    let limit = Some(2);

    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "d1"), limit)
        .await
        .expect("d1");
    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "d2"), limit)
        .await
        .expect("d2");
    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "d3"), limit)
        .await
        .expect_err("at the cap");

    plane
        .revoke_device_grant(
            bearer,
            "d1",
            DeviceGrantRevokeRequest {
                relay_id: enrolled.relay_id.clone(),
                broker_room_id: enrolled.broker_room_id.clone(),
            },
        )
        .await
        .expect("revoke d1");

    plane
        .issue_device_grant(bearer, grant_request(&enrolled, "d3"), limit)
        .await
        .expect("revoking a device frees a slot for a new one");
}

#[test]
fn should_touch_last_seen_respects_throttle() {
    assert!(
        should_touch_last_seen(None, 100),
        "never-recorded always touches"
    );
    assert!(
        !should_touch_last_seen(Some(100), 100 + LAST_SEEN_THROTTLE_SECS - 1),
        "within the throttle window it must NOT touch"
    );
    assert!(
        should_touch_last_seen(Some(100), 100 + LAST_SEEN_THROTTLE_SECS),
        "at/after the throttle window it must touch"
    );
}

async fn last_seen_for(plane: &PublicControlPlane, device_id: &str) -> Option<u64> {
    plane
        .lock_state()
        .await
        .expect("lock")
        .grants_by_hash
        .values()
        .find(|grant| grant.device_id == device_id)
        .and_then(|grant| grant.last_seen)
}

#[tokio::test]
async fn last_seen_is_set_on_grant_and_throttled_on_refresh() {
    let plane = in_memory_plane().await;
    let enrolled = enroll(&plane, "lastseen").await;
    let issued = plane
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            grant_request(&enrolled, "dev"),
            None,
        )
        .await
        .expect("grant");

    let at_grant = last_seen_for(&plane, "dev").await;
    assert!(at_grant.is_some(), "last_seen must be set at grant time");

    // Refresh immediately: still inside the throttle window → unchanged.
    plane
        .issue_device_ws_token(&issued.device_refresh_token)
        .await
        .expect("refresh within window");
    assert_eq!(
        last_seen_for(&plane, "dev").await,
        at_grant,
        "a refresh inside the throttle window must not bump last_seen"
    );

    // Age last_seen far into the past, then refresh → it must bump forward.
    {
        let mut store = plane.lock_state().await.expect("lock");
        for grant in store.grants_by_hash.values_mut() {
            if grant.device_id == "dev" {
                grant.last_seen = Some(1); // epoch 1 = well past the throttle window
            }
        }
    }
    plane
        .issue_device_ws_token(&issued.device_refresh_token)
        .await
        .expect("refresh after window");
    let bumped = last_seen_for(&plane, "dev")
        .await
        .expect("last_seen still present");
    assert!(
        bumped > 1,
        "a refresh after the throttle window must bump last_seen; got {bumped}"
    );
}
