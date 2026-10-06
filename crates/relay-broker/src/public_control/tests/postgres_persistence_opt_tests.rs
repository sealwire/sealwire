use super::*;
use std::time::Instant;

fn relay_reg(hash: &str, label: Option<&str>) -> PersistedRelayRegistration {
    PersistedRelayRegistration {
        relay_id: format!("relay-{hash}"),
        broker_room_id: format!("room-{hash}"),
        refresh_token_hash: hash.to_string(),
        created_at: 100,
        relay_label: label.map(|s| s.to_string()),
        relay_verify_key: Some(format!("vk-{hash}")),
    }
}
fn client_ident(hash: &str) -> PersistedClientIdentity {
    PersistedClientIdentity {
        client_id: format!("client-{hash}"),
        client_verify_key: format!("cvk-{hash}"),
        refresh_token_hash: hash.to_string(),
        created_at: 300,
        client_label: None,
        superseded: Vec::new(),
    }
}
fn device_grant(hash: &str, last_seen: Option<u64>) -> PersistedDeviceGrant {
    PersistedDeviceGrant {
        relay_id: format!("relay-{hash}"),
        broker_room_id: format!("room-{hash}"),
        device_id: format!("dev-{hash}"),
        refresh_token_hash: hash.to_string(),
        created_at: 200,
        last_seen,
        superseded: Vec::new(),
    }
}
fn client_relay_grant(client_id: &str, relay_id: &str) -> PersistedClientRelayGrant {
    PersistedClientRelayGrant {
        client_id: client_id.to_string(),
        relay_id: relay_id.to_string(),
        broker_room_id: format!("room-{relay_id}"),
        device_id: format!("dev-{client_id}"),
        granted_at: 400,
        relay_label: None,
        device_label: None,
    }
}
fn store_from(
    regs: Vec<PersistedRelayRegistration>,
    clients: Vec<PersistedClientIdentity>,
    grants: Vec<PersistedDeviceGrant>,
    crg: Vec<PersistedClientRelayGrant>,
) -> PublicControlStateStore {
    let mut s = PublicControlStateStore::default();
    for r in regs {
        s.relay_registrations_by_hash
            .insert(r.refresh_token_hash.clone(), r);
    }
    for c in clients {
        s.client_registrations_by_hash
            .insert(c.refresh_token_hash.clone(), c);
    }
    for g in grants {
        s.grants_by_hash.insert(g.refresh_token_hash.clone(), g);
    }
    for g in crg {
        s.client_relay_grants_by_key
            .insert(client_relay_grant_key(&g.client_id, &g.relay_id), g);
    }
    s
}
async fn truncate_all(pool: &PgPool) {
    for table in [
        "public_client_relay_grants",
        "public_device_grants",
        "public_client_identities",
        "public_relay_registrations",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(pool)
            .await
            .expect("truncate table");
    }
}
async fn connect_and_init(url: &str) -> PgPool {
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(url)
        .await
        .expect("connect test postgres");
    initialize_postgres_public_control_schema(&pool)
        .await
        .expect("init schema");
    pool
}
async fn test_url() -> Option<(String, tokio::sync::MutexGuard<'static, ()>)> {
    crate::postgres_test_url().await
}

#[tokio::test]
async fn postgres_rotation_cannot_restore_a_concurrently_revoked_device() {
    assert_postgres_rotation_revoke_conflict(false).await;
}

#[tokio::test]
async fn postgres_revoke_cannot_report_success_after_a_concurrent_rotation() {
    assert_postgres_rotation_revoke_conflict(true).await;
}

async fn assert_postgres_rotation_revoke_conflict(rotation_first: bool) {
    let Some((url, _serial)) = test_url().await else {
        return;
    };
    let pool = connect_and_init(&url).await;
    truncate_all(&pool).await;
    let original = store_from(
        vec![relay_reg("race", None)],
        vec![client_ident("race")],
        vec![device_grant("race", None)],
        vec![],
    );
    save_public_control_postgres(&pool, &PublicControlStateStore::default(), &original)
        .await
        .expect("seed originals");
    let mut rotated = original.clone();
    let mut grant = rotated.grants_by_hash.remove("race").unwrap();
    grant.refresh_token_hash = "race-new".into();
    rotated
        .grants_by_hash
        .insert(grant.refresh_token_hash.clone(), grant);
    let mut revoked = original.clone();
    revoked.grants_by_hash.clear();
    let (first, second) = if rotation_first {
        (&rotated, &revoked)
    } else {
        (&revoked, &rotated)
    };
    save_public_control_postgres(&pool, &original, first)
        .await
        .expect("first writer commits");
    let result = save_public_control_postgres(&pool, &original, second).await;
    let actual = load_public_control_postgres(&pool)
        .await
        .expect("load final state");
    truncate_all(&pool).await;
    assert!(
        result.is_err(),
        "a stale write must fail instead of restoring access or reporting a false revoke"
    );
    assert_eq!(
        &actual, first,
        "a failed stale write must leave committed authorization intact"
    );
}

