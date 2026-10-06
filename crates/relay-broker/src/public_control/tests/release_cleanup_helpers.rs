use super::{
    sanitize_persistence_error, shared_release_cleanup_after_save_error,
    target_access_fully_cleared, PersistedRelayRegistration, PublicControlStateStore,
};

#[test]
fn shared_release_cleanup_checks_reload_forced_before_target_cleared() {
    // Reload-unknown + in-memory target-absent must NOT succeed.
    assert!(shared_release_cleanup_after_save_error(true, true)
        .unwrap_err()
        .contains("reload-uncertain"));
    assert!(shared_release_cleanup_after_save_error(true, false)
        .unwrap_err()
        .contains("reload-uncertain"));
    // Successful reconcile + target gone ⇒ effective success.
    assert!(shared_release_cleanup_after_save_error(false, true).is_ok());
    // Successful reconcile + target still present ⇒ unavailable/retry.
    assert!(shared_release_cleanup_after_save_error(false, false)
        .unwrap_err()
        .contains("target still present"));
}

#[test]
fn target_access_fully_cleared_is_true_only_when_reg_and_grants_gone() {
    let empty = PublicControlStateStore::default();
    assert!(target_access_fully_cleared(&empty, "relay-a", "room-a"));

    let mut with_reg = PublicControlStateStore::default();
    with_reg.relay_registrations_by_hash.insert(
        "hash".to_string(),
        PersistedRelayRegistration {
            relay_id: "relay-a".to_string(),
            broker_room_id: "room-a".to_string(),
            refresh_token_hash: "hash".to_string(),
            created_at: 1,
            relay_label: None,
            relay_verify_key: None,
        },
    );
    assert!(!target_access_fully_cleared(&with_reg, "relay-a", "room-a"));
    assert!(target_access_fully_cleared(&with_reg, "relay-b", "room-a"));
}

#[test]
fn sanitize_persistence_error_keeps_redacted_operator_class() {
    assert!(sanitize_persistence_error(
        "failed to write /var/lib/secret/state.json: permission denied".into()
    )
    .contains("public control-plane persistence failed"));
    assert!(!sanitize_persistence_error(
        "failed to write /var/lib/secret/state.json: permission denied".into()
    )
    .contains("/var/lib"));
    assert_eq!(
        sanitize_persistence_error(
            "public control-plane persistence failed (reload-uncertain)".into()
        ),
        "public control-plane persistence failed (reload-uncertain)"
    );
    assert_eq!(
        sanitize_persistence_error(
            "public control-plane persistence failed (target still present)".into()
        ),
        "public control-plane persistence failed (target still present)"
    );
}
