use super::authentication::issue_claim_challenge_outcome;
use super::delivery::{
    build_encrypted_remote_action_result_chunk_payloads, cached_remote_action_result,
    measure_remote_action_result_sizes, publish_remote_action_result_chunks,
    publish_remote_action_result_private, remote_action_result_kind, RemoteActionOutcome,
    RemoteActionResultChunkPlaintext, RemoteActionResultKind, RemoteActionResultPlaintext,
    CLIENT_REMOTE_ACTION_DEADLINE, REMOTE_ACTION_PENDING_NOTICE_INTERVAL,
};
use super::execution::execute_remote_action;
use super::request::{remote_action_emits_info_log, requires_signed_attempt};
use super::*;
use crate::{
    broker::{
        crypto::{decrypt_json, encrypt_json},
        protocol::{frame_bytes_for_payload, OutboundBrokerPayload},
        MAX_BROKER_TEXT_FRAME_BYTES,
    },
    protocol::{SessionSnapshot, ThreadsQuery},
};
use tokio::time::Duration;

async fn device_proof_test_state() -> (
    AppState,
    std::sync::Arc<tokio::sync::RwLock<crate::state::RelayState>>,
    ed25519_dalek::SigningKey,
) {
    use crate::state::{PairedDevice, RelayState, SecurityProfile};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::{collections::HashMap, sync::Arc};
    use tokio::sync::{watch, RwLock};

    let signing_key = ed25519_dalek::SigningKey::from_bytes(&[31; 32]);
    let (change_tx, _) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        "/tmp/device-proof-test".to_string(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    {
        let mut relay = relay.write().await;
        relay.paired_devices.insert(
            "phone-1".to_string(),
            PairedDevice {
                device_id: "phone-1".to_string(),
                label: "Phone".to_string(),
                payload_secret: "leaked-secret".to_string(),
                device_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
                created_at: 1,
                last_seen_at: None,
                last_peer_id: None,
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
            },
        );
        relay.mark_surface_peer_online("surface-phone");
        relay.mark_surface_peer_online("surface-attacker");
    }
    let state = AppState::from_parts(relay.clone(), HashMap::new(), change_tx);
    (state, relay, signing_key)
}

static TEST_REQUEST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A signed attempt from the paired test phone (key `[31; 32]`) on `peer_id`.
fn signed_test_payload(
    peer_id: &str,
    action_id: &str,
    request: serde_json::Value,
    sid: &str,
) -> serde_json::Value {
    let (writer, _, _) = super::super::writer::test_writer_with_identity();
    super::super::request_auth::test_signed_request(
        &ed25519_dalek::SigningKey::from_bytes(&[31; 32]),
        &writer.request_binding().unwrap(),
        "phone-1",
        peer_id,
        sid,
        TEST_REQUEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1,
        action_id,
        &request,
        "leaked-secret",
    )
}

/// Hand `payload` to the relay as if the broker said it came from `peer_id`.
async fn deliver_as(
    state: &AppState,
    peer_id: &str,
    payload: serde_json::Value,
) -> Option<serde_json::Value> {
    let parsed = super::super::protocol::parse_inbound_payload(payload)
        .expect("payload parses")
        .expect("payload is an action");
    let super::super::protocol::InboundBrokerPayload::EncryptedRemoteAction {
        action_id,
        device_id,
        action,
        request_sid,
        request_boot,
        request_seq,
        request_time,
        op_boot,
        op_t0,
        request_signature,
        envelope,
    } = parsed
    else {
        panic!("not an action payload");
    };
    let (writer, mut replies, _trains) = super::super::writer::test_writer_with_identity();
    // Boxed: the handler's future is too large for a test thread's stack in debug builds.
    Box::pin(handle_encrypted_remote_action(
        state,
        &writer,
        FrameOrigin {
            ingress: crate::state::next_relay_ingress(),
            lease: state
                .current_surface_lease(peer_id)
                .await
                .unwrap_or_default(),
        },
        peer_id.to_string(),
        action_id.clone(),
        device_id,
        signed_attempt_from_parts(
            action,
            request_sid,
            request_boot,
            request_seq,
            request_time,
            op_boot,
            op_t0,
            request_signature,
        ),
        envelope,
    ))
    .await
    .expect("the room remains connected");
    let tokio_tungstenite::tungstenite::Message::Text(text) = replies.try_recv().ok()? else {
        panic!("expected a text reply");
    };
    let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
    if frame["payload"]["kind"] == "remote_action_reauthorize" {
        return Some(serde_json::json!({"reauthorize": true}));
    }
    assert_eq!(
        frame["payload"]["action_id"].as_str(),
        Some(action_id.as_str()),
        "wire replies keep the caller's action id"
    );
    let envelope = serde_json::from_value(frame["payload"]["envelope"].clone()).unwrap();
    Some(decrypt_json("leaked-secret", &envelope).unwrap())
}

/// A claim step (no `sid`), or an ordinary action signed under `sid`.
async fn device_proof_test_reply(
    state: &AppState,
    peer_id: &str,
    action_id: &str,
    request: serde_json::Value,
    sid: Option<String>,
) -> Option<serde_json::Value> {
    let payload = match sid {
        Some(sid) => signed_test_payload(peer_id, action_id, request, &sid),
        None => serde_json::json!({
            "kind": "encrypted_remote_action",
            "protocol_version": super::super::RELAY_PROTOCOL_VERSION,
            "action_id": action_id,
            "device_id": "phone-1",
            "envelope": encrypt_json(
                "leaked-secret",
                &serde_json::json!({"action_id": action_id, "request": request}),
            )
            .expect("request encrypts"),
        }),
    };
    deliver_as(state, peer_id, payload).await
}

async fn device_proof_test_action(
    state: &AppState,
    peer_id: &str,
    action_id: &str,
    request: serde_json::Value,
    sid: Option<String>,
) -> serde_json::Value {
    device_proof_test_reply(state, peer_id, action_id, request, sid)
        .await
        .unwrap_or_else(|| panic!("{action_id} got no answer"))
}

fn assert_no_session_material(reply: &serde_json::Value) {
    for field in [
        "snapshot",
        "session_claim",
        "session_claim_expires_at",
        "threads",
        "devices",
        "providers",
        "models",
        "receipt",
        "thread_transcript",
        "thread_entry_detail",
        "workspace_diff",
        "projects",
        "reviews",
        "workflows",
        "claim_challenge",
        "claim_challenge_id",
        "claim_challenge_expires_at",
    ] {
        assert!(
            reply[field].is_null(),
            "{field} leaked from an unauthenticated claim completion: {reply}"
        );
    }
}

fn auth_cache_action_id(peer_id: &str, action_id: &str) -> String {
    serde_json::to_string(&(peer_id, action_id)).expect("auth cache key")
}

fn sign_message(key: &ed25519_dalek::SigningKey, message: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::Signer;
    STANDARD.encode(key.sign(message.as_bytes()).to_bytes())
}

fn claim_device_request(
    key: &ed25519_dalek::SigningKey,
    challenge_id: &str,
    nonce: &str,
    peer_id: &str,
) -> serde_json::Value {
    serde_json::json!({
        "type": "claim_device",
        "challenge_id": challenge_id,
        "challenge": nonce,
        "proof": sign_message(
            key,
            &super::super::device_claim_proof_message(challenge_id, nonce, "phone-1", peer_id),
        ),
    })
}

#[tokio::test]
async fn a_leaked_payload_secret_cannot_read_mutate_or_subscribe() {
    let (state, relay, _) = device_proof_test_state().await;
    for (index, request) in [
        serde_json::json!({"type":"start_session", "input":{}}),
        serde_json::json!({"type":"fork_session", "input":{"source_thread_id":"thread-1"}}),
        serde_json::json!({"type":"resume_session", "input":{"thread_id":"thread-1"}}),
        serde_json::json!({"type":"take_over", "input":{"thread_id":"thread-1"}}),
        serde_json::json!({"type":"list_threads", "query":{}}),
        serde_json::json!({"type":"fetch_devices"}),
        serde_json::json!({"type":"watch_threads", "input":{"thread_ids":[]}}),
        serde_json::json!({"type":"heartbeat", "input":{}}),
    ]
    .into_iter()
    .enumerate()
    {
        let reply = device_proof_test_reply(
            &state,
            "surface-attacker",
            &format!("unsigned-{index}"),
            request,
            None,
        )
        .await;
        assert!(
            reply.is_none(),
            "an unsigned action gets no answer at all, got {reply:?}"
        );
        assert!(state.broker_targets().await.is_empty());
    }
    let relay = relay.read().await;
    assert!(relay.paired_devices["phone-1"].last_peer_id.is_none());
    assert!(relay.active_thread_id.is_none());
}

#[tokio::test]
async fn only_the_paired_private_key_can_claim_and_access_on_its_connection() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::Signer;

    let (state, relay, key) = device_proof_test_state().await;
    let rejected = device_proof_test_action(
        &state,
        "surface-attacker",
        "forged-init",
        serde_json::json!({"type":"claim_challenge", "proof": STANDARD.encode([0; 64])}),
        None,
    )
    .await;
    assert_eq!(rejected["ok"], false);
    assert!(state.broker_targets().await.is_empty());
    assert!(relay.read().await.pending_claim_challenges.is_empty());

    let proof = STANDARD.encode(
        key.sign(
            super::super::device_claim_init_proof_message(
                "signed-init",
                "phone-1",
                "surface-phone",
            )
            .as_bytes(),
        )
        .to_bytes(),
    );
    let wrong_peer_init = device_proof_test_action(
        &state,
        "surface-attacker",
        "signed-init",
        serde_json::json!({"type":"claim_challenge", "proof":proof}),
        None,
    )
    .await;
    assert_eq!(wrong_peer_init["ok"], false);
    assert!(state.broker_targets().await.is_empty());
    assert!(relay.read().await.pending_claim_challenges.is_empty());

    let challenge = device_proof_test_action(
        &state,
        "surface-phone",
        "signed-init",
        serde_json::json!({"type":"claim_challenge", "proof":proof}),
        None,
    )
    .await;
    assert_eq!(challenge["ok"], true);
    let challenge_id = challenge["claim_challenge_id"].as_str().unwrap();
    let nonce = challenge["claim_challenge"].as_str().unwrap();
    let invalid = device_proof_test_action(
        &state,
        "surface-phone",
        "forged-completion",
        serde_json::json!({"type":"claim_device", "challenge_id":challenge_id,
            "challenge":nonce, "proof":STANDARD.encode([0; 64])}),
        None,
    )
    .await;
    assert_eq!(invalid["ok"], false);
    assert!(invalid["error"]
        .as_str()
        .unwrap()
        .contains("device claim proof is invalid"));
    assert_no_session_material(&invalid);

    let proof = STANDARD.encode(
        key.sign(
            super::super::device_claim_proof_message(
                challenge_id,
                nonce,
                "phone-1",
                "surface-phone",
            )
            .as_bytes(),
        )
        .to_bytes(),
    );
    let wrong_peer_completion = device_proof_test_action(
        &state,
        "surface-attacker",
        "signed-completion",
        serde_json::json!({"type":"claim_device", "challenge_id":challenge_id,
            "challenge":nonce, "proof":proof}),
        None,
    )
    .await;
    assert_eq!(wrong_peer_completion["ok"], false);
    assert!(wrong_peer_completion["error"]
        .as_str()
        .unwrap()
        .contains("device claim proof is invalid"));
    assert_no_session_material(&wrong_peer_completion);

    let claimed = device_proof_test_action(
        &state,
        "surface-phone",
        "signed-completion",
        serde_json::json!({"type":"claim_device", "challenge_id":challenge_id,
            "challenge":nonce, "proof":proof}),
        None,
    )
    .await;
    assert_eq!(claimed["ok"], true);
    let token = claimed["session_claim"].as_str().unwrap().to_string();
    let read = device_proof_test_action(
        &state,
        "surface-phone",
        "authenticated-read",
        serde_json::json!({"type":"fetch_devices"}),
        Some(token.clone()),
    )
    .await;
    assert_eq!(read["ok"], true);
    assert!(read["devices"].is_object());

    let captured = signed_test_payload(
        "surface-phone",
        "captured-read",
        serde_json::json!({"type":"fetch_devices"}),
        &token,
    );
    assert!(
        deliver_as(&state, "surface-attacker", captured)
            .await
            .is_none(),
        "a request signed for one connection answers nothing on another"
    );
    assert_eq!(state.broker_targets().await.len(), 1);
}