/// The diff-save must apply adds, in-place updates, AND deletes so a reload
/// reproduces the live state exactly — this is the regression guard that the
/// switch away from wipe-and-rebuild did not silently drop or stale any row.
#[tokio::test]
async fn postgres_targeted_save_applies_add_update_delete() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    let pool = connect_and_init(&url).await;
    truncate_all(&pool).await;

    // (1) ADD from empty.
    let empty = PublicControlStateStore::default();
    let v1 = store_from(
        vec![relay_reg("r1", Some("first"))],
        vec![client_ident("c1")],
        vec![device_grant("g1", Some(7))],
        vec![client_relay_grant("client-c1", "relay-r1")],
    );
    save_public_control_postgres(&pool, &empty, &v1)
        .await
        .expect("save v1");
    let loaded1 = load_public_control_postgres(&pool).await.expect("load v1");
    assert_eq!(
        loaded1.relay_registrations_by_hash, v1.relay_registrations_by_hash,
        "add relay registration"
    );
    assert_eq!(
        loaded1.client_registrations_by_hash, v1.client_registrations_by_hash,
        "add client identity"
    );
    assert_eq!(
        loaded1.grants_by_hash, v1.grants_by_hash,
        "add device grant"
    );
    assert_eq!(
        loaded1.client_relay_grants_by_key, v1.client_relay_grants_by_key,
        "add client-relay grant"
    );

    // (2) One save carrying an add/update/delete for EVERY table:
    //   relay:        in-place label update (r1)
    //   client:       in-place label update (c1)
    //   device grant: delete g1 + add g2
    //   client-relay: delete the only grant
    let updated_client = PersistedClientIdentity {
        client_label: Some("renamed-client".to_string()),
        ..client_ident("c1")
    };
    let v2 = store_from(
        vec![relay_reg("r1", Some("renamed"))],
        vec![updated_client],
        vec![device_grant("g2", None)],
        vec![], // client-relay grant removed
    );
    save_public_control_postgres(&pool, &v1, &v2)
        .await
        .expect("save v2");
    let loaded2 = load_public_control_postgres(&pool).await.expect("load v2");
    assert_eq!(
        loaded2.relay_registrations_by_hash, v2.relay_registrations_by_hash,
        "in-place relay label update must persist"
    );
    assert_eq!(
        loaded2.client_registrations_by_hash, v2.client_registrations_by_hash,
        "in-place client label update must persist"
    );
    assert!(
        !loaded2.grants_by_hash.contains_key("g1"),
        "removed device grant must be deleted, not left stale"
    );
    assert_eq!(
        loaded2.grants_by_hash, v2.grants_by_hash,
        "delete g1 + add g2 must both persist"
    );
    assert!(
        loaded2.client_relay_grants_by_key.is_empty(),
        "removed client-relay grant must be deleted"
    );

    truncate_all(&pool).await;
}

/// Credential rotation (relay re-enroll, client rotation, device re-registration)
/// changes the PK `refresh_token_hash` while KEEPING a secondary UNIQUE column
/// (relay_id / broker_room_id / relay_verify_key / client_id / client_verify_key /
/// `(relay_id, broker_room_id, device_id)`). The diff-save must delete the old row
/// BEFORE inserting the new one, or the insert collides with the surviving old row
/// on that secondary unique index and the whole transaction aborts — wedging the
/// control plane. This is the regression guard for that ordering.
#[tokio::test]
async fn postgres_targeted_save_handles_credential_rotation() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    let pool = connect_and_init(&url).await;
    truncate_all(&pool).await;

    // Seed one row per rotating table.
    let v1 = store_from(
        vec![relay_reg("rot1", Some("v1"))],
        vec![client_ident("rotc1")],
        vec![device_grant("rotg1", Some(1))],
        vec![],
    );
    save_public_control_postgres(&pool, &PublicControlStateStore::default(), &v1)
        .await
        .expect("seed rotation baseline");

    // Rotate the PK (refresh_token_hash) while every secondary UNIQUE column
    // stays identical — exactly what re-enrollment / rotation / re-grant do.
    let mut rotated_relay = relay_reg("rot1", Some("v2"));
    rotated_relay.refresh_token_hash = "rot1-NEW".to_string();
    let mut rotated_client = client_ident("rotc1");
    rotated_client.refresh_token_hash = "rotc1-NEW".to_string();
    let mut rotated_grant = device_grant("rotg1", Some(2));
    rotated_grant.refresh_token_hash = "rotg1-NEW".to_string();
    let v2 = store_from(
        vec![rotated_relay],
        vec![rotated_client],
        vec![rotated_grant],
        vec![],
    );

    save_public_control_postgres(&pool, &v1, &v2)
        .await
        .expect("rotation must not violate secondary unique constraints");

    let loaded = load_public_control_postgres(&pool).await.expect("load");
    assert_eq!(
        loaded.relay_registrations_by_hash.len(),
        1,
        "old relay row must be gone, only the rotated one remains"
    );
    assert!(loaded.relay_registrations_by_hash.contains_key("rot1-NEW"));
    assert!(loaded
        .client_registrations_by_hash
        .contains_key("rotc1-NEW"));
    assert!(loaded.grants_by_hash.contains_key("rotg1-NEW"));
    assert!(!loaded.relay_registrations_by_hash.contains_key("rot1"));

    truncate_all(&pool).await;
}

