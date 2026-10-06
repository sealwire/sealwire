use super::*;
use crate::events::{UsageEvent, UsageEventKind, UsageEventSink};
use crate::protocol::{PresenceKind, ServerMessage};
use serde_json::json;

#[tokio::test]
async fn join_publish_and_leave_broadcast_presence() {
    let state = BrokerState::default();
    let mut relay = state
        .join("room-a", "relay-1", PeerRole::Relay, None, None)
        .await
        .expect("relay should join");
    assert!(relay.existing_peers.is_empty());

    let mut surface = state
        .join("room-a", "phone-1", PeerRole::Surface, None, None)
        .await
        .expect("surface should join");
    assert_eq!(
        surface.existing_peers,
        vec![PeerSummary {
            peer_id: "relay-1".to_string(),
            role: PeerRole::Relay,
            device_id: None,
        }]
    );

    let joined = relay
        .receiver
        .recv()
        .await
        .map(decode)
        .expect("relay should see join presence");
    assert_eq!(
        joined,
        ServerMessage::Presence {
            channel_id: "room-a".to_string(),
            kind: PresenceKind::Joined,
            peer: PeerSummary {
                peer_id: "phone-1".to_string(),
                role: PeerRole::Surface,
                device_id: None,
            },
        }
    );

    state
        .publish(
            "room-a",
            "relay-1",
            json!({"target_peer_id":"phone-1", "ciphertext":"abc"}),
        )
        .await
        .expect("publish should succeed");
    let relayed = surface
        .receiver
        .recv()
        .await
        .map(decode)
        .expect("surface should receive message");
    assert_eq!(
        relayed,
        ServerMessage::Message {
            channel_id: "room-a".to_string(),
            from_peer_id: "relay-1".to_string(),
            from_role: PeerRole::Relay,
            payload: json!({"target_peer_id":"phone-1", "ciphertext":"abc"}),
        }
    );

    state.leave("room-a", "phone-1").await;
    let left = relay
        .receiver
        .recv()
        .await
        .map(decode)
        .expect("relay should see leave presence");
    assert_eq!(
        left,
        ServerMessage::Presence {
            channel_id: "room-a".to_string(),
            kind: PresenceKind::Left,
            peer: PeerSummary {
                peer_id: "phone-1".to_string(),
                role: PeerRole::Surface,
                device_id: None,
            },
        }
    );
}

#[tokio::test]
async fn duplicate_peer_ids_are_rejected_per_channel() {
    let state = BrokerState::default();
    state
        .join("room-a", "phone-1", PeerRole::Surface, None, None)
        .await
        .expect("first peer should join");

    let error = state
        .join("room-a", "phone-1", PeerRole::Surface, None, None)
        .await
        .expect_err("duplicate peer should fail");
    assert!(error.contains("already connected"));

    state
        .join("room-b", "phone-1", PeerRole::Surface, None, None)
        .await
        .expect("same peer id in another channel should work");
}

#[tokio::test]
async fn relay_reconnect_replaces_old_connection_without_old_leave_removing_new_peer() {
    let state = BrokerState::default();
    let mut surface = state
        .join("room-a", "phone-1", PeerRole::Surface, None, None)
        .await
        .expect("surface should join");
    let mut old_relay = state
        .join("room-a", "relay-1", PeerRole::Relay, None, None)
        .await
        .expect("old relay should join");
    let old_connection_id = old_relay.connection_id;
    drain_presence(&mut surface.receiver).await;

    let new_relay = state
        .join("room-a", "relay-1", PeerRole::Relay, None, None)
        .await
        .expect("authenticated relay reconnect should replace its stale connection");
    assert_ne!(new_relay.connection_id, old_connection_id);
    assert_eq!(
        new_relay.existing_peers,
        vec![PeerSummary {
            peer_id: "phone-1".to_string(),
            role: PeerRole::Surface,
            device_id: None,
        }]
    );
    assert_eq!(
        old_relay.receiver.recv().await.map(decode),
        None,
        "replacing the peer should close the old connection's outbound channel"
    );
    let stale_publish = state
        .publish_connection(
            "room-a",
            "relay-1",
            old_connection_id,
            json!({"kind":"stale_snapshot"}),
        )
        .await
        .expect_err("replaced connection must not publish through the new peer identity");
    assert!(stale_publish.contains("connection has been replaced"));

    state
        .leave_connection("room-a", "relay-1", old_connection_id)
        .await;
    drain_presence(&mut surface.receiver).await;
    state
        .publish_connection(
            "room-a",
            "relay-1",
            new_relay.connection_id,
            json!({"kind":"session_snapshot", "target_peer_id":"phone-1"}),
        )
        .await
        .expect("old connection cleanup must not remove the replacement");
    assert!(matches!(
        surface.receiver.recv().await.map(decode),
        Some(ServerMessage::Message { from_peer_id, .. }) if from_peer_id == "relay-1"
    ));
}

