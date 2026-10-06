use super::*;

fn temp_state_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "public-control-miss-reload-{tag}-{}-{}.json",
        std::process::id(),
        random_token(8).to_ascii_lowercase()
    ))
}

async fn json_plane(path: &Path) -> PublicControlPlane {
    PublicControlPlane::from_parts(
        Some("miss-reload-test-issuer-a3f76b4c2089d15e6b0fa873c4e9521d".to_string()),
        None,
        Some(path.display().to_string()),
        None,
        None,
    )
    .await
    .expect("json plane should build")
}

/// Treats its file as shared, the way Postgres is, so a second plane on the
/// same path stands in for another broker instance.
async fn shared_json_plane(
    path: &Path,
    configure: impl FnOnce(&mut PublicControlPlaneInner),
) -> PublicControlPlane {
    let mut plane = json_plane(path).await;
    let inner = Arc::get_mut(&mut plane.inner).expect("a fresh plane is unshared");
    inner.force_shared_backend = true;
    inner.miss_reload_min_interval = Duration::from_millis(100);
    configure(inner);
    plane
}

fn relay_ws_request(relay_id: &str, broker_room_id: &str) -> RelayWsTokenRequest {
    RelayWsTokenRequest {
        relay_id: relay_id.to_string(),
        broker_room_id: broker_room_id.to_string(),
        relay_peer_id: "relay-peer".to_string(),
        challenge_id: String::new(),
        challenge_signature: String::new(),
    }
}

fn ticket_signing_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[9_u8; 32])
}

async fn signed_relay_ws_token(
    plane: &PublicControlPlane,
    bearer: &str,
    relay_id: &str,
    broker_room_id: &str,
) -> Result<RelayWsTokenResponse, String> {
    use ed25519_dalek::Signer;
    let challenge = plane
        .create_relay_ws_ticket_challenge(
            bearer,
            RelayWsTokenChallengeRequest {
                relay_id: relay_id.to_string(),
                broker_room_id: broker_room_id.to_string(),
                relay_peer_id: "relay-peer".to_string(),
            },
        )
        .await?;
    let refresh_token_hash = relay_util::sha256_hex(bearer.trim());
    let message = relay_ws_ticket_message(
        &challenge.broker_origin,
        &challenge.challenge_id,
        &challenge.challenge,
        &challenge.relay_id,
        &challenge.broker_room_id,
        &challenge.relay_peer_id,
        &refresh_token_hash,
    )?;
    let challenge_signature = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        ticket_signing_key().sign(&message).to_bytes(),
    );
    plane
        .issue_relay_ws_token(
            bearer,
            RelayWsTokenRequest {
                relay_id: relay_id.to_string(),
                broker_room_id: broker_room_id.to_string(),
                relay_peer_id: "relay-peer".to_string(),
                challenge_id: challenge.challenge_id,
                challenge_signature,
            },
        )
        .await
}

fn ticket_verify_key() -> String {
    base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        ticket_signing_key().verifying_key().to_bytes(),
    )
}

fn device_request(enrolled: &RelayEnrollmentResponse, device_id: &str) -> DeviceGrantRequest {
    DeviceGrantRequest {
        relay_id: enrolled.relay_id.clone(),
        broker_room_id: enrolled.broker_room_id.clone(),
        device_id: device_id.to_string(),
    }
}

/// Eight streams of five unknown bearers each, across all three credential kinds.
async fn unknown_bearer_streams(plane: &PublicControlPlane) -> Vec<Result<(), String>> {
    let streams = (0..8)
        .map(|stream| {
            let plane = plane.clone();
            tokio::spawn(async move {
                let mut outcomes = Vec::new();
                for attempt in 0..5 {
                    let bearer = format!("unknown-{stream}-{attempt}");
                    let outcome = match attempt % 3 {
                        0 => plane.issue_device_ws_token(&bearer).await.map(|_| ()),
                        1 => plane.issue_client_session(&bearer).await.map(|_| ()),
                        _ => plane
                            .issue_relay_ws_token(&bearer, relay_ws_request("r", "room"))
                            .await
                            .map(|_| ()),
                    };
                    outcomes.push(outcome);
                }
                outcomes
            })
        })
        .collect::<Vec<_>>();
    let mut outcomes = Vec::new();
    for stream in streams {
        outcomes.extend(stream.await.expect("stream should finish"));
    }
    outcomes
}

fn full_loads(plane: &PublicControlPlane) -> u64 {
    plane.inner.full_load_count.load(Ordering::SeqCst)
}