async fn issue_claim_challenge(
    state: &AppState,
    key: &ed25519_dalek::SigningKey,
    peer_id: &str,
    action_id: &str,
) -> (String, String) {
    let proof = sign_message(
        key,
        &super::super::device_claim_init_proof_message(action_id, "phone-1", peer_id),
    );
    let challenge = device_proof_test_action(
        state,
        peer_id,
        action_id,
        serde_json::json!({"type":"claim_challenge", "proof": proof}),
        None,
    )
    .await;
    assert_eq!(challenge["ok"], true);
    (
        challenge["claim_challenge_id"]
            .as_str()
            .unwrap()
            .to_string(),
        challenge["claim_challenge"].as_str().unwrap().to_string(),
    )
}

async fn first_connection_survives_foreign_completions(
    state: &AppState,
    relay: &std::sync::Arc<tokio::sync::RwLock<crate::state::RelayState>>,
    key: &ed25519_dalek::SigningKey,
) -> (String, String, String) {
    let (challenge_id, nonce) = issue_claim_challenge(state, key, "surface-phone", "init-p").await;
    let completion = claim_device_request(key, &challenge_id, &nonce, "surface-phone");

    let invalid = device_proof_test_action(
        state,
        "surface-attacker",
        "shared-claim",
        serde_json::json!({
            "type": "claim_device",
            "challenge_id": challenge_id,
            "challenge": nonce,
            "proof": sign_message(key, "not a claim proof"),
        }),
        None,
    )
    .await;
    assert_eq!(invalid["ok"], false);
    assert!(invalid["error"]
        .as_str()
        .unwrap()
        .contains("device claim proof is invalid"));
    assert_no_session_material(&invalid);
    assert!(state
        .completed_remote_action("phone-1", "shared-claim")
        .await
        .is_none());
    assert!(state
        .completed_remote_action(
            "phone-1",
            &auth_cache_action_id("surface-attacker", "shared-claim"),
        )
        .await
        .is_none());
    assert!(relay
        .read()
        .await
        .pending_claim_challenges
        .contains_key(&challenge_id));

    let from_other_connection = device_proof_test_action(
        state,
        "surface-attacker",
        "shared-claim",
        completion.clone(),
        None,
    )
    .await;
    assert_eq!(from_other_connection["ok"], false);
    assert!(from_other_connection["error"]
        .as_str()
        .unwrap()
        .contains("device claim proof is invalid"));
    assert_no_session_material(&from_other_connection);
    assert!(state
        .completed_remote_action(
            "phone-1",
            &auth_cache_action_id("surface-phone", "shared-claim"),
        )
        .await
        .is_none());

    let claimed = device_proof_test_action(
        state,
        "surface-phone",
        "shared-claim",
        completion.clone(),
        None,
    )
    .await;
    assert_eq!(claimed["ok"], true);
    let token = claimed["session_claim"].as_str().unwrap().to_string();
    assert!(!token.is_empty());
    let cached = state
        .completed_remote_action(
            "phone-1",
            &auth_cache_action_id("surface-phone", "shared-claim"),
        )
        .await
        .expect("the completing connection keeps its own result");
    assert!(cached.ok);
    assert_eq!(cached.session_claim.as_deref(), Some(token.as_str()));
    assert!(cached.snapshot.is_none());
    assert!(state
        .completed_remote_action("phone-1", "shared-claim")
        .await
        .is_none());

    let replayed_elsewhere = device_proof_test_action(
        state,
        "surface-attacker",
        "shared-claim",
        completion.clone(),
        None,
    )
    .await;
    assert_eq!(replayed_elsewhere["ok"], false);
    assert_no_session_material(&replayed_elsewhere);
    assert!(state
        .completed_remote_action(
            "phone-1",
            &auth_cache_action_id("surface-attacker", "shared-claim"),
        )
        .await
        .is_none());

    let replayed_here =
        device_proof_test_action(state, "surface-phone", "shared-claim", completion, None).await;
    assert_eq!(replayed_here["ok"], true);
    assert_eq!(
        replayed_here["session_claim"].as_str(),
        Some(token.as_str())
    );
    assert!(replayed_here["snapshot"].is_null());
    (challenge_id, nonce, token)
}

async fn second_connection_claim_is_independent(
    state: &AppState,
    key: &ed25519_dalek::SigningKey,
    challenge_id: &str,
    nonce: &str,
    token: &str,
) -> String {
    let (challenge_id_b, nonce_b) =
        issue_claim_challenge(state, key, "surface-phone-b", "init-b").await;
    let completion_b = claim_device_request(key, &challenge_id_b, &nonce_b, "surface-phone-b");
    let claimed_b = device_proof_test_action(
        state,
        "surface-phone-b",
        "shared-claim",
        completion_b.clone(),
        None,
    )
    .await;
    assert_eq!(claimed_b["ok"], true);
    let token_b = claimed_b["session_claim"].as_str().unwrap().to_string();
    assert_ne!(token_b, token);
    let replayed_b =
        device_proof_test_action(state, "surface-phone-b", "shared-claim", completion_b, None)
            .await;
    assert_eq!(replayed_b["session_claim"].as_str(), Some(token_b.as_str()));
    let still_p = device_proof_test_action(
        state,
        "surface-phone",
        "shared-claim",
        claim_device_request(key, challenge_id, nonce, "surface-phone"),
        None,
    )
    .await;
    assert_eq!(still_p["session_claim"].as_str(), Some(token));
    token_b
}

async fn signed_nonce_mismatch_does_not_cross_connections(
    state: &AppState,
    relay: &std::sync::Arc<tokio::sync::RwLock<crate::state::RelayState>>,
    key: &ed25519_dalek::SigningKey,
    token: &str,
    token_b: &str,
) {
    let (mismatch_id, mismatch_nonce) =
        issue_claim_challenge(state, key, "surface-phone", "init-p-mismatch").await;
    let wrong_nonce = device_proof_test_action(
        state,
        "surface-phone",
        "wrong-nonce",
        claim_device_request(key, &mismatch_id, "not-the-issued-nonce", "surface-phone"),
        None,
    )
    .await;
    assert_eq!(wrong_nonce["ok"], false);
    assert!(wrong_nonce["error"]
        .as_str()
        .unwrap()
        .contains("does not match the issued challenge"));
    assert_no_session_material(&wrong_nonce);
    let cached_mismatch = state
        .completed_remote_action(
            "phone-1",
            &auth_cache_action_id("surface-phone", "wrong-nonce"),
        )
        .await
        .expect("a signed nonce mismatch is cached for that connection");
    assert!(!cached_mismatch.ok);
    assert!(cached_mismatch.snapshot.is_none());
    assert!(cached_mismatch.session_claim.is_none());
    assert!(relay
        .read()
        .await
        .pending_claim_challenges
        .contains_key(&mismatch_id));

    let (other_id, other_nonce) =
        issue_claim_challenge(state, key, "surface-phone-b", "init-b-again").await;
    let other_connection_same_id = device_proof_test_action(
        state,
        "surface-phone-b",
        "wrong-nonce",
        claim_device_request(key, &other_id, &other_nonce, "surface-phone-b"),
        None,
    )
    .await;
    assert_eq!(other_connection_same_id["ok"], true);
    let token_other = other_connection_same_id["session_claim"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(token_other, token);
    let cached_b = state
        .completed_remote_action(
            "phone-1",
            &auth_cache_action_id("surface-phone-b", "shared-claim"),
        )
        .await
        .expect("the other connection keeps the claim it already finished");
    assert_eq!(cached_b.session_claim.as_deref(), Some(token_b));
    let still_failed = state
        .completed_remote_action(
            "phone-1",
            &auth_cache_action_id("surface-phone", "wrong-nonce"),
        )
        .await
        .expect("the nonce mismatch stays on the connection that signed it");
    assert!(!still_failed.ok);
    assert!(still_failed.session_claim.is_none());
    assert!(still_failed.snapshot.is_none());

    let recovered = device_proof_test_action(
        state,
        "surface-phone",
        "recovered-claim",
        claim_device_request(key, &mismatch_id, &mismatch_nonce, "surface-phone"),
        None,
    )
    .await;
    assert_eq!(recovered["ok"], true);
    assert!(recovered["session_claim"].is_string());
    assert_ne!(
        recovered["session_claim"].as_str(),
        Some(token_other.as_str())
    );
    assert!(!relay
        .read()
        .await
        .pending_claim_challenges
        .contains_key(&mismatch_id));
    let recovered_cached = state
        .completed_remote_action(
            "phone-1",
            &auth_cache_action_id("surface-phone", "recovered-claim"),
        )
        .await
        .expect("the corrected completion is cached under its own id");
    assert!(recovered_cached.ok);
    assert!(recovered_cached.snapshot.is_none());
    let mismatch_after = state
        .completed_remote_action(
            "phone-1",
            &auth_cache_action_id("surface-phone", "wrong-nonce"),
        )
        .await
        .expect("correcting a later action id leaves the mismatch cached");
    assert!(!mismatch_after.ok);
    assert!(mismatch_after.session_claim.is_none());
}

#[tokio::test]
async fn claim_completion_is_checked_before_cache_and_isolated_per_connection() {
    let (state, relay, key) = device_proof_test_state().await;
    relay
        .write()
        .await
        .mark_surface_peer_online("surface-phone-b");
    let (challenge_id, nonce, token) = Box::pin(first_connection_survives_foreign_completions(
        &state, &relay, &key,
    ))
    .await;
    let token_b = Box::pin(second_connection_claim_is_independent(
        &state,
        &key,
        &challenge_id,
        &nonce,
        &token,
    ))
    .await;
    Box::pin(signed_nonce_mismatch_does_not_cross_connections(
        &state, &relay, &key, &token, &token_b,
    ))
    .await;
}

#[tokio::test]
async fn broker_presence_cannot_authenticate_a_device_and_rejoins_drop_its_binding() {
    let (state, relay, _) = device_proof_test_state().await;
    let (writer, _replies, _trains) = super::super::writer::test_writer();
    super::super::handle_server_message(
        &state,
        &writer,
        test_origin(),
        super::super::ServerMessage::Presence {
            channel_id: "room".to_string(),
            kind: super::super::PresenceKind::Joined,
            peer: relay_broker::protocol::PeerSummary {
                peer_id: "surface-attacker".to_string(),
                role: super::super::PeerRole::Surface,
                device_id: Some("phone-1".to_string()),
            },
        },
    )
    .await
    .unwrap();
    assert!(state.broker_targets().await.is_empty());
    relay
        .write()
        .await
        .bind_surface_peer_to_device("phone-1", "surface-phone");
    assert_eq!(state.broker_targets().await.len(), 1);
    relay
        .write()
        .await
        .mark_surface_peer_online("surface-phone");
    assert!(state.broker_targets().await.is_empty());
    relay
        .write()
        .await
        .bind_surface_peer_to_device("phone-1", "surface-phone");
    state
        .replace_online_surface_peers(["surface-phone".to_string()])
        .await;
    assert!(state.broker_targets().await.is_empty());
}
use crate::protocol::{
    AskUserOptionView, AskUserQuestionDetailResponse, AskUserQuestionRequestView,
    AskUserQuestionView, SecurityMode, ThreadSummaryView, ThreadTranscriptResponse,
    ThreadsResponse, TranscriptEntryKind, TranscriptEntryView,
};

fn make_snapshot() -> SessionSnapshot {
    SessionSnapshot {
        transcript_generation: String::new(),
        provider_fork_capabilities: Vec::new(),
        relay_resolves_fork_points: true,
        provider_archive_capabilities: Vec::new(),
        provider_status: Vec::new(),
        revision: 7,
        transcript_revision: 3,
        server_time: 11,
        provider: "codex".to_string(),
        service_ready: true,
        provider_connected: true,
        broker_connected: true,
        broker_channel_id: Some("room".to_string()),
        broker_peer_id: Some("relay".to_string()),
        security_mode: SecurityMode::Private,
        e2ee_enabled: true,
        broker_can_read_content: false,
        audit_enabled: false,
        beta_features_enabled: false,
        active_thread_id: Some("thread-1".to_string()),
        active_thread_task_reviewer: false,
        active_controller_device_id: Some("device-1".to_string()),
        active_controller_last_seen_at: Some(1),
        controller_lease_expires_at: Some(2),
        controller_lease_seconds: 15,
        active_turn_id: Some("turn-1".to_string()),
        current_status: "idle".to_string(),
        current_phase: None,
        current_tool: None,
        last_progress_at: None,
        active_flags: vec![],
        thread_activity: vec![],
        current_cwd: "/tmp/project".to_string(),
        thread_workspace_cwd: None,
        workspace_missing: None,
        model: "gpt-5.4".to_string(),
        available_models: vec![],
        approval_policy: "untrusted".to_string(),
        sandbox: "workspace-write".to_string(),
        reasoning_effort: "medium".to_string(),
        allowed_roots: vec![],
        device_records: vec![],
        paired_devices: vec![],
        pending_pairing_requests: vec![],
        devices_revision: 0,
        pending_approvals: vec![],
        pending_ask_user_questions: vec![],
        transcript_truncated: false,
        transcript: (0..12)
            .map(|index| TranscriptEntryView {
                row_id: None,
                order_seq: None,
                withdrawn: false,
                item_id: Some(format!("item-{index}")),
                kind: TranscriptEntryKind::AgentText,
                text: Some("x".repeat(2_000)),
                status: "completed".to_string(),
                turn_id: Some(format!("turn-{index}")),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
                injection: None,
            })
            .collect(),
        logs: vec![],
        active_review_jobs: vec![],
        reviewer_threads: vec![],
        review_activity: vec![],
        review_activity_total: 0,
        review_blocked: false,
        reviews_revision: 0,
        active_workflow_runs: vec![],
        workflow_activity: vec![],
        workflows_revision: 0,
        push_vapid_public_key: None,
        projects_revision: 0,
        threads_revision: 0,
        thread_workspaces_revision: 0,
        teams_revision: 0,
        orchestrator_thread_id: None,
        orchestrator_proposals_revision: 0,
    }
}

fn make_threads() -> ThreadsResponse {
    ThreadsResponse {
        threads: (0..16)
            .map(|index| ThreadSummaryView {
                workspace_trusted: false,
                id: format!("thread-{index}"),
                name: Some(format!("Thread {index}")),
                preview: "x".repeat(2_000),
                cwd: "/tmp/project".to_string(),
                updated_at: index as u64,
                source: "local".to_string(),
                status: "idle".to_string(),
                model_provider: "openai".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
                renamed: false,
                flagged: false,
            })
            .collect(),
        unavailable_providers: Vec::new(),
    }
}

#[test]
fn cached_remote_action_result_keeps_canonical_snapshot_for_session_lifecycle() {
    let snapshot = make_snapshot();

    for action in [
        RemoteActionKind::StartSession,
        RemoteActionKind::ForkSession,
    ] {
        let cached = cached_remote_action_result(
            action,
            snapshot.clone(),
            RemoteActionOutcome::default(),
            None,
            true,
            None,
        );
        let cached_snapshot = cached.snapshot.expect("allowed snapshot");

        assert_eq!(cached_snapshot.transcript.len(), snapshot.transcript.len());
        assert_eq!(
            cached_snapshot.transcript_truncated,
            snapshot.transcript_truncated
        );
    }
}

#[test]
fn cached_remote_action_result_omits_snapshot_for_non_session_lifecycle_actions() {
    let cached = cached_remote_action_result(
        RemoteActionKind::Heartbeat,
        make_snapshot(),
        RemoteActionOutcome::default(),
        None,
        true,
        None,
    );

    assert!(cached.snapshot.is_none());
}

#[test]
fn high_frequency_remote_actions_do_not_emit_info_logs() {
    assert!(!remote_action_emits_info_log(RemoteActionKind::Heartbeat));
    assert!(!remote_action_emits_info_log(RemoteActionKind::ListThreads));
    assert!(!remote_action_emits_info_log(
        RemoteActionKind::FetchThreadEntryDetail
    ));
    assert!(!remote_action_emits_info_log(
        RemoteActionKind::FetchThreadTranscript
    ));

    assert!(remote_action_emits_info_log(RemoteActionKind::StartSession));
    assert!(remote_action_emits_info_log(RemoteActionKind::ForkSession));
    assert!(remote_action_emits_info_log(RemoteActionKind::SendMessage));
    assert!(remote_action_emits_info_log(
        RemoteActionKind::DecideApproval
    ));
}

#[test]
fn fork_session_action_round_trips_and_binds_the_device() {
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fork_session",
        "input": {
            "source_thread_id": "thread-source",
            "provider": "claude_code",
            "initial_prompt": "continue here"
        }
    }))
    .expect("fork_session should parse");
    assert_eq!(request.kind(), RemoteActionKind::ForkSession);
    assert_eq!(RemoteActionKind::ForkSession.as_str(), "fork_session");

    match request.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::ForkSession { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-9"));
            assert_eq!(input.source_thread_id, "thread-source");
            assert_eq!(input.provider.as_deref(), Some("claude_code"));
            assert_eq!(input.initial_prompt.as_deref(), Some("continue here"));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::ForkSession),
        RemoteActionResultKind::RemoteSessionResult
    ));
    assert!(requires_signed_attempt(RemoteActionKind::ForkSession));
}

