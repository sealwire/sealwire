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

// Every route that accepts pasted images must lift axum's 2 MB default body
// limit, or a single retina screenshot 413s before the handler (and its
// friendly size errors) is ever reached. `/api/session/fork` shipped without
// the layer its start/message siblings carry, which capped forking at roughly
// 1.5 MB of image bytes — far under the 8 MB/image the validator advertises.
#[tokio::test]
async fn image_accepting_routes_accept_a_body_over_the_default_limit() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    for route in [
        "/api/session/fork",
        "/api/session/start",
        "/api/session/message",
    ] {
        let project = tempfile::TempDir::new().expect("project tempdir");
        let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
        let relay = std::sync::Arc::new(tokio::sync::RwLock::new(crate::state::RelayState::new(
            project.path().display().to_string(),
            change_tx.clone(),
            crate::state::SecurityProfile::private(),
        )));
        let context = AppContext {
            app: crate::state::AppState::from_parts(
                relay,
                std::collections::HashMap::new(),
                change_tx,
            ),
            auth: test_auth(),
            launch_id: None,
            security_headers: SecurityHeadersConfig::default(),
            host_policy: HostPolicy::loopback_only(),
        };
        let router = build_router(context, WebAssets::Embedded);

        // Comfortably over axum's 2 MB default, comfortably under our 24 MB cap.
        let body = format!(
            r#"{{"source_thread_id":"t","cwd":"/tmp","device_id":"d","padding":"{}"}}"#,
            "a".repeat(3 * 1024 * 1024)
        );
        // Bearer auth (not cookie) so the request clears CSRF and actually
        // reaches the body extractor, which is what the limit guards.
        let response = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(route)
                    .header(header::HOST, "127.0.0.1:8787")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_ne!(
            response.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "{route} must raise the default body limit so a pasted screenshot fits"
        );
    }
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

#[test]
fn release_web_assets_do_not_resolve_the_build_workspace() {
    let assets = select_default_web_assets(None, false, || {
        panic!("release binaries must not resolve their build-time workspace")
    });

    assert!(matches!(assets, WebAssets::Embedded));
}

#[test]
fn debug_web_assets_use_built_workspace_assets_when_present() {
    let workspace = tempfile::tempdir().expect("temporary workspace should be created");
    let web_root = workspace.path().join("web");
    std::fs::create_dir(&web_root).expect("web directory should be created");

    let missing_assets = select_default_web_assets(None, true, || workspace.path().to_path_buf());
    assert!(matches!(missing_assets, WebAssets::Embedded));

    std::fs::write(web_root.join("index.html"), "test").expect("test web index should be written");
    let built_assets = select_default_web_assets(None, true, || workspace.path().to_path_buf());
    assert!(matches!(built_assets, WebAssets::Directory(path) if path == web_root));
}

#[test]
fn web_root_override_is_trimmed_and_blank_override_falls_through() {
    let overridden = select_default_web_assets(Some("  /x  ".to_string()), false, || {
        panic!("a non-blank override must bypass workspace resolution")
    });
    assert!(matches!(overridden, WebAssets::Directory(path) if path == PathBuf::from("/x")));

    let blank = select_default_web_assets(Some("   ".to_string()), false, || {
        panic!("release binaries must not resolve their build-time workspace")
    });
    assert!(matches!(blank, WebAssets::Embedded));
}

#[test]
fn local_message_images_are_validated_and_canonicalized() {
    let png = BASE64_STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    let images = parse_local_message_images(vec![LocalImageInput {
        data_url: format!("data:image/png;base64,{png}"),
    }])
    .expect("valid PNG data URL should be accepted");

    assert_eq!(
        images,
        vec![ProviderImage {
            media_type: "image/png".to_string(),
            data: png,
        }]
    );
}

#[test]
fn local_start_session_accepts_images_without_changing_the_shared_start_input() {
    let input: LocalStartSessionInput = serde_json::from_value(serde_json::json!({
        "cwd": "/tmp/project",
        "initial_prompt": null,
        "model": "gpt-test",
        "approval_policy": "untrusted",
        "sandbox": "workspace-write",
        "effort": "medium",
        "device_id": "device-1",
        "provider": "codex",
        "images": [{ "data_url": "data:image/png;base64,iVBORw0KGgo=" }]
    }))
    .expect("the local start request should accept image attachments");

    assert_eq!(input.session.cwd.as_deref(), Some("/tmp/project"));
    assert!(input.session.initial_prompt.is_none());
    assert_eq!(input.images.len(), 1);
}

