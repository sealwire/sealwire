use std::net::SocketAddr;

use axum::{http::HeaderValue, middleware, routing::get, Router};
use tokio::net::TcpListener;

use super::*;

// Test-only value; shaped like a real one so it passes validation.
const SECRET: &str = "Test0nly-origin-secret-0123456789abcdefXYZ";

fn enforced() -> OriginGuard {
    OriginGuard::from_config(None, Some(SECRET), false).expect("valid config should enforce")
}

fn edge_headers(values: &[&str]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for value in values {
        headers.append(
            DEFAULT_ORIGIN_AUTH_HEADER,
            HeaderValue::from_str(value).expect("test header value"),
        );
    }
    headers
}

fn config_error(header: Option<&str>, secret: Option<&str>, require: bool) -> String {
    match OriginGuard::from_config(header, secret, require) {
        Ok(guard) => panic!("expected a config error for header={header:?}, got {guard:?}"),
        Err(error) => error,
    }
}

#[test]
fn nothing_configured_leaves_the_guard_off() {
    let guard = OriginGuard::from_config(None, None, false).expect("empty config is valid");
    assert!(!guard.is_enforced());
    assert!(!guard.is_misconfigured());
    assert_eq!(guard.verify(&HeaderMap::new()), Ok(()));
}

#[test]
fn only_one_exact_copy_of_the_secret_passes() {
    let guard = enforced();
    assert!(guard.is_enforced());
    assert_eq!(guard.verify(&edge_headers(&[SECRET])), Ok(()));

    let folded = format!("{SECRET},{SECRET}");
    let extended = format!("{SECRET}x");
    let truncated = &SECRET[..SECRET.len() - 1];
    let cases: [(&[&str], OriginAuthFailure); 7] = [
        (&[], OriginAuthFailure::Missing),
        (&[SECRET, SECRET], OriginAuthFailure::Duplicate),
        (&["wrong", SECRET], OriginAuthFailure::Duplicate),
        (&[&folded], OriginAuthFailure::Mismatch),
        (&[&extended], OriginAuthFailure::Mismatch),
        (&[truncated], OriginAuthFailure::Mismatch),
        (&[""], OriginAuthFailure::Mismatch),
    ];
    for (values, expected) in cases {
        assert_eq!(
            guard.verify(&edge_headers(values)),
            Err(expected),
            "values: {values:?}"
        );
    }
}

#[test]
fn a_custom_header_name_is_normalized_and_replaces_the_default() {
    let guard = OriginGuard::from_config(Some("X-Edge-Auth"), Some(SECRET), false)
        .expect("custom header should be accepted");
    let mut headers = HeaderMap::new();
    headers.insert("x-edge-auth", HeaderValue::from_static(SECRET));
    assert_eq!(guard.verify(&headers), Ok(()));
    assert_eq!(
        guard.verify(&edge_headers(&[SECRET])),
        Err(OriginAuthFailure::Missing)
    );
}

#[test]
fn require_flag_accepts_a_configured_secret() {
    let guard = OriginGuard::from_config(None, Some(SECRET), true).expect("required and present");
    assert!(guard.is_enforced());
}

#[test]
fn partial_or_required_but_missing_config_is_an_error_not_a_silent_disable() {
    assert!(config_error(None, None, true).contains(REQUIRE_ORIGIN_AUTH_ENV));
    assert!(config_error(Some("x-edge-auth"), None, false).contains(ORIGIN_AUTH_HEADER_ENV));
    assert!(config_error(None, Some(""), false).contains("empty"));
    assert!(config_error(Some(""), Some(SECRET), false).contains("empty"));
}

#[test]
fn an_empty_require_flag_is_an_error_not_off() {
    for empty in ["", "  "] {
        let error = OriginGuard::from_env_values(None, None, Some(empty))
            .expect_err("empty require flag must not read as off");
        assert!(error.contains(REQUIRE_ORIGIN_AUTH_ENV), "{error}");
        assert!(OriginGuard::from_env_values(None, Some(SECRET), Some(empty)).is_err());
    }
    let off = OriginGuard::from_env_values(None, None, Some("0")).expect("explicit off is valid");
    assert!(!off.is_enforced());
    let absent = OriginGuard::from_env_values(None, None, None).expect("absent is valid");
    assert!(!absent.is_enforced());
}

#[test]
fn require_flag_typos_fail_closed() {
    assert!(crate::parse_bool_value(REQUIRE_ORIGIN_AUTH_ENV, Some("maybe"), false).is_err());
    assert_eq!(
        crate::parse_bool_value(REQUIRE_ORIGIN_AUTH_ENV, Some(" ON "), false),
        Ok(true)
    );
}