#[tokio::test]
async fn unknown_bearers_never_buy_a_full_reload_while_memory_is_fresh() {
    let path = temp_state_path("unknown");
    let plane = shared_json_plane(&path, |_| {}).await;

    let outcomes = unknown_bearer_streams(&plane).await;
    let loads = full_loads(&plane);
    let probes = plane.inner.probe_count.load(Ordering::SeqCst);
    let _ = std::fs::remove_file(&path);

    assert!(
        outcomes.iter().all(Result::is_err),
        "unknown bearers must be refused"
    );
    assert_eq!(loads, 0, "40 unknown bearers caused {loads} full reloads");
    assert_eq!(
        probes, 40,
        "each unknown bearer should cost one indexed probe"
    );
}

/// A 401 is terminal to the remote client, so a token still inside its rotation grace
/// window must not be refused just because another instance rotated it.
#[tokio::test]
async fn a_rotated_away_token_minted_elsewhere_authenticates_without_waiting() {
    let path = temp_state_path("rotated");
    let reader = shared_json_plane(&path, |_| {}).await;
    let writer = json_plane(&path).await;
    let enrolled = writer
        .issue_relay_registration_for_verify_key("vk-rotated", None)
        .await
        .expect("enroll on the other instance");
    let first = writer
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            device_request(&enrolled, "device-rotated"),
            None,
        )
        .await
        .expect("grant on the other instance");
    // A re-approval rotates the token; `first` survives only as a superseded hash.
    writer
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            device_request(&enrolled, "device-rotated"),
            None,
        )
        .await
        .expect("re-grant on the other instance");

    let device = reader
        .issue_device_ws_token(&first.device_refresh_token)
        .await;
    let _ = std::fs::remove_file(&path);

    device.expect("a token inside its rotation grace window must authenticate");
}

#[tokio::test]
async fn an_expired_rotated_away_token_is_refused_without_a_reload() {
    let path = temp_state_path("expired");
    let reader = shared_json_plane(&path, |_| {}).await;
    let writer = json_plane(&path).await;
    let enrolled = writer
        .issue_relay_registration_for_verify_key("vk-expired", None)
        .await
        .expect("enroll on the other instance");
    let first = writer
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            device_request(&enrolled, "device-expired"),
            None,
        )
        .await
        .expect("grant on the other instance");
    writer
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            device_request(&enrolled, "device-expired"),
            None,
        )
        .await
        .expect("re-grant on the other instance");
    // Age the grace window out on disk, as a later instance would find it.
    let mut stored = load_public_control_json(&path).await.expect("load state");
    for grant in stored.grants_by_hash.values_mut() {
        for token in &mut grant.superseded {
            token.expires_at = 1;
        }
    }
    save_public_control_json(&path, &stored)
        .await
        .expect("save state");

    let mut refused = 0;
    for _ in 0..5 {
        if reader
            .issue_device_ws_token(&first.device_refresh_token)
            .await
            .is_err()
        {
            refused += 1;
        }
    }
    let loads = full_loads(&reader);
    let _ = std::fs::remove_file(&path);

    assert_eq!(refused, 5);
    assert_eq!(loads, 0, "an expired token bought {loads} full reloads");
}

/// A token found by the probe is in memory after one reload, so presenting it again
/// with the wrong scope is refused from memory rather than by another reload.
#[tokio::test]
async fn a_valid_token_presented_for_the_wrong_room_buys_one_reload_at_most() {
    let path = temp_state_path("wrong-room");
    let reader = shared_json_plane(&path, |_| {}).await;
    let writer = json_plane(&path).await;
    let enrolled = writer
        .issue_relay_registration_for_verify_key("vk-wrong-room", None)
        .await
        .expect("enroll on the other instance");
    let grant = writer
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            device_request(&enrolled, "device-wrong-room"),
            None,
        )
        .await
        .expect("grant on the other instance");

    for _ in 0..5 {
        assert!(reader
            .issue_device_ws_token_scoped(&grant.device_refresh_token, "some-other-room")
            .await
            .is_err());
    }
    let loads = full_loads(&reader);
    let _ = std::fs::remove_file(&path);

    assert_eq!(loads, 1, "a wrong-room token bought {loads} full reloads");
}