#[tokio::test]
async fn targeted_messages_publish_only_to_listed_peers() {
    let state = BrokerState::default();
    let mut surface_a = state
        .join("room-a", "surface-a", PeerRole::Surface, None, None)
        .await
        .expect("surface a should join");
    let mut surface_b = state
        .join("room-a", "surface-b", PeerRole::Surface, None, None)
        .await
        .expect("surface b should join");
    let mut surface_c = state
        .join("room-a", "surface-c", PeerRole::Surface, None, None)
        .await
        .expect("surface c should join");
    let mut relay = state
        .join("room-a", "relay-1", PeerRole::Relay, None, None)
        .await
        .expect("relay should join");

    drain_presence(&mut surface_a.receiver).await;
    drain_presence(&mut surface_b.receiver).await;
    drain_presence(&mut surface_c.receiver).await;
    drain_presence(&mut relay.receiver).await;

    state
        .publish(
            "room-a",
            "relay-1",
            json!({
                "kind": "targeted_messages",
                "messages": [
                    {
                        "target_peer_id": "surface-a",
                        "payload": {"kind": "encrypted_transcript_delta", "value": 1}
                    },
                    {
                        "target_peer_id": "surface-c",
                        "payload": {"kind": "encrypted_transcript_delta", "value": 3}
                    }
                ]
            }),
        )
        .await
        .expect("targeted publish should succeed");

    assert_eq!(
        surface_a.receiver.recv().await.map(decode),
        Some(ServerMessage::Message {
            channel_id: "room-a".to_string(),
            from_peer_id: "relay-1".to_string(),
            from_role: PeerRole::Relay,
            payload: json!({"kind": "encrypted_transcript_delta", "value": 1}),
        })
    );
    assert_eq!(
        surface_c.receiver.recv().await.map(decode),
        Some(ServerMessage::Message {
            channel_id: "room-a".to_string(),
            from_peer_id: "relay-1".to_string(),
            from_role: PeerRole::Relay,
            payload: json!({"kind": "encrypted_transcript_delta", "value": 3}),
        })
    );
    assert!(surface_b.receiver.try_recv().is_err());
}

#[derive(Clone, Default)]
struct CollectingSink {
    events: Arc<std::sync::Mutex<Vec<UsageEvent>>>,
}