#[test]
fn fetch_workspace_git_context_round_trips_and_binds_the_requesting_device() {
    // The stamp is load-bearing, not bookkeeping: the path scope is resolved from
    // the device id, and the cwd here is caller-supplied.
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_workspace_git_context",
        "cwd": "/repo/checkout"
    }))
    .expect("fetch_workspace_git_context should parse");
    assert_eq!(request.kind(), RemoteActionKind::FetchWorkspaceGitContext);
    assert_eq!(
        RemoteActionKind::FetchWorkspaceGitContext.as_str(),
        "fetch_workspace_git_context"
    );

    match request.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::FetchWorkspaceGitContext { device_id, cwd } => {
            assert_eq!(device_id.as_deref(), Some("device-9"));
            assert_eq!(
                cwd.as_deref(),
                Some("/repo/checkout"),
                "bind_device must preserve the path being asked about"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }
}

#[test]
fn fetch_workspace_git_context_is_read_only_and_requires_device_authentication() {
    // A paired device must see what it is about to launch into without taking
    // control of whatever session happens to be running.
    assert!(
        requires_signed_attempt(RemoteActionKind::FetchWorkspaceGitContext),
        "reading a workspace's git standing must not require taking over a session"
    );
}

#[test]
fn fetch_workspace_diff_round_trips_and_bind_device_preserves_thread_id() {
    // bind_device must keep thread_id. Extra `root`/`auto_root` fields parse and are ignored.
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_workspace_diff",
        "thread_id": "thread-viewed",
        "root": "/repo/linked",
        "auto_root": true
    }))
    .expect("fetch_workspace_diff should parse");
    assert_eq!(request.kind(), RemoteActionKind::FetchWorkspaceDiff);
    assert_eq!(
        RemoteActionKind::FetchWorkspaceDiff.as_str(),
        "fetch_workspace_diff"
    );

    match request.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::FetchWorkspaceDiff {
            device_id,
            thread_id,
            view_root,
        } => {
            assert_eq!(device_id.as_deref(), Some("device-9"));
            assert_eq!(
                thread_id.as_deref(),
                Some("thread-viewed"),
                "bind_device must preserve the viewed thread_id, not drop it"
            );
            assert_eq!(view_root, None);
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // Legacy client that omits thread_id still parses (serde default) and binds.
    let legacy: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_workspace_diff"
    }))
    .expect("legacy fetch_workspace_diff should parse");
    match legacy.bind_device("device-1".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::FetchWorkspaceDiff {
            device_id,
            thread_id,
            view_root,
        } => {
            assert_eq!(device_id.as_deref(), Some("device-1"));
            assert_eq!(thread_id, None);
            assert_eq!(view_root, None);
        }
        other => panic!("unexpected variant: {other:?}"),
    }
}

// Device authentication does not take the controller lease.
#[test]
fn thread_workspace_actions_round_trip_and_require_device_authentication() {
    let fetch: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_thread_workspace",
        "thread_id": "thread-viewed"
    }))
    .expect("fetch_thread_workspace should parse");
    assert_eq!(fetch.kind(), RemoteActionKind::FetchThreadWorkspace);
    assert_eq!(
        RemoteActionKind::FetchThreadWorkspace.as_str(),
        "fetch_thread_workspace"
    );
    match fetch.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::FetchThreadWorkspace {
            device_id,
            thread_id,
            roots_status,
        } => {
            assert_eq!(device_id.as_deref(), Some("device-9"));
            assert_eq!(thread_id, "thread-viewed");
            assert!(
                !roots_status,
                "a client that does not ask must not be charged a git status per worktree"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // `bind_device` rebuilds the variant field by field, so a forgotten one is dropped
    // silently — here, downgrading the open picker's request to an unmeasured one.
    let measured: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_thread_workspace",
        "thread_id": "thread-viewed",
        "roots_status": true
    }))
    .expect("fetch_thread_workspace should parse with roots_status");
    match measured.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::FetchThreadWorkspace { roots_status, .. } => {
            assert!(
                roots_status,
                "the picker's request must survive device binding"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // The pin's payload is flattened, so `thread_id`/`cwd` sit next to `type`.
    let pin: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "set_thread_workspace",
        "thread_id": "thread-viewed",
        "cwd": "/repo/linked",
        // Client-supplied device_id must not win over bind_device.
        "device_id": "device-someone-else"
    }))
    .expect("set_thread_workspace should parse");
    assert_eq!(pin.kind(), RemoteActionKind::SetThreadWorkspace);
    match pin.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::SetThreadWorkspace { device_id, input } => {
            assert_eq!(device_id.as_deref(), Some("device-9"));
            assert_eq!(input.thread_id, "thread-viewed");
            assert_eq!(input.cwd.as_deref(), Some("/repo/linked"));
            assert_eq!(
                input.device_id.as_deref(),
                Some("device-9"),
                "the INNER device_id is what pin_thread_workspace scopes on, so \
bind_device must overwrite the client's"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // An absent `cwd` is the un-pin, not a malformed request.
    let unpin: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "set_thread_workspace",
        "thread_id": "thread-viewed"
    }))
    .expect("an un-pin carries no cwd");
    match unpin {
        RemoteActionRequest::SetThreadWorkspace { input, .. } => assert_eq!(input.cwd, None),
        other => panic!("unexpected request: {other:?}"),
    }

    for action in [
        RemoteActionKind::FetchThreadWorkspace,
        RemoteActionKind::SetThreadWorkspace,
    ] {
        assert!(
            requires_signed_attempt(action),
            "{} must not require a session claim",
            action.as_str()
        );
    }
}

#[test]
fn project_action_round_trips_and_binds_authenticated_device() {
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "project_action",
        "input": { "action": "assign", "thread_id": "t1", "project_id": "proj_x" }
    }))
    .expect("project_action should parse");
    assert_eq!(request.kind(), RemoteActionKind::ProjectAction);
    assert_eq!(RemoteActionKind::ProjectAction.as_str(), "project_action");

    match request.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::ProjectAction { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-9"));
            assert_eq!(
                input.action,
                crate::protocol::ProjectAction::Assign {
                    thread_id: "t1".to_string(),
                    project_id: "proj_x".to_string(),
                }
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    assert!(requires_signed_attempt(RemoteActionKind::ProjectAction));
}

#[test]
fn push_subscription_actions_round_trip_and_require_device_authentication() {
    let reg: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "register_push_subscription",
        "input": { "endpoint": "https://push/x", "keys": { "p256dh": "p", "auth": "a" } }
    }))
    .unwrap();
    assert_eq!(reg.kind(), RemoteActionKind::RegisterPushSubscription);
    // device_id is injected server-side by bind_device, never trusted from the wire.
    match reg.bind_device("device-1".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::RegisterPushSubscription { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-1"));
            assert_eq!(input.endpoint, "https://push/x");
        }
        other => panic!("unexpected variant: {other:?}"),
    }

    let unreg: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "unregister_push_subscription",
        "endpoint": "https://push/x"
    }))
    .unwrap();
    assert_eq!(unreg.kind(), RemoteActionKind::UnregisterPushSubscription);
    match unreg.bind_device("device-1".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::UnregisterPushSubscription {
            device_id,
            endpoint,
        } => {
            assert_eq!(device_id.as_deref(), Some("device-1"));
            assert_eq!(endpoint, "https://push/x");
        }
        other => panic!("unexpected variant: {other:?}"),
    }

    for kind in [
        RemoteActionKind::RegisterPushSubscription,
        RemoteActionKind::UnregisterPushSubscription,
    ] {
        assert!(
            requires_signed_attempt(kind),
            "{kind:?} must not require a session claim"
        );
    }
}