// The local fork endpoint wraps the SHARED ForkSessionInput rather than adding
// an image field to it, so the broker's remote fork payload stays image-free.
// This pins both halves: the wrapper parses images, and the flattened fork
// fields still land on the shared struct.
#[test]
fn local_fork_accepts_images_without_changing_the_shared_fork_input() {
    let input: LocalForkSessionInput = serde_json::from_value(serde_json::json!({
        "source_thread_id": "thread-1",
        "up_to_item_id": "item-4",
        "cwd": "/tmp/project",
        "initial_prompt": "continue here",
        "model": "gpt-test",
        "approval_policy": null,
        "sandbox": null,
        "effort": null,
        "device_id": "device-1",
        "provider": "codex",
        "images": [{ "data_url": "data:image/png;base64,iVBORw0KGgo=" }]
    }))
    .expect("the local fork request should accept image attachments");

    assert_eq!(input.fork.source_thread_id, "thread-1");
    assert_eq!(input.fork.up_to_item_id.as_deref(), Some("item-4"));
    assert_eq!(input.fork.initial_prompt.as_deref(), Some("continue here"));
    assert_eq!(input.images.len(), 1);

    // A remote fork sends no `images` key at all; it must still deserialize.
    let remote: LocalForkSessionInput = serde_json::from_value(serde_json::json!({
        "source_thread_id": "thread-1",
        "cwd": "/tmp/project",
        "initial_prompt": null,
        "model": null,
        "approval_policy": null,
        "sandbox": null,
        "effort": null,
        "device_id": "device-1",
        "provider": "codex"
    }))
    .expect("a fork request without images must still parse");
    assert!(remote.images.is_empty());
}

#[test]
fn local_message_images_reject_spoofed_content_and_unsupported_types() {
    let spoofed = BASE64_STANDARD.encode(b"not a png");
    let error = parse_local_message_images(vec![LocalImageInput {
        data_url: format!("data:image/png;base64,{spoofed}"),
    }])
    .expect_err("MIME spoofing must be rejected");
    assert!(error.contains("do not match"), "{error}");

    let svg = BASE64_STANDARD.encode(b"<svg/>");
    let error = parse_local_message_images(vec![LocalImageInput {
        data_url: format!("data:image/svg+xml;base64,{svg}"),
    }])
    .expect_err("SVG must stay outside the provider image allow-list");
    assert!(error.contains("unsupported"), "{error}");
}

#[test]
fn local_message_images_accept_webp_magic_bytes() {
    let webp = BASE64_STANDARD.encode(b"RIFF\x04\0\0\0WEBP");
    let images = parse_local_message_images(vec![LocalImageInput {
        data_url: format!("data:image/webp;base64,{webp}"),
    }])
    .expect("valid WebP data URL should be accepted");

    assert_eq!(images[0].media_type, "image/webp");
    assert_eq!(images[0].data, webp);
}

#[test]
fn local_message_images_enforce_the_decoded_total_size_limit() {
    fn png_data_url(size: usize) -> String {
        let mut bytes = vec![0; size];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        format!("data:image/png;base64,{}", BASE64_STANDARD.encode(bytes))
    }

    let error = parse_local_message_images(vec![
        LocalImageInput {
            data_url: png_data_url(MAX_LOCAL_MESSAGE_IMAGE_BYTES),
        },
        LocalImageInput {
            data_url: png_data_url(MAX_LOCAL_MESSAGE_IMAGE_BYTES),
        },
        LocalImageInput {
            data_url: png_data_url(8),
        },
    ])
    .expect_err("decoded image bytes over the total limit must be rejected");

    assert!(error.contains("in total"), "{error}");
}

// Session endpoints mapped every non-path-policy failure to 502
// `provider_bridge_error`, so a malformed request and a state conflict both
// read as "the upstream agent broke". 502 invites a retry, which is wrong for
// both: a bad fork point never succeeds, a conflict succeeds only once the
// turn ends.
//
// These cases are driven from the REAL producing sites, not hand-written
// examples — an earlier version of this test used invented phrasings and so
// passed while three real error paths still returned 502.
#[test]
fn session_errors_are_classified_by_cause_not_lumped_into_502() {
    // Conflicts: retryable once the state changes.
    for message in [
        // state/app/fork.rs FORK_BUSY_SOURCE_MSG
        "cannot fork a thread while a turn is in progress".to_string(),
        // state/app/review.rs acquire_session_slot
        "a review is in progress; wait for it to finish before changing the session".to_string(),
        // state/app/mod.rs REVIEW_LOCKED_THREAD_MSG, by constant
        crate::state::REVIEW_LOCKED_THREAD_MSG.to_string(),
    ] {
        let (status, _) = classify_session_error(message.clone());
        assert_eq!(status, StatusCode::CONFLICT, "{message} is a conflict");
    }

    // Caller errors: never succeed on retry.
    for message in [
        // state/app/fork.rs truncate_transcript_at
        "fork point item-9 is not part of the source thread transcript",
        // require_device_id
        "device_id is required",
        // state/app/fork.rs
        "source_thread_id is required",
        // state/app/providers.rs find_thread_provider
        "thread 'abc' was not found on any provider",
        // state/app/providers.rs resolve_provider
        "agent provider 'nope' is not available",
    ] {
        let (status, _) = classify_session_error(message.to_string());
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{message} is a caller error"
        );
    }

    // Path policy keeps its existing 400.
    let (status, _) =
        classify_session_error("/etc is outside this relay's allowed roots".to_string());
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Anything unrecognized is still attributed to the provider — the safe
    // fallback, so an unknown failure is never blamed on the caller.
    for message in [
        "codex app-server exited",
        // Broad needles would have caught these: an upstream failure that
        // happens to be phrased like a caller error must NOT become a 400.
        "codex: model is required for this request",
        "the requested tool is not available in this workspace",
    ] {
        let (status, body) = classify_session_error(message.to_string());
        assert_eq!(
            status,
            StatusCode::BAD_GATEWAY,
            "{message} is an upstream failure"
        );
        assert_eq!(body.0.error.code, "provider_bridge_error");
    }
}

