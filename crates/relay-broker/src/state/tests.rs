use super::*;
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
