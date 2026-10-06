use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

/// Live-Postgres round-trip: a relay registration written by one instance
/// must survive a "restart" and load in a fresh instance against the same
/// database. Closes the gap that the JSON path was the only backend with
/// automated coverage.
///
/// Env-gated so plain `cargo test` stays offline. Run ONLY against a
/// DISPOSABLE database, serially (see the module-level SAFETY note):
///   RELAY_BROKER_TEST_POSTGRES_URL=postgres://user:pw@127.0.0.1:5433/throwaway \
///     cargo test -p relay-broker postgres_relay_registration -- --test-threads=1
#[tokio::test]
async fn postgres_relay_registration_persists_across_reload() {
    let Some((url, _serial)) = crate::postgres_test_url().await else {
        eprintln!("skipping postgres round-trip: set RELAY_BROKER_TEST_POSTGRES_URL to a live DB");
        return;
    };

    let issuer = Some("test-issuer-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string());
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let verify_key = format!("test-verify-key-{unique}");

    // Plane A writes a relay registration -> exercises the Postgres SAVE path.
    let plane_a = PublicControlPlane::from_parts_with_postgres(
        issuer.clone(),
        None,
        None,
        Some(url.clone()),
        None,
        None,
    )
    .await
    .expect("plane A should connect to postgres");
    let enrolled = plane_a
        .issue_relay_registration_for_verify_key(&verify_key, Some("round-trip".to_string()))
        .await
        .expect("registration should save to postgres");

    // Plane B is a brand-new instance against the same DB; its constructor
    // load()s from Postgres -> exercises the LOAD path after a "restart".
    let plane_b = PublicControlPlane::from_parts_with_postgres(
        issuer,
        None,
        None,
        Some(url.clone()),
        None,
        None,
    )
    .await
    .expect("plane B should connect to postgres");

    let loaded = plane_b
        .inner
        .state
        .lock()
        .await
        .registration_for_verify_key(&verify_key)
        .expect("registration written by plane A must survive reload in plane B");

    // Row-scoped cleanup: a targeted DELETE of only THIS run's registration
    // before asserting, so failures still clean up without touching any other
    // rows in the (disposable) database.
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("aux pool");
    sqlx::query("DELETE FROM public_relay_registrations WHERE relay_id = $1")
        .bind(&enrolled.relay_id)
        .execute(&pool)
        .await
        .expect("cleanup relay registration");

    assert_eq!(loaded.relay_id, enrolled.relay_id);
    assert_eq!(loaded.broker_room_id, enrolled.broker_room_id);
    assert_eq!(loaded.relay_label.as_deref(), Some("round-trip"));
}

/// Live-Postgres round-trip for device grants: a grant (with `last_seen`) must
/// survive reload, and a throttled ws-token refresh must bump `last_seen` via
/// the targeted single-row UPDATE (`touch_device_last_seen`). Env-gated.
///
/// DANGER: this test writes and deletes public-control rows (`issue_*` →
/// targeted `save()`, plus row-scoped cleanup). Point `RELAY_BROKER_TEST_POSTGRES_URL`
/// at a DISPOSABLE database ONLY, and run with `--test-threads=1`. Never point
/// it at a shared or running broker's database — a concurrent writer's rows can
/// be lost. Cleanup below is row-scoped (targeted DELETEs, not a whole-state
/// save) to minimise blast radius.
#[tokio::test]
async fn postgres_device_grant_last_seen_round_trips_and_touches() {
    let Some((url, _serial)) = crate::postgres_test_url().await else {
        eprintln!("skipping postgres device-grant round-trip: set RELAY_BROKER_TEST_POSTGRES_URL");
        return;
    };
    let issuer = Some("test-issuer-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string());
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let verify_key = format!("test-verify-key-devgrant-{unique}");
    let device_id = format!("device-{unique}");

    let plane_a = PublicControlPlane::from_parts_with_postgres(
        issuer.clone(),
        None,
        None,
        Some(url.clone()),
        None,
        None,
    )
    .await
    .expect("plane A should connect");
    let enrolled = plane_a
        .issue_relay_registration_for_verify_key(&verify_key, None)
        .await
        .expect("relay enroll");
    let grant = plane_a
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            DeviceGrantRequest {
                relay_id: enrolled.relay_id.clone(),
                broker_room_id: enrolled.broker_room_id.clone(),
                device_id: device_id.clone(),
            },
            Some(5),
        )
        .await
        .expect("device grant should save to postgres");

    // (1) A fresh instance loads the grant (with last_seen) from Postgres.
    let plane_b = PublicControlPlane::from_parts_with_postgres(
        issuer.clone(),
        None,
        None,
        Some(url.clone()),
        None,
        None,
    )
    .await
    .expect("plane B should connect");
    let reloaded_last_seen = {
        let guard = plane_b.inner.state.lock().await;
        guard
            .grants_by_hash
            .values()
            .find(|candidate| candidate.device_id == device_id)
            .map(|candidate| candidate.last_seen)
    };

    // (2) Age last_seen, then a ws-token refresh must bump it via the targeted
    // UPDATE (touch_device_last_seen), not the whole-state save. The throttle
    // decision reads the IN-MEMORY last_seen, so with reload-before-use off
    // (single-instance default) we must age the in-memory value — not just the
    // DB row — to simulate a device unseen for longer than the throttle window.
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("aux pool");
    sqlx::query("UPDATE public_device_grants SET last_seen = 1 WHERE device_id = $1")
        .bind(&device_id)
        .execute(&pool)
        .await
        .expect("age last_seen");
    {
        let mut store = plane_a.inner.state.lock().await;
        for grant in store.grants_by_hash.values_mut() {
            if grant.device_id == device_id {
                grant.last_seen = Some(1); // epoch 1 = well past the throttle window
            }
        }
    }
    plane_a
        .issue_device_ws_token(&grant.device_refresh_token)
        .await
        .expect("ws-token refresh");
    let (bumped,): (Option<i64>,) =
        sqlx::query_as("SELECT last_seen FROM public_device_grants WHERE device_id = $1")
            .bind(&device_id)
            .fetch_one(&pool)
            .await
            .expect("read last_seen");

    // Row-scoped cleanup before asserting — targeted DELETEs so we only touch
    // THIS test's rows in the (disposable) database.
    sqlx::query("DELETE FROM public_device_grants WHERE relay_id = $1")
        .bind(&enrolled.relay_id)
        .execute(&pool)
        .await
        .expect("cleanup device grants");
    sqlx::query("DELETE FROM public_relay_registrations WHERE relay_id = $1")
        .bind(&enrolled.relay_id)
        .execute(&pool)
        .await
        .expect("cleanup relay registration");

    assert!(
        reloaded_last_seen
            .expect("device grant must survive reload")
            .is_some(),
        "last_seen (set at grant time) must persist across reload"
    );
    assert!(
        bumped.unwrap_or(0) > 1,
        "a ws-token refresh must bump last_seen via the targeted UPDATE, got {bumped:?}"
    );
}
