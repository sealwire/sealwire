use super::*;

fn verify_key(seed: u32) -> String {
    let mut bytes = [7_u8; 32];
    bytes[..4].copy_from_slice(&seed.to_le_bytes());
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&bytes);
    STANDARD.encode(signing_key.verifying_key().to_bytes())
}

async fn in_memory_plane() -> PublicControlPlane {
    PublicControlPlane::from_parts(
        Some("input-test-issuer-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("in-memory plane should build")
}

/// The challenge endpoint is anonymous and each entry lives 300s.
#[tokio::test]
async fn enrollment_challenges_keep_labels_short_and_stop_at_a_cap() {
    let plane = in_memory_plane().await;
    plane
        .create_relay_enrollment_challenge(RelayEnrollmentChallengeRequest {
            relay_verify_key: verify_key(0),
            relay_label: Some("x".repeat(10_000)),
        })
        .await
        .expect("a long label is shortened, not refused");
    let mut accepted = 1;
    for seed in 1..5_000 {
        if plane
            .create_relay_enrollment_challenge(RelayEnrollmentChallengeRequest {
                relay_verify_key: verify_key(seed),
                relay_label: None,
            })
            .await
            .is_ok()
        {
            accepted += 1;
        }
    }

    let challenges = plane.inner.relay_enrollment_challenges.lock().await;
    let longest_label = challenges
        .values()
        .filter_map(|challenge| challenge.relay_label.as_ref())
        .map(|label| label.chars().count())
        .max();
    assert!(
        longest_label <= Some(128),
        "a {longest_label:?}-char label is held"
    );
    assert!(
        challenges.len() <= 4_096 && accepted < 5_000,
        "{} pending challenges are held",
        challenges.len()
    );
}

#[tokio::test]
async fn pending_client_claims_keep_labels_short_and_refuse_oversized_ids() {
    let plane = in_memory_plane().await;
    let enrolled = plane
        .issue_relay_registration_for_verify_key(&verify_key(1), None)
        .await
        .expect("enroll");
    let request = |device_id: String| ClientGrantRequest {
        relay_id: enrolled.relay_id.clone(),
        broker_room_id: enrolled.broker_room_id.clone(),
        device_id,
        client_verify_key: verify_key(2),
        client_label: Some("c".repeat(10_000)),
        device_label: Some("d".repeat(10_000)),
    };
    plane
        .issue_client_grant(&enrolled.relay_refresh_token, request("phone".to_string()))
        .await
        .expect("long labels are shortened, not refused");
    let oversized = plane
        .issue_client_grant(&enrolled.relay_refresh_token, request("p".repeat(10_000)))
        .await;

    let claims = plane.inner.pending_client_claims.lock().await;
    let longest_label = claims
        .values()
        .flat_map(|claim| [&claim.client_label, &claim.device_label])
        .filter_map(Option::as_ref)
        .map(|label| label.chars().count())
        .max();
    assert!(
        longest_label <= Some(128),
        "a {longest_label:?}-char label is held"
    );
    assert!(oversized.is_err(), "a 10k-byte device id must be refused");
    assert_eq!(claims.len(), 1);
}

#[tokio::test]
async fn a_relay_that_keeps_asking_for_client_claims_does_not_stop_another_relay_pairing() {
    let plane = in_memory_plane().await;
    let busy = plane
        .issue_relay_registration_for_verify_key(&verify_key(10), None)
        .await
        .expect("enroll the busy relay");
    let other = plane
        .issue_relay_registration_for_verify_key(&verify_key(11), None)
        .await
        .expect("enroll the other relay");
    let request =
        |relay: &RelayEnrollmentResponse, device_id: String, key: String| ClientGrantRequest {
            relay_id: relay.relay_id.clone(),
            broker_room_id: relay.broker_room_id.clone(),
            device_id,
            client_verify_key: key,
            client_label: None,
            device_label: None,
        };

    for n in 0..1_000 {
        let _ = plane
            .issue_client_grant(
                &busy.relay_refresh_token,
                request(&busy, format!("phone-{n}"), verify_key(1_000 + n)),
            )
            .await;
    }
    let paired = plane
        .issue_client_grant(
            &other.relay_refresh_token,
            request(&other, "phone".to_string(), verify_key(12)),
        )
        .await;

    assert!(
        paired.is_ok(),
        "another relay's requests blocked this relay's pairing: {paired:?}"
    );
}