#[test]
fn weak_or_unsafe_secrets_are_rejected_without_echoing_them() {
    let too_long = "Ab0-".repeat(129);
    let rejected = [
        "Short0nly-secret".to_string(),
        too_long,
        format!("{SECRET}\n"),
        format!(" {SECRET}"),
        format!("{SECRET},more"),
        format!("{SECRET}\""),
        format!("{SECRET}é"),
        "change-me-change-me-change-me-change-me".to_string(),
    ];
    for secret in &rejected {
        let error = config_error(None, Some(secret), false);
        assert!(error.contains(ORIGIN_AUTH_SECRET_ENV), "{error}");
        assert!(
            !error.contains(secret.trim()) && !error.contains(SECRET),
            "error must not echo the secret: {error}"
        );
    }
}

#[test]
fn reserved_or_malformed_header_names_are_rejected() {
    for name in [
        "authorization",
        "Cookie",
        "host",
        "upgrade",
        "cf-connecting-ip",
        "x-forwarded-for",
        "sec-websocket-key",
        "content-type",
        "x edge",
        "x_edge",
        "-x-edge",
        &"x".repeat(MAX_HEADER_NAME_LEN + 1),
    ] {
        let error = config_error(Some(name), Some(SECRET), false);
        assert!(error.contains(ORIGIN_AUTH_HEADER_ENV), "{name}: {error}");
        assert!(!error.contains(SECRET), "{error}");
    }
}

#[test]
fn debug_output_redacts_the_secret_and_its_digest() {
    let rendered = format!("{:?}", enforced());
    let digest_hex = relay_util::sha256_hex(SECRET);
    assert!(rendered.contains(DEFAULT_ORIGIN_AUTH_HEADER), "{rendered}");
    assert!(!rendered.contains(SECRET), "{rendered}");
    assert!(!rendered.contains(&digest_hex[..16]), "{rendered}");
}

async fn saw_edge_header(headers: HeaderMap) -> &'static str {
    if headers.contains_key(DEFAULT_ORIGIN_AUTH_HEADER) {
        "handler saw the edge header"
    } else {
        "handler did not see the edge header"
    }
}

async fn spawn_guarded(guard: OriginGuard) -> SocketAddr {
    let router = Router::new()
        .route("/api/health", get(saw_edge_header))
        .route("/probe", get(saw_edge_header))
        .layer(middleware::from_fn_with_state(guard, enforce_origin_auth));
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener address");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });
    address
}

async fn get_status_and_body(
    address: SocketAddr,
    path: &str,
    secret: Option<&str>,
) -> (u16, String) {
    let mut request = reqwest::Client::new().get(format!("http://{address}{path}"));
    if let Some(secret) = secret {
        request = request.header(DEFAULT_ORIGIN_AUTH_HEADER, secret);
    }
    let response = request.send().await.expect("request should complete");
    let status = response.status().as_u16();
    (status, response.text().await.expect("body should read"))
}

#[tokio::test]
async fn handlers_never_see_the_edge_header() {
    let address = spawn_guarded(enforced()).await;
    for path in ["/probe", "/api/health"] {
        assert_eq!(
            get_status_and_body(address, path, Some(SECRET)).await,
            (200, "handler did not see the edge header".to_string()),
            "{path}"
        );
    }
}

#[tokio::test]
async fn refusal_does_not_reveal_the_header_or_secret() {
    let address = spawn_guarded(enforced()).await;
    let (status, body) = get_status_and_body(address, "/probe", Some("wrong")).await;
    assert_eq!(status, 403);
    assert!(!body.contains(SECRET), "{body}");
    assert!(!body.contains(DEFAULT_ORIGIN_AUTH_HEADER), "{body}");
}

#[tokio::test]
async fn readiness_is_exempt_but_nothing_else_is() {
    let address = spawn_guarded(enforced()).await;
    assert_eq!(
        get_status_and_body(address, "/api/health", None).await.0,
        200
    );
    assert_eq!(get_status_and_body(address, "/probe", None).await.0, 403);
    assert_eq!(
        get_status_and_body(address, "/api/health/", None).await.0,
        403
    );
}

#[tokio::test]
async fn a_fail_closed_guard_refuses_even_a_correct_header_but_lets_readiness_report() {
    let address = spawn_guarded(OriginGuard::fail_closed()).await;
    assert_eq!(
        get_status_and_body(address, "/probe", Some(SECRET)).await.0,
        503
    );
    assert_eq!(
        get_status_and_body(address, "/api/health", None).await.0,
        200
    );
}

#[tokio::test]
async fn a_disabled_guard_changes_nothing() {
    let address = spawn_guarded(OriginGuard::disabled()).await;
    assert_eq!(get_status_and_body(address, "/probe", None).await.0, 200);
}
