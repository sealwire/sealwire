use super::*;

#[test]
fn remote_connections_are_always_e2ee() {
    let profile = SecurityProfile::private();
    assert_eq!(profile.mode(), SecurityMode::Private);
    assert!(profile.e2ee_enabled());
    assert!(!profile.broker_can_read_content());
    assert!(!profile.audit_enabled());
}

#[test]
fn plaintext_and_unknown_modes_are_rejected() {
    assert!(validate_security_mode("managed").is_err());
    assert!(validate_security_mode("unknown").is_err());
    assert!(validate_security_mode("private").is_ok());
}