// Regression guard for the layer neither side's unit tests covered: the frontend
// builds a query string and the backend deserializes it, and NOTHING exercised the
// contract between them. That gap is how a query built with `auto_root=1` came to 400
// before the handler ever ran, leaving the panel showing only an error.
#[test]
fn workspace_diff_query_parses_the_url_the_client_actually_builds() {
    use axum::extract::Query;

    let uri: Uri = "/api/workspace/diff?thread_id=thread-a"
        .parse()
        .expect("uri");
    let query: Query<crate::WorkspaceDiffQuery> =
        Query::try_from_uri(&uri).expect("the client's own URL must deserialize");
    assert_eq!(query.0.thread_id.as_deref(), Some("thread-a"));

    // No thread selected is the legacy global view, not a rejection.
    let uri: Uri = "/api/workspace/diff".parse().expect("uri");
    let query: Query<crate::WorkspaceDiffQuery> = Query::try_from_uri(&uri).expect("legacy url");
    assert_eq!(query.0.thread_id, None);

    // Unknown query fields must parse (stale clients) and be ignored.
    let uri: Uri = "/api/workspace/diff?thread_id=t&root=%2Frepo%2Flinked&auto_root=true"
        .parse()
        .expect("uri");
    let query: Query<crate::WorkspaceDiffQuery> =
        Query::try_from_uri(&uri).expect("a stale client's URL must still deserialize");
    assert_eq!(query.0.thread_id.as_deref(), Some("t"));
    assert_eq!(query.0.view_root, None);

    let uri: Uri = "/api/workspace/diff?thread_id=t&view_root=%2Frepo%2Fwt"
        .parse()
        .expect("uri");
    let query: Query<crate::WorkspaceDiffQuery> =
        Query::try_from_uri(&uri).expect("view_root must deserialize");
    assert_eq!(query.0.view_root.as_deref(), Some("/repo/wt"));
}

// thread_id is required: there is no session-less workspace.
#[test]
fn thread_workspace_query_requires_a_thread_and_takes_an_optional_device() {
    use axum::extract::Query;

    let uri: Uri = "/api/thread/workspace?thread_id=thread-a&device_id=phone-1"
        .parse()
        .expect("uri");
    let query: Query<crate::ThreadWorkspaceQuery> = Query::try_from_uri(&uri).expect("url");
    assert_eq!(query.0.thread_id, "thread-a");
    assert_eq!(query.0.device_id.as_deref(), Some("phone-1"));

    // The local operator surface sends no device id.
    let uri: Uri = "/api/thread/workspace?thread_id=thread-a"
        .parse()
        .expect("uri");
    let query: Query<crate::ThreadWorkspaceQuery> = Query::try_from_uri(&uri).expect("local url");
    assert_eq!(query.0.device_id, None);

    assert!(
        Query::<crate::ThreadWorkspaceQuery>::try_from_uri(
            &"/api/thread/workspace".parse::<Uri>().expect("uri")
        )
        .is_err(),
        "answering with no session named would mean guessing which one"
    );
}

/// A rename body that cannot be parsed must be REFUSED, never read as a reset.
///
/// The neighbouring archive/delete handlers take `Option<Json<_>>`, whose rejection type
/// is `Infallible` — it turns a missing content-type, malformed JSON, or a wrong value
/// type into `None`. That is harmless for archive (it defaults to "keep reviewers") and
/// destructive for rename, where the default means "clear the user's title". This pins
/// the rename endpoint to a REQUIRED body so the same shape cannot be copied back in.
#[tokio::test]
async fn rename_thread_refuses_an_unparseable_body_instead_of_clearing_the_name() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    // Each case would deserialize to `RenameThreadInput::default()` (a RESET) under
    // `Option<Json<_>>`, and so would silently delete an existing title.
    let cases: Vec<(&str, Option<&str>, &str)> = vec![
        (
            "body with no content-type",
            None,
            r#"{"name":"Deploy work"}"#,
        ),
        (
            "body with the wrong content-type",
            Some("text/plain"),
            r#"{"name":"Deploy work"}"#,
        ),
        (
            "malformed json",
            Some("application/json"),
            r#"{"name":"Deploy work"#,
        ),
        (
            "wrong value type",
            Some("application/json"),
            r#"{"name":123}"#,
        ),
    ];

    for (label, content_type, body) in cases {
        let project = tempfile::TempDir::new().expect("project tempdir");
        let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
        let relay = std::sync::Arc::new(tokio::sync::RwLock::new(crate::state::RelayState::new(
            project.path().display().to_string(),
            change_tx.clone(),
            crate::state::SecurityProfile::private(),
        )));
        let context = AppContext {
            app: crate::state::AppState::from_parts(
                relay,
                std::collections::HashMap::new(),
                change_tx,
            ),
            auth: test_auth(),
            launch_id: None,
            security_headers: SecurityHeadersConfig::default(),
            host_policy: HostPolicy::loopback_only(),
        };
        let router = build_router(context, WebAssets::Embedded);

        let mut request = Request::builder()
            .method(Method::POST)
            .uri("/api/threads/t1/rename")
            .header(header::HOST, "127.0.0.1:8787")
            .header(header::AUTHORIZATION, "Bearer secret");
        if let Some(content_type) = content_type {
            request = request.header(header::CONTENT_TYPE, content_type);
        }
        let response = router
            .oneshot(
                request
                    .body(Body::from(body))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert!(
            response.status().is_client_error(),
            "{label}: an unparseable rename body must be refused, got {}",
            response.status()
        );
    }
}

