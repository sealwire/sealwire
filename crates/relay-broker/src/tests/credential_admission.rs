use super::*;

#[tokio::test]
async fn a_phone_cannot_block_its_relays_revoke_or_reconnect() {
    assert_phone_cannot_block_relay(None).await;
}

#[tokio::test]
async fn a_phone_cannot_spend_the_licenses_relay_control_budget() {
    assert_phone_cannot_block_relay(Some("license-for-test".into())).await;
}

async fn assert_phone_cannot_block_relay(quota_key: Option<String>) {
    let mut access = ScriptedAccessStrategy::allow();
    access.quota_key = quota_key;
    let (address, _, plane) = spawn_public_mode_app_with_access_hardening(
        std::sync::Arc::new(access),
        BrokerState::default(),
        BrokerHardeningConfig {
            authenticated_api_rate_limit_per_minute: 4,
            ..BrokerHardeningConfig::default()
        },
    )
    .await;
    let phone = grant(&plane).await;
    let clients = review_mint_clients(&plane, 1).await;
    let challenge = RelayWsTokenChallengeRequest {
        relay_id: "relay-1".into(),
        broker_room_id: "room-a".into(),
        relay_peer_id: "relay-1".into(),
    };
    for token in [
        &phone.device_refresh_token,
        &clients[0].1.client_refresh_token,
    ] {
        assert_eq!(
            public_post_response(
                address,
                "/api/public/relay/ws-token/challenge",
                token,
                &challenge
            )
            .await
            .status(),
            reqwest::StatusCode::UNAUTHORIZED,
        );
    }
    for i in 0..5 {
        assert_eq!(
            public_post_response(
                address,
                "/api/public/device/ws-token",
                &phone.device_refresh_token,
                &json!({})
            )
            .await
            .status(),
            if i < 4 {
                reqwest::StatusCode::OK
            } else {
                reqwest::StatusCode::TOO_MANY_REQUESTS
            },
        );
    }
    assert_eq!(
        public_post_response(
            address,
            "/api/public/devices/phone/revoke",
            "relay-refresh-1",
            &DeviceGrantRevokeRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
            }
        )
        .await
        .status(),
        reqwest::StatusCode::OK,
        "the relay must be able to revoke the phone that exhausted its client budget",
    );
    assert_eq!(
        public_post_response(
            address,
            "/api/public/device/ws-token",
            &phone.device_refresh_token,
            &json!({})
        )
        .await
        .status(),
        reqwest::StatusCode::UNAUTHORIZED,
    );
    assert_eq!(
        post_signed_relay_ws_token_response(
            address,
            "relay-refresh-1",
            "relay-1",
            "room-a",
            "relay-1",
            &seeded_relay_signing_key()
        )
        .await
        .status(),
        reqwest::StatusCode::OK,
    );
    assert_eq!(
        public_post_response(
            address,
            "/api/public/relay/ws-token/challenge",
            "relay-refresh-1",
            &challenge
        )
        .await
        .status(),
        reqwest::StatusCode::TOO_MANY_REQUESTS,
        "relay credentials must still have a bounded allowance across routes",
    );
}

#[tokio::test]
async fn recovery_for_an_ungranted_room_spends_the_callers_budget() {
    assert_wrong_room_recovery_is_limited(false).await;
}

#[tokio::test]
async fn orphaned_client_recovery_for_an_ungranted_room_is_source_limited() {
    assert_wrong_room_recovery_is_limited(true).await;
}

