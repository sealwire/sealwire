use super::*;

const IDENTITY_COUNT: usize = 1_025;

fn app_state(plane: PublicControlPlane, config: BrokerHardeningConfig) -> BrokerAppState {
    BrokerAppState {
        broker: BrokerState::default(),
        join_verifier: BrokerJoinVerifier::PublicControlPlane(plane),
        hardening: BrokerHardeningState {
            config,
            rate_limiter: Default::default(),
            credential_rate_limiter: Default::default(),
            credential_probe_rate_limiter: Default::default(),
            account_rate_limiter: Default::default(),
            failed_join_rate_limiter: Default::default(),
            join_rate_limiter: Default::default(),
            relay_rate_limiter: Default::default(),
            publish_rate_limiter: Default::default(),
            byte_limiter: Default::default(),
            publish_metrics: Default::default(),
            connection_tracker: Default::default(),
            tenant_connection_tracker: Default::default(),
        },
        public_monitoring: Default::default(),
        access: Arc::new(OpenAccessStrategy),
        enrollment_locks: Default::default(),
        admin_token: None,
        origin_guard: OriginGuard::from_config(None, None, false).unwrap(),
        min_relay_version: Arc::new(client_version::MinRelayVersion::from_env()),
    }
}

fn forwarded_request(
    url: String,
    source: &str,
) -> tokio_tungstenite::tungstenite::http::Request<()> {
    let mut request = url.into_client_request().expect("websocket request");
    request
        .headers_mut()
        .insert("x-forwarded-for", source.parse().expect("source header"));
    request
}

fn guard() -> BanGuard {
    BanGuard {
        blocklist: Blocklist::disabled(),
        trusted_ip_header: Some("x-forwarded-for".parse().unwrap()),
    }
}

#[tokio::test]
async fn invalid_ticket_churn_cannot_block_a_valid_join() {
    let address = spawn_app_with_guard(guard()).await;
    for index in 0..IDENTITY_COUNT {
        let request = forwarded_request(
            format!("ws://{address}/ws/flood-{index}?role=surface"),
            &format!("2001:db8:{index:x}:1::1"),
        );
        let (mut socket, _) = connect_async(request).await.unwrap();
        assert!(matches!(
            next_server_message(&mut socket).await,
            ServerMessage::Error { .. }
        ));
    }
    let request = forwarded_request(
        websocket_url(
            address,
            "valid-room",
            protocol::PeerRole::Surface,
            None,
            JoinTicketClaims::device_surface_join("valid-room", "valid-device", None),
        ),
        "2001:db8:ffff:1::1",
    );
    let (mut socket, _) = connect_async(request).await.unwrap();
    let reply = next_server_message(&mut socket).await;
    assert!(
        matches!(reply, ServerMessage::Welcome { .. }),
        "invalid tickets from unrelated networks must not block a valid join: {reply:?}"
    );
}

#[tokio::test]
async fn a_join_budget_follows_the_device_across_networks_and_ticket_refresh() {
    let address = spawn_app_with_guard_and_hardening(
        guard(),
        BrokerHardeningConfig {
            join_rate_limit_per_minute: 1,
            ..Default::default()
        },
    )
    .await;
    for (device, source, admitted) in [
        ("phone", "203.0.113.1", true),
        ("phone", "203.0.113.2", false),
        ("other-phone", "203.0.113.1", true),
    ] {
        let request = forwarded_request(
            websocket_url(
                address,
                "room-a",
                protocol::PeerRole::Surface,
                None,
                JoinTicketClaims::device_surface_join("room-a", device, None),
            ),
            source,
        );
        let (mut socket, _) = connect_async(request).await.unwrap();
        let reply = next_server_message(&mut socket).await;
        assert_eq!(
            matches!(reply, ServerMessage::Welcome { .. }),
            admitted,
            "join quota must follow the device, rather than its network or ticket: {reply:?}"
        );
        if !admitted {
            assert!(matches!(reply, ServerMessage::Error { code, .. } if code == "rate_limited"));
        }
        socket.close(None).await.unwrap();
    }
}

