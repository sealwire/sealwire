use super::*;
use axum::http::{HeaderValue, Uri};
use std::net::{IpAddr, Ipv4Addr};

fn uri(path: &str) -> Uri {
    path.parse().expect("uri should parse")
}

#[test]
fn disabled_auth_allows_requests() {
    let auth = AuthConfig {
        token: None,
        insecure_no_auth_override: false,
    };
    let headers = HeaderMap::new();

    assert!(auth.authorize(&headers, &uri("/api/session")).is_ok());
}

#[test]
fn bearer_header_authorizes_request() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer secret"),
    );

    assert!(auth.authorize(&headers, &uri("/api/session")).is_ok());
}

#[test]
fn invalid_token_is_rejected() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
    };
    let headers = HeaderMap::new();
    let error = auth
        .authorize(&headers, &uri("/api/session"))
        .expect_err("missing token should be rejected");

    assert_eq!(error.0, StatusCode::UNAUTHORIZED);
    assert_eq!(error.1 .0.error.code, "unauthorized");
}

#[test]
fn session_cookie_authorizes_request() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
    };
    let set_cookie = auth
        .issue_session_cookie("secret", false)
        .expect("cookie issuance should succeed")
        .expect("auth-enabled config should issue a cookie");
    let cookie_value = set_cookie.to_str().expect("cookie header should be utf-8");
    let session_cookie = cookie_value
        .split(';')
        .next()
        .expect("set-cookie should include name=value");

    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(session_cookie).unwrap(),
    );

    assert!(auth.authorize(&headers, &uri("/api/session")).is_ok());

    let view = auth.session_view(&headers);
    assert!(view.auth_required);
    assert!(view.authenticated);
    assert!(view.cookie_session);
}

#[test]
fn session_cookie_uses_secure_attribute_for_https() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
    };
    let set_cookie = auth
        .issue_session_cookie("secret", true)
        .expect("cookie issuance should succeed")
        .expect("auth-enabled config should issue a cookie");
    let header = set_cookie.to_str().expect("cookie header should be utf-8");

    assert!(header.contains("Secure"));
    assert!(header.contains("HttpOnly"));
    assert!(header.contains("SameSite=Strict"));
}

#[test]
fn invalid_session_cookie_is_rejected() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_static("agent_relay_session=not-a-real-cookie"),
    );

    let error = auth
        .authorize(&headers, &uri("/api/session"))
        .expect_err("invalid cookie should be rejected");

    assert_eq!(error.0, StatusCode::UNAUTHORIZED);
}

#[test]
fn bearer_header_marks_session_as_authenticated_without_cookie_session() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer secret"),
    );

    let view = auth.session_view(&headers);

    assert!(view.auth_required);
    assert!(view.authenticated);
    assert!(!view.cookie_session);
    assert!(auth.authenticates_with_bearer(&headers));
    assert!(!auth.authenticates_with_cookie(&headers));
}

#[test]
fn expired_session_cookie_is_rejected() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
    };
    let expired_cookie =
        mint_session_cookie_value("secret", now_seconds().saturating_sub(1)).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("agent_relay_session={expired_cookie}")).unwrap(),
    );

    let error = auth
        .authorize(&headers, &uri("/api/session"))
        .expect_err("expired cookie should be rejected");

    assert_eq!(error.0, StatusCode::UNAUTHORIZED);
    assert!(!auth.authenticates_with_cookie(&headers));
}

#[test]
fn clear_session_cookie_expires_immediately() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
    };
    let clear_cookie = auth.clear_session_cookie(false);
    let header = clear_cookie.to_str().expect("clear cookie should be utf-8");

    assert!(header.contains("Max-Age=0"));
    assert!(header.contains("HttpOnly"));
}

#[test]
fn valid_session_cookie_marks_cookie_authenticated_transport() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
    };
    let set_cookie = auth
        .issue_session_cookie("secret", false)
        .expect("cookie issuance should succeed")
        .expect("auth-enabled config should issue a cookie");
    let cookie = set_cookie
        .to_str()
        .expect("cookie header should be utf-8")
        .split(';')
        .next()
        .expect("set-cookie should include name=value");

    let mut headers = HeaderMap::new();
    headers.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());

    assert!(auth.authenticates_with_cookie(&headers));
    assert!(!auth.authenticates_with_bearer(&headers));
}

#[test]
fn access_token_query_is_rejected() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
    };
    let headers = HeaderMap::new();
    let error = auth
        .authorize(&headers, &uri("/api/stream?access_token=secret"))
        .expect_err("query tokens should no longer authorize the stream");

    assert_eq!(error.0, StatusCode::UNAUTHORIZED);
    assert_eq!(error.1 .0.error.code, "unauthorized");
}

#[test]
fn disabled_auth_reports_authenticated_without_cookie_session() {
    let auth = AuthConfig {
        token: None,
        insecure_no_auth_override: false,
    };
    let view = auth.session_view(&HeaderMap::new());

    assert!(!view.auth_required);
    assert!(view.authenticated);
    assert!(!view.cookie_session);
}

#[test]
fn loopback_bind_allows_missing_token() {
    let auth = AuthConfig::from_parts(None, None, IpAddr::V4(Ipv4Addr::LOCALHOST))
        .expect("loopback bind should allow missing auth");

    assert!(!auth.enabled());
    assert!(!auth.insecure_no_auth_override_active());
}

#[test]
fn non_loopback_bind_requires_token_by_default() {
    let error = AuthConfig::from_parts(None, None, IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)))
        .expect_err("non-loopback bind should require auth");

    assert!(error.contains("RELAY_API_TOKEN"));
}

#[test]
fn non_loopback_bind_allows_explicit_insecure_override() {
    let auth = AuthConfig::from_parts(
        None,
        Some("1".to_string()),
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
    )
    .expect("explicit insecure override should allow startup");

    assert!(!auth.enabled());
    assert!(auth.insecure_no_auth_override_active());
}

#[test]
fn non_loopback_bind_accepts_token() {
    let auth = AuthConfig::from_parts(
        Some("secret".to_string()),
        None,
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, 12)),
    )
    .expect("non-loopback bind should accept explicit auth");

    assert!(auth.enabled());
    assert!(!auth.insecure_no_auth_override_active());
}

#[test]
fn invalid_insecure_override_value_is_rejected() {
    let error = AuthConfig::from_parts(
        None,
        Some("maybe".to_string()),
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, 12)),
    )
    .expect_err("invalid override values should be rejected");

    assert!(error.contains("RELAY_ALLOW_INSECURE_NO_AUTH"));
}