#[test]
fn cached_remote_action_result_keeps_canonical_threads() {
    let threads = make_threads();

    let cached = cached_remote_action_result(
        RemoteActionKind::ListThreads,
        make_snapshot(),
        RemoteActionOutcome {
            threads: Some(threads.clone()),
            ..RemoteActionOutcome::default()
        },
        None,
        true,
        None,
    );

    let cached_threads = cached.threads.expect("cached threads");
    assert_eq!(cached_threads.threads.len(), threads.threads.len());
    assert_eq!(
        cached_threads.threads[0].preview,
        threads.threads[0].preview
    );
}

#[test]
fn remote_action_result_size_breakdown_reports_large_thread_transcript_payloads() {
    let thread_transcript = ThreadTranscriptResponse {
        transcript_generation: String::new(),
        thread_id: "thread-1".to_string(),
        revision: 9,
        server_time: 12,
        entries: vec![TranscriptEntryView {
            row_id: None,
            order_seq: None,
            withdrawn: false,
            item_id: Some("item-large".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some("transcript".repeat(3_000)),
            status: "completed".to_string(),
            turn_id: Some("turn-large".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
            injection: None,
        }],
        prev_cursor: Some(crate::protocol::TranscriptCursorToken::new(
            "tc1.test.1".to_string(),
        )),
        thread_state: None,
        missing_rows: Vec::new(),
        deferred_rows: Vec::new(),
    };
    let breakdown = measure_remote_action_result_sizes(
        RemoteActionKind::FetchThreadTranscript,
        true,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(&thread_transcript),
        // workspace_diff
        None,
        // workspace_git_context
        None,
        // thread_workspace
        None,
        // thread_settings
        None,
        // thread_skills
        None,
        // reviews
        None,
        // workflows
        None,
        // devices
        None,
        // projects
        None,
        // ask_user_question_detail
        None,
        // ask_detail
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        // error_code
        None,
    );

    assert_eq!(breakdown.snapshot_bytes, 0);
    assert!(breakdown.thread_transcript_bytes > breakdown.snapshot_bytes);
    assert!(breakdown.plaintext_bytes >= breakdown.thread_transcript_bytes);
}

fn make_large_thread_transcript_plaintext() -> RemoteActionResultPlaintext {
    RemoteActionResultPlaintext {
        kind: RemoteActionResultKind::RemoteTranscriptResult,
        action: RemoteActionKind::FetchThreadTranscript,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entry_detail: None,
        thread_transcript: Some(ThreadTranscriptResponse {
            transcript_generation: String::new(),
            thread_id: "thread-1".to_string(),
            revision: 9,
            server_time: 12,
            entries: vec![TranscriptEntryView {
                row_id: None,
                order_seq: None,
                withdrawn: false,
                item_id: Some("item-large".to_string()),
                kind: TranscriptEntryKind::AgentText,
                text: Some("transcript".repeat(12_000)),
                status: "completed".to_string(),
                turn_id: Some("turn-large".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
                injection: None,
            }],
            prev_cursor: Some(crate::protocol::TranscriptCursorToken::new(
                "tc1.test.1".to_string(),
            )),
            thread_state: None,
            missing_rows: Vec::new(),
            deferred_rows: Vec::new(),
        }),
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        thread_skills: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        ask_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        session_claim_boot: None,
        session_claim_relay_ms: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
        error_code: None,
    }
}

fn make_large_ask_user_detail_plaintext() -> RemoteActionResultPlaintext {
    RemoteActionResultPlaintext {
        kind: RemoteActionResultKind::RemoteTranscriptResult,
        action: RemoteActionKind::FetchAskUserQuestionDetail,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        thread_skills: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: Some(AskUserQuestionDetailResponse {
            request: AskUserQuestionRequestView::with_inline_questions(
                "ask:large".to_string(),
                "toolu_large".to_string(),
                "thread-1".to_string(),
                123,
                vec![AskUserQuestionView {
                    question: "Which large option should be sent back to Claude? ".repeat(800),
                    header: "Large question".to_string(),
                    multi_select: false,
                    options: vec![
                        AskUserOptionView {
                            label: "Option A".to_string(),
                            description: "Detailed option A. ".repeat(1_500),
                        },
                        AskUserOptionView {
                            label: "Option B".to_string(),
                            description: "Detailed option B. ".repeat(1_500),
                        },
                    ],
                }],
            ),
        }),
        ask_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        session_claim_boot: None,
        session_claim_relay_ms: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
        error_code: None,
    }
}

#[test]
fn request_review_action_round_trips_and_binds_device() {
    let json = serde_json::json!({
        "type": "request_review",
        "input": {
            "reviewer_provider": "codex",
            "instructions": "look at the tests",
            // The remote surface sends the VIEWED thread as the review parent; it must
            // survive deserialization + device binding so the relay reviews that thread.
            "parent_thread_id": "thread-viewed",
        }
    });
    let request: RemoteActionRequest =
        serde_json::from_value(json).expect("request_review should parse");
    assert_eq!(request.kind(), RemoteActionKind::RequestReview);
    assert_eq!(RemoteActionKind::RequestReview.as_str(), "request_review");

    // Re-serializing keeps the snake_case tag.
    let serialized = serde_json::to_value(&request).expect("serialize request_review");
    assert_eq!(serialized["type"], "request_review");
    assert_eq!(serialized["input"]["reviewer_provider"], "codex");
    assert_eq!(serialized["input"]["parent_thread_id"], "thread-viewed");

    // bind_device stamps the requesting device onto the input WITHOUT dropping parent.
    match request.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::RequestReview { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-9"));
            assert_eq!(input.reviewer_provider, "codex");
            assert_eq!(input.instructions.as_deref(), Some("look at the tests"));
            assert_eq!(input.parent_thread_id.as_deref(), Some("thread-viewed"));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // It is an ack-style action gated behind a session claim.
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::RequestReview),
        RemoteActionResultKind::RemoteActionAck
    ));
    assert!(requires_signed_attempt(RemoteActionKind::RequestReview));
}

#[test]
fn start_workflow_action_round_trips_and_binds_device() {
    let json = serde_json::json!({
        "type": "start_workflow",
        "input": {
            "workflow_id": "code_flow",
            "task_prompt": "implement the cache fix",
            "reviewer_provider": "codex",
            "reviewer_model": "gpt-5.5",
            "reviewer_instructions": "focus on tests",
            "max_rounds": 3,
        }
    });
    let request: RemoteActionRequest =
        serde_json::from_value(json).expect("start_workflow should parse");
    assert_eq!(request.kind(), RemoteActionKind::StartWorkflow);
    assert_eq!(RemoteActionKind::StartWorkflow.as_str(), "start_workflow");

    let serialized = serde_json::to_value(&request).expect("serialize start_workflow");
    assert_eq!(serialized["type"], "start_workflow");
    assert_eq!(serialized["input"]["workflow_id"], "code_flow");
    assert_eq!(serialized["input"]["reviewer_provider"], "codex");

    match request.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::StartWorkflow { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-9"));
            assert_eq!(input.task_prompt, "implement the cache fix");
            assert_eq!(input.reviewer_provider, "codex");
            assert_eq!(input.max_rounds, Some(3));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::StartWorkflow),
        RemoteActionResultKind::RemoteActionAck
    ));
    assert!(requires_signed_attempt(RemoteActionKind::StartWorkflow));
}

#[test]
fn fetch_reviews_action_round_trips_and_requires_device_authentication() {
    let request: RemoteActionRequest =
        serde_json::from_value(serde_json::json!({ "type": "fetch_reviews" }))
            .expect("fetch_reviews should parse");
    assert_eq!(request.kind(), RemoteActionKind::FetchReviews);
    assert_eq!(RemoteActionKind::FetchReviews.as_str(), "fetch_reviews");
    assert!(
        requires_signed_attempt(RemoteActionKind::FetchReviews),
        "listing reviews requires device authentication, without taking control"
    );
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::FetchReviews),
        RemoteActionResultKind::RemoteTranscriptResult
    ));
    match request.bind_device("device-7".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::FetchReviews { device_id } => {
            assert_eq!(device_id.as_deref(), Some("device-7"));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }
}

#[test]
fn fetch_ask_action_round_trips_and_requires_device_authentication() {
    // Agents card hover: same read-only data channel shape as fetch_reviews.
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_ask",
        "ask_id": "ask-9"
    }))
    .expect("fetch_ask should parse");
    assert_eq!(request.kind(), RemoteActionKind::FetchAsk);
    assert_eq!(RemoteActionKind::FetchAsk.as_str(), "fetch_ask");
    assert!(
        requires_signed_attempt(RemoteActionKind::FetchAsk),
        "ask detail requires device authentication, without taking control"
    );
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::FetchAsk),
        RemoteActionResultKind::RemoteTranscriptResult
    ));
    match request.bind_device("device-7".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::FetchAsk { ask_id, device_id } => {
            assert_eq!(ask_id, "ask-9");
            assert_eq!(device_id.as_deref(), Some("device-7"));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }
}

#[test]
fn dedicated_workflows_and_devices_actions_are_read_only_data_fetches() {
    for (wire_type, expected_kind) in [
        ("fetch_workflows", RemoteActionKind::FetchWorkflows),
        ("fetch_devices", RemoteActionKind::FetchDevices),
    ] {
        let request: RemoteActionRequest =
            serde_json::from_value(serde_json::json!({ "type": wire_type }))
                .expect("dedicated fetch should parse");
        assert_eq!(request.kind(), expected_kind);
        assert!(requires_signed_attempt(expected_kind));
        assert_eq!(
            remote_action_result_kind(expected_kind),
            RemoteActionResultKind::RemoteTranscriptResult
        );
        match (
            expected_kind,
            request.bind_device("device-12".to_string(), "surface-test", test_origin()),
        ) {
            (
                RemoteActionKind::FetchWorkflows,
                RemoteActionRequest::FetchWorkflows { device_id },
            )
            | (RemoteActionKind::FetchDevices, RemoteActionRequest::FetchDevices { device_id }) => {
                assert_eq!(device_id.as_deref(), Some("device-12"))
            }
            (_, other) => panic!("unexpected bound request: {other:?}"),
        }
    }
}

#[test]
fn fetch_projects_action_round_trips_and_requires_device_authentication() {
    // The dedicated Projects read channel for remote (mirrors fetch_reviews): read-only,
    // parses from `{}`, binds the device, requires device authentication, and routes to the data
    // (transcript-result) kind so its `projects` payload reaches the device.
    let request: RemoteActionRequest =
        serde_json::from_value(serde_json::json!({ "type": "fetch_projects" }))
            .expect("fetch_projects should parse");
    assert_eq!(request.kind(), RemoteActionKind::FetchProjects);
    assert_eq!(RemoteActionKind::FetchProjects.as_str(), "fetch_projects");
    assert!(
        requires_signed_attempt(RemoteActionKind::FetchProjects),
        "listing projects requires device authentication, without taking control"
    );
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::FetchProjects),
        RemoteActionResultKind::RemoteTranscriptResult
    ));
    match request.bind_device("device-11".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::FetchProjects { device_id } => {
            assert_eq!(device_id.as_deref(), Some("device-11"));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }
}

