use super::*;
use crate::events::{UsageEvent, UsageEventKind, UsageEventSink};
use crate::protocol::{PresenceKind, ServerMessage};
use serde_json::json;

#[tokio::test]
async fn join_publish_and_leave_broadcast_presence() {
    let state = BrokerState::default();
    let mut relay = state
        .join("room-a", "relay-1", PeerRole::Relay, None)
        .await
        .expect("relay should join");
    assert!(relay.existing_peers.is_empty());

    let mut surface = state
        .join("room-a", "phone-1", PeerRole::Surface, None)
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
        .publish("room-a", "relay-1", json!({"ciphertext":"abc"}))
        .await
        .expect("publish should succeed");
    let relayed = surface
        .receiver
        .recv()
        .await
        .expect("surface should receive message");
    assert_eq!(
        relayed,
        ServerMessage::Message {
            channel_id: "room-a".to_string(),
            from_peer_id: "relay-1".to_string(),
            from_role: PeerRole::Relay,
            payload: json!({"ciphertext":"abc"}),
        }
    );

    state.leave("room-a", "phone-1").await;
    let left = relay
        .receiver
        .recv()
        .await
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
        .join("room-a", "phone-1", PeerRole::Surface, None)
        .await
        .expect("first peer should join");

    let error = state
        .join("room-a", "phone-1", PeerRole::Surface, None)
        .await
        .expect_err("duplicate peer should fail");
    assert!(error.contains("already connected"));

    state
        .join("room-b", "phone-1", PeerRole::Surface, None)
        .await
        .expect("same peer id in another channel should work");
}

#[tokio::test]
async fn targeted_messages_publish_only_to_listed_peers() {
    let state = BrokerState::default();
    let mut surface_a = state
        .join("room-a", "surface-a", PeerRole::Surface, None)
        .await
        .expect("surface a should join");
    let mut surface_b = state
        .join("room-a", "surface-b", PeerRole::Surface, None)
        .await
        .expect("surface b should join");
    let mut surface_c = state
        .join("room-a", "surface-c", PeerRole::Surface, None)
        .await
        .expect("surface c should join");
    let mut relay = state
        .join("room-a", "relay-1", PeerRole::Relay, None)
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
        surface_a.receiver.recv().await,
        Some(ServerMessage::Message {
            channel_id: "room-a".to_string(),
            from_peer_id: "relay-1".to_string(),
            from_role: PeerRole::Relay,
            payload: json!({"kind": "encrypted_transcript_delta", "value": 1}),
        })
    );
    assert_eq!(
        surface_c.receiver.recv().await,
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
        )
        .await
        .expect("relay should join");
    state
        .join("room-a", "phone-1", PeerRole::Surface, None)
        .await
        .expect("surface should join");
    state
        .publish("room-a", "relay-1", json!({"kind": "session_snapshot"}))
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
        .join("room-a", "relay-1", PeerRole::Relay, None)
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

async fn drain_presence(receiver: &mut tokio::sync::mpsc::UnboundedReceiver<ServerMessage>) {
    while matches!(receiver.try_recv(), Ok(ServerMessage::Presence { .. })) {}
}
