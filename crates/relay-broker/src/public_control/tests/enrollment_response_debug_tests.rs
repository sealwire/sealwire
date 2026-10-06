use super::*;

#[test]
fn relay_enrollment_response_debug_redacts_refresh_token() {
    let response = RelayEnrollmentResponse {
        relay_id: "r1".into(),
        broker_room_id: "room".into(),
        relay_refresh_token: "secret-refresh-token".into(),
        created_at: 1,
        relay_label: None,
    };
    let rendered = format!("{response:?}");
    assert!(!rendered.contains("secret-refresh-token"));
    assert!(rendered.contains("redacted"));
}