/// An omitted `name` is a 4xx, NOT a reset.
///
/// `{}` is a well-formed JSON body, so requiring a body does not catch it; only making
/// `name` a REQUIRED (but nullable) field does. Without that, any client bug, partial
/// write or schema drift that drops the field silently deletes the user's title while
/// answering 200 — the same data-loss class as the swallowed-rejection bug above,
/// reached through a different door.
#[tokio::test]
async fn rename_thread_refuses_a_body_that_omits_the_name_field() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let project = tempfile::TempDir::new().expect("project tempdir");
    let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
    let relay = std::sync::Arc::new(tokio::sync::RwLock::new(crate::state::RelayState::new(
        project.path().display().to_string(),
        change_tx.clone(),
        crate::state::SecurityProfile::private(),
    )));
    let context = AppContext {
        app: crate::state::AppState::from_parts(relay, std::collections::HashMap::new(), change_tx),
        auth: test_auth(),
        launch_id: None,
        security_headers: SecurityHeadersConfig::default(),
        host_policy: HostPolicy::loopback_only(),
    };
    let router = build_router(context, WebAssets::Embedded);

    let response = router
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/threads/t1/rename")
                .header(header::HOST, "127.0.0.1:8787")
                .header(header::AUTHORIZATION, "Bearer secret")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .expect("request should build"),
        )
        .await
        .expect("router should respond");
    assert!(
        response.status().is_client_error(),
        "an omitted name must be refused, not read as a reset (got {})",
        response.status()
    );
}

/// The counterpart: an explicit `{"name": null}` IS the reset, and must still be
/// accepted — dropping the bodyless convenience must not drop the reset itself.
#[tokio::test]
async fn rename_thread_accepts_an_explicit_null_name_as_a_reset() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let project = tempfile::TempDir::new().expect("project tempdir");
    let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
    let relay = std::sync::Arc::new(tokio::sync::RwLock::new(crate::state::RelayState::new(
        project.path().display().to_string(),
        change_tx.clone(),
        crate::state::SecurityProfile::private(),
    )));
    // Rename refuses an id the relay cannot place in a workspace, so the session has to
    // exist for this to reach the reset path at all.
    relay
        .write()
        .await
        .ensure_runtime_for_thread("t1")
        .current_cwd = project.path().display().to_string();
    let context = AppContext {
        app: crate::state::AppState::from_parts(relay, std::collections::HashMap::new(), change_tx),
        auth: test_auth(),
        launch_id: None,
        security_headers: SecurityHeadersConfig::default(),
        host_policy: HostPolicy::loopback_only(),
    };
    let router = build_router(context, WebAssets::Embedded);

    let response = router
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/threads/t1/rename")
                .header(header::HOST, "127.0.0.1:8787")
                .header(header::AUTHORIZATION, "Bearer secret")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"name":null}"#))
                .expect("request should build"),
        )
        .await
        .expect("router should respond");
    assert_eq!(response.status(), StatusCode::OK);
}

// The FIRST frame on `/api/stream` must be built point-in-time, never served from the
// notify fan-out cache.
//
// This is a WIRING test, and it exists because the unit level cannot fail here: both
// `local_snapshot_payload` (shared across one notification's fan-out) and
// `fresh_local_snapshot_payload` (point-in-time) are correct in isolation. The defect is
// handing a CONNECTING surface the shared one — a pairing only the endpoint expresses.
// A snapshot is not a pure function of the revision (`server_time` and `devices_revision`
// come from the clock, and building one runs the expiry sweeps), so a reconnect landing
// in a quiet period would otherwise get a frame built arbitrarily long ago and overwrite
// the state the client just fetched from `/api/session`.
#[tokio::test]
async fn the_first_stream_frame_is_built_fresh_not_served_from_the_fanout_cache() {
    use axum::body::Body;
    use axum::http::Request;
    use futures_util::StreamExt;
    use tower::ServiceExt;

    let project = tempfile::TempDir::new().expect("project tempdir");
    let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
    let relay = std::sync::Arc::new(tokio::sync::RwLock::new(crate::state::RelayState::new(
        project.path().display().to_string(),
        change_tx.clone(),
        crate::state::SecurityProfile::private(),
    )));
    let app =
        crate::state::AppState::from_parts(relay, std::collections::HashMap::new(), change_tx);

    // An earlier notify fan-out warmed the cache, and then the relay went quiet — the
    // revision never moves again, so a naive cache would serve this entry forever.
    let warm = app.local_snapshot_payload().await;
    assert_eq!(app.local_snapshot_build_count(), 1);
    drop(warm);

    let context = AppContext {
        app: app.clone(),
        auth: test_auth(),
        launch_id: None,
        security_headers: SecurityHeadersConfig::default(),
        host_policy: HostPolicy::loopback_only(),
    };
    let router = build_router(context, WebAssets::Embedded);

    let response = router
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/stream?surface_id=surface-1")
                .header(header::HOST, "127.0.0.1:8787")
                .header(header::AUTHORIZATION, "Bearer secret")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("router should respond");
    assert_eq!(response.status(), StatusCode::OK);

    // Read only the first frame; an SSE stream never ends on its own.
    let mut frames = response.into_body().into_data_stream();
    let first = frames
        .next()
        .await
        .expect("the stream must emit an initial frame")
        .expect("the initial frame should read");
    let text = String::from_utf8_lossy(&first);
    assert!(
        text.contains("event: session"),
        "the first frame should be the session snapshot, got: {text}"
    );

    assert_eq!(
        app.local_snapshot_build_count(),
        2,
        "a connecting surface must build its own snapshot; serving the warm fan-out \
         entry would hand it `server_time`/`devices_revision` from an arbitrarily old \
         build and skip the expiry sweeps that building runs"
    );
}