/// Rotation exercised through the real `PublicControlPlane` save path (not just
/// the low-level diff helper): re-enrolling the same relay verify key rotates the
/// refresh token but keeps relay_id/room/verify_key, which must persist.
#[tokio::test]
async fn postgres_relay_reenrollment_through_save_path_persists() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let verify_key = format!("reenroll-vk-{unique}");

    let plane = PublicControlPlane::from_parts_with_postgres(
        Some("test-issuer-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        Some(url.clone()),
        None,
        None,
    )
    .await
    .expect("plane connects");

    let first = plane
        .issue_relay_registration_for_verify_key(&verify_key, Some("first".to_string()))
        .await
        .expect("initial enroll");
    // Second enroll with the SAME verify key = re-enrollment: rotates the refresh
    // token, keeps relay_id/room. With insert-before-delete this aborted on the
    // relay_verify_key / relay_id unique index.
    let second = plane
        .issue_relay_registration_for_verify_key(&verify_key, Some("second".to_string()))
        .await
        .expect("re-enrollment must succeed through the save path");
    assert_eq!(second.relay_id, first.relay_id, "re-enroll keeps relay_id");

    // Fresh instance loads from Postgres → the rotated registration survived.
    let plane_b = PublicControlPlane::from_parts_with_postgres(
        Some("test-issuer-secret-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        None,
        Some(url.clone()),
        None,
        None,
    )
    .await
    .expect("plane B connects");
    let loaded = plane_b
        .inner
        .state
        .lock()
        .await
        .registration_for_verify_key(&verify_key)
        .expect("rotated registration must survive reload");
    assert_eq!(loaded.relay_id, second.relay_id);

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("aux pool");
    sqlx::query("DELETE FROM public_relay_registrations WHERE relay_id = $1")
        .bind(&second.relay_id)
        .execute(&pool)
        .await
        .expect("cleanup");
}

/// Build a store that fails the save via a transaction-local constraint
/// violation: a second registration reuses relay_id `relay-A`, so its upsert
/// hits the `relay_id` UNIQUE index and the transaction aborts WITHOUT dropping
/// the table (so the DB stays inspectable). Contains the original A row too.
fn store_that_violates_relay_id_unique() -> PublicControlStateStore {
    let mut bad = store_from(vec![relay_reg("A", Some("orig"))], vec![], vec![], vec![]);
    let mut dup = relay_reg("A", Some("orig")); // same relay_id = relay-A
    dup.refresh_token_hash = "DUP".to_string();
    bad.relay_registrations_by_hash
        .insert("DUP".to_string(), dup);
    bad
}

/// Pre-commit failure (definite rollback): a save that aborts mid-transaction
/// must leave BOTH the DB and memory at the original credential A — memory must
/// never run ahead of the database.
#[tokio::test]
async fn postgres_save_failure_reconciles_memory_with_db() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    let pool = connect_and_init(&url).await;
    truncate_all(&pool).await;

    let persistence = PublicControlPersistence::Postgres {
        pool: pool.clone(),
        gate: PublicControlDbGate::default(),
        reload_before_use: false,
        last_saved: std::sync::Arc::new(
            tokio::sync::Mutex::new(PublicControlStateStore::default()),
        ),
        needs_reload: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };

    // Persist the original credential A.
    let mut store = store_from(vec![relay_reg("A", Some("orig"))], vec![], vec![], vec![]);
    persistence.save(&mut store).await.expect("initial save");

    // A save that violates the relay_id UNIQUE index aborts pre-commit.
    let mut bad = store_that_violates_relay_id_unique();
    assert!(
        persistence.save(&mut bad).await.is_err(),
        "duplicate relay_id must fail the save"
    );

    // Memory: only A, the un-persisted DUP is gone.
    assert!(bad.relay_registrations_by_hash.contains_key("A"));
    assert!(
        !bad.relay_registrations_by_hash.contains_key("DUP"),
        "the un-persisted row must not survive in memory"
    );

    // DB: also still exactly A (transaction rolled back cleanly).
    let db_hashes: Vec<String> = sqlx::query_scalar(
        "SELECT refresh_token_hash FROM public_relay_registrations ORDER BY refresh_token_hash",
    )
    .fetch_all(&pool)
    .await
    .expect("read db");
    assert_eq!(db_hashes, vec!["A".to_string()], "DB must remain at A");

    truncate_all(&pool).await;
}