#[test]
fn resolve_and_delete_review_actions_round_trip_and_bind_device() {
    // resolve_review
    let resolve: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "resolve_review",
        "review_job_id": "review-9"
    }))
    .expect("resolve_review should parse");
    assert_eq!(resolve.kind(), RemoteActionKind::ResolveReview);
    assert_eq!(RemoteActionKind::ResolveReview.as_str(), "resolve_review");
    match resolve.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::ResolveReview {
            review_job_id,
            device_id,
        } => {
            assert_eq!(review_job_id.as_deref(), Some("review-9"));
            assert_eq!(device_id.as_deref(), Some("device-9"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    // resolve_workflow
    let resolve_workflow: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "resolve_workflow",
        "workflow_run_id": "workflow-9"
    }))
    .expect("resolve_workflow should parse");
    assert_eq!(resolve_workflow.kind(), RemoteActionKind::ResolveWorkflow);
    assert_eq!(
        RemoteActionKind::ResolveWorkflow.as_str(),
        "resolve_workflow"
    );
    match resolve_workflow.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::ResolveWorkflow {
            workflow_run_id,
            device_id,
        } => {
            assert_eq!(workflow_run_id.as_deref(), Some("workflow-9"));
            assert_eq!(device_id.as_deref(), Some("device-9"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    // delete_review
    let delete: RemoteActionRequest = serde_json::from_value(
        serde_json::json!({ "type": "delete_review", "review_id": "review-1" }),
    )
    .expect("delete_review should parse");
    assert_eq!(delete.kind(), RemoteActionKind::DeleteReview);
    assert_eq!(RemoteActionKind::DeleteReview.as_str(), "delete_review");
    match delete.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::DeleteReview {
            review_id,
            device_id,
        } => {
            assert_eq!(review_id, "review-1");
            assert_eq!(device_id.as_deref(), Some("device-9"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    let accept: RemoteActionRequest = serde_json::from_value(
        serde_json::json!({ "type": "accept_review", "review_id": "review-1" }),
    )
    .expect("accept_review should parse");
    assert_eq!(accept.kind(), RemoteActionKind::AcceptReview);
    assert_eq!(RemoteActionKind::AcceptReview.as_str(), "accept_review");
    match accept.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::AcceptReview {
            review_id,
            device_id,
        } => {
            assert_eq!(review_id, "review-1");
            assert_eq!(device_id.as_deref(), Some("device-9"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    // All are ack-style and gated behind a session claim.
    for kind in [
        RemoteActionKind::ResolveReview,
        RemoteActionKind::ResolveWorkflow,
        RemoteActionKind::DeleteReview,
        RemoteActionKind::AcceptReview,
    ] {
        assert!(matches!(
            remote_action_result_kind(kind),
            RemoteActionResultKind::RemoteActionAck
        ));
        assert!(requires_signed_attempt(kind));
    }
}

#[test]
fn encrypted_remote_action_result_chunk_payloads_fit_within_broker_limit() {
    let plaintext = make_large_thread_transcript_plaintext();
    let payloads = build_encrypted_remote_action_result_chunk_payloads(
        "action-1",
        "surface-1",
        "device-1",
        "payload-secret",
        &plaintext,
    )
    .expect("encrypted chunk payloads");

    assert!(payloads.len() > 1);
    assert!(payloads
        .iter()
        .all(|payload| frame_bytes_for_payload(payload) <= MAX_BROKER_TEXT_FRAME_BYTES));
}

#[test]
fn large_ask_user_detail_result_chunks_fit_within_broker_limit() {
    let plaintext = make_large_ask_user_detail_plaintext();
    let encrypted_payloads = build_encrypted_remote_action_result_chunk_payloads(
        "action-1",
        "surface-1",
        "device-1",
        "payload-secret",
        &plaintext,
    )
    .expect("encrypted ask-user detail chunks");

    assert!(encrypted_payloads.len() > 1);
    assert!(encrypted_payloads
        .iter()
        .all(|payload| frame_bytes_for_payload(payload) <= MAX_BROKER_TEXT_FRAME_BYTES));
}

#[test]
fn encrypted_fetch_reviews_result_carries_the_reviews_payload_to_the_device() {
    let reviews = crate::protocol::ReviewsResponse {
        handovers: Vec::new(),
        handover_links: Vec::new(),
        asks: Vec::new(),
        goals: Vec::new(),
        reviews_revision: 99,
        review_jobs: Vec::new(),
        reviewer_threads: vec![crate::protocol::ReviewerThreadView {
            reviewer_thread_id: "reviewer-1".to_string(),
            parent_thread_id: "parent-1".to_string(),
            reviewer_provider: Some("codex".to_string()),
            name: Some("reviewer one".to_string()),
            updated_at: Some(5),
            cwd: None,
            model: None,
            reasoning_effort: None,
        }],
    };
    let result = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(RemoteActionKind::FetchReviews),
        action: RemoteActionKind::FetchReviews,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        thread_skills: None,
        reviews: Some(reviews),
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        ask_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        session_claim_boot: None,
        session_claim_relay_ms: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
        error_code: None,
    };

    let payload = sealed_result_value(&result).expect("reviews payload");
    let json = serde_json::to_value(&payload).expect("serialize reviews payload");
    let carried = json
        .get("reviews")
        .unwrap_or(&serde_json::Value::Null)
        .clone();
    assert!(
        !carried.is_null(),
        "the encrypted fetch_reviews envelope must carry `reviews` to the device; got: {json}"
    );
    assert_eq!(
        carried["reviewer_threads"][0]["reviewer_thread_id"], "reviewer-1",
        "the device needs the reviewer threads to populate the reuse picker"
    );
}

#[test]
fn encrypted_fetch_ask_result_carries_the_ask_detail_payload_to_the_device() {
    let ask_detail = crate::protocol::AskDetailResponse {
        id: "ask-1".to_string(),
        asker_thread_id: "asker".to_string(),
        peer_thread_id: "peer".to_string(),
        peer_provider: "codex".to_string(),
        asker_provider: None,
        peer_model: None,
        peer_effort: None,
        message: "full prompt with context".to_string(),
        answer: Some("full answer".to_string()),
        status: "done".to_string(),
        error: None,
        delivered: true,
        updated_at: 9,
    };
    let result = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(RemoteActionKind::FetchAsk),
        action: RemoteActionKind::FetchAsk,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        thread_skills: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        ask_detail: Some(ask_detail),
        session_claim: None,
        session_claim_expires_at: None,
        session_claim_boot: None,
        session_claim_relay_ms: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
        error_code: None,
    };

    let payload = sealed_result_value(&result).expect("ask detail payload");
    let json = serde_json::to_value(&payload).expect("serialize ask detail payload");
    let carried = json
        .get("ask_detail")
        .unwrap_or(&serde_json::Value::Null)
        .clone();
    assert!(
        !carried.is_null(),
        "the encrypted fetch_ask envelope must carry `ask_detail` to the device; got: {json}"
    );
    assert_eq!(carried["id"], "ask-1");
    assert_eq!(carried["message"], "full prompt with context");
    assert_eq!(carried["answer"], "full answer");
}

#[test]
fn encrypted_dedicated_workflows_and_devices_payloads_reach_the_device() {
    let result = RemoteActionResultPlaintext {
        kind: RemoteActionResultKind::RemoteTranscriptResult,
        action: RemoteActionKind::FetchWorkflows,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        thread_skills: None,
        reviews: None,
        workflows: Some(crate::protocol::WorkflowsResponse {
            workflows_revision: 4,
            workflow_runs: Vec::new(),
        }),
        devices: Some(crate::protocol::DevicesResponse {
            devices_revision: 5,
            device_records: Vec::new(),
            paired_devices: Vec::new(),
            pending_pairing_requests: Vec::new(),
        }),
        projects: None,
        ask_user_question_detail: None,
        ask_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        session_claim_boot: None,
        session_claim_relay_ms: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
        error_code: None,
    };

    let payload = sealed_result_value(&result).expect("dedicated data payload");
    let json = serde_json::to_value(payload).expect("serialize payload");
    assert_eq!(json["workflows"]["workflows_revision"], 4);
    assert_eq!(json["devices"]["devices_revision"], 5);
}

#[test]
fn encrypted_fetch_projects_result_carries_the_projects_payload_to_the_device() {
    let mut thread_project_id = std::collections::HashMap::new();
    thread_project_id.insert("thread-1".to_string(), "proj-1".to_string());
    let projects = crate::protocol::ProjectsResponse {
        projects_revision: 42,
        projects: vec![crate::protocol::ProjectView {
            id: "proj-1".to_string(),
            name: "Sealwire".to_string(),
            instructions: None,
        }],
        thread_project_id,
    };
    let result = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(RemoteActionKind::FetchProjects),
        action: RemoteActionKind::FetchProjects,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        thread_skills: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: Some(projects),
        ask_user_question_detail: None,
        ask_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        session_claim_boot: None,
        session_claim_relay_ms: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
        error_code: None,
    };

    let payload = sealed_result_value(&result).expect("projects payload");
    let json = serde_json::to_value(&payload).expect("serialize projects payload");
    let carried = json
        .get("projects")
        .unwrap_or(&serde_json::Value::Null)
        .clone();
    assert!(
        !carried.is_null(),
        "the encrypted fetch_projects envelope must carry `projects` to the device; got: {json}"
    );
    assert_eq!(carried["projects_revision"], 42);
    assert_eq!(carried["projects"][0]["id"], "proj-1");
    assert_eq!(
        carried["thread_project_id"]["thread-1"], "proj-1",
        "the device needs membership to group sessions by project"
    );
}

#[test]
fn encrypted_fetch_workspace_git_context_result_reaches_the_device() {
    let result = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(RemoteActionKind::FetchWorkspaceGitContext),
        action: RemoteActionKind::FetchWorkspaceGitContext,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        thread_workspace: None,
        thread_settings: None,
        thread_skills: None,
        workspace_git_context: Some(crate::protocol::WorkspaceGitContextView {
            cwd: "/repo/checkout".to_string(),
            is_repo: true,
            branch: Some("main".to_string()),
            detached: false,
            dirty: true,
            dirty_known: true,
            restricted: false,
            skipped_agent_config: Vec::new(),
        }),
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        ask_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        session_claim_boot: None,
        session_claim_relay_ms: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
        error_code: None,
    };

    let payload = sealed_result_value(&result).expect("git context payload");
    let json = serde_json::to_value(&payload).expect("serialize git context payload");
    let carried = json
        .get("workspace_git_context")
        .unwrap_or(&serde_json::Value::Null)
        .clone();
    assert!(
        !carried.is_null(),
        "the decrypted result must carry `workspace_git_context`; got: {json}"
    );
    assert_eq!(carried["branch"], "main");
    assert_eq!(carried["dirty"], true);
    assert_eq!(
        carried["cwd"], "/repo/checkout",
        "the echoed cwd is what lets a client drop an answer about a directory it has moved off"
    );
}

// Device authentication must not take the controller lease just to repair a workspace.
#[test]
fn repair_workspace_round_trips_and_requires_device_authentication() {
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "repair_workspace",
        "thread_id": "thread-1",
        "input": {}
    }))
    .expect("repair_workspace should parse with an empty input");
    assert_eq!(request.kind(), RemoteActionKind::RepairWorkspace);
    assert_eq!(
        RemoteActionKind::RepairWorkspace.as_str(),
        "repair_workspace"
    );

    match request.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::RepairWorkspace { thread_id, input } => {
            assert_eq!(thread_id, "thread-1");
            assert_eq!(
                input.device_id.as_deref(),
                Some("device-9"),
                "the server stamps the actor; a device cannot claim to be another"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::RepairWorkspace),
        RemoteActionResultKind::RemoteActionAck
    ));
    assert!(
        requires_signed_attempt(RemoteActionKind::RepairWorkspace),
        "workspace repair requires device authentication, without taking control"
    );
}