// ---------------------------------------------------------------------------
// Local surface hardening: Host allowlist + CSRF on the unauthenticated path.
// ---------------------------------------------------------------------------

fn no_auth() -> AuthConfig {
    AuthConfig::from_parts(
        None,
        None,
        "127.0.0.1".parse().expect("loopback should parse"),
    )
    .expect("a loopback bind with no token is a valid config")
}

/// Returns the `TempDir` alongside the context: the caller has to hold it for
/// the lifetime of the router, and dropping it cleans the directory up.
fn test_context(auth: AuthConfig, host_policy: HostPolicy) -> (AppContext, tempfile::TempDir) {
    let project = tempfile::TempDir::new().expect("project tempdir");
    let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
    let relay = std::sync::Arc::new(tokio::sync::RwLock::new(crate::state::RelayState::new(
        project.path().display().to_string(),
        change_tx.clone(),
        crate::state::SecurityProfile::private(),
    )));
    let context = AppContext {
        app: crate::state::AppState::from_parts(relay, std::collections::HashMap::new(), change_tx),
        auth,
        launch_id: None,
        security_headers: SecurityHeadersConfig::default(),
        host_policy,
    };
    (context, project)
}

/// DNS rebinding: after the rebind the browser still sends the ATTACKER's
/// hostname, only the resolved IP changed. Asserting on Host (not Origin) is
/// the whole point — `request_origin` derives the expected origin FROM Host,
/// so the same-origin check happily compares `http://evil.example` against
/// itself and passes. Only an allowlist on the Host header stops this.
#[tokio::test]
async fn a_rebound_attacker_host_is_rejected_before_routing() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let (context, _project) = test_context(no_auth(), HostPolicy::loopback_only());
    let router = build_router(context, WebAssets::Embedded);

    let response = router
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/session/start")
                .header(header::HOST, "evil.example")
                // The rebound page's own origin — self-consistent with Host,
                // which is exactly why the Origin check cannot catch it.
                .header(header::ORIGIN, "http://evil.example")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .expect("request should build"),
        )
        .await
        .expect("router should respond");

    assert_eq!(
        response.status(),
        StatusCode::MISDIRECTED_REQUEST,
        "a foreign Host must be refused before any handler runs"
    );
}

#[test]
fn the_host_allowlist_accepts_loopback_names_and_the_configured_bind_host() {
    let policy = HostPolicy::loopback_only();
    for host in [
        "127.0.0.1:8787",
        "127.0.0.1",
        "localhost:8787",
        "localhost",
        "[::1]:8787",
        "[::1]",
        "127.0.0.53:8787",
    ] {
        assert!(
            policy.allows_host(Some(host)),
            "{host} is a loopback name and must be accepted"
        );
    }

    for host in ["evil.example", "evil.example:8787", "10.0.0.4:8787"] {
        assert!(
            !policy.allows_host(Some(host)),
            "{host} must be rejected by a loopback-only policy"
        );
    }

    let bound = HostPolicy::from_parts("192.168.1.166".parse().expect("ip"), None)
        .expect("a non-loopback bind with no explicit list is valid");
    assert!(
        bound.allows_host(Some("anything.example")),
        "a non-loopback bind with no explicit allowlist must not enforce, or every \
         existing reverse-proxy deployment breaks"
    );

    let listed = HostPolicy::from_parts(
        "0.0.0.0".parse().expect("ip"),
        Some("relay.example, other.example".to_string()),
    )
    .expect("an explicit allowlist is valid");
    assert!(listed.allows_host(Some("relay.example")));
    assert!(listed.allows_host(Some("other.example:8787")));
    assert!(
        listed.allows_host(Some("localhost:8787")),
        "loopback stays allowed alongside an explicit list"
    );
    assert!(!listed.allows_host(Some("evil.example")));
}

/// The `!auth.enabled()` short-circuit is what this pins: with no token
/// configured — the default for the laptop UI — a mutating `/api/` request
/// carrying a foreign Origin currently sails straight through.
#[test]
fn csrf_rejects_a_foreign_origin_when_no_token_is_configured() {
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8787"));
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("https://evil.example"),
    );

    let error = authorize_csrf_protection(
        &no_auth(),
        &Method::POST,
        &headers,
        &Uri::from_static("/api/session/start"),
    )
    .expect_err("a foreign origin must be rejected even with auth disabled");

    assert_eq!(error.0, StatusCode::FORBIDDEN);
    assert_eq!(error.1 .0.error.code, "csrf_rejected");
}