async fn assert_wrong_room_recovery_is_limited(orphaned: bool) {
    let plane = test_public_control_plane().await;
    let clients = review_mint_clients(&plane, 1).await;
    let (key, client) = &clients[0];
    let (other_relay, other_phone) = another_relay(&plane).await;
    if orphaned {
        plane
            .revoke_device_grant(
                "relay-refresh-1",
                "p0",
                DeviceGrantRevokeRequest {
                    relay_id: "relay-1".into(),
                    broker_room_id: "room-a".into(),
                },
            )
            .await
            .unwrap();
    }
    let address = spawn_public_mode_app_with(
        plane,
        BrokerHardeningConfig {
            public_api_rate_limit_per_minute: 2,
            authenticated_api_rate_limit_per_minute: 2,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    for i in 0..3 {
        let response = reqwest::Client::new()
            .post(format!(
                "http://{address}/api/public/client/refresh/challenge"
            ))
            .json(&refresh_init_body(
                address,
                key,
                &client.client_id,
                Some(&other_relay.broker_room_id),
                None,
                &format!("wrong-room-{i}"),
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if i < 2 {
                reqwest::StatusCode::UNAUTHORIZED
            } else {
                reqwest::StatusCode::TOO_MANY_REQUESTS
            }
        );
    }
    assert_eq!(
        public_post_response(
            address,
            "/api/public/device/ws-token",
            &other_phone.device_refresh_token,
            &json!({})
        )
        .await
        .status(),
        reqwest::StatusCode::OK,
        "invalid scope must not debit the relay named by the caller",
    );
}

#[tokio::test]
async fn recovery_completion_after_grant_revocation_is_source_limited() {
    let plane = test_public_control_plane().await;
    grant(&plane).await;
    let initial = spawn_public_mode_app_with(
        plane.clone(),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let key = SigningKey::from_bytes(&[97; 32]);
    let client = public_client_pair(
        initial,
        "relay-refresh-1",
        &key,
        &ClientGrantRequest {
            relay_id: "relay-1".into(),
            broker_room_id: "room-a".into(),
            device_id: "phone".into(),
            client_verify_key: STANDARD.encode(key.verifying_key().to_bytes()),
            client_label: None,
            device_label: None,
        },
    )
    .await;
    let address = spawn_public_mode_app_with(
        plane.clone(),
        BrokerHardeningConfig {
            public_api_rate_limit_per_minute: 2,
            authenticated_api_rate_limit_per_minute: 2,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let signed = signed_refresh_request(address, &key, &client.client_id, Some("room-a")).await;
    plane
        .revoke_device_grant(
            "relay-refresh-1",
            "phone",
            DeviceGrantRevokeRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
            },
        )
        .await
        .unwrap();
    for i in 0..3 {
        assert_eq!(
            redeem_signed_refresh(address, &signed).await.status(),
            if i < 2 {
                reqwest::StatusCode::UNAUTHORIZED
            } else {
                reqwest::StatusCode::TOO_MANY_REQUESTS
            }
        );
    }
}

#[tokio::test]
async fn review_regression_clients_share_their_issuing_relays_budget() {
    let plane = test_public_control_plane().await;
    let clients = review_mint_clients(&plane, 3).await;
    let (_, other_device) = another_relay(&plane).await;
    let address = spawn_public_mode_app_with(
        plane,
        BrokerHardeningConfig {
            authenticated_api_rate_limit_per_minute: 2,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    for (i, (_, client)) in clients.iter().enumerate() {
        let response = reqwest::Client::new()
            .get(format!("http://{address}/api/public/relays"))
            .bearer_auth(&client.client_refresh_token)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if i < 2 {
                reqwest::StatusCode::OK
            } else {
                reqwest::StatusCode::TOO_MANY_REQUESTS
            }
        );
    }
    assert_eq!(
        public_post_response(
            address,
            "/api/public/device/ws-token",
            &other_device.device_refresh_token,
            &json!({})
        )
        .await
        .status(),
        reqwest::StatusCode::OK
    );
}

async fn another_relay(
    plane: &PublicControlPlane,
) -> (RelayEnrollmentResponse, DeviceGrantResponse) {
    let address = spawn_public_mode_app_with(
        plane.clone(),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let relay = enroll_relay(address, "other-quota-owner", None)
        .await
        .unwrap();
    let device = plane
        .issue_device_grant(
            &relay.relay_refresh_token,
            DeviceGrantRequest {
                relay_id: relay.relay_id.clone(),
                broker_room_id: relay.broker_room_id.clone(),
                device_id: "other-phone".into(),
            },
            None,
        )
        .await
        .unwrap();
    (relay, device)
}

#[tokio::test]
async fn review_regression_registered_counter_capacity_does_not_lock_out_a_new_relay() {
    let registrations: Vec<_> = (0..=RATE_LIMIT_BUCKET_PRUNE_THRESHOLD).map(|i| json!({
        "relay_id": format!("registered-{i}"), "broker_room_id": format!("room-{i}"),
        "refresh_token": format!("registered-token-{i}"), "relay_verify_key": seeded_relay_verify_key()
    })).collect();
    let plane = PublicControlPlane::from_parts(
        Some("registered-counter-issuer-a3f76b4c2089d15e6b0fa873c4e9521d".into()),
        Some(serde_json::to_string(&registrations).unwrap()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let address = spawn_public_mode_app_with(
        plane,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    for i in 0..=RATE_LIMIT_BUCKET_PRUNE_THRESHOLD {
        let response = public_post_response(address, "/api/public/relay/ws-token/challenge", &format!("registered-token-{i}"), &json!({
            "relay_id": format!("registered-{i}"), "broker_room_id": format!("room-{i}"), "relay_peer_id": format!("registered-{i}")
        })).await;
        assert_eq!(
            response.status(),
            reqwest::StatusCode::OK,
            "registered relay {i} was refused by unrelated counter keys"
        );
    }
}

#[tokio::test]
async fn review_regression_recovery_pending_capacity_is_per_relay() {
    let plane = test_public_control_plane().await;
    let clients = review_mint_clients(&plane, 17).await;
    let address: SocketAddr = "127.0.0.1:9".parse().unwrap();
    let origin = format!("http://{address}");
    for (i, (key, client)) in clients.iter().enumerate() {
        for n in 0..4 {
            let body = refresh_init_body(
                address,
                key,
                &client.client_id,
                None,
                None,
                &format!("n{n}"),
            );
            let result = plane
                .create_credential_refresh_challenge(serde_json::from_value(body).unwrap(), &origin)
                .await;
            assert_eq!(
                result.is_ok(),
                i < 16,
                "one relay must not retain more than 64 recovery challenges"
            );
        }
    }
    let (relay, _) = another_relay(&plane).await;
    let key = SigningKey::from_bytes(&[202; 32]);
    let grant = plane
        .issue_client_grant(
            &relay.relay_refresh_token,
            ClientGrantRequest {
                relay_id: relay.relay_id.clone(),
                broker_room_id: relay.broker_room_id,
                device_id: "other-phone".into(),
                client_verify_key: STANDARD.encode(key.verifying_key().to_bytes()),
                client_label: None,
                device_label: None,
            },
        )
        .await
        .unwrap();
    let message = client_claim_message(&grant.claim_id, &grant.claim_nonce, &relay.relay_id);
    let client = plane
        .claim_client_identity(ClientClaimRequest {
            claim_id: grant.claim_id,
            claim_signature: STANDARD.encode(key.sign(message.as_bytes()).to_bytes()),
        })
        .await
        .unwrap();
    let body = refresh_init_body(address, &key, &client.client_id, None, None, "other-relay");
    plane
        .create_credential_refresh_challenge(serde_json::from_value(body).unwrap(), &origin)
        .await
        .expect("another relay retains recovery capacity");
}

#[tokio::test]
async fn review_regression_one_relay_cannot_accumulate_unbounded_client_identities() {
    let plane = test_public_control_plane().await;
    review_mint_clients(&plane, 64).await;
    let key = SigningKey::from_bytes(&[155; 32]);
    let grant = plane
        .issue_client_grant(
            "relay-refresh-1",
            ClientGrantRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
                device_id: "excess".into(),
                client_verify_key: STANDARD.encode(key.verifying_key().to_bytes()),
                client_label: None,
                device_label: None,
            },
        )
        .await
        .unwrap();
    let message = client_claim_message(&grant.claim_id, &grant.claim_nonce, "relay-1");
    let result = plane
        .claim_client_identity(ClientClaimRequest {
            claim_id: grant.claim_id,
            claim_signature: STANDARD.encode(key.sign(message.as_bytes()).to_bytes()),
        })
        .await;
    assert!(
        result.is_err(),
        "a relay must have a bound on durable client identities"
    );
    review_mint_clients(&plane, 1).await;
    plane
        .revoke_device_grant(
            "relay-refresh-1",
            "p1",
            DeviceGrantRevokeRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
            },
        )
        .await
        .unwrap();
    let grant = plane
        .issue_client_grant(
            "relay-refresh-1",
            ClientGrantRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
                device_id: "replacement".into(),
                client_verify_key: STANDARD.encode(key.verifying_key().to_bytes()),
                client_label: None,
                device_label: None,
            },
        )
        .await
        .unwrap();
    let message = client_claim_message(&grant.claim_id, &grant.claim_nonce, "relay-1");
    plane
        .claim_client_identity(ClientClaimRequest {
            claim_id: grant.claim_id,
            claim_signature: STANDARD.encode(key.sign(message.as_bytes()).to_bytes()),
        })
        .await
        .expect("revoking an old device frees identity capacity");
}

#[tokio::test]
async fn orphaned_clients_share_anonymous_limits_and_cannot_spend_the_former_relays_budget() {
    let plane = test_public_control_plane().await;
    let clients = review_mint_clients(&plane, 7).await;
    let kept = grant(&plane).await;
    for i in 0..7 {
        plane
            .revoke_device_grant(
                "relay-refresh-1",
                &format!("p{i}"),
                DeviceGrantRevokeRequest {
                    relay_id: "relay-1".into(),
                    broker_room_id: "room-a".into(),
                },
            )
            .await
            .unwrap();
    }
    let address = spawn_public_mode_app_with(
        plane,
        BrokerHardeningConfig {
            authenticated_api_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    for (i, (_, client)) in clients.iter().enumerate() {
        let response = reqwest::Client::new()
            .get(format!("http://{address}/api/public/relays"))
            .bearer_auth(&client.client_refresh_token)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if i < 5 {
                reqwest::StatusCode::OK
            } else {
                reqwest::StatusCode::TOO_MANY_REQUESTS
            }
        );
    }
    assert_eq!(
        public_post_response(
            address,
            "/api/public/device/ws-token",
            &kept.device_refresh_token,
            &json!({})
        )
        .await
        .status(),
        reqwest::StatusCode::OK
    );
}

#[tokio::test]
async fn scoped_key_recovery_also_spends_the_target_relays_budget() {
    let plane = test_public_control_plane().await;
    let device = grant(&plane).await;
    let initial_address = spawn_public_mode_app_with(
        plane.clone(),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let key = SigningKey::from_bytes(&[96; 32]);
    let client = public_client_pair(
        initial_address,
        "relay-refresh-1",
        &key,
        &ClientGrantRequest {
            relay_id: "relay-1".into(),
            broker_room_id: "room-a".into(),
            device_id: "phone".into(),
            client_verify_key: STANDARD.encode(key.verifying_key().to_bytes()),
            client_label: None,
            device_label: None,
        },
    )
    .await;
    let address = spawn_public_mode_app_with(
        plane,
        BrokerHardeningConfig {
            authenticated_api_rate_limit_per_minute: 2,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    assert_eq!(
        public_post_response(
            address,
            "/api/public/device/ws-token",
            &device.device_refresh_token,
            &json!({})
        )
        .await
        .status(),
        reqwest::StatusCode::OK
    );
    let signed = signed_refresh_request(address, &key, &client.client_id, Some("room-a")).await;
    assert_eq!(
        redeem_signed_refresh(address, &signed).await.status(),
        reqwest::StatusCode::TOO_MANY_REQUESTS
    );
}

async fn grant(plane: &PublicControlPlane) -> DeviceGrantResponse {
    plane
        .issue_device_grant(
            "relay-refresh-1",
            DeviceGrantRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
                device_id: "phone".into(),
            },
            None,
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn a_rotated_token_and_its_grace_token_share_the_relays_budget_across_routes() {
    let plane = test_public_control_plane().await;
    let old = grant(&plane).await;
    let current = grant(&plane).await;
    let address = spawn_public_mode_app_with(
        plane,
        BrokerHardeningConfig {
            authenticated_api_rate_limit_per_minute: 2,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let http = reqwest::Client::new();
    for (path, token, status) in [
        (
            "device/session",
            old.device_refresh_token.as_str(),
            reqwest::StatusCode::OK,
        ),
        (
            "device/ws-token",
            current.device_refresh_token.as_str(),
            reqwest::StatusCode::OK,
        ),
        (
            "device/session",
            old.device_refresh_token.as_str(),
            reqwest::StatusCode::TOO_MANY_REQUESTS,
        ),
        (
            "relay/ws-token/challenge",
            "relay-refresh-1",
            reqwest::StatusCode::OK,
        ),
    ] {
        let response = http
            .post(format!("http://{address}/api/public/{path}"))
            .bearer_auth(token)
            .json(&RelayWsTokenChallengeRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
                relay_peer_id: "relay-1".into(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{path}");
    }
}

#[tokio::test]
async fn a_license_budget_is_shared_even_when_the_relay_identity_changes() {
    let mut access = ScriptedAccessStrategy::allow();
    access.quota_key = Some("license-for-test".into());
    let (address, _, plane) = spawn_public_mode_app_with_access_hardening(
        std::sync::Arc::new(access),
        BrokerState::default(),
        BrokerHardeningConfig {
            authenticated_api_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
    )
    .await;
    let first = enroll_relay(address, "quota-before", None).await.unwrap();
    let second = enroll_relay(address, "quota-after", None).await.unwrap();
    for (relay, status) in [
        (&first, reqwest::StatusCode::OK),
        (&second, reqwest::StatusCode::TOO_MANY_REQUESTS),
    ] {
        let phone = plane
            .issue_device_grant(
                &relay.relay_refresh_token,
                DeviceGrantRequest {
                    relay_id: relay.relay_id.clone(),
                    broker_room_id: relay.broker_room_id.clone(),
                    device_id: "phone".into(),
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            public_post_response(
                address,
                "/api/public/device/ws-token",
                &phone.device_refresh_token,
                &json!({})
            )
            .await
            .status(),
            status,
        );
    }
    for (relay, status) in [
        (&first, reqwest::StatusCode::OK),
        (&second, reqwest::StatusCode::TOO_MANY_REQUESTS),
    ] {
        let response = reqwest::Client::new()
            .post(format!(
                "http://{address}/api/public/relay/ws-token/challenge"
            ))
            .bearer_auth(&relay.relay_refresh_token)
            .json(&RelayWsTokenChallengeRequest {
                relay_id: relay.relay_id.clone(),
                broker_room_id: relay.broker_room_id.clone(),
                relay_peer_id: relay.relay_id.clone(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
}

#[tokio::test]
async fn invalid_signatures_cannot_spend_a_clients_recovery_budget() {
    let plane = test_public_control_plane().await;
    let initial_address = spawn_public_mode_app_with(
        plane.clone(),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let key = SigningKey::from_bytes(&[94; 32]);
    let client = public_client_pair(
        initial_address,
        "relay-refresh-1",
        &key,
        &ClientGrantRequest {
            relay_id: "relay-1".into(),
            broker_room_id: "room-a".into(),
            device_id: "phone".into(),
            client_verify_key: STANDARD.encode(key.verifying_key().to_bytes()),
            client_label: None,
            device_label: None,
        },
    )
    .await;
    let address = spawn_public_mode_app_with(
        plane,
        BrokerHardeningConfig {
            authenticated_api_rate_limit_per_minute: 2,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    for _ in 0..6 {
        let forged = refresh_init_body(
            address,
            &SigningKey::from_bytes(&[95; 32]),
            &client.client_id,
            None,
            None,
            "forged",
        );
        let response = reqwest::Client::new()
            .post(format!(
                "http://{address}/api/public/client/refresh/challenge"
            ))
            .json(&forged)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_client_error());
    }
    let signed = signed_refresh_request(address, &key, &client.client_id, None).await;
    assert_eq!(
        redeem_signed_refresh(address, &signed).await.status(),
        reqwest::StatusCode::OK
    );
}

#[tokio::test]
async fn anonymous_counter_churn_does_not_fill_the_credential_counter_map() {
    let plane = test_public_control_plane().await;
    let device = grant(&plane).await;
    let guard = BanGuard {
        blocklist: Blocklist::disabled(),
        trusted_ip_header: Some("x-forwarded-for".parse().unwrap()),
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = app_with_web_root_and_verifier_and_hardening(
        BrokerState::default(),
        test_web_root(),
        BrokerJoinVerifier::PublicControlPlane(plane),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .layer(middleware::from_fn_with_state(guard, reject_banned_ips));
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let http = reqwest::Client::new();
    for i in 0..(RATE_LIMIT_BUCKET_PRUNE_THRESHOLD + 2) {
        let ip = std::net::Ipv4Addr::from(0xc6120000 + i as u32);
        let response = http
            .post(format!("http://{address}/api/public/device/ws-token"))
            .header("x-forwarded-for", ip.to_string())
            .bearer_auth("fabricated")
            .send()
            .await
            .unwrap();
        assert!(response.status().is_client_error());
    }
    let response = http
        .post(format!("http://{address}/api/public/device/ws-token"))
        .header(
            "Cookie",
            format!(
                "{DEVICE_SESSION_COOKIE_NAME}={}",
                device.device_refresh_token
            ),
        )
        .header("x-forwarded-for", "203.0.113.91")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
}

async fn review_mint_clients(
    plane: &PublicControlPlane,
    count: usize,
) -> Vec<(SigningKey, ClientClaimResponse)> {
    let mut out = Vec::new();
    for i in 0..count {
        let mut seed = [7u8; 32];
        seed[..8].copy_from_slice(&(i as u64 + 1).to_le_bytes());
        let key = SigningKey::from_bytes(&seed);
        let grant = plane
            .issue_client_grant(
                "relay-refresh-1",
                ClientGrantRequest {
                    relay_id: "relay-1".into(),
                    broker_room_id: "room-a".into(),
                    device_id: format!("p{i}"),
                    client_verify_key: STANDARD.encode(key.verifying_key().to_bytes()),
                    client_label: None,
                    device_label: None,
                },
            )
            .await
            .unwrap();
        let message = client_claim_message(&grant.claim_id, &grant.claim_nonce, "relay-1");
        let claimed = plane
            .claim_client_identity(ClientClaimRequest {
                claim_id: grant.claim_id,
                claim_signature: STANDARD.encode(key.sign(message.as_bytes()).to_bytes()),
            })
            .await
            .unwrap();
        out.push((key, claimed));
    }
    out
}

#[tokio::test]
async fn review_regression_revoked_device_cannot_spend_relay_budget() {
    let plane = test_public_control_plane().await;
    let revoked = plane
        .issue_device_grant(
            "relay-refresh-1",
            DeviceGrantRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
                device_id: "lost-phone".into(),
            },
            None,
        )
        .await
        .unwrap();
    let kept = grant(&plane).await;
    plane
        .revoke_device_grant(
            "relay-refresh-1",
            "lost-phone",
            DeviceGrantRevokeRequest {
                relay_id: "relay-1".into(),
                broker_room_id: "room-a".into(),
            },
        )
        .await
        .unwrap();
    let address = spawn_public_mode_app_with(
        plane,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let http = reqwest::Client::new();
    let mut unauthorized = 0;
    for _ in 0..120 {
        let r = http
            .post(format!("http://{address}/api/public/device/ws-token"))
            .bearer_auth(&revoked.device_refresh_token)
            .send()
            .await
            .unwrap();
        if r.status() == reqwest::StatusCode::UNAUTHORIZED {
            unauthorized += 1;
        }
    }
    assert!(unauthorized > 0);
    let victim = http
        .post(format!("http://{address}/api/public/device/ws-token"))
        .bearer_auth(&kept.device_refresh_token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        victim.status(),
        reqwest::StatusCode::OK,
        "owner's remaining phone locked out by a revoked phone"
    );
}