/// Locks the `rename_thread` wire contract against the exact payload the phone sends
/// (`remote/project-actions.js`: `{ thread_id, input: { name } }`). A drift here fails
/// only at runtime, on a device, with a confusing broker error.
#[test]
fn rename_thread_round_trips_the_payload_the_remote_surface_sends() {
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "rename_thread",
        "thread_id": "thread-1",
        "input": { "name": "Auth work" }
    }))
    .expect("rename_thread should parse");
    assert_eq!(request.kind(), RemoteActionKind::RenameThread);
    assert_eq!(RemoteActionKind::RenameThread.as_str(), "rename_thread");

    // bind_device must stamp the actor WITHOUT dropping the selector — the same
    // rebuild-loses-the-field bug fetch_workspace_diff guards against.
    match request.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::RenameThread { thread_id, input } => {
            assert_eq!(thread_id, "thread-1");
            assert_eq!(input.name.as_deref(), Some("Auth work"));
            assert_eq!(
                input.device_id.as_deref(),
                Some("device-9"),
                "the server stamps the actor; a device cannot claim to be another"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // A reset is `{"name": null}` — it must parse, not be mistaken for a malformed body.
    let reset: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "rename_thread",
        "thread_id": "thread-1",
        "input": { "name": null }
    }))
    .expect("a reset should parse");
    match reset {
        RemoteActionRequest::RenameThread { input, .. } => assert!(input.name.is_none()),
        other => panic!("unexpected request: {other:?}"),
    }

    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::RenameThread),
        RemoteActionResultKind::RemoteActionAck
    ));
    // Renaming a tab must not fight the active controller for the relay-wide lease,
    // and must work while that session is mid-turn.
    assert!(requires_signed_attempt(RemoteActionKind::RenameThread));
}

/// Locks the `set_thread_flag` wire contract against the exact payload the phone
/// sends (`remote/project-actions.js`: `{ thread_id, input: { flagged } }`). Mirrors
/// `rename_thread_round_trips_the_payload_the_remote_surface_sends` above.
#[test]
fn set_thread_flag_round_trips_the_payload_the_remote_surface_sends() {
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "set_thread_flag",
        "thread_id": "thread-1",
        "input": { "flagged": true }
    }))
    .expect("set_thread_flag should parse");
    assert_eq!(request.kind(), RemoteActionKind::SetThreadFlag);
    assert_eq!(RemoteActionKind::SetThreadFlag.as_str(), "set_thread_flag");

    // bind_device must stamp the actor WITHOUT dropping the selector — the same
    // rebuild-loses-the-field bug fetch_workspace_diff guards against.
    match request.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::SetThreadFlag { thread_id, input } => {
            assert_eq!(thread_id, "thread-1");
            assert!(input.flagged);
            assert_eq!(
                input.device_id.as_deref(),
                Some("device-9"),
                "the server stamps the actor; a device cannot claim to be another"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::SetThreadFlag),
        RemoteActionResultKind::RemoteActionAck
    ));
    // Flagging a session must not fight the active controller for the relay-wide
    // lease, and must work while that session is mid-turn.
    assert!(requires_signed_attempt(RemoteActionKind::SetThreadFlag));
}

/// The broker's `list_threads` action must carry `q` into the search, not drop it.
///
/// This is one line in `execute_remote_action`, and it is the whole feature on a phone:
/// with `q` dropped the relay answers with the ordinary page, so the device shows every
/// session and the search box looks broken. The browser e2e cannot see it — that harness
/// stubs the relay, so it IS the server there.

#[tokio::test]
async fn list_threads_action_carries_the_search_query() {
    use crate::fake_provider::FakeProviderBridge;
    use crate::protocol::StartSessionInput;
    use crate::provider::ProviderBridge;
    use crate::state::{PairedDevice, RelayState, SecurityProfile};
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::{watch, RwLock};

    let dir = tempfile::TempDir::new().expect("tmpdir");
    let cwd = dir.path().to_string_lossy().to_string();
    let (change_tx, _rx) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        cwd.clone(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    let bridge = FakeProviderBridge::spawn(relay.clone())
        .await
        .expect("fake provider should spawn");
    let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
    providers.insert("fake".to_string(), Arc::new(bridge));
    // start_session refuses an unidentified caller; pair one the way the relay would.
    // Before `from_parts`, which takes the Arc — `AppState.relay` is private.
    {
        let mut guard = relay.write().await;
        guard.paired_devices.insert(
            "phone-1".to_string(),
            PairedDevice {
                device_id: "phone-1".to_string(),
                label: "phone-1".to_string(),
                payload_secret: "secret".to_string(),
                device_verify_key: "verify".to_string(),
                created_at: 1,
                last_seen_at: Some(1),
                last_peer_id: None,
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
            },
        );
    }
    let state = AppState::from_parts(relay, providers, change_tx);

    state
        .start_session(StartSessionInput {
            device_id: Some("phone-1".to_string()),
            cwd: Some(cwd.clone()),
            model: None,
            effort: None,
            approval_policy: None,
            sandbox: None,
            provider: Some("fake".to_string()),
            initial_prompt: None,
            project_id: None,
        })
        .await
        .expect("start_session");

    let listed = state.list_threads(50, None).await.expect("list");
    let title = listed.threads[0]
        .name
        .clone()
        .expect("the fake provider titles its sessions");

    let run = |q: Option<&str>| {
        let state = state.clone();
        let q = q.map(str::to_string);
        async move {
            let outcome = execute_remote_action(
                &state,
                RemoteActionRequest::ListThreads {
                    query: ThreadsQuery {
                        limit: Some(50),
                        device_id: None,
                        q,
                        ids: None,
                    },
                },
                0,
            )
            .await
            .expect("action should succeed");
            outcome.threads.expect("the action returns a thread list")
        }
    };

    assert_eq!(
        run(Some(&title)).await.threads.len(),
        1,
        "a query matching the session's title must come back with it"
    );
    assert!(
        run(Some("zzz-no-such-session")).await.threads.is_empty(),
        "a non-matching query must narrow the answer — if it does not, `q` was dropped"
    );
    assert_eq!(
        run(None).await.threads.len(),
        1,
        "no query still returns the ordinary page"
    );
}

/// Publishing a chunked reply must not cost the caller the reply's pacing.
///
/// `broker.rs` awaits `handle_server_message` INLINE in the `select!` arm that reads the
/// broker socket, and a chunked action reply is published from inside that handler. So
/// for as long as this function takes, the relay reads NOTHING: not another surface's
/// `fetch_thread_transcript`, not a `claim_challenge`, not even the presence frame
/// saying the surface it is answering has gone away.
///
/// It used to sleep `REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS` between every
/// chunk, so a 21-chunk reply — a real trace had exactly that, one
/// `fetch_workspace_diff` — blinded the relay for ~5 seconds. Users experienced it as
/// "I clicked and nothing happened, then a while later everything arrived at once".
///
/// Runs on a paused clock, so the assertion is about the pacing this call performs, not
/// about how fast the machine is: a paused runtime auto-advances time whenever the task
/// sleeps, which means a version that still paces inline reports the full ~5s here.
#[tokio::test(start_paused = true)]
async fn queueing_a_chunk_train_does_not_block_the_read_loop() {
    use crate::state::{RelayState, SecurityProfile};
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::{watch, RwLock};

    let (change_tx, _rx) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        "/tmp/chunk-train-test".to_string(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    relay.write().await.mark_surface_peer_online("surface-1");
    let state = AppState::from_parts(relay, HashMap::new(), change_tx);

    let (writer, _now_queue, mut queued) = super::super::writer::test_writer();
    let chunks = workspace_diff_chunks("surface-1", 21);

    let started_at = tokio::time::Instant::now();
    publish_remote_action_result_chunks(
        &state,
        &writer,
        chunks,
        "test chunk train",
        "surface-1",
        None,
    )
    .await
    .expect("queueing a train succeeds");
    let blocked_for = started_at.elapsed();

    assert!(
        blocked_for < Duration::from_millis(50),
        "handing off a 21-chunk reply must be a queue push, not {}ms of blocked read \
         loop — the pacing belongs to the writer task",
        blocked_for.as_millis()
    );

    let frame = queued
        .try_recv()
        .expect("the train must actually be queued");
    assert_eq!(frame.chunks.len(), 21, "every chunk is handed over");
    assert_eq!(
        frame.interval,
        Duration::from_millis(REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS),
        "and the writer is told the pacing to apply"
    );
    assert_eq!(
        frame.watch_target.as_deref(),
        Some("surface-1"),
        "a surface observed online at queue time is watched, so its train can be \
         abandoned if it leaves"
    );
}

fn workspace_diff_chunks(target_peer_id: &str, chunk_count: usize) -> Vec<OutboundBrokerPayload> {
    (0..chunk_count)
        .map(
            |chunk_index| OutboundBrokerPayload::EncryptedRemoteActionResultChunk {
                action_id: "action-1".to_string(),
                target_peer_id: target_peer_id.to_string(),
                action: RemoteActionKind::FetchWorkspaceDiff,
                chunk_index,
                chunk_count,
                device_id: "phone-1".to_string(),
                envelope: encrypt_json("secret", &serde_json::json!({"data":"payload"}))
                    .expect("chunk encrypts"),
            },
        )
        .collect()
}

/// A chunked reply must not pay for base64 twice.
///
/// The encrypted chunk path used to base64 the chunk into `data_base64`, wrap that in
/// JSON, encrypt it, and base64 the ciphertext **again** — two 4/3 expansions, so the wire
/// cost was ~1.78x the payload. The inner encoding was never needed: the thing being
/// chunked is already JSON *text*, so it can travel as a JSON string provided the split
/// respects character boundaries.
///
/// This is a real cost, not a theoretical one — the broker's egress is billed per GB, and
/// chunked replies are the largest thing the relay sends.
#[test]
fn a_chunked_reply_does_not_pay_for_base64_twice() {
    let plaintext = make_large_thread_transcript_plaintext();
    let payload_bytes = serde_json::to_vec(&plaintext)
        .expect("plaintext serializes")
        .len();

    let encrypted = build_encrypted_remote_action_result_chunk_payloads(
        "action-1",
        "surface-1",
        "device-1",
        "payload-secret",
        &plaintext,
    )
    .expect("encrypted chunk payloads");
    let encrypted_wire: usize = encrypted.iter().map(frame_bytes_for_payload).sum();
    let encrypted_ratio = encrypted_wire as f64 / payload_bytes as f64;

    assert!(
        encrypted_ratio < 1.45,
        "an encrypted chunked reply cost {encrypted_ratio:.3}x its payload ({encrypted_wire} \
         bytes on the wire for {payload_bytes} bytes of result). One base64 layer is \
         unavoidable for ciphertext; a second one is pure waste, and at ~1.78x it is a \
         quarter of the bandwidth bill for the largest thing the relay sends."
    );
}

/// Build the same large transcript, but out of text that makes chunking hard: multi-byte
/// characters, and the characters JSON has to escape.
fn make_unicode_heavy_transcript_plaintext() -> RemoteActionResultPlaintext {
    // Every ingredient that can make a chunk serialize larger than its neighbours:
    // 3-byte CJK, 4-byte emoji (a surrogate pair in the browser), combining marks, and
    // quotes/backslashes/newlines/tabs that JSON expands to two characters each.
    let nasty = "日本語のテキスト🙂🇯🇵é\"quoted\"\\back\\slash\n\ttab—dash";
    // Deliberately FRONT-LOADED WITH ASCII. A uniformly nasty fixture is not a test of
    // anything: every piece serializes alike, so sampling one and assuming the rest match
    // gives the right answer by accident. The cheap prefix makes the first piece
    // unrepresentative, so only a fit loop that measures every piece keeps the later,
    // far heavier ones inside the frame limit.
    let mut body = "plain ascii filler. ".repeat(4_000);
    body.push_str(&nasty.repeat(4_000));
    let mut plaintext = make_large_thread_transcript_plaintext();
    if let Some(transcript) = plaintext.thread_transcript.as_mut() {
        for entry in transcript.entries.iter_mut() {
            entry.text = Some(body.clone());
        }
    }
    plaintext
}

/// Chunking on character boundaries must survive text that is not one byte per character.
///
/// The old encoding sliced raw bytes and base64'd them, so every chunk was the same size
/// and could not split a character. Sending text instead buys ~25% of the bandwidth back
/// and costs exactly this: a slice can land mid-character (producing bytes no client can
/// decode), and pieces vary in serialized size because multi-byte characters and
/// JSON-escaped ones cost more. Fitting the frame by sampling one chunk and assuming the
/// rest match is how an oversized frame reaches the broker — which discards it and, since
/// this relay treats that as fatal, tears the session down.
#[test]
fn unicode_and_escape_heavy_chunks_stay_within_the_frame_limit_and_round_trip() {
    let plaintext = make_unicode_heavy_transcript_plaintext();
    let expected = serde_json::to_value(&plaintext).expect("plaintext serializes");

    let encrypted = build_encrypted_remote_action_result_chunk_payloads(
        "action-1",
        "surface-1",
        "device-1",
        "payload-secret",
        &plaintext,
    )
    .expect("encrypted chunk payloads");
    assert!(encrypted.len() > 1);
    let mut decrypted = String::new();
    for payload in &encrypted {
        assert!(
            frame_bytes_for_payload(payload) <= MAX_BROKER_TEXT_FRAME_BYTES,
            "an encrypted chunk of multi-byte / escape-heavy text produced an oversized frame"
        );
        match payload {
            OutboundBrokerPayload::EncryptedRemoteActionResultChunk { envelope, .. } => {
                let chunk: RemoteActionResultChunkPlaintext =
                    crate::broker::crypto::decrypt_json("payload-secret", envelope)
                        .expect("chunk decrypts");
                decrypted.push_str(&chunk.data);
            }
            other => panic!("expected an encrypted chunk, got {other:?}"),
        }
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&decrypted).expect("decrypted chunks must reassemble into JSON");
    assert_eq!(parsed, expected);
}

#[test]
fn goal_actions_round_trip_and_bind_device() {
    let set: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "set_goal",
        "thread_id": "thread-1",
        "objective": "Ship the mobile surface"
    }))
    .expect("set_goal should parse");
    assert_eq!(set.kind(), RemoteActionKind::SetGoal);
    assert_eq!(RemoteActionKind::SetGoal.as_str(), "set_goal");
    match set.bind_device("device-3".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::SetGoal {
            thread_id,
            objective,
            reset_turns,
            device_id,
        } => {
            assert_eq!(thread_id, "thread-1");
            assert_eq!(objective, "Ship the mobile surface");
            assert!(!reset_turns, "omitted reset_turns defaults to false");
            assert_eq!(device_id.as_deref(), Some("device-3"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    let stop: RemoteActionRequest =
        serde_json::from_value(serde_json::json!({ "type": "stop_goal", "thread_id": "thread-1" }))
            .expect("stop_goal should parse");
    assert_eq!(stop.kind(), RemoteActionKind::StopGoal);
    assert_eq!(RemoteActionKind::StopGoal.as_str(), "stop_goal");
    match stop.bind_device("device-3".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::StopGoal {
            thread_id,
            device_id,
        } => {
            assert_eq!(thread_id, "thread-1");
            assert_eq!(device_id.as_deref(), Some("device-3"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    for kind in [RemoteActionKind::SetGoal, RemoteActionKind::StopGoal] {
        assert!(matches!(
            remote_action_result_kind(kind),
            RemoteActionResultKind::RemoteActionAck
        ));
    }
}

#[test]
fn a_goal_card_action_names_its_card_and_binds_the_device() {
    let card: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "goal_card",
        "thread_id": "thread-1",
        "seq": 4,
        "action": "keep_going"
    }))
    .expect("goal_card should parse");
    assert_eq!(card.kind(), RemoteActionKind::GoalCard);
    assert_eq!(RemoteActionKind::GoalCard.as_str(), "goal_card");
    match card.bind_device("device-3".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::GoalCard {
            thread_id,
            seq,
            action,
            device_id,
        } => {
            assert_eq!(
                (thread_id.as_str(), seq, action.as_str()),
                ("thread-1", 4, "keep_going")
            );
            assert_eq!(device_id.as_deref(), Some("device-3"));
        }
        other => panic!("unexpected: {other:?}"),
    }
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::GoalCard),
        RemoteActionResultKind::RemoteActionAck
    ));
}

// Stopping a goal is not the brake `stop_turn` is: it settles the goal Cancelled and the
// card goes away.
#[test]
fn both_goal_actions_need_the_session_claim() {
    assert!(requires_signed_attempt(RemoteActionKind::SetGoal));
    assert!(requires_signed_attempt(RemoteActionKind::StopGoal));
    assert!(requires_signed_attempt(RemoteActionKind::GoalCard));
    assert!(requires_signed_attempt(RemoteActionKind::StopTurn));
}

// `/delegate` from a phone. The other two composer commands already had a door —
// `set_goal`/`stop_goal` and `request_review` — so this was the one that could only be
// typed on a desktop.
#[test]
fn delegating_from_a_paired_device_round_trips_and_binds_it() {
    let ask: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "delegate",
        "thread_id": "thread-1",
        "message": "look at the retry loop",
        "provider": "codex"
    }))
    .expect("delegate should parse");
    assert_eq!(ask.kind(), RemoteActionKind::Delegate);
    assert_eq!(RemoteActionKind::Delegate.as_str(), "delegate");
    match ask.bind_device("device-4".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::Delegate {
            thread_id,
            message,
            provider,
            device_id,
            ..
        } => {
            assert_eq!(thread_id, "thread-1");
            assert_eq!(message, "look at the retry loop");
            assert_eq!(provider.as_deref(), Some("codex"));
            assert_eq!(device_id.as_deref(), Some("device-4"));
        }
        other => panic!("unexpected: {other:?}"),
    }
    // Bringing in another agent is starting work, so it is gated like sending a message.
    assert!(requires_signed_attempt(RemoteActionKind::Delegate));
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::Delegate),
        RemoteActionResultKind::RemoteActionAck
    ));
}