#[tokio::test]
async fn invalid_batches_and_same_role_routes_never_deliver_a_prefix() {
    let state = BrokerState::default();
    let mut relay = state
        .join("room", "relay", PeerRole::Relay, None, None)
        .await
        .unwrap();
    let mut other_relay = state
        .join("room", "other-relay", PeerRole::Relay, None, None)
        .await
        .unwrap();
    let mut surface = state
        .join("room", "surface", PeerRole::Surface, None, None)
        .await
        .unwrap();
    let mut other_surface = state
        .join("room", "other-surface", PeerRole::Surface, None, None)
        .await
        .unwrap();
    for peer in [
        &mut relay,
        &mut other_relay,
        &mut surface,
        &mut other_surface,
    ] {
        drain_presence(&mut peer.receiver).await;
    }

    let message = json!({"target_peer_id":"surface", "payload":{"kind":"probe"}});
    let repeated = state
        .publish(
            "room",
            "relay",
            json!({
                "kind":"targeted_messages", "messages":[message.clone(), message.clone()]
            }),
        )
        .await
        .unwrap_err();
    assert!(repeated.contains("repeats"));
    let oversized = (0..=MAX_TARGETED_MESSAGES_PER_PUBLISH)
        .map(|index| json!({"target_peer_id":format!("surface-{index}"), "payload":{}}))
        .collect::<Vec<_>>();
    let too_many = state
        .publish(
            "room",
            "relay",
            json!({
                "kind":"targeted_messages", "messages":oversized
            }),
        )
        .await
        .unwrap_err();
    assert!(too_many.contains("exceeds"));
    let wrong_role = state.publish("room", "relay", json!({
        "kind":"targeted_messages", "messages":[message, {"target_peer_id":"other-relay", "payload":{}}]
    })).await.unwrap_err();
    assert!(wrong_role.contains("opposite peer role"));
    let wrong_role = state
        .publish("room", "surface", json!({"target_peer_id":"other-surface"}))
        .await
        .unwrap_err();
    assert!(wrong_role.contains("opposite peer role"));
    for peer in [
        &mut relay,
        &mut other_relay,
        &mut surface,
        &mut other_surface,
    ] {
        assert!(peer.receiver.try_recv().is_err());
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(1),
            peer.overflow.notified()
        )
        .await
        .is_err());
    }
}

#[tokio::test]
async fn a_surface_cannot_flood_any_peer_with_a_targeted_batch() {
    let state = BrokerState::default();
    let mut relay = state
        .join("room", "relay", PeerRole::Relay, None, None)
        .await
        .unwrap();
    let mut surface = state
        .join("room", "surface", PeerRole::Surface, None, None)
        .await
        .unwrap();
    drain_presence(&mut relay.receiver).await;
    let messages = vec![json!({"target_peer_id":"relay", "payload":{"kind":"probe"}}); 400];
    let error = state
        .publish(
            "room",
            "surface",
            json!({
                "kind":"targeted_messages", "messages":messages
            }),
        )
        .await
        .unwrap_err();
    assert!(error.contains("single payload"));
    assert!(relay.receiver.try_recv().is_err());
    assert!(surface.receiver.try_recv().is_err());
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(1),
        relay.overflow.notified()
    )
    .await
    .is_err());
    state
        .publish(
            "room",
            "surface",
            json!({"target_peer_id":"relay", "kind":"probe"}),
        )
        .await
        .unwrap();
    assert!(matches!(
        relay.receiver.try_recv().map(decode),
        Ok(ServerMessage::Message {
            from_role: PeerRole::Surface,
            ..
        })
    ));
}

impl UsageEventSink for CollectingSink {
    fn record(&self, event: UsageEvent) {
        self.events
            .lock()
            .expect("sink mutex should not be poisoned")
            .push(event);
    }
}

#[tokio::test]
async fn records_usage_events_for_connect_publish_and_disconnect() {
    let sink = Arc::new(CollectingSink::default());
    let state = BrokerState::with_event_sink(sink.clone());

    state
        .join(
            "room-a",
            "relay-1",
            PeerRole::Relay,
            Some("device-xyz".to_string()),
            None,
        )
        .await
        .expect("relay should join");
    state
        .join("room-a", "phone-1", PeerRole::Surface, None, None)
        .await
        .expect("surface should join");
    state
        .publish(
            "room-a",
            "relay-1",
            json!({"kind": "session_snapshot", "target_peer_id":"phone-1"}),
        )
        .await
        .expect("publish should succeed");
    state.leave("room-a", "phone-1").await;

    let events = sink
        .events
        .lock()
        .expect("sink mutex should not be poisoned")
        .clone();

    let kinds: Vec<_> = events.iter().map(|event| event.event).collect();
    assert_eq!(
        kinds,
        vec![
            UsageEventKind::Connect,
            UsageEventKind::Connect,
            UsageEventKind::Publish,
            UsageEventKind::Disconnect,
        ],
        "expected connect, connect, publish, disconnect; got {events:?}"
    );

    let relay_connect = &events[0];
    assert_eq!(relay_connect.channel_id, "room-a");
    assert_eq!(relay_connect.peer_id, "relay-1");
    assert_eq!(relay_connect.role, PeerRole::Relay);
    assert_eq!(relay_connect.device_id.as_deref(), Some("device-xyz"));
    assert!(relay_connect.ts_ms > 0, "timestamp should be populated");
    assert_eq!(relay_connect.payload_kind, None);

    let publish = &events[2];
    assert_eq!(publish.peer_id, "relay-1");
    assert_eq!(publish.role, PeerRole::Relay);
    assert_eq!(
        publish.device_id.as_deref(),
        Some("device-xyz"),
        "publish should be attributed to the sending device"
    );
    assert_eq!(publish.payload_kind.as_deref(), Some("session_snapshot"));

    let disconnect = &events[3];
    assert_eq!(disconnect.peer_id, "phone-1");
    assert_eq!(disconnect.role, PeerRole::Surface);
    assert_eq!(disconnect.device_id, None);
}

