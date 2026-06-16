use super::*;
use crate::auth::AuthConfig;
use axum::http::{header, header::HeaderName, Method, StatusCode};
use relay_http::{
    apply_standard_security_headers, build_content_security_policy, DEFAULT_CONNECT_SRC,
    PERMISSIONS_POLICY, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS,
};

fn test_auth() -> AuthConfig {
    AuthConfig::from_parts(
        Some("secret".to_string()),
        None,
        "127.0.0.1".parse().expect("loopback should parse"),
    )
    .expect("auth config should parse")
}

fn cookie_headers() -> HeaderMap {
    let auth = test_auth();
    let set_cookie = auth
        .issue_session_cookie("secret", false)
        .expect("cookie issuance should succeed")
        .expect("auth-enabled config should issue a cookie");
    let cookie = set_cookie
        .to_str()
        .expect("cookie header should be utf-8")
        .split(';')
        .next()
        .expect("cookie should have a name=value pair")
        .to_string();
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8787"));
    headers.insert(header::COOKIE, HeaderValue::from_str(&cookie).unwrap());
    headers
}

#[test]
fn security_headers_are_applied() {
    let mut headers = HeaderMap::new();
    let config = SecurityHeadersConfig::default();
    apply_standard_security_headers(
        &mut headers,
        &config.content_security_policy,
        &config.strict_transport_security,
        config.enable_hsts,
        false,
    );

    assert_eq!(
        headers
            .get("content-security-policy")
            .and_then(|value| value.to_str().ok()),
        Some(build_content_security_policy(DEFAULT_CONNECT_SRC).as_str())
    );
    assert_eq!(
        headers
            .get("permissions-policy")
            .and_then(|value| value.to_str().ok()),
        Some(PERMISSIONS_POLICY)
    );
    assert_eq!(
        headers
            .get("referrer-policy")
            .and_then(|value| value.to_str().ok()),
        Some(REFERRER_POLICY)
    );
    assert_eq!(
        headers
            .get("x-content-type-options")
            .and_then(|value| value.to_str().ok()),
        Some(X_CONTENT_TYPE_OPTIONS)
    );
    assert!(!headers.contains_key("strict-transport-security"));
}

