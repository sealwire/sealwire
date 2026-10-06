use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

// Regression: a client_relay_grant with no matching device grant must still be
// removed AND persisted by revoke_device_grant. The save guard previously only
// checked the device-grant count, so an orphan client grant removal was dropped.
#[tokio::test]
async fn revoke_device_grant_persists_orphan_client_relay_grant_removal() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("agent-relay-revoke-{unique}.json"));
    let path_str = path.to_str().expect("temp path is utf8").to_string();
    let issuer = Some("revoke-test-issuer-a3f76b4c2089d15e6b0fa873c4e9521d".to_string());

    let plane =
        PublicControlPlane::from_parts(issuer.clone(), None, Some(path_str.clone()), None, None)
            .await
            .expect("plane should build");

    // Enroll a relay so we have a valid bearer token + relay_id/room.
    let enrolled = plane
        .issue_relay_registration_for_verify_key(&format!("vk-{unique}"), None)
        .await
        .expect("enroll should succeed");

    // Inject an ORPHAN client_relay_grant (no matching device grant), then persist.
    let device_id = "device-orphan";
    {
        let mut store = plane.lock_state().await.expect("lock");
        let grant = PersistedClientRelayGrant {
            client_id: "client-orphan".to_string(),
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: device_id.to_string(),
            granted_at: 0,
            relay_label: None,
            device_label: None,
        };
        store.client_relay_grants_by_key.insert(
            client_relay_grant_key(&grant.client_id, &grant.relay_id),
            grant,
        );
        plane
            .inner
            .persistence
            .save(&mut store)
            .await
            .expect("seed save");
    }

    // Revoke the device: no device grant to remove, but the orphan client grant
    // must be removed AND persisted.
    plane
        .revoke_device_grant(
            &enrolled.relay_refresh_token,
            device_id,
            DeviceGrantRevokeRequest {
                relay_id: enrolled.relay_id.clone(),
                broker_room_id: enrolled.broker_room_id.clone(),
            },
        )
        .await
        .expect("revoke should succeed");

    // Reload from disk: the orphan grant must be gone (i.e. the removal persisted).
    let reloaded = PublicControlPlane::from_parts(issuer, None, Some(path_str), None, None)
        .await
        .expect("reload should build");
    let remaining = reloaded
        .lock_state()
        .await
        .expect("lock reloaded")
        .client_relay_grants_by_key
        .len();
    let _ = std::fs::remove_file(&path);

    assert_eq!(
        remaining, 0,
        "orphan client_relay_grant removal must be persisted"
    );
}