/// Stands in for another instance committing a device grant for `token`.
async fn mint_device_token_on_disk(path: &Path, token: &str) {
    let mut stored = load_public_control_json(path).await.expect("load state");
    let hash = sha256_hex(token);
    stored.grants_by_hash.insert(
        hash.clone(),
        PersistedDeviceGrant {
            relay_id: "relay-elsewhere".to_string(),
            broker_room_id: "room-elsewhere".to_string(),
            device_id: "device-elsewhere".to_string(),
            refresh_token_hash: hash,
            created_at: unix_now(),
            last_seen: None,
            superseded: Vec::new(),
        },
    );
    save_public_control_json(path, &stored)
        .await
        .expect("save state");
}

/// A load that began after the request arrived but read the table before the token
/// was committed must not stand in for looking.
#[tokio::test]
async fn a_load_that_read_before_the_mint_does_not_make_a_miss_final() {
    let path = temp_state_path("early-fresh");
    let reader = shared_json_plane(&path, |_| {}).await;
    json_plane(&path).await;

    let held = reader.inner.state.lock().await;
    let request = {
        let reader = reader.clone();
        tokio::spawn(async move { reader.issue_device_ws_token("dref-early").await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    let loaded = reader
        .load_full_state()
        .await
        .expect("load before the mint");
    mint_device_token_on_disk(&path, "dref-early").await;
    let mut held = held;
    *held = loaded;
    drop(held);
    let outcome = request.await.expect("request should finish");
    let _ = std::fs::remove_file(&path);

    outcome.expect("a token committed before the lookup looked must authenticate");
}

/// A positive probe can only be overruled by a load that began after the probe saw it.
#[tokio::test]
async fn a_positive_probe_is_not_overruled_by_a_load_that_began_before_it() {
    let path = temp_state_path("positive-probe");
    let release = Arc::new(Semaphore::new(0));
    let reader = shared_json_plane(&path, |inner| {
        inner.probe_release = Some(release.clone());
    })
    .await;
    json_plane(&path).await;

    let request = {
        let reader = reader.clone();
        tokio::spawn(async move { reader.issue_device_ws_token("dref-probed").await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    {
        let mut store = reader.inner.state.lock().await;
        *store = reader
            .load_full_state()
            .await
            .expect("load before the mint");
    }
    mint_device_token_on_disk(&path, "dref-probed").await;
    release.add_permits(1);
    let outcome = request.await.expect("request should finish");
    let _ = std::fs::remove_file(&path);

    outcome.expect("a token the probe saw must not be refused on an older load");
}

/// The HTTP layer maps any error mentioning "invalid" to a terminal 401.
#[tokio::test]
async fn a_database_failure_never_reads_as_an_invalid_credential() {
    let path = temp_state_path("db-error-text");
    let probe_fails = shared_json_plane(&path, |_| {}).await;
    let load_fails = shared_json_plane(&path, |inner| inner.force_probe_hit = true).await;
    probe_fails
        .inner
        .persistence_down
        .store(true, Ordering::SeqCst);
    load_fails
        .inner
        .persistence_down
        .store(true, Ordering::SeqCst);

    let from_probe = probe_fails.issue_device_ws_token("dref-any").await;
    let from_load = load_fails.issue_device_ws_token("dref-any").await;
    let _ = std::fs::remove_file(&path);

    for (path_name, outcome) in [("probe", from_probe), ("reload", from_load)] {
        let error = outcome.expect_err("the database is down");
        assert!(
            !error.to_ascii_lowercase().contains("invalid"),
            "a {path_name} failure surfaced as {error:?}, which the HTTP layer calls a 401"
        );
    }
}

/// Same rule for writes: a storage failure after a good bearer is not a bad bearer.
#[tokio::test]
async fn a_storage_failure_never_reads_as_an_invalid_credential() {
    let path = temp_state_path("save-error-text");
    let plane = shared_json_plane(&path, |_| {}).await;
    let enrolled = plane
        .issue_relay_registration_for_verify_key("vk-save-error", None)
        .await
        .expect("enroll");
    plane.inner.persistence_down.store(true, Ordering::SeqCst);

    let grant = plane
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            device_request(&enrolled, "device-save-error"),
            None,
        )
        .await;
    let _ = std::fs::remove_file(&path);

    let error = grant.expect_err("the store is down");
    assert!(
        !error.to_ascii_lowercase().contains("invalid"),
        "a storage failure surfaced as {error:?}, which the HTTP layer calls a 401"
    );
}

#[tokio::test]
async fn tokens_minted_elsewhere_back_to_back_both_authenticate() {
    let path = temp_state_path("visibility");
    let reader = shared_json_plane(&path, |_| {}).await;
    let writer = json_plane(&path).await;

    let enrolled = writer
        .issue_relay_registration_for_verify_key(&ticket_verify_key(), None)
        .await
        .expect("enroll on the other instance");
    let relay = signed_relay_ws_token(
        &reader,
        &enrolled.relay_refresh_token,
        &enrolled.relay_id,
        &enrolled.broker_room_id,
    )
    .await;
    // Minted right after the reader's reload, so the next miss lands in the spacing window.
    let grant = writer
        .issue_device_grant(
            &enrolled.relay_refresh_token,
            device_request(&enrolled, "device-elsewhere"),
            None,
        )
        .await
        .expect("grant on the other instance");
    let device = reader
        .issue_device_ws_token(&grant.device_refresh_token)
        .await;
    let _ = std::fs::remove_file(&path);

    relay.expect("a relay token another instance minted must authenticate here");
    device.expect("a device token another instance minted must authenticate here");
}

#[tokio::test]
async fn slow_reloads_never_run_back_to_back_or_starve_requests_that_hit() {
    let path = temp_state_path("slow");
    let load_delay = Duration::from_millis(200);
    let plane = shared_json_plane(&path, |inner| {
        inner.load_delay = load_delay;
        // Every miss now asks for a reload: the worst case for spacing.
        inner.force_probe_hit = true;
    })
    .await;
    let enrolled = plane
        .issue_relay_registration_for_verify_key(&ticket_verify_key(), None)
        .await
        .expect("enroll");

    let hitter = {
        let plane = plane.clone();
        let enrolled = enrolled.clone();
        tokio::spawn(async move {
            let mut slowest = Duration::ZERO;
            for _ in 0..10 {
                let started = Instant::now();
                signed_relay_ws_token(
                    &plane,
                    &enrolled.relay_refresh_token,
                    &enrolled.relay_id,
                    &enrolled.broker_room_id,
                )
                .await
                .expect("a known relay token must keep authenticating");
                slowest = slowest.max(started.elapsed());
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            slowest
        })
    };
    unknown_bearer_streams(&plane).await;
    let slowest_hit = hitter.await.expect("hitter should finish");
    let log = plane.inner.load_log.lock().expect("load log").clone();
    let _ = std::fs::remove_file(&path);

    let interval = plane.inner.miss_reload_min_interval;
    for pair in log.windows(2) {
        let gap = pair[1].0.saturating_duration_since(pair[0].1);
        assert!(
            gap + Duration::from_millis(5) >= interval,
            "a full reload began {gap:?} after the previous one ended; loads: {log:?}"
        );
    }
    assert!(
        slowest_hit < load_delay * 2,
        "a request whose token is in memory waited {slowest_hit:?}, longer than one reload"
    );
}

#[tokio::test]
async fn an_outage_refuses_misses_without_reloading_and_still_serves_hits() {
    let path = temp_state_path("outage");
    let plane = shared_json_plane(&path, |inner| {
        inner.load_delay = Duration::from_millis(50);
    })
    .await;
    let enrolled = plane
        .issue_relay_registration_for_verify_key(&ticket_verify_key(), None)
        .await
        .expect("enroll");
    plane.inner.persistence_down.store(true, Ordering::SeqCst);

    let outcomes = unknown_bearer_streams(&plane).await;
    let hit = signed_relay_ws_token(
        &plane,
        &enrolled.relay_refresh_token,
        &enrolled.relay_id,
        &enrolled.broker_room_id,
    )
    .await;
    let loads = full_loads(&plane);
    let _ = std::fs::remove_file(&path);

    assert!(outcomes.iter().all(Result::is_err));
    assert_eq!(
        loads, 0,
        "misses during an outage attempted {loads} full reloads"
    );
    hit.expect("a token already in memory must keep working through an outage");
}

#[tokio::test]
async fn a_forced_reload_during_an_outage_is_attempted_once_not_per_request() {
    let path = temp_state_path("forced");
    let plane = shared_json_plane(&path, |inner| {
        inner.force_reload_before_use = true;
        inner.load_delay = Duration::from_millis(50);
    })
    .await;
    plane.inner.persistence_down.store(true, Ordering::SeqCst);

    let outcomes = unknown_bearer_streams(&plane).await;
    let loads = full_loads(&plane);
    let _ = std::fs::remove_file(&path);

    assert!(outcomes.iter().all(Result::is_err));
    assert!(
        loads <= 2,
        "40 requests during an outage made {loads} full-reload attempts"
    );
}