#[test]
fn strict_transport_security_only_applies_when_enabled_for_https_requests() {
    let mut secure_headers = HeaderMap::new();
    let secure_config = SecurityHeadersConfig::from_parts(
        true,
        None,
        Some("max-age=86400".to_string()),
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
    .expect("custom HSTS config should parse");
    apply_standard_security_headers(
        &mut secure_headers,
        &secure_config.content_security_policy,
        &secure_config.strict_transport_security,
        secure_config.enable_hsts,
        true,
    );
    assert_eq!(
        secure_headers
            .get("strict-transport-security")
            .and_then(|value| value.to_str().ok()),
        Some("max-age=86400")
    );

    let mut insecure_headers = HeaderMap::new();
    let insecure_config = SecurityHeadersConfig::from_parts(
        true,
        None,
        Some("max-age=86400".to_string()),
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
    .expect("custom HSTS config should parse");
    apply_standard_security_headers(
        &mut insecure_headers,
        &insecure_config.content_security_policy,
        &insecure_config.strict_transport_security,
        insecure_config.enable_hsts,
        false,
    );
    assert!(!insecure_headers.contains_key("strict-transport-security"));
}

#[test]
fn cache_control_policy_for_static_surface() {
    // Hashed bundles are immutable — but ONLY on success.
    assert_eq!(
        cache_control_for("/static/assets/app-deadbeef.js", StatusCode::OK),
        Some("public, max-age=31536000, immutable")
    );
    // The bug being guarded: a missing hashed asset must NOT be cached as
    // immutable (a year-long negative cache).
    assert_eq!(
        cache_control_for("/static/assets/app-deadbeef.js", StatusCode::NOT_FOUND),
        None
    );
    // The HTML shell and other non-hashed static files revalidate.
    assert_eq!(cache_control_for("/", StatusCode::OK), Some("no-cache"));
    assert_eq!(
        cache_control_for("/index.html", StatusCode::OK),
        Some("no-cache")
    );
    // Non-2xx for those revalidating paths is also left untouched.
    assert_eq!(cache_control_for("/missing", StatusCode::NOT_FOUND), None);
    // API responses (JSON + the SSE stream) manage their own freshness.
    assert_eq!(cache_control_for("/api/session", StatusCode::OK), None);
    assert_eq!(cache_control_for("/api/stream", StatusCode::OK), None);
}

#[test]
fn content_security_policy_can_override_connect_src() {
    let mut headers = HeaderMap::new();
    let connect_src = "'self' https://relay.example.com wss://broker.example.com";
    let config = SecurityHeadersConfig::from_parts(
        false,
        Some(connect_src.to_string()),
        None,
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
    .expect("custom CSP config should parse");
    apply_standard_security_headers(
        &mut headers,
        &config.content_security_policy,
        &config.strict_transport_security,
        config.enable_hsts,
        false,
    );

    assert_eq!(
        headers
            .get("content-security-policy")
            .and_then(|value| value.to_str().ok()),
        Some(build_content_security_policy(connect_src).as_str())
    );
}

#[test]
fn forwarded_https_is_treated_as_secure() {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-forwarded-proto"),
        HeaderValue::from_static("https"),
    );

    assert!(request_uses_https(&headers, Some(&Uri::from_static("/"))));
    assert!(!request_uses_https(
        &HeaderMap::new(),
        Some(&Uri::from_static("/"))
    ));
}

#[test]
fn forwarded_and_forwarded_ssl_headers_are_treated_as_secure() {
    let mut forwarded_headers = HeaderMap::new();
    forwarded_headers.insert(
        HeaderName::from_static("forwarded"),
        HeaderValue::from_static("for=203.0.113.9;proto=https"),
    );
    assert!(request_uses_https(
        &forwarded_headers,
        Some(&Uri::from_static("/"))
    ));

    let mut forwarded_ssl_headers = HeaderMap::new();
    forwarded_ssl_headers.insert(
        HeaderName::from_static("x-forwarded-ssl"),
        HeaderValue::from_static("on"),
    );
    assert!(request_uses_https(
        &forwarded_ssl_headers,
        Some(&Uri::from_static("/"))
    ));
}

#[test]
fn invalid_security_header_overrides_are_rejected() {
    let csp_error = SecurityHeadersConfig::from_parts(
        false,
        Some("https://relay.example.com\r\nx".to_string()),
        None,
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
    .expect_err("invalid CSP override should fail");
    assert!(csp_error.contains(CSP_CONNECT_SRC_ENV));

    let hsts_error = SecurityHeadersConfig::from_parts(
        true,
        None,
        Some("max-age=86400\r\nx".to_string()),
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
    .expect_err("invalid HSTS override should fail");
    assert!(hsts_error.contains(HSTS_VALUE_ENV));
}

#[test]
fn csrf_protection_rejects_cookie_authenticated_post_without_csrf_header() {
    let auth = test_auth();
    let mut headers = cookie_headers();
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://127.0.0.1:8787"),
    );

    let error = authorize_csrf_protection(
        &auth,
        &Method::POST,
        &headers,
        &Uri::from_static("/api/session/message"),
    )
    .expect_err("cookie-authenticated post should require csrf header");

    assert_eq!(error.0, StatusCode::FORBIDDEN);
    assert_eq!(error.1 .0.error.code, "csrf_rejected");
}

#[test]
fn csrf_protection_allows_cookie_authenticated_post_with_same_origin_and_header() {
    let auth = test_auth();
    let mut headers = cookie_headers();
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://127.0.0.1:8787"),
    );
    headers.insert(
        HeaderName::from_static(CSRF_HEADER_NAME),
        HeaderValue::from_static(CSRF_HEADER_VALUE),
    );

    assert!(authorize_csrf_protection(
        &auth,
        &Method::POST,
        &headers,
        &Uri::from_static("/api/session/message"),
    )
    .is_ok());
}

#[test]
fn csrf_protection_allows_matching_referer_when_origin_is_missing() {
    let auth = test_auth();
    let mut headers = cookie_headers();
    headers.insert(
        header::REFERER,
        HeaderValue::from_static("http://127.0.0.1:8787/app?tab=remote"),
    );
    headers.insert(
        HeaderName::from_static(CSRF_HEADER_NAME),
        HeaderValue::from_static(CSRF_HEADER_VALUE),
    );

    assert!(authorize_csrf_protection(
        &auth,
        &Method::DELETE,
        &headers,
        &Uri::from_static("/api/auth/session"),
    )
    .is_ok());
}

#[test]
fn csrf_protection_rejects_cross_origin_cookie_authenticated_post() {
    let auth = test_auth();
    let mut headers = cookie_headers();
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("https://evil.example"),
    );
    headers.insert(
        HeaderName::from_static(CSRF_HEADER_NAME),
        HeaderValue::from_static(CSRF_HEADER_VALUE),
    );

    let error = authorize_csrf_protection(
        &auth,
        &Method::POST,
        &headers,
        &Uri::from_static("/api/session/start"),
    )
    .expect_err("cross-origin cookie-authenticated post should be rejected");

    assert_eq!(error.0, StatusCode::FORBIDDEN);
    assert_eq!(error.1 .0.error.code, "csrf_rejected");
}

#[test]
fn csrf_protection_does_not_apply_to_bearer_authenticated_post() {
    let auth = test_auth();
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8787"));
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer secret"),
    );

    assert!(authorize_csrf_protection(
        &auth,
        &Method::POST,
        &headers,
        &Uri::from_static("/api/session/message"),
    )
    .is_ok());
}

#[test]
fn embedded_asset_content_type_serves_png_as_image() {
    // The brand logo (sealwire_logo.png) is embedded and served by the LOCAL relay
    // as the favicon / apple-touch-icon. Without an explicit arm it falls through
    // to application/octet-stream, which some icon contexts reject — so this guards
    // the mapping the broker's ServeDir gets for free but the embedded server doesn't.
    assert_eq!(
        embedded_asset_content_type("sealwire_logo.png"),
        "image/png"
    );
    assert_eq!(
        embedded_asset_content_type("nested/dir/icon.svg"),
        "image/svg+xml"
    );
    assert_eq!(
        embedded_asset_content_type("unknown.bin"),
        "application/octet-stream"
    );
}