/// AMBIGUOUS commit failure: Postgres may durably commit `next` even though the
/// client sees a save error (connection dropped after COMMIT, before the ack).
/// We simulate the resulting state — the DB has moved ahead of the last snapshot
/// — then trigger a failed save, and assert the failure handler reconciles memory
/// to the ACTUAL DB state instead of blindly restoring the stale snapshot (which
/// would drop the durably-committed row). Red→green guard for the ambiguous fix:
/// restoring the snapshot yields {A} and fails the `contains_key("B")` assert.
#[tokio::test]
async fn postgres_ambiguous_save_failure_reconciles_to_db_truth() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    let pool = connect_and_init(&url).await;
    truncate_all(&pool).await;

    let persistence = PublicControlPersistence::Postgres {
        pool: pool.clone(),
        gate: PublicControlDbGate::default(),
        reload_before_use: false,
        last_saved: std::sync::Arc::new(
            tokio::sync::Mutex::new(PublicControlStateStore::default()),
        ),
        needs_reload: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };

    // Snapshot = {A}.
    let mut store = store_from(vec![relay_reg("A", Some("orig"))], vec![], vec![], vec![]);
    persistence.save(&mut store).await.expect("initial save");

    // Out of band, the DB gains B — standing in for a committed-but-unacked row.
    // The DB is now {A, B} while the in-memory snapshot is still {A}.
    sqlx::query(
        "INSERT INTO public_relay_registrations \
         (refresh_token_hash, relay_id, broker_room_id, created_at, relay_verify_key) \
         VALUES ('B', 'relay-B', 'room-B', 1, 'vk-B')",
    )
    .execute(&pool)
    .await
    .expect("inject committed row B");

    // A save that fails (duplicate relay_id) leaves the DB at {A, B}.
    let mut bad = store_that_violates_relay_id_unique();
    assert!(
        persistence.save(&mut bad).await.is_err(),
        "duplicate relay_id must fail the save"
    );

    // Memory must reconcile to the ACTUAL DB state {A, B}, NOT the stale snapshot
    // {A}. Restoring the snapshot would drop the durably-committed B.
    assert!(
        bad.relay_registrations_by_hash.contains_key("A"),
        "A present"
    );
    assert!(
        bad.relay_registrations_by_hash.contains_key("B"),
        "failure handling must reload the DB truth (B), not restore the stale snapshot"
    );
    assert!(
        !bad.relay_registrations_by_hash.contains_key("DUP"),
        "the un-persisted DUP must not survive"
    );

    truncate_all(&pool).await;
}

/// The decision that turns a failed-but-committed save into `Ok` (so the caller
/// delivers the credential) vs `Err`. Pure, no DB. This is the guard for "when
/// the reconciled DB holds the intended rotation B, save() reports success".
#[test]
fn classify_save_reconciliation_maps_db_truth_to_outcome() {
    let a = store_from(vec![relay_reg("A", None)], vec![], vec![], vec![]);
    let b = store_from(vec![relay_reg("B", None)], vec![], vec![], vec![]);
    let c = store_from(vec![relay_reg("C", None)], vec![], vec![], vec![]);
    // prev = A, next = B.
    // DB == next(B): the commit landed → Committed → save() returns Ok, B delivered.
    assert_eq!(
        classify_save_reconciliation(&b, &a, &b),
        SaveReconciliation::Committed
    );
    // DB == prev(A): rolled back → RolledBack → save() returns Err, A still valid.
    assert_eq!(
        classify_save_reconciliation(&a, &a, &b),
        SaveReconciliation::RolledBack
    );
    // DB == neither → Indeterminate → save() returns Err, memory follows the DB.
    assert_eq!(
        classify_save_reconciliation(&c, &a, &b),
        SaveReconciliation::Indeterminate
    );
}

/// When a save fails AND the reconciling reload also fails (DB unreachable), the
/// outcome is unknown: save() must surface the error AND arm a forced reload so
/// the next reachable operation repairs memory (rather than silently trusting a
/// possibly-stale snapshot with reload-before-use off).
#[tokio::test]
async fn postgres_save_and_reload_both_failing_arms_forced_reload() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    let pool = connect_and_init(&url).await;
    truncate_all(&pool).await;

    let persistence = PublicControlPersistence::Postgres {
        pool: pool.clone(),
        gate: PublicControlDbGate::default(),
        reload_before_use: false,
        last_saved: std::sync::Arc::new(
            tokio::sync::Mutex::new(PublicControlStateStore::default()),
        ),
        needs_reload: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };

    let mut store = store_from(vec![relay_reg("A", Some("orig"))], vec![], vec![], vec![]);
    persistence.save(&mut store).await.expect("initial save");

    // Drop every table so BOTH the save and the reconciling reload fail.
    for table in [
        "public_client_relay_grants",
        "public_device_grants",
        "public_client_identities",
        "public_relay_registrations",
    ] {
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&pool)
            .await
            .expect("drop table");
    }

    let mut next = store_from(vec![relay_reg("B", Some("new"))], vec![], vec![], vec![]);
    assert!(
        persistence.save(&mut next).await.is_err(),
        "save must fail with all tables dropped"
    );
    // The reload could not determine the outcome → a forced reload must be armed.
    if let PublicControlPersistence::Postgres { needs_reload, .. } = &persistence {
        assert!(
            needs_reload.load(std::sync::atomic::Ordering::SeqCst),
            "an indeterminate save failure must arm a forced reload"
        );
    } else {
        panic!("expected a Postgres persistence");
    }

    // cleanup: recreate the tables on the disposable DB.
    initialize_postgres_public_control_schema(&pool)
        .await
        .expect("recreate tables");
    truncate_all(&pool).await;
}