#[tokio::test]
async fn relay_peer_id_churn_cannot_reset_the_relay_join_quota() {
    let address = spawn_public_mode_app_with(
        test_public_control_plane().await,
        BrokerHardeningConfig {
            join_rate_limit_per_minute: 1,
            ..Default::default()
        },
        Default::default(),
    )
    .await;
    let join = |peer: &'static str| async move {
        let ticket = post_signed_relay_ws_token(
            address,
            "relay-refresh-1",
            "relay-1",
            "room-a",
            peer,
            &seeded_relay_signing_key(),
        )
        .await;
        let url = format!(
            "ws://{address}/ws/room-a?role=relay&peer_id={peer}&client_version={}&join_ticket={}",
            client_version::DEFAULT_MIN_RELAY_VERSION,
            ticket.relay_ws_token
        );
        let (mut socket, _) = connect_async(url).await.unwrap();
        let reply = next_server_message(&mut socket).await;
        let _ = socket.close(None).await;
        reply
    };
    assert!(matches!(
        join("relay-1").await,
        ServerMessage::Welcome { .. }
    ));
    assert!(matches!(
        join("relay-1").await,
        ServerMessage::Error { code, .. } if code == "rate_limited"
    ));
    let churned = join("relay-churn-2").await;
    assert!(
        matches!(&churned, ServerMessage::Error { code, .. } if code == "rate_limited"),
        "a proven relay must not get a fresh join quota by renaming its peer: {churned:?}"
    );
}

async fn assert_relay_peer_churn_preserves_publish_budget(
    config: BrokerHardeningConfig,
    frame: String,
    initial_frames: usize,
) {
    let address = spawn_public_mode_app_with(
        test_public_control_plane().await,
        config,
        Default::default(),
    )
    .await;
    for (peer, count) in [("relay-1", initial_frames), ("relay-renamed", 1)] {
        let ticket = post_signed_relay_ws_token(
            address,
            "relay-refresh-1",
            "relay-1",
            "room-a",
            peer,
            &seeded_relay_signing_key(),
        )
        .await;
        let (mut socket, _) = connect_async(format!(
            "ws://{address}/ws/room-a?role=relay&peer_id={peer}&client_version={}&join_ticket={}",
            client_version::DEFAULT_MIN_RELAY_VERSION,
            ticket.relay_ws_token
        ))
        .await
        .unwrap();
        assert!(matches!(
            next_server_message(&mut socket).await,
            ServerMessage::Welcome { .. }
        ));
        assert_eq!(
            publish_until_error(socket, frame.clone(), count)
                .await
                .as_deref(),
            Some("rate_limited"),
            "the proven relay must retain its spent publish budget under peer id {peer}"
        );
    }
}

#[tokio::test]
async fn relay_peer_id_churn_cannot_reset_the_publish_frame_quota() {
    assert_relay_peer_churn_preserves_publish_budget(
        BrokerHardeningConfig {
            relay_publish_rate_limit_per_minute: 2,
            ..Default::default()
        },
        large_publish_frame(16),
        3,
    )
    .await;
}

#[tokio::test]
async fn relay_peer_id_churn_cannot_reset_the_publish_byte_quota() {
    assert_relay_peer_churn_preserves_publish_budget(
        BrokerHardeningConfig {
            relay_publish_bytes_per_minute: 1,
            relay_publish_burst_bytes: 64 * 1024,
            ..Default::default()
        },
        large_publish_frame(56 * 1024),
        2,
    )
    .await;
}