// The flagship card on a phone. The device comes from the broker, never the body.
#[test]
fn deciding_a_model_request_from_a_paired_device_binds_it_and_needs_the_session() {
    let decision: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "decide_model_request",
        "ask_id": "ask-1",
        "decision": "switch",
        "model": "opus[1m]",
        "device_id": "forged"
    }))
    .expect("decide_model_request should parse");
    assert_eq!(decision.kind(), RemoteActionKind::DecideModelRequest);
    assert_eq!(
        RemoteActionKind::DecideModelRequest.as_str(),
        "decide_model_request"
    );
    match decision.bind_device("device-6".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::DecideModelRequest {
            ask_id,
            decision,
            model,
            device_id,
        } => {
            assert_eq!(ask_id, "ask-1");
            assert_eq!(decision, "switch");
            assert_eq!(model.as_deref(), Some("opus[1m]"));
            assert_eq!(device_id.as_deref(), Some("device-6"));
        }
        other => panic!("unexpected: {other:?}"),
    }
    assert!(requires_signed_attempt(
        RemoteActionKind::DecideModelRequest
    ));
}

// `/handover` from a phone. Same door as `delegate`, and deliberately a different
// action: a delegate insists on a message, a handover carries only an optional note.
#[test]
fn handing_over_from_a_paired_device_round_trips_and_binds_it() {
    let handover: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "handover",
        "thread_id": "thread-1",
        "agent": "thread-2"
    }))
    .expect("handover should parse with nothing but a thread and a target");
    assert_eq!(handover.kind(), RemoteActionKind::Handover);
    assert_eq!(RemoteActionKind::Handover.as_str(), "handover");
    match handover.bind_device("device-5".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::Handover {
            thread_id,
            note,
            agent,
            device_id,
            ..
        } => {
            assert_eq!(thread_id, "thread-1");
            assert_eq!(note, "", "an omitted note is a handover, not a bad request");
            assert_eq!(agent.as_deref(), Some("thread-2"));
            assert_eq!(device_id.as_deref(), Some("device-5"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    // The device on the wire is never trusted: whatever a client claims is replaced by
    // the one this connection is bound to.
    let spoofed: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "handover",
        "thread_id": "thread-1",
        "note": "mind the parser",
        "provider": "codex",
        "model": "gpt-5.6",
        "effort": "xhigh",
        "device_id": "somebody-elses-device"
    }))
    .expect("handover should parse");
    match spoofed.bind_device("device-5".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::Handover {
            note,
            provider,
            model,
            effort,
            device_id,
            ..
        } => {
            assert_eq!(note, "mind the parser");
            assert_eq!(provider.as_deref(), Some("codex"));
            assert_eq!(model.as_deref(), Some("gpt-5.6"));
            assert_eq!(effort.as_deref(), Some("xhigh"));
            assert_eq!(
                device_id.as_deref(),
                Some("device-5"),
                "the claimed device is overwritten by the bound one"
            );
        }
        other => panic!("unexpected: {other:?}"),
    }

    // Starting somebody else's session on this work is starting work, so it is gated
    // exactly as sending a message is.
    assert!(requires_signed_attempt(RemoteActionKind::Handover));
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::Handover),
        RemoteActionResultKind::RemoteActionAck
    ));
}

// The receipt half. A handover that failed after being accepted is held on the snapshot
// until it has been read; without this door the phone can see one and never clear it, so
// the same failure lands under every draft it writes from then on.
#[test]
fn acknowledging_a_handover_binds_the_device_and_requires_device_authentication() {
    let ack: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "ack_handover",
        "handover_id": "handover-9",
        "device_id": "somebody-elses-device"
    }))
    .expect("ack_handover should parse");
    assert_eq!(ack.kind(), RemoteActionKind::AckHandover);
    assert_eq!(RemoteActionKind::AckHandover.as_str(), "ack_handover");
    match ack.bind_device("device-6".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::AckHandover {
            handover_id,
            device_id,
        } => {
            assert_eq!(handover_id, "handover-9");
            assert_eq!(
                device_id.as_deref(),
                Some("device-6"),
                "the claimed device is overwritten by the bound one, so the scope check \
is against who is really asking"
            );
        }
        other => panic!("unexpected: {other:?}"),
    }

    // Reading a failure is not starting work. Requiring the controller lease to dismiss
    // a notice would be a worse bargain than the one this closes — a second device would
    // have to take control of the session just to clear its own composer.
    assert!(requires_signed_attempt(RemoteActionKind::AckHandover));
    assert!(
        requires_signed_attempt(RemoteActionKind::Handover),
        "…while the handover itself still is"
    );
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::AckHandover),
        RemoteActionResultKind::RemoteActionAck
    ));
}

/// The relay repeats "still running" faster than the phone gives up. If these two drift
/// apart the phone reports a failure between two notices — for a write that is running.
#[test]
fn the_still_working_notice_outpaces_the_deadline_it_exists_to_hold_off() {
    assert!(
        REMOTE_ACTION_PENDING_NOTICE_INTERVAL < CLIENT_REMOTE_ACTION_DEADLINE,
        "the relay repeats every {:?} but the phone gives up after {:?}",
        REMOTE_ACTION_PENDING_NOTICE_INTERVAL,
        CLIENT_REMOTE_ACTION_DEADLINE
    );
}

/// A frame origin for tests that only care about what `bind_device` stamps.
fn test_origin() -> FrameOrigin {
    FrameOrigin {
        ingress: 1,
        lease: 1,
    }
}