/// Build a Postgres-backed plane with an EMPTY in-memory state — models a serving
/// broker whose in-memory map does not (yet) know about a client identity that IS
/// durably persisted in Postgres. Real ways to reach this on a "single instance":
/// a rotation committed by the other container during a rolling-deploy window, a
/// second replica, or a committed-but-unacked rotation whose row is in the DB.
/// `reload_before_use` picks the two production modes.
fn postgres_plane(pool: PgPool, reload_before_use: bool) -> PublicControlPlane {
    PublicControlPlane {
        inner: Arc::new(PublicControlPlaneInner {
            issuer_key: JoinTicketKey::from_secret(
                b"client-lockout-repro-issuer-a3f76b4c2089d15e6b0fa873c4e9521d",
            )
            .expect("issuer key"),
            relay_ws_ttl_secs: DEFAULT_PUBLIC_RELAY_WS_TTL_SECS,
            device_ws_ttl_secs: DEFAULT_PUBLIC_DEVICE_WS_TTL_SECS,
            rotation_grace_secs: DEFAULT_PUBLIC_ROTATION_GRACE_SECS,
            persistence: PublicControlPersistence::Postgres {
                pool,
                gate: PublicControlDbGate::default(),
                reload_before_use,
                last_saved: Arc::new(Mutex::new(PublicControlStateStore::default())),
                needs_reload: Arc::new(AtomicBool::new(false)),
            },
            state: Mutex::new(PublicControlStateStore::default()),
            relay_enrollment_challenges: Mutex::new(HashMap::new()),
            relay_ws_ticket_challenges: Mutex::new(HashMap::new()),
            relay_control_challenges: Mutex::new(HashMap::new()),
            ticket_origin: DEFAULT_RELAY_WS_TICKET_ORIGIN.to_string(),
            relay_ws_ticket_challenge_ttl_secs: DEFAULT_RELAY_WS_TICKET_CHALLENGE_TTL_SECS,
            pending_client_claims: Mutex::new(HashMap::new()),
            pending_credential_refreshes: Mutex::new(HashMap::new()),
            last_full_load: std::sync::Mutex::new(None),
            miss_reload_min_interval: MISS_RELOAD_MIN_INTERVAL,
            force_shared_backend: false,
            force_probe_hit: false,
            probe_release: None,
            force_reload_before_use: false,
            full_load_count: std::sync::atomic::AtomicU64::new(0),
            probe_count: std::sync::atomic::AtomicU64::new(0),
            load_delay: Duration::ZERO,
            persistence_down: AtomicBool::new(false),
            load_log: std::sync::Mutex::new(Vec::new()),
            save_fail_remaining: std::sync::atomic::AtomicU64::new(0),
            reload_uncertain_fail_remaining: std::sync::atomic::AtomicU64::new(0),
            cleanup_pause: std::sync::Mutex::new(None),
        }),
    }
}

#[tokio::test]
async fn postgres_signed_refresh_probes_client_id_and_persists_credentials() {
    use ed25519_dalek::Signer;
    let Some((url, _serial)) = test_url().await else {
        return;
    };
    let pool = connect_and_init(&url).await;
    truncate_all(&pool).await;
    let owner = postgres_plane(pool.clone(), false);
    let relay = owner
        .issue_relay_registration_for_verify_key("vk-signed-refresh", None)
        .await
        .unwrap();
    owner
        .issue_device_grant(
            &relay.relay_refresh_token,
            DeviceGrantRequest {
                relay_id: relay.relay_id.clone(),
                broker_room_id: relay.broker_room_id.clone(),
                device_id: "signed-phone".into(),
            },
            None,
        )
        .await
        .unwrap();
    let key = ed25519_dalek::SigningKey::from_bytes(&[88; 32]);
    let attestation = owner
        .issue_client_grant(
            &relay.relay_refresh_token,
            ClientGrantRequest {
                relay_id: relay.relay_id.clone(),
                broker_room_id: relay.broker_room_id.clone(),
                device_id: "signed-phone".into(),
                client_verify_key: STANDARD.encode(key.verifying_key().to_bytes()),
                client_label: None,
                device_label: None,
            },
        )
        .await
        .unwrap();
    let client = owner
        .claim_client_identity(ClientClaimRequest {
            claim_id: attestation.claim_id.clone(),
            claim_signature: STANDARD.encode(
                key.sign(
                    client_claim_message(
                        &attestation.claim_id,
                        &attestation.claim_nonce,
                        &attestation.relay_id,
                    )
                    .as_bytes(),
                )
                .to_bytes(),
            ),
        })
        .await
        .unwrap();
    let peer = postgres_plane(pool.clone(), false);
    let origin = "https://broker.test";
    let mut request = CredentialRefreshChallengeRequest {
        client_id: client.client_id,
        broker_room_id: Some(relay.broker_room_id),
        device_id: Some("signed-phone".into()),
        nonce: "postgres-refresh-init".into(),
        signature: String::new(),
    };
    request.signature = STANDARD.encode(
        key.sign(credential_refresh_init_message(&request, origin).as_bytes())
            .to_bytes(),
    );
    let challenge = peer
        .create_credential_refresh_challenge(request, origin)
        .await
        .unwrap();
    assert_eq!(peer.inner.probe_count.load(Ordering::SeqCst), 1);
    assert_eq!(peer.inner.full_load_count.load(Ordering::SeqCst), 1);
    let (response, client_token, device_token) = peer
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
        .await
        .unwrap();
    assert_eq!(response.device.as_ref().unwrap().device_id, "signed-phone");
    let restarted = postgres_plane(pool.clone(), false);
    restarted
        .issue_client_session(&client_token)
        .await
        .expect("client token survives database reload");
    restarted
        .issue_device_ws_token(&device_token.unwrap())
        .await
        .expect("device token survives database reload");
    truncate_all(&pool).await;
}