#[tokio::test]
async fn policy_denied_joins_spend_the_failed_join_log_budget_only() {
    let access = Arc::new(ScriptedAccessStrategy {
        deny_device_socket: Some(AccessDenial::forbidden("device access denied")),
        ..ScriptedAccessStrategy::allow()
    });
    let (address, _, plane) = spawn_public_mode_app_with_access_hardening(
        access,
        BrokerState::default(),
        BrokerHardeningConfig {
            join_rate_limit_per_minute: 1,
            public_api_global_rate_limit_per_minute: 1,
            ..Default::default()
        },
    )
    .await;
    let ticket = plane
        .issuer_key()
        .mint(&JoinTicketClaims::device_surface_join(
            "room-a", "phone", None,
        ))
        .unwrap();
    for expected in ["join_rejected", "rate_limited"] {
        let (mut socket, _) = connect_async(format!(
            "ws://{address}/ws/room-a?role=surface&join_ticket={ticket}"
        ))
        .await
        .unwrap();
        let reply = next_server_message(&mut socket).await;
        assert!(
            matches!(&reply, ServerMessage::Error { code, .. } if code == expected),
            "policy rejection must share the bounded failed-join log budget: {reply:?}"
        );
    }
    let relay_ticket = post_signed_relay_ws_token(
        address,
        "relay-refresh-1",
        "relay-1",
        "room-a",
        "relay-1",
        &seeded_relay_signing_key(),
    )
    .await;
    let (mut relay, _) = connect_async(format!(
        "ws://{address}/ws/room-a?role=relay&peer_id=relay-1&client_version={}&join_ticket={}",
        client_version::DEFAULT_MIN_RELAY_VERSION,
        relay_ticket.relay_ws_token
    ))
    .await
    .unwrap();
    assert!(matches!(
        next_server_message(&mut relay).await,
        ServerMessage::Welcome { .. }
    ));
}

#[tokio::test]
async fn mismatched_relay_peers_spend_the_failed_join_log_budget_only() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            join_rate_limit_per_minute: 1,
            join_ip_rate_limit_per_minute: 1,
            ..Default::default()
        },
        Default::default(),
    )
    .await;
    let valid_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1", &seeded_relay_verify_key()),
    );
    let invalid_url = valid_url.replace("peer_id=relay-1", "peer_id=wrong-peer");
    for expected in ["join_rejected", "rate_limited"] {
        let (mut socket, _) = connect_async(&invalid_url).await.unwrap();
        let reply = next_server_message(&mut socket).await;
        assert!(
            matches!(&reply, ServerMessage::Error { code, .. } if code == expected),
            "peer mismatch must share the bounded failed-join log budget: {reply:?}"
        );
    }
    let (mut relay, _) = connect_async(valid_url).await.unwrap();
    assert!(matches!(
        next_server_message(&mut relay).await,
        ServerMessage::Welcome { .. }
    ));
}

#[tokio::test(start_paused = true)]
async fn publish_identity_churn_preserves_other_peers_and_spent_windows() {
    let state = app_state(test_public_control_plane().await, Default::default());
    let limiter = &state.hardening.publish_rate_limiter;
    assert!(limiter.allow("publish:room:device:hot".into(), 1).await);
    for index in 0..IDENTITY_COUNT {
        assert!(
            limiter
                .allow(format!("publish:room:device:{index}"), 1)
                .await,
            "a new verified publisher must not be refused because other identities are active"
        );
    }
    assert!(!limiter.allow("publish:room:device:hot".into(), 1).await);
    tokio::time::advance(Duration::from_secs(RATE_LIMIT_WINDOW_SECS + 1)).await;
    assert!(limiter.allow("publish:room:device:hot".into(), 1).await);
}

#[tokio::test]
async fn a_failed_relay_key_proof_cannot_spend_the_relays_join_quota() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            join_rate_limit_per_minute: 1,
            ..Default::default()
        },
        Default::default(),
    )
    .await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1", &seeded_relay_verify_key()),
    );
    let (mut attacker, _) = connect_async(&url).await.unwrap();
    assert!(matches!(
        read_server_message(&mut attacker).await,
        ServerMessage::RelayJoinChallenge { .. }
    ));
    attacker.send(Message::Text("{}".into())).await.unwrap();
    assert!(matches!(
        read_server_message(&mut attacker).await,
        ServerMessage::Error { code, .. } if code == "join_rejected"
    ));
    let (mut relay, _) = connect_async(&url).await.unwrap();
    let reply = next_server_message(&mut relay).await;
    assert!(
        matches!(reply, ServerMessage::Welcome { .. }),
        "only a successful key proof may debit the relay identity's join quota: {reply:?}"
    );
}

