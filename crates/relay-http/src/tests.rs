use super::*;
use axum::http::{HeaderValue, Uri};

#[test]
fn request_uses_https_accepts_forwarded_headers() {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-forwarded-proto"),
        HeaderValue::from_static("https"),
    );
    assert!(request_uses_https(&headers, None));

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("forwarded"),
        HeaderValue::from_static("for=203.0.113.9;proto=https"),
    );
    assert!(request_uses_https(&headers, None));
}

#[test]
fn request_origin_uses_host_or_uri_authority() {
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("relay.example.com"));
    assert_eq!(
        request_origin(&headers, None).as_deref(),
        Some("http://relay.example.com")
    );

    let uri = Uri::from_static("https://relay.example.com/api/session");
    assert_eq!(
        request_origin(&HeaderMap::new(), Some(&uri)).as_deref(),
        Some("https://relay.example.com")
    );
}

#[test]
fn header_origin_normalizes_origin_and_referer() {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("https://relay.example.com"),
    );
    headers.insert(
        header::REFERER,
        HeaderValue::from_static("https://relay.example.com/app?tab=remote"),
    );
    assert_eq!(
        header_origin(&headers, header::ORIGIN).as_deref(),
        Some("https://relay.example.com")
    );
    assert_eq!(
        header_origin(&headers, header::REFERER).as_deref(),
        Some("https://relay.example.com")
    );
}

#[test]
fn validated_security_header_values_use_defaults_and_validate_inputs() {
    let values = validated_security_header_values(None, None, "CSP_ENV", "HSTS_ENV")
        .expect("default security header values should be valid");
    assert_eq!(
        values.content_security_policy.to_str().ok(),
        Some(build_content_security_policy(DEFAULT_CONNECT_SRC).as_str())
    );
    assert_eq!(
        values.strict_transport_security.to_str().ok(),
        Some(DEFAULT_HSTS_VALUE)
    );

    let error = validated_security_header_values(
        Some("https://relay.example.com\r\nx"),
        None,
        "CSP_ENV",
        "HSTS_ENV",
    )
    .expect_err("invalid CSP header should fail");
    assert!(error.contains("CSP_ENV"));
}