/// The counterweight: a browser ALWAYS attaches `Origin` to a cross-site
/// mutating request, so "no Origin at all" is not reachable from a hostile
/// page — it is curl, a Node e2e script, or the Tauri shell. Rejecting those
/// would buy nothing and break every non-browser client.
#[test]
fn csrf_allows_a_mutating_request_that_carries_no_origin_at_all() {
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8787"));

    assert!(
        authorize_csrf_protection(
            &no_auth(),
            &Method::POST,
            &headers,
            &Uri::from_static("/api/session/start"),
        )
        .is_ok(),
        "non-browser clients send no Origin and must keep working"
    );
}

/// `vite.config.js` proxies /api with `changeOrigin: true`, so in dev the
/// browser's Origin is the vite port while Host is rewritten to the relay's —
/// a legitimate mismatch that must keep working.
///
/// The custom header is what makes accepting it safe, and it is why this test
/// sends one: every mutating call from the real frontend goes through
/// `createApiFetch` -> `applyCsrfHeader` (`frontend/local/api.js`). Loopback
/// alone is NOT sufficient — see
/// `another_loopback_page_cannot_post_without_the_csrf_header`.
#[test]
fn csrf_allows_a_loopback_origin_from_the_vite_dev_proxy() {
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8787"));
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://localhost:5173"),
    );
    headers.insert(
        HeaderName::from_static(CSRF_HEADER_NAME),
        HeaderValue::from_static(CSRF_HEADER_VALUE),
    );

    assert!(
        authorize_csrf_protection(
            &no_auth(),
            &Method::POST,
            &headers,
            &Uri::from_static("/api/session/start"),
        )
        .is_ok(),
        "the vite dev proxy must keep working"
    );
}

/// These two routes take no body extractor, so they are CORS "simple
/// requests": no preflight, sendable cross-origin straight from a form.
/// Impact is denial of service — unpair the user's phone — and `device_id` is
/// client-chosen at pairing, so `iphone` is a guessable target.
#[tokio::test]
async fn body_less_revoke_routes_reject_a_cross_origin_form_post() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    for route in [
        "/api/devices/iphone/revoke",
        "/api/devices/iphone/revoke-others",
    ] {
        let (context, _project) = test_context(no_auth(), HostPolicy::loopback_only());
        let router = build_router(context, WebAssets::Embedded);

        let response = router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(route)
                    .header(header::HOST, "127.0.0.1:8787")
                    .header(header::ORIGIN, "https://evil.example")
                    // A real form post: a CORS-simple content type, no preflight.
                    .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "{route} must refuse a cross-origin form post"
        );
    }
}

/// `Origin: null` is what a browser sends from an opaque origin. It is a
/// *declared* origin that names nobody, and it must not be laundered into "no
/// Origin header, therefore a non-browser client" — an ordinary web page can
/// arrange to send it, with no Referer alongside.
///
/// `relay_http::header_origin` collapses `null` to `None` exactly like an
/// absent header, so anything built on it has to re-check the raw header.
/// This is not hypothetical: the first cut of this check did not, and the
/// body-less revoke routes stayed reachable.
#[tokio::test]
async fn an_opaque_origin_is_not_mistaken_for_a_non_browser_client() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let (context, _project) = test_context(no_auth(), HostPolicy::loopback_only());
    let router = build_router(context, WebAssets::Embedded);

    let response = router
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/devices/iphone/revoke")
                .header(header::HOST, "127.0.0.1:8787")
                .header(header::ORIGIN, "null")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("router should respond");

    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "an opaque `Origin: null` must be refused, not treated as undeclared"
    );
}

#[test]
fn an_opaque_or_unparseable_origin_is_refused_rather_than_ignored() {
    for value in ["null", "NULL", "  null  ", "", "not a url"] {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8787"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_str(value).expect("header"),
        );

        assert!(
            authorize_csrf_protection(
                &no_auth(),
                &Method::POST,
                &headers,
                &Uri::from_static("/api/session/start"),
            )
            .is_err(),
            "`Origin: {value}` is declared but names nobody; it must not pass"
        );
    }
}

/// A present-but-opaque `Origin` must not fall through to `Referer`. Origin is
/// the authoritative statement; if it says "opaque", a same-origin Referer
/// alongside it is not a second opinion worth taking.
#[test]
fn an_opaque_origin_does_not_fall_through_to_a_friendly_referer() {
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8787"));
    headers.insert(header::ORIGIN, HeaderValue::from_static("null"));
    headers.insert(
        header::REFERER,
        HeaderValue::from_static("http://127.0.0.1:8787/app"),
    );

    assert!(
        authorize_csrf_protection(
            &no_auth(),
            &Method::POST,
            &headers,
            &Uri::from_static("/api/session/start"),
        )
        .is_err(),
        "Origin is authoritative; a friendly Referer must not rescue an opaque one"
    );
}

/// Loopback is not a trust boundary. Another page served from this machine —
/// a second dev server, a static server showing an untrusted file, a local
/// tool with an XSS — presents `http://localhost:<port>` just as legitimately
/// as vite does. What separates them is the custom header: a cross-origin page
/// cannot set it without a CORS preflight this server never grants.
#[test]
fn another_loopback_page_cannot_post_without_the_csrf_header() {
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8787"));
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://localhost:8000"),
    );

    assert!(
        authorize_csrf_protection(
            &no_auth(),
            &Method::POST,
            &headers,
            &Uri::from_static("/api/session/start"),
        )
        .is_err(),
        "a cross-port loopback origin without the custom header must be refused"
    );
}