#[tokio::test]
async fn malformed_targeted_publish_is_not_counted_as_activity() {
    let sink = Arc::new(CollectingSink::default());
    let state = BrokerState::with_event_sink(sink.clone());

    state
        .join("room-a", "relay-1", PeerRole::Relay, None, None)
        .await
        .expect("relay should join");

    // A `targeted_messages` frame with an empty target_peer_id fails validation,
    // so the publish is rejected and nothing is delivered.
    let result = state
        .publish(
            "room-a",
            "relay-1",
            json!({
                "kind": "targeted_messages",
                "messages": [
                    { "target_peer_id": "", "payload": {"kind": "encrypted_transcript_delta"} }
                ]
            }),
        )
        .await;
    assert!(
        result.is_err(),
        "malformed targeted publish should be rejected"
    );

    let events = sink
        .events
        .lock()
        .expect("sink mutex should not be poisoned")
        .clone();

    // Only the join's connect event; the rejected frame must not be counted as
    // publish activity.
    assert!(
        events
            .iter()
            .all(|event| event.event != UsageEventKind::Publish),
        "malformed publish must not be recorded as activity; got {events:?}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event == UsageEventKind::Connect)
            .count(),
        1,
        "only the relay connect should be recorded; got {events:?}"
    );
}

#[tokio::test]
async fn a_refused_unaddressed_publish_is_not_counted_as_activity() {
    let sink = Arc::new(CollectingSink::default());
    let state = BrokerState::with_event_sink(sink.clone());

    state
        .join("room-a", "relay-1", PeerRole::Relay, None, None)
        .await
        .expect("relay should join");

    let result = state
        .publish(
            "room-a",
            "relay-1",
            json!({
                "kind": "encrypted_pairing_result",
                "pairing_id": "pair-1",
                "envelope": {"nonce": "n", "ciphertext": "c"},
            }),
        )
        .await;
    assert!(
        result.is_err(),
        "an unaddressed pairing result should be rejected, got {result:?}"
    );

    let events = sink
        .events
        .lock()
        .expect("sink mutex should not be poisoned")
        .clone();
    assert!(
        events
            .iter()
            .all(|event| event.event != UsageEventKind::Publish),
        "a refused publish must not be recorded as activity; got {events:?}"
    );
}

#[tokio::test]
async fn a_directed_remote_action_result_reaches_only_its_target() {
    let state = BrokerState::default();

    let relay = state
        .join("room-a", "relay-1", PeerRole::Relay, None, None)
        .await
        .expect("relay should join");
    let mut bystander = state
        .join("room-a", "phone-other", PeerRole::Surface, None, None)
        .await
        .expect("bystander should join")
        .receiver;
    let mut surface = state
        .join("room-a", "phone-1", PeerRole::Surface, None, None)
        .await
        .expect("surface should join")
        .receiver;
    drop(relay);

    drain_presence(&mut bystander).await;
    state
        .publish(
            "room-a",
            "relay-1",
            json!({
                "kind": "encrypted_remote_action_result",
                "action_id": "action-1",
                "target_peer_id": "phone-1",
                "device_id": "device-1",
                "envelope": {"nonce": "n", "ciphertext": "c"},
            }),
        )
        .await
        .expect("a directed remote action result should publish");

    match surface.try_recv().map(decode) {
        Ok(ServerMessage::Message { payload, .. }) => {
            assert_eq!(payload["kind"], "encrypted_remote_action_result");
        }
        other => panic!("surface should receive the remote action result: {other:?}"),
    }
    assert!(
        bystander.try_recv().is_err(),
        "bystander must not receive ciphertext"
    );
}