#[tokio::test]
async fn pairing_ticket_budgets_have_no_cross_relay_capacity_gate() {
    let state = app_state(test_public_control_plane().await, Default::default());
    for index in 0..IDENTITY_COUNT {
        assert!(
            state
                .hardening
                .relay_rate_limiter
                .allow(format!("pairing-ticket:relay-{index}"), 1)
                .await,
            "a new verified relay must retain its own pairing-ticket quota"
        );
    }
    assert!(
        !state
            .hardening
            .relay_rate_limiter
            .allow("pairing-ticket:relay-0".into(), 1)
            .await
    );
}

#[tokio::test]
async fn unauthenticated_credential_routes_spend_the_shared_budget() {
    let address = spawn_app_with_guard_and_hardening(
        guard(),
        BrokerHardeningConfig {
            public_api_global_rate_limit_per_minute: 2,
            ..Default::default()
        },
    )
    .await;
    let client = reqwest::Client::new();
    for index in 0..3 {
        let status = client
            .post(format!("http://{address}/api/public/relay/ws-token"))
            .header("x-forwarded-for", format!("203.0.113.{}", index + 1))
            .json(&RelayWsTokenRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
                relay_peer_id: "relay-1".into(),
                challenge_id: String::new(),
                challenge_signature: String::new(),
            })
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(
            status == reqwest::StatusCode::TOO_MANY_REQUESTS,
            index == 2,
            "anonymous credential requests must debit the shared budget: {status}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_configured_anonymous_budget_can_exceed_1024_without_eviction() {
    let limiter = SlidingWindowRateLimiter::default();
    let budget = IDENTITY_COUNT + 1;
    assert!(admit_public_api(&limiter, "hot".into(), 1, budget).await);
    for index in 0..IDENTITY_COUNT {
        assert!(
            admit_public_api(&limiter, format!("source-{index}"), 1, budget).await,
            "admission must depend on configured quotas rather than a hidden 1024-key cap"
        );
    }
    assert!(!admit_public_api(&limiter, "hot".into(), 1, budget).await);
    assert!(!admit_public_api(&limiter, "overflow".into(), 1, budget).await);
    assert_eq!(limiter.bucket_count_for_test().await, budget + 1);
    tokio::time::advance(Duration::from_secs(RATE_LIMIT_WINDOW_SECS + 1)).await;
    assert!(admit_public_api(&limiter, "after-expiry".into(), 1, budget).await);
    assert_eq!(limiter.bucket_count_for_test().await, 2);
}

#[tokio::test]
async fn credential_probes_have_a_separate_shared_budget_and_skip_cached_credentials() {
    let plane = test_public_control_plane().await;
    let phone = plane
        .issue_device_grant(
            "relay-refresh-1",
            DeviceGrantRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
                device_id: "revoked-phone".into(),
            },
            None,
        )
        .await
        .unwrap();
    plane
        .revoke_device_grant(
            "relay-refresh-1",
            "revoked-phone",
            DeviceGrantRevokeRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
            },
        )
        .await
        .unwrap();
    let state = app_state(
        plane,
        BrokerHardeningConfig {
            public_api_global_rate_limit_per_minute: 2,
            ..Default::default()
        },
    );
    for index in 0..3 {
        let outcome = credential_admission(
            &state,
            format!("203.0.113.{}:1234", index + 1).parse().unwrap(),
            public_control::CredentialKind::Device,
            Some(&phone.device_refresh_token),
        )
        .await;
        assert_eq!(
            outcome.is_err(),
            index == 2,
            "probe must spend shared quota"
        );
    }
    assert!(matches!(
        credential_admission(
            &state,
            "203.0.113.4:1234".parse().unwrap(),
            public_control::CredentialKind::Relay,
            Some("relay-refresh-1"),
        )
        .await,
        Ok(Some(_))
    ));
    assert_eq!(
        state
            .hardening
            .credential_probe_rate_limiter
            .bucket_count_for_test()
            .await,
        3
    );
    assert!(
        enforce_shared_api_rate_limit(&state, "203.0.113.4:1234".parse().unwrap())
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn broker_restart_admits_more_than_1024_preexisting_device_identities() {
    let state_path = temp_state_path("broker-reconnect-capacity");
    let registrations = (0..IDENTITY_COUNT)
        .map(|index| {
            json!({
                "relay_id": format!("relay-{index}"),
                "broker_room_id": format!("room-{index}"),
                "refresh_token": format!("refresh-{index}"),
                "relay_verify_key": seeded_relay_verify_key(),
            })
        })
        .collect::<Vec<_>>();
    let plane = PublicControlPlane::from_parts(
        Some("public-broker-issuer-secret-a3f76b4c2089d15e6b0fa873c4e9521d".into()),
        Some(serde_json::to_string(&registrations).unwrap()),
        Some(state_path.clone()),
        None,
        None,
    )
    .await
    .unwrap();
    // Real device tickets are only issued to granted devices, and a join checks the grant.
    plane
        .seed_device_grants_for_test((0..IDENTITY_COUNT).map(|index| {
            (
                format!("relay-{index}"),
                format!("room-{index}"),
                format!("device-{index}"),
            )
        }))
        .await;
    let tickets = (0..IDENTITY_COUNT)
        .map(|index| {
            plane
                .issuer_key()
                .mint(&JoinTicketClaims::device_surface_join(
                    &format!("room-{index}"),
                    &format!("device-{index}"),
                    Some(crate::join_ticket::unix_now() + 300),
                ))
                .unwrap()
        })
        .collect::<Vec<_>>();
    let boot = |plane| async {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = app_with_web_root_and_verifier_and_hardening(
            BrokerState::default(),
            test_web_root(),
            BrokerJoinVerifier::PublicControlPlane(plane),
            BrokerHardeningConfig::default(),
            SecurityHeadersConfig::default(),
        )
        .layer(middleware::from_fn_with_state(guard(), reject_banned_ips));
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (address, server)
    };
    let (address, server) = boot(plane).await;
    assert_eq!(broker_health(address).await.status, "ok");
    server.abort();
    let _ = server.await;
    let plane = PublicControlPlane::from_parts(
        Some("public-broker-issuer-secret-a3f76b4c2089d15e6b0fa873c4e9521d".into()),
        None,
        Some(state_path.clone()),
        None,
        None,
    )
    .await
    .unwrap();
    let (address, server) = boot(plane).await;
    let mut results = futures_util::stream::iter(tickets.into_iter().enumerate())
        .map(|(index, ticket)| async move {
            let request = forwarded_request(
                format!("ws://{address}/ws/room-{index}?role=surface&join_ticket={ticket}"),
                &format!("2001:db8:{index:x}:1::1"),
            );
            let (mut socket, _) = connect_async(request).await.unwrap();
            let reply = next_server_message(&mut socket).await;
            socket.close(None).await.unwrap();
            reply
        })
        .buffer_unordered(32);
    let mut admitted = 0;
    while let Some(reply) = results.next().await {
        assert!(
            matches!(reply, ServerMessage::Welcome { .. }),
            "preexisting devices must reconnect after restart: {reply:?}"
        );
        admitted += 1;
    }
    assert_eq!(admitted, IDENTITY_COUNT);
    server.abort();
    let _ = server.await;
    fs::remove_file(state_path).unwrap();
}