/// A claim challenge from a connection that has gone must not take the device back.
///
/// It was the one action exempt from the lease check, and it is the worst one to exempt:
/// the challenge is bound to the peer that asked, so binding the device to a dead peer
/// aims every reply there AND makes completing the claim from the live connection fail.
#[tokio::test]
async fn a_claim_challenge_from_a_closed_connection_does_not_take_the_device_back() {
    use crate::state::{PairedDevice, RelayState, SecurityProfile};
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::{watch, RwLock};

    let (change_tx, _rx) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        "/tmp/claim-lease-test".to_string(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    {
        let mut relay = relay.write().await;
        relay.paired_devices.insert(
            "phone-1".to_string(),
            PairedDevice {
                device_id: "phone-1".to_string(),
                label: "phone-1".to_string(),
                payload_secret: "secret".to_string(),
                device_verify_key: "verify".to_string(),
                created_at: 1,
                last_seen_at: Some(1),
                last_peer_id: None,
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
            },
        );
        relay.mark_surface_peer_online("surface-old")
    };
    let state = AppState::from_parts(relay.clone(), HashMap::new(), change_tx);
    let stale_lease = relay
        .read()
        .await
        .current_surface_lease("surface-old")
        .expect("the old connection holds one");

    // The old connection got a challenge of its own while it was still live — so what
    // refuses it below has to be the lease, not the challenge's own peer binding.
    let old_challenge = state
        .issue_claim_challenge("phone-1", "surface-old", stale_lease)
        .await
        .expect("the live connection of the day gets a challenge");

    // Then it goes, and the phone comes back as a new peer the device binds to.
    let live_lease = {
        let mut relay = relay.write().await;
        relay.mark_surface_peer_offline("surface-old");
        relay.mark_surface_peer_online("surface-new");
        relay
            .mark_paired_device_seen("phone-1", "surface-new", None, 2)
            .expect("bind");
        relay
            .current_surface_lease("surface-new")
            .expect("the live connection holds one")
    };

    // Completing the OLD connection's own challenge, before anything prunes it: it is
    // still on file and still belongs to that peer, so the only thing left to refuse it
    // is the lease. This is the half that binds the device and mints a token.
    assert!(
        state
            .complete_remote_claim(
                "phone-1",
                &old_challenge.challenge_id,
                "surface-old",
                stale_lease
            )
            .await
            .is_err(),
        "a claim completed from a connection that has gone binds the device to a dead \
         socket and mints a token the live connection cannot use"
    );
    assert_eq!(
        relay
            .read()
            .await
            .paired_devices
            .get("phone-1")
            .and_then(|device| device.last_peer_id.clone())
            .as_deref(),
        Some("surface-new"),
        "and must leave the binding where it was"
    );

    // The live connection has a challenge in hand.
    let live = state
        .issue_claim_challenge("phone-1", "surface-new", live_lease)
        .await
        .expect("the live connection gets a challenge");

    let stale = issue_claim_challenge_outcome(&state, "phone-1", "surface-old", stale_lease).await;

    assert!(
        stale.is_err(),
        "a challenge asked for on a connection that has gone must be refused, not served"
    );
    assert!(
        state
            .claim_challenge("phone-1", &live.challenge_id, "surface-new")
            .await
            .is_ok(),
        "issuing a challenge deletes every other one for the device, so a stale request \
         takes away the live connection's and its claim is then refused as missing"
    );
    assert_eq!(
        relay
            .read()
            .await
            .paired_devices
            .get("phone-1")
            .and_then(|device| device.last_peer_id.clone())
            .as_deref(),
        Some("surface-new"),
        "a challenge queued by the closed connection bound the device back to it"
    );
}

#[test]
fn fetch_thread_skills_binds_the_asking_device_and_requires_device_authentication() {
    // The device id decides which folders may be listed, so the client's own must lose.
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_thread_skills",
        "device_id": "spoofed",
        "thread_id": "thread-7"
    }))
    .expect("fetch_thread_skills should parse");
    assert_eq!(request.kind(), RemoteActionKind::FetchThreadSkills);
    assert_eq!(
        RemoteActionKind::FetchThreadSkills.as_str(),
        "fetch_thread_skills"
    );
    match request.bind_device("device-9".to_string(), "surface-test", test_origin()) {
        RemoteActionRequest::FetchThreadSkills {
            device_id,
            thread_id,
        } => {
            assert_eq!(device_id.as_deref(), Some("device-9"));
            assert_eq!(thread_id, "thread-7");
        }
        other => panic!("unexpected bound request: {other:?}"),
    }
    assert!(requires_signed_attempt(RemoteActionKind::FetchThreadSkills));
    assert!(!remote_action_emits_info_log(
        RemoteActionKind::FetchThreadSkills
    ));
}

#[test]
fn encrypted_fetch_thread_skills_result_reaches_the_device() {
    let result = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(RemoteActionKind::FetchThreadSkills),
        action: RemoteActionKind::FetchThreadSkills,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        thread_skills: Some(crate::protocol::ThreadSkillsView {
            thread_id: "thread-7".to_string(),
            provider: "codex".to_string(),
            cwd: "/repo".to_string(),
            source: "runtime".to_string(),
            invocation: "skill_input".to_string(),
            note: None,
            skills: vec![crate::protocol::ProviderSkillView {
                name: "probe".to_string(),
                description: "the .codex copy".to_string(),
                scope: "repo".to_string(),
                origin: None,
                path: Some("/repo/.codex/skills/probe/SKILL.md".to_string()),
                argument_hint: None,
            }],
        }),
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        ask_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        session_claim_boot: None,
        session_claim_relay_ms: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
        error_code: None,
    };
    let payload = sealed_result_value(&result).expect("skills payload");
    let json = serde_json::to_value(&payload).expect("serialize skills payload");
    let carried = &json["thread_skills"];
    assert_eq!(
        carried["provider"], "codex",
        "the decrypted result must carry thread_skills: {json}"
    );
    assert_eq!(carried["cwd"], "/repo");
    assert_eq!(
        carried["skills"][0]["path"],
        "/repo/.codex/skills/probe/SKILL.md"
    );
}

// The phone reloads the latest page on this code alone, so it must survive every way a
// result travels: encrypted and replayed from the cache.
#[tokio::test]
async fn a_rejected_transcript_cursor_reaches_the_device_as_its_code() {
    use crate::state::{RelayState, SecurityProfile};
    use std::sync::Arc;
    use tokio::sync::{watch, RwLock};

    let dir = tempfile::TempDir::new().expect("tmpdir");
    let cwd = dir.path().to_string_lossy().to_string();
    let (change_tx, _rx) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        cwd.clone(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    relay
        .write()
        .await
        .ensure_runtime_for_thread("t1")
        .current_cwd = cwd;
    let state = AppState::from_parts(relay, std::collections::HashMap::new(), change_tx);
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_thread_transcript",
        "input": { "thread_id": "t1", "before": "tc1.another-runtime.0" },
    }))
    .expect("the request the phone sends");

    let failure = execute_remote_action(&state, request, 0)
        .await
        .expect_err("a cursor from another runtime");
    let (outcome, error) = failure.into_refusal();
    let cached = cached_remote_action_result(
        RemoteActionKind::FetchThreadTranscript,
        state.snapshot().await,
        outcome,
        Some(error),
        false,
        None,
    );
    assert_eq!(
        cached.error_code,
        Some(ClientErrorCode::TranscriptCursorRejected)
    );

    let mut result = make_large_thread_transcript_plaintext();
    result.ok = false;
    result.thread_transcript = None;
    result.error = cached.error.clone();
    result.error_code = cached.error_code;
    let sealed = serde_json::to_value(&result).expect("sealed result");
    assert_eq!(sealed["error_code"], "transcript_cursor_rejected");
}

// The phone recovers shelled rows by id; the action must parse and answer like a page.
#[tokio::test]
async fn fetch_thread_rows_answers_the_named_rows_and_names_the_missing() {
    use crate::state::{RelayState, SecurityProfile};
    use std::sync::Arc;
    use tokio::sync::{watch, RwLock};

    let dir = tempfile::TempDir::new().expect("tmpdir");
    let cwd = dir.path().to_string_lossy().to_string();
    let (change_tx, _rx) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        cwd.clone(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    {
        let mut relay = relay.write().await;
        relay.ensure_runtime_for_thread("t1").current_cwd = cwd;
        relay.upsert_transcript_item_for_thread(
            "t1",
            "r1".to_string(),
            crate::protocol::TranscriptEntryKind::AgentText,
            Some("recovered body".to_string()),
            "completed".to_string(),
            None,
            None,
        );
    }
    let state = AppState::from_parts(relay, std::collections::HashMap::new(), change_tx);
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_thread_rows",
        "input": { "thread_id": "t1", "row_ids": ["r1", "gone"] },
    }))
    .expect("the request the phone sends");
    assert_eq!(request.kind(), RemoteActionKind::FetchThreadRows);
    assert!(!remote_action_emits_info_log(
        RemoteActionKind::FetchThreadRows
    ));

    let outcome = execute_remote_action(&state, request, 0)
        .await
        .map_err(|failure| failure.into_refusal().1)
        .expect("rows");
    let rows = outcome
        .thread_transcript
        .expect("rows ride the transcript result");
    assert_eq!(rows.entries.len(), 1);
    assert_eq!(rows.entries[0].text.as_deref(), Some("recovered body"));
    assert_eq!(rows.missing_rows, vec!["gone".to_string()]);
}

#[test]
fn recheck_signed_out_providers_is_a_claim_free_remote_action() {
    let request: RemoteActionRequest =
        serde_json::from_value(serde_json::json!({ "type": "recheck_signed_out_providers" }))
            .expect("recheck_signed_out_providers should parse");
    assert_eq!(request.kind(), RemoteActionKind::RecheckSignedOutProviders);
    // Opening Settings on a phone must not steal the session from another device.
    assert!(requires_signed_attempt(
        RemoteActionKind::RecheckSignedOutProviders
    ));
}

fn sealed_result_value(result: &RemoteActionResultPlaintext) -> Result<serde_json::Value, String> {
    let envelope = encrypt_json("payload-secret", result)?;
    decrypt_json("payload-secret", &envelope)
}

#[test]
fn encrypted_actions_require_the_authenticated_action_id() {
    for request in [
        serde_json::json!({"type": "list_threads", "query": {"limit": 5}}),
        serde_json::json!({"type": "claim_challenge", "proof": "proof"}),
        serde_json::json!({"type": "claim_device", "challenge_id": "challenge", "challenge": "nonce", "proof": "proof"}),
        serde_json::json!({"type": "heartbeat", "input": {}}),
    ] {
        let envelope = encrypt_json(
            "secret",
            &serde_json::json!({
                "action_id": "original", "request": request,
            }),
        )
        .expect("encrypt bound request");
        decrypt_remote_action_with_secret("secret", "original", &envelope)
            .expect("matching IDs are accepted");
        assert!(
            decrypt_remote_action_with_secret("secret", "changed", &envelope)
                .expect_err("changed outer ID is refused")
                .contains("action_id does not match")
        );
        let unbound = encrypt_json("secret", &request).expect("encrypt old request");
        assert!(decrypt_remote_action_with_secret("secret", "original", &unbound).is_err());
    }
}

// The reply to a phone's own action carries a snapshot too, so the folder limit has to
// hold there as well as on the broadcast one.
#[tokio::test]
async fn an_action_reply_gives_a_folder_limited_phone_nothing_outside_its_folder() {
    let canonical = |dir: &tempfile::TempDir| {
        std::fs::canonicalize(dir.path())
            .expect("tempdir canonicalizes")
            .to_string_lossy()
            .to_string()
    };
    let phone_dir = tempfile::TempDir::new().expect("phone tempdir");
    let session_dir = tempfile::TempDir::new().expect("session tempdir");
    let session_cwd = canonical(&session_dir);
    let state =
        super::super::tests::folder_limited_phone_state(&canonical(&phone_dir), &session_cwd).await;
    let (writer, mut now_queue, _queued) = super::super::writer::test_writer();

    publish_remote_action_result_private(
        &state,
        &writer,
        "surface-a".to_string(),
        "phone-1".to_string(),
        "action-1".to_string(),
        RemoteActionKind::TakeOver,
        Some(state.snapshot().await),
        RemoteActionOutcome::default(),
        None,
        true,
        None,
        None,
    )
    .await
    .expect("the reply publishes");

    let tokio_tungstenite::tungstenite::Message::Text(text) =
        now_queue.try_recv().expect("one reply frame")
    else {
        panic!("broker frames are text");
    };
    let frame: serde_json::Value = serde_json::from_str(&text).expect("frame is json");
    let envelope: EncryptedEnvelope =
        serde_json::from_value(frame["payload"]["envelope"].clone()).expect("envelope");
    let reply: serde_json::Value = decrypt_json("secret", &envelope).expect("reply decrypts");
    let text = reply.to_string();
    assert!(!text.contains("the secret reply"), "transcript leaked");
    assert!(!text.contains("cat secrets.txt"), "approval leaked");
    assert!(!text.contains(&session_cwd), "session folder leaked");
}