#[tokio::test]
async fn routing_rejects_missing_invalid_and_conflicting_targets_before_delivery() {
    let state = BrokerState::default();
    let mut relay = state
        .join("room", "relay", PeerRole::Relay, None, None)
        .await
        .unwrap();
    let mut surface = state
        .join("room", "phone", PeerRole::Surface, None, None)
        .await
        .unwrap();
    drain_presence(&mut relay.receiver).await;
    for payload in [
        json!({"kind":"encrypted_remote_action"}),
        json!({"kind":"future_action"}),
        json!({"kind":"encrypted_remote_action_result", "target_peer_id":null}),
        json!({"kind":"encrypted_remote_action_result", "target_peer_id":42}),
        json!({"kind":"encrypted_remote_action_result", "target_peer_id":""}),
        json!({"kind":"encrypted_remote_action_result", "target_peer_id":" "}),
        json!({"kind":"targeted_messages", "messages":[
            {"target_peer_id":"phone", "payload":{"kind":"encrypted_remote_action_result"}},
            {"target_peer_id":"phone", "payload":{"target_peer_id":"other"}}
        ]}),
        json!({"kind":"targeted_messages", "messages":[
            {"target_peer_id":"phone", "payload":{"kind":"encrypted_remote_action_result"}},
            {"target_peer_id":" ", "payload":{}}
        ]}),
    ] {
        assert!(
            state
                .publish("room", "relay", payload.clone())
                .await
                .is_err(),
            "accepted invalid routing: {payload}"
        );
        assert!(
            surface.receiver.try_recv().is_err(),
            "invalid routing must not deliver even a batch prefix"
        );
    }
    state
        .publish(
            "room",
            "relay",
            json!({"kind":"future_action", "target_peer_id":"offline"}),
        )
        .await
        .unwrap();
    assert!(
        surface.receiver.try_recv().is_err(),
        "an offline target must never fall back to broadcasting"
    );
}

#[tokio::test]
async fn requests_are_delivered_only_to_the_named_relay() {
    let state = BrokerState::default();
    let mut relay = state
        .join("room", "relay", PeerRole::Relay, None, None)
        .await
        .unwrap();
    let mut other_relay = state
        .join("room", "relay-other", PeerRole::Relay, None, None)
        .await
        .unwrap();
    let mut bystander = state
        .join(
            "room",
            "other-phone",
            PeerRole::Surface,
            Some("device-1".into()),
            None,
        )
        .await
        .unwrap();
    let mut surface = state
        .join(
            "room",
            "phone",
            PeerRole::Surface,
            Some("device-1".into()),
            None,
        )
        .await
        .unwrap();
    for receiver in [
        &mut relay.receiver,
        &mut other_relay.receiver,
        &mut bystander.receiver,
    ] {
        drain_presence(receiver).await;
    }
    for kind in ["pairing_request", "encrypted_remote_action"] {
        state.publish("room", "phone", json!({"kind":kind, "target_peer_id":"relay", "envelope":{"nonce":"n", "ciphertext":"c"}})).await.unwrap();
        assert!(
            matches!(relay.receiver.try_recv().map(decode), Ok(ServerMessage::Message {payload, ..}) if payload["kind"] == kind)
        );
        for receiver in [
            &mut other_relay.receiver,
            &mut bystander.receiver,
            &mut surface.receiver,
        ] {
            assert!(
                receiver.try_recv().is_err(),
                "a bystander sharing the room or device must receive no request"
            );
        }
    }
}