/// Build a router whose relay is rooted at `cwd` and (optionally) fenced to
/// `allowed_roots`, for the `/api/workspace/git-context` tests below.
/// `allowed_roots` fences which paths may be ASKED about; `trusted` is the separate
/// statement that git may run in them. They were once the same list, which is exactly the
/// conflation the trust split undid — so a fixture that wants git to run has to say so.
async fn git_context_router(
    cwd: &str,
    allowed_roots: Vec<String>,
    trusted: Vec<String>,
) -> axum::Router {
    let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
    let relay = std::sync::Arc::new(tokio::sync::RwLock::new(crate::state::RelayState::new(
        cwd.to_string(),
        change_tx.clone(),
        crate::state::SecurityProfile::private(),
    )));
    if !allowed_roots.is_empty() {
        relay.write().await.set_allowed_roots(
            crate::state::normalize_allowed_roots(allowed_roots).expect("roots"),
        );
    }
    relay.write().await.trusted_workspaces = trusted;
    let context = AppContext {
        app: crate::state::AppState::from_parts(relay, std::collections::HashMap::new(), change_tx),
        auth: test_auth(),
        launch_id: None,
        security_headers: SecurityHeadersConfig::default(),
        host_policy: HostPolicy::loopback_only(),
    };
    build_router(context, WebAssets::Embedded)
}

async fn get_json(router: axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let response = router
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(uri)
                .header(header::HOST, "127.0.0.1:8787")
                .header(header::AUTHORIZATION, "Bearer secret")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("router should respond");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("body should read");
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

async fn seed_git_repo(dir: &std::path::Path) -> String {
    let path = dir.canonicalize().expect("canonicalize");
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "t@e.com"],
        vec!["config", "user.name", "T"],
    ] {
        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(&path)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?} failed");
    }
    std::fs::write(path.join("seed.txt"), "line1\n").expect("write");
    for args in [vec!["add", "seed.txt"], vec!["commit", "-q", "-m", "seed"]] {
        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(&path)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?} failed");
    }
    path.to_string_lossy().to_string()
}

/// A router whose relay already knows `thread_id`, so `/api/thread/workspace` resolves
/// instead of 400-ing on an unknown thread.
async fn thread_workspace_router(cwd: &str, thread_id: &str) -> axum::Router {
    let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
    let relay = std::sync::Arc::new(tokio::sync::RwLock::new(crate::state::RelayState::new(
        cwd.to_string(),
        change_tx.clone(),
        crate::state::SecurityProfile::private(),
    )));
    {
        let mut relay = relay.write().await;
        relay.ensure_runtime_for_thread(thread_id).current_cwd = cwd.to_string();
        // Granted: enumerating a thread's worktree roots and counting their changes are
        // both `git` in this directory, which `admit` refuses without a grant.
        relay.trusted_workspaces = vec![cwd.to_string()];
    }
    let context = AppContext {
        app: crate::state::AppState::from_parts(relay, std::collections::HashMap::new(), change_tx),
        auth: test_auth(),
        launch_id: None,
        security_headers: SecurityHeadersConfig::default(),
        host_policy: HostPolicy::loopback_only(),
    };
    build_router(context, WebAssets::Embedded)
}