/// Insert a client identity straight into Postgres (bypassing the in-memory
/// state), returning nothing — the caller keeps the plaintext token the "client"
/// now holds. Stands in for a rotation whose row is durably in the DB.
async fn inject_client_identity_into_db(pool: &PgPool, client_id: &str, token: &str) {
    sqlx::query(
        "INSERT INTO public_client_identities \
         (refresh_token_hash, client_id, client_verify_key, created_at, client_label) \
         VALUES ($1, $2, $3, 300, NULL)",
    )
    .bind(sha256_hex(token))
    .bind(client_id)
    .bind(format!("cvk-{client_id}"))
    .execute(pool)
    .await
    .expect("inject client identity row");
}

/// RED — reproduces the production client-side lockout. A client holds a refresh
/// token whose identity is DURABLY in Postgres, but the serving broker's in-memory
/// state does not have it (rolling-deploy window / concurrent writer /
/// committed-but-unacked). With the single-instance default
/// (`reload_before_use = false`) the broker consults ONLY its stale in-memory map,
/// so a token that IS valid in the database is rejected as
/// "client refresh token is invalid" — exactly the repeated
/// `invalid refresh token was reused chain=client_identity` seen right after an
/// approval. INVARIANT: a durably-persisted client token must authenticate.
/// This assertion currently FAILS (the bug); it is the regression guard for the fix.
#[tokio::test]
async fn client_token_in_db_but_not_in_memory_is_rejected_without_reload() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    let pool = connect_and_init(&url).await;
    truncate_all(&pool).await;

    let token = "cref-lockout-repro-token";
    inject_client_identity_into_db(&pool, "client-lockout", token).await;

    let plane = postgres_plane(pool.clone(), false);
    let result = plane.issue_client_session(token).await;

    truncate_all(&pool).await;

    assert!(
        result.is_ok(),
        "a client refresh token durably persisted in Postgres must authenticate, \
         but the single-instance default (reload_before_use=false) rejected it: {result:?}"
    );
}

/// GREEN mitigation — turning `reload_before_use` ON (env
/// `RELAY_BROKER_PUBLIC_POSTGRES_RELOAD_BEFORE_USE=1`) makes the broker reload the
/// authoritative DB state before authenticating, so the SAME durably-persisted
/// token that the default rejects is now accepted. Confirms the env-var stopgap
/// covers the "DB has it, memory doesn't" class (deploy window / concurrent writer /
/// committed-but-unacked). It does NOT cover a token that is genuinely gone from the
/// DB (the rotation-protocol lockout / follow-up A) — that needs a grace period.
#[tokio::test]
async fn client_token_in_db_authenticates_with_reload_before_use() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    let pool = connect_and_init(&url).await;
    truncate_all(&pool).await;

    let token = "cref-lockout-repro-token";
    inject_client_identity_into_db(&pool, "client-lockout", token).await;

    let plane = postgres_plane(pool.clone(), true);
    let session = plane.issue_client_session(token).await;

    truncate_all(&pool).await;

    let session =
        session.expect("reload-before-use must consult the DB and accept the persisted token");
    assert_eq!(session.client_id, "client-lockout");
}

/// The indexed probe decides whether a miss reloads: an unknown bearer costs no full
/// reload, a token durably in the database still gets one.
#[tokio::test]
async fn postgres_probe_gates_the_reload_on_a_miss() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    let pool = connect_and_init(&url).await;
    truncate_all(&pool).await;
    let plane = postgres_plane(pool.clone(), false);
    let now = tokio::time::Instant::now();
    *plane.last_full_load() = Some(FullLoad {
        started: now,
        finished: now,
        succeeded: true,
    });

    let unknown = plane.issue_client_session("cref-probe-unknown").await;
    let loads_after_unknown = plane.inner.full_load_count.load(Ordering::SeqCst);
    inject_client_identity_into_db(&pool, "client-probe", "cref-probe-token").await;
    let known = plane.issue_client_session("cref-probe-token").await;
    // Rotated elsewhere: the old token lives only in the superseded JSON column.
    sqlx::query(
        "INSERT INTO public_client_identities \
         (refresh_token_hash, client_id, client_verify_key, created_at, client_label, \
          superseded_tokens) VALUES ($1, $2, $3, 300, NULL, $4)",
    )
    .bind(sha256_hex("cref-probe-current"))
    .bind("client-rotated")
    .bind("cvk-client-rotated")
    .bind(
        encode_superseded(&[SupersededToken {
            refresh_token_hash: sha256_hex("cref-probe-old"),
            expires_at: unix_now() + 3600,
        }])
        .expect("encode superseded"),
    )
    .execute(&pool)
    .await
    .expect("inject rotated client identity row");
    let rotated = plane.issue_client_session("cref-probe-old").await;
    sqlx::query(
        "INSERT INTO public_client_identities \
         (refresh_token_hash, client_id, client_verify_key, created_at, client_label, \
          superseded_tokens) VALUES ($1, $2, $3, 300, NULL, $4)",
    )
    .bind(sha256_hex("cref-probe-expired-current"))
    .bind("client-expired")
    .bind("cvk-client-expired")
    .bind(
        encode_superseded(&[SupersededToken {
            refresh_token_hash: sha256_hex("cref-probe-expired"),
            expires_at: 1,
        }])
        .expect("encode superseded"),
    )
    .execute(&pool)
    .await
    .expect("inject expired client identity row");
    let loads_before_expired = plane.inner.full_load_count.load(Ordering::SeqCst);
    let expired = plane.issue_client_session("cref-probe-expired").await;
    let loads_after_expired = plane.inner.full_load_count.load(Ordering::SeqCst);
    truncate_all(&pool).await;

    assert!(unknown.is_err());
    assert_eq!(
        loads_after_unknown, 0,
        "an unknown bearer must not buy a full reload"
    );
    assert_eq!(
        known
            .expect("a token durably in Postgres must authenticate")
            .client_id,
        "client-probe"
    );
    assert_eq!(
        rotated
            .expect("a superseded token in its grace window must authenticate")
            .client_id,
        "client-rotated"
    );
    assert!(expired.is_err());
    assert_eq!(
        loads_after_expired, loads_before_expired,
        "an expired superseded token must not buy a full reload"
    );
}