#[tokio::test]
async fn force_close_room_removes_all_peers() {
    let state = BrokerState::default();
    state
        .join("room-x", "relay-1", PeerRole::Relay, None, None)
        .await
        .expect("relay");
    state
        .join("room-x", "phone-1", PeerRole::Surface, None, None)
        .await
        .expect("surface");
    assert_eq!(state.room_peer_count("room-x").await, 2);
    let epoch_before = state.access_epoch_for_test().await;
    assert_eq!(
        state
            .force_close_room("room-x", "access_released", "released")
            .await,
        2
    );
    assert_eq!(state.room_peer_count("room-x").await, 0);
    assert!(state.access_epoch_for_test().await > epoch_before);
    let epoch_empty = state.access_epoch_for_test().await;
    assert_eq!(
        state
            .force_close_room("room-x", "access_released", "released")
            .await,
        0
    );
    assert!(
        state.access_epoch_for_test().await > epoch_empty,
        "empty-room force-close must still bump the access epoch"
    );
}

async fn drain_presence(receiver: &mut tokio::sync::mpsc::Receiver<OutboundMessage>) {
    while matches!(
        receiver.try_recv().map(decode),
        Ok(ServerMessage::Presence { .. })
    ) {}
}

fn decode(message: OutboundMessage) -> ServerMessage {
    serde_json::from_str(&message.text).expect("queued server message")
}

#[tokio::test]
async fn message_count_limit_signals_a_slow_peer_without_blocking_a_healthy_peer() {
    let state = BrokerState::default();
    let mut relay = state
        .join("room", "relay", PeerRole::Relay, None, None)
        .await
        .unwrap();
    let slow = state
        .join("room", "slow", PeerRole::Surface, None, None)
        .await
        .unwrap();
    let mut healthy = state
        .join("room", "healthy", PeerRole::Surface, None, None)
        .await
        .unwrap();
    drain_presence(&mut relay.receiver).await;

    for n in 0..=OUTBOUND_QUEUE_CAPACITY {
        state
            .publish(
                "room",
                "relay",
                json!({
                    "kind":"targeted_messages",
                    "messages":[
                        {"target_peer_id":"slow", "payload":{"n":n}},
                        {"target_peer_id":"healthy", "payload":{"n":n}}
                    ]
                }),
            )
            .await
            .unwrap();
        assert!(matches!(
            healthy.receiver.recv().await.map(decode),
            Some(ServerMessage::Message { .. })
        ));
    }
    assert_eq!(slow.receiver.len(), OUTBOUND_QUEUE_CAPACITY);
    tokio::time::timeout(std::time::Duration::from_secs(1), slow.overflow.notified())
        .await
        .unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(10),
        healthy.overflow.notified()
    )
    .await
    .is_err());
}

#[tokio::test]
async fn byte_limit_also_bounds_targeted_messages_and_releases_consumed_bytes() {
    let state = BrokerState::default();
    let mut relay = state
        .join("room", "relay", PeerRole::Relay, None, None)
        .await
        .unwrap();
    let mut slow = state
        .join("room", "slow", PeerRole::Surface, None, None)
        .await
        .unwrap();
    drain_presence(&mut relay.receiver).await;
    let payload = json!({
        "kind": "targeted_messages",
        "messages": [{"target_peer_id": "slow", "payload": {"ciphertext": "x".repeat(64 * 1024 - 256)}}]
    });

    for _ in 0..OUTBOUND_QUEUE_CAPACITY {
        state
            .publish("room", "relay", payload.clone())
            .await
            .unwrap();
        assert!(slow.receiver.recv().await.is_some());
    }
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(10),
        slow.overflow.notified()
    )
    .await
    .is_err());

    for _ in 0..OUTBOUND_QUEUE_CAPACITY {
        state
            .publish("room", "relay", payload.clone())
            .await
            .unwrap();
    }
    assert!(slow.receiver.len() < OUTBOUND_QUEUE_CAPACITY);
    tokio::time::timeout(std::time::Duration::from_secs(1), slow.overflow.notified())
        .await
        .unwrap();
}