/// Both halves over real HTTP. The default carrying NO counts is the half that keeps a
/// twice-per-refresh path cheap, and no test of the measurement function can see it.
#[tokio::test]
async fn thread_workspace_route_measures_roots_only_when_asked() {
    let dir = tempfile::TempDir::new().expect("tmp");
    let cwd = seed_git_repo(dir.path()).await;
    std::fs::write(std::path::Path::new(&cwd).join("scratch.txt"), "new\n").expect("write");

    let uri = "/api/thread/workspace?thread_id=thread-a";
    let (status, body) = get_json(thread_workspace_router(&cwd, "thread-a").await, &uri).await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    let roots = body["data"]["roots"].as_array().expect("roots");
    assert_eq!(roots.len(), 1, "body={body}");
    assert!(
        roots[0].get("changed_files").is_none(),
        "an unmeasured root must be ABSENT from the payload, not zero: {body}"
    );

    let (status, body) = get_json(
        thread_workspace_router(&cwd, "thread-a").await,
        &format!("{uri}&roots_status=true"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        body["data"]["roots"][0]["changed_files"],
        serde_json::json!(1),
        "asking must actually produce the count: {body}"
    );
}

/// The local surface must expose the probe the launch dialog's `main · clean` chip
/// reads, beside `/api/workspace/diff`.
#[tokio::test]
async fn workspace_git_context_route_answers_for_a_local_path() {
    let dir = tempfile::TempDir::new().expect("tmp");
    let cwd = seed_git_repo(dir.path()).await;
    std::fs::write(std::path::Path::new(&cwd).join("scratch.txt"), "new\n").expect("write");

    // In the fence AND vouched for: `dirty` is the one field that needs a subprocess, so
    // this chip only fills it in where the local operator granted the workspace.
    let router = git_context_router(&cwd, vec![cwd.clone()], vec![cwd.clone()]).await;
    let (status, body) = get_json(
        router,
        &format!("/api/workspace/git-context?cwd={}", cwd.replace(' ', "%20")),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["data"]["is_repo"], serde_json::Value::Bool(true));
    assert_eq!(body["data"]["branch"], serde_json::json!("main"));
    assert_eq!(body["data"]["detached"], serde_json::Value::Bool(false));
    assert_eq!(
        body["data"]["dirty"],
        serde_json::Value::Bool(true),
        "an untracked file must show as dirty"
    );
}

/// A caller-supplied-path probe, so `allowed_roots` must fence it and the refusal
/// must be a 4xx that says nothing about the target.
#[tokio::test]
async fn workspace_git_context_route_refuses_a_path_outside_the_allowed_roots() {
    let allowed = tempfile::TempDir::new().expect("tmp");
    let outside = tempfile::TempDir::new().expect("tmp");
    let allowed_cwd = seed_git_repo(allowed.path()).await;
    let outside_cwd = seed_git_repo(outside.path()).await;

    // Deliberately no grants: this asserts the FENCE, which must refuse on its own,
    // before trust is even consulted.
    let router = git_context_router(&allowed_cwd, vec![allowed_cwd.clone()], Vec::new()).await;
    let (status, body) = get_json(
        router,
        &format!("/api/workspace/git-context?cwd={outside_cwd}"),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "body={body}");
    let message = body["error"]["message"].as_str().unwrap_or_default();
    assert!(
        !message.contains(&outside_cwd) && !message.contains("main"),
        "the refusal must not describe the target: {message}"
    );
}

async fn post_json(
    router: axum::Router,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let response = router
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(uri)
                .header(header::HOST, "127.0.0.1:8787")
                .header(header::AUTHORIZATION, "Bearer secret")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .expect("request should build"),
        )
        .await
        .expect("router should respond");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 256 * 1024)
        .await
        .expect("body should read");
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

/// A router over a relay that can actually start sessions, so `/api/session/handover`
/// reaches the real path rather than failing on a missing provider.
async fn handover_router(cwd: &str) -> (axum::Router, crate::state::AppState) {
    let (change_tx, _rx) = tokio::sync::watch::channel(0_u64);
    let relay = std::sync::Arc::new(tokio::sync::RwLock::new(crate::state::RelayState::new(
        cwd.to_string(),
        change_tx.clone(),
        crate::state::SecurityProfile::private(),
    )));
    {
        let mut relay = relay.write().await;
        relay.trusted_workspaces = vec![cwd.to_string()];
    }
    let bridge = std::sync::Arc::new(
        crate::fake_provider::FakeProviderBridge::spawn(relay.clone())
            .await
            .expect("fake provider should spawn"),
    );
    let mut providers: std::collections::HashMap<
        String,
        std::sync::Arc<dyn crate::provider::ProviderBridge>,
    > = std::collections::HashMap::new();
    providers.insert(
        "fake".to_string(),
        std::sync::Arc::clone(&bridge) as std::sync::Arc<dyn crate::provider::ProviderBridge>,
    );
    let app = crate::state::AppState::from_parts(relay, providers, change_tx);
    let context = AppContext {
        app: app.clone(),
        auth: test_auth(),
        launch_id: None,
        security_headers: SecurityHeadersConfig::default(),
        host_policy: HostPolicy::loopback_only(),
    };
    (build_router(context, WebAssets::Embedded), app)
}

/// The desktop door. A refusal here is a 200 carrying `isError` — the composer reads
/// the reason as text, and mapping it to a 4xx would surface as a dead Send instead.
#[tokio::test]
async fn the_handover_route_accepts_a_bare_thread_and_answers_refusals_as_text() {
    let dir = tempfile::TempDir::new().expect("tmp");
    let cwd = dir.path().to_string_lossy().to_string();
    let (router, app) = handover_router(&cwd).await;

    let started = app
        .start_session(crate::protocol::StartSessionInput {
            cwd: Some(cwd.clone()),
            provider: Some("fake".to_string()),
            approval_policy: Some("never".to_string()),
            device_id: Some("dev".to_string()),
            initial_prompt: None,
            model: None,
            effort: None,
            project_id: None,
            sandbox: None,
        })
        .await
        .expect("session starts")
        .active_thread_id
        .clone()
        .expect("thread");

    // No note, no agent, no provider: the ordinary handover, and every field omitted.
    let (status, body) = post_json(
        router,
        "/api/session/handover",
        serde_json::json!({ "thread_id": started }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_ne!(
        body["isError"],
        serde_json::json!(true),
        "an empty note is the normal case, not a bad request: {body}"
    );
    let text = body["content"][0]["text"].as_str().unwrap_or_default();
    assert!(
        text.contains("Handing over"),
        "the caller is told where the work went: {text}"
    );

    // …and a refusal comes back the same shape, so the composer can show the reason.
    let (router, _app) = handover_router(&cwd).await;
    let (status, body) = post_json(
        router,
        "/api/session/handover",
        serde_json::json!({ "thread_id": "no-such-thread" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a refusal is not a transport failure: {body}"
    );
    assert_eq!(body["isError"], serde_json::json!(true), "body={body}");
    assert!(
        body["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .len()
            > 0,
        "a silent refusal is indistinguishable from a dead Send: {body}"
    );
}