/// Prepared statements may switch to a generic plan, where the planner no longer sees the
/// hash; the probe then scanned every row per unknown bearer (~30ms at 50k rows).
#[tokio::test]
async fn postgres_probe_uses_the_superseded_index_under_a_generic_plan() {
    use sqlx::{Connection as _, Executor as _, Row as _};
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    // TEMP tables on a private connection shadow the real names for this session only,
    // so the probe runs as production writes it and parallel tests cannot interfere.
    let mut conn = sqlx::PgConnection::connect(&url).await.expect("connect");
    let now = 1_790_000_001_i64;
    for table in ["public_device_grants", "public_client_identities"] {
        let setup = [
            format!(
                "CREATE TEMP TABLE {table} (refresh_token_hash TEXT PRIMARY KEY, \
                 owner_id TEXT NOT NULL, label TEXT, created_at BIGINT NOT NULL, \
                 last_seen BIGINT, superseded_tokens TEXT)"
            ),
            // Two in five rows carry one to three rotated-away hashes, as re-approvals leave.
            format!(
                "INSERT INTO {table} SELECT md5('p' || g) || md5('q' || g), 'owner-' || g, \
                 'Phone ' || g, 1700000000, NULL, CASE WHEN g % 5 < 2 THEN (SELECT \
                 jsonb_agg(jsonb_build_object('refresh_token_hash', md5('s' || g || '-' || k) \
                 || md5('t' || g || '-' || k), 'expires_at', {now} - 1 + k))::text \
                 FROM generate_series(1, 1 + g % 3) k) END FROM generate_series(1, 50000) g"
            ),
            // CONCURRENTLY is meaningless on a session-private table; same expression.
            superseded_index_sql(table).replace("CONCURRENTLY ", ""),
            format!("ANALYZE {table}"),
        ];
        for statement in setup {
            conn.execute(statement.as_str())
                .await
                .expect("set up probe table");
        }
    }
    conn.execute("SET plan_cache_mode = force_generic_plan")
        .await
        .expect("force generic plans");

    for (name, table) in [
        ("device_probe", "public_device_grants"),
        ("client_probe", "public_client_identities"),
    ] {
        conn.execute(
            format!(
                "PREPARE {name}(text, text, bigint) AS {}",
                superseded_probe_sql(table)
            )
            .as_str(),
        )
        .await
        .expect("prepare probe");
        // Arguments are SQL expressions, so the fixture's hashes are rebuilt in place.
        let run = |hash: &str| {
            format!(
                r#"EXECUTE {name}({hash}, '[{{"refresh_token_hash":"' || {hash} || '"}}]', {now})"#
            )
        };
        let plan = conn
            .fetch_all(format!("EXPLAIN {}", run("repeat('f', 64)")).as_str())
            .await
            .expect("explain probe")
            .iter()
            .map(|row| row.get::<String, _>(0))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            plan.contains(&format!("Index Scan on {table}_superseded_idx"))
                && !plan.contains(&format!("Seq Scan on {table}")),
            "the {table} probe must use its superseded index under a generic plan:\n{plan}"
        );
        // Row 1 holds hashes expiring at `now` (k = 1) and just after it (k = 2).
        for (hash, expected, what) in [
            (
                "md5('s1-2') || md5('t1-2')",
                true,
                "an unexpired rotated-away hash",
            ),
            (
                "md5('s1-1') || md5('t1-1')",
                false,
                "an expired rotated-away hash",
            ),
            ("md5('p7') || md5('q7')", true, "a current hash"),
            ("repeat('f', 64)", false, "an unknown hash"),
        ] {
            let found = conn
                .fetch_one(run(hash).as_str())
                .await
                .expect("run probe")
                .get::<bool, _>(0);
            assert_eq!(found, expected, "{table}: {what}");
        }
    }
}

#[tokio::test]
async fn postgres_schema_init_leaves_a_valid_superseded_index() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL to a disposable DB");
        return;
    };
    let pool = connect_and_init(&url).await;
    initialize_postgres_public_control_schema(&pool)
        .await
        .expect("a second startup must find the index ready");
    for table in ["public_device_grants", "public_client_identities"] {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            superseded_index_valid(&mut conn, table)
                .await
                .expect("index check"),
            Some(true),
            "{table} must carry a valid superseded index"
        );
    }
}

/// Not a pass/fail test — prints timings so we can compare JSON vs Postgres
/// (full-rebuild vs targeted) and the reload-before-use cost. `#[ignore]` so
/// normal runs skip it; run with:
///   RELAY_BROKER_TEST_POSTGRES_URL=postgres://sealwire:dev@127.0.0.1:5433/sealwire_test \
///     cargo test -p relay-broker bench_persistence_backends -- --ignored --nocapture --test-threads=1
#[tokio::test]
#[ignore = "perf benchmark; needs RELAY_BROKER_TEST_POSTGRES_URL; run with --ignored --nocapture"]
async fn bench_persistence_backends() {
    let Some((url, _serial)) = test_url().await else {
        eprintln!("skipping benchmark: set RELAY_BROKER_TEST_POSTGRES_URL");
        return;
    };
    let pool = connect_and_init(&url).await;

    const N: usize = 200; // baseline rows in each of two tables
    const M: u32 = 20; // timed iterations

    let mut base = PublicControlStateStore::default();
    for i in 0..N {
        let h = format!("seed-{i}");
        base.relay_registrations_by_hash
            .insert(h.clone(), relay_reg(&h, Some("seed")));
        let g = format!("seed-grant-{i}");
        base.grants_by_hash
            .insert(g.clone(), device_grant(&g, Some(1)));
    }

    // SAVE — full rebuild: every save re-writes all rows.
    truncate_all(&pool).await;
    save_public_control_postgres_full_rebuild(&pool, &base)
        .await
        .expect("seed for full-rebuild");
    let t_full = {
        let start = Instant::now();
        for i in 0..M {
            let mut s = base.clone();
            let h = format!("extra-full-{i}");
            s.grants_by_hash.insert(h.clone(), device_grant(&h, None));
            save_public_control_postgres_full_rebuild(&pool, &s)
                .await
                .expect("full save");
        }
        start.elapsed() / M
    };

    // SAVE — targeted: every save writes only the one new grant.
    truncate_all(&pool).await;
    save_public_control_postgres_full_rebuild(&pool, &base)
        .await
        .expect("seed for targeted");
    let t_targeted = {
        let mut prev = base.clone();
        let start = Instant::now();
        for i in 0..M {
            let mut next = prev.clone();
            let h = format!("extra-tgt-{i}");
            next.grants_by_hash
                .insert(h.clone(), device_grant(&h, None));
            save_public_control_postgres(&pool, &prev, &next)
                .await
                .expect("targeted save");
            prev = next;
        }
        start.elapsed() / M
    };

    // SAVE — JSON baseline: whole-file write.
    let json_path =
        std::env::temp_dir().join(format!("bench-public-control-{}.json", std::process::id()));
    save_public_control_json(&json_path, &base)
        .await
        .expect("seed json");
    let t_json_save = {
        let start = Instant::now();
        for i in 0..M {
            let mut s = base.clone();
            let h = format!("extra-json-{i}");
            s.grants_by_hash.insert(h.clone(), device_grant(&h, None));
            save_public_control_json(&json_path, &s)
                .await
                .expect("json save");
        }
        start.elapsed() / M
    };

    // READ — PG full reload (the per-op cost reload_before_use pays) vs JSON file read.
    truncate_all(&pool).await;
    save_public_control_postgres_full_rebuild(&pool, &base)
        .await
        .expect("seed for read");
    let t_pg_reload = {
        let start = Instant::now();
        for _ in 0..M {
            load_public_control_postgres(&pool)
                .await
                .expect("pg reload");
        }
        start.elapsed() / M
    };
    let t_json_read = {
        let start = Instant::now();
        for _ in 0..M {
            load_public_control_json(&json_path)
                .await
                .expect("json read");
        }
        start.elapsed() / M
    };

    let _ = tokio::fs::remove_file(&json_path).await;
    truncate_all(&pool).await;

    eprintln!(
        "\n=== persistence benchmark (N={N} rows x2 tables, M={M} iters, LOCAL pg = ~0 network RTT) ==="
    );
    eprintln!("SAVE one mutation @ {N} baseline rows:");
    eprintln!("  PG full-rebuild (old): {t_full:?}/op");
    eprintln!("  PG targeted     (new): {t_targeted:?}/op");
    eprintln!("  JSON file            : {t_json_save:?}/op");
    eprintln!("READ whole state @ {N} baseline rows:");
    eprintln!("  PG full reload (reload_before_use=ON): {t_pg_reload:?}/op");
    eprintln!("  JSON file read                       : {t_json_read:?}/op");
    eprintln!("  in-memory (reload_before_use=OFF)    : ~0 (no I/O at all)");
    eprintln!(
        "NOTE: Railway adds network RTT per round-trip. full-rebuild does O(rows) round-trips \
         and reload does O(1) SELECTs returning all rows; targeted save + reload-off do far \
         fewer, which is the win you feel over the wire.\n"
    );
}
