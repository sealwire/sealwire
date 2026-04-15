mod auth;
mod broker;
mod codex;
mod codex_local;
mod protocol;
#[cfg(test)]
mod protocol_tests;
mod state;

use std::{convert::Infallible, time::Duration};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use auth::AuthConfig;
use axum::{
    extract::{Path, Query, Request, State},
    http::header::HeaderName,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::stream::{self, StreamExt};
use protocol::{
    AllowedRootsInput, AllowedRootsReceipt, ApiEnvelope, ApiError, ApprovalDecisionInput,
    ApprovalReceipt, AuthSessionInput, AuthSessionView, BulkRevokeDevicesReceipt, HealthResponse,
    HeartbeatInput, PairingDecisionInput, PairingDecisionReceipt, PairingStartInput,
    PairingTicketView, ReadThreadTranscriptInput, ResumeSessionInput, RevokeDeviceReceipt,
    SendMessageInput, SessionSnapshot, SessionSnapshotCompactProfile, StartSessionInput,
    TakeOverInput, ThreadArchiveReceipt, ThreadDeleteReceipt, ThreadTranscriptResponse,
    ThreadsQuery, ThreadsResponse,
};
use relay_http::{
    apply_standard_security_headers, header_origin, parse_optional_string_env, request_origin,
    request_uses_https, SecurityHeadersConfig,
};
use serde::Deserialize;
use state::{AppState, ApprovalError};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{info, warn};

const CSP_CONNECT_SRC_ENV: &str = "RELAY_CSP_CONNECT_SRC";
const ENABLE_HSTS_ENV: &str = "RELAY_ENABLE_HSTS";
const HSTS_VALUE_ENV: &str = "RELAY_HSTS_VALUE";
const CSRF_HEADER_NAME: &str = "x-agent-relay-csrf";
const CSRF_HEADER_VALUE: &str = "1";

#[derive(Clone)]
struct AppContext {
    app: AppState,
    auth: AuthConfig,
    security_headers: SecurityHeadersConfig,
}

#[derive(Debug, Deserialize)]
struct ThreadTranscriptQuery {
    cursor: Option<usize>,
    before: Option<usize>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "relay_server=debug,tower_http=info".into()),
        )
        .init();

    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let host = std::env::var("BIND_HOST")
        .ok()
        .and_then(|value| value.parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)));
    let auth = AuthConfig::from_env_for_bind_host(host)
        .unwrap_or_else(|error| panic!("relay-server auth config is invalid: {error}"));
    let security_headers = security_headers_from_env()
        .unwrap_or_else(|error| panic!("relay-server security header config is invalid: {error}"));
    if auth.enabled() {
        info!("relay-server API token auth is enabled for protected /api routes");
    } else if auth.insecure_no_auth_override_active() {
        warn!(
            "relay-server API auth is disabled on a non-loopback bind because RELAY_ALLOW_INSECURE_NO_AUTH is set"
        );
    } else {
        info!("relay-server API auth is disabled because the server is bound to loopback only");
    }

    let state = AppState::new()
        .await
        .expect("failed to initialize Codex app-server bridge");
    let web_root = workspace_root().join("web");
    if !web_root.join("index.html").exists() {
        warn!(
            path = %web_root.join("index.html").display(),
            "relay web assets are missing; run `npm run build` before opening the local UI"
        );
    }
    let context = AppContext {
        app: state,
        auth,
        security_headers,
    };
    let app = build_router(context, web_root);
    let address = SocketAddr::from((host, port));

    info!("relay-server listening on http://{}:{}", host, port);

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind tcp listener");

    axum::serve(listener, app)
        .await
        .expect("server exited unexpectedly");
}

fn build_router(context: AppContext, web_root: PathBuf) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/auth/session",
            get(auth_session_status)
                .post(auth_session_login)
                .delete(auth_session_logout),
        )
        .route("/api/session", get(session_snapshot))
        .route("/api/stream", get(session_stream))
        .route("/api/threads", get(list_threads))
        .route("/api/threads/:thread_id/transcript", get(thread_transcript))
        .route("/api/allowed-roots", post(update_allowed_roots))
        .route("/api/threads/:thread_id/archive", post(archive_thread))
        .route(
            "/api/threads/:thread_id/delete",
            post(delete_thread_permanently),
        )
        .route("/api/session/start", post(start_session))
        .route("/api/session/resume", post(resume_session))
        .route("/api/session/heartbeat", post(session_heartbeat))
        .route("/api/session/take-over", post(take_over_session))
        .route("/api/session/message", post(send_message))
        .route("/api/pairing/start", post(start_pairing))
        .route(
            "/api/pairings/:pairing_id/decision",
            post(decide_pairing_request),
        )
        .route("/api/devices/:device_id/revoke", post(revoke_device))
        .route(
            "/api/devices/:device_id/revoke-others",
            post(revoke_other_devices),
        )
        .route("/api/approvals/:request_id", post(decide_approval))
        .route_service("/", ServeFile::new(web_root.join("index.html")))
        .nest_service("/static", ServeDir::new(web_root))
        .with_state(context.clone())
        .layer(middleware::from_fn_with_state(
            context.clone(),
            with_csrf_protection,
        ))
        .layer(middleware::from_fn_with_state(
            context,
            with_security_headers,
        ))
        .layer(TraceLayer::new_for_http())
}

fn security_headers_from_env() -> Result<SecurityHeadersConfig, String> {
    SecurityHeadersConfig::from_parts(
        parse_optional_bool_env(ENABLE_HSTS_ENV)?,
        parse_optional_string_env(CSP_CONNECT_SRC_ENV)?,
        parse_optional_string_env(HSTS_VALUE_ENV)?,
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
}

async fn health() -> Json<ApiEnvelope<HealthResponse>> {
    Json(ApiEnvelope::ok(HealthResponse {
        status: "ok",
        service: "relay-server",
        provider: "codex",
    }))
}

async fn auth_session_status(
    State(context): State<AppContext>,
    headers: HeaderMap,
) -> Json<ApiEnvelope<AuthSessionView>> {
    Json(ApiEnvelope::ok(context.auth.session_view(&headers)))
}

async fn auth_session_login(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<AuthSessionInput>,
) -> Result<(HeaderMap, Json<ApiEnvelope<AuthSessionView>>), (StatusCode, Json<ApiError>)> {
    let mut response_headers = HeaderMap::new();
    if let Some(cookie) = context
        .auth
        .issue_session_cookie(&input.token, request_uses_https(&headers, Some(&uri)))?
    {
        response_headers.insert(HeaderName::from_static("set-cookie"), cookie);
    }

    Ok((
        response_headers,
        Json(ApiEnvelope::ok(AuthSessionView {
            auth_required: context.auth.enabled(),
            authenticated: true,
            cookie_session: context.auth.enabled(),
        })),
    ))
}

async fn auth_session_logout(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> (HeaderMap, Json<ApiEnvelope<AuthSessionView>>) {
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        HeaderName::from_static("set-cookie"),
        context
            .auth
            .clear_session_cookie(request_uses_https(&headers, Some(&uri))),
    );

    (
        response_headers,
        Json(ApiEnvelope::ok(AuthSessionView {
            auth_required: context.auth.enabled(),
            authenticated: !context.auth.enabled(),
            cookie_session: false,
        })),
    )
}

async fn session_snapshot(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    Ok(Json(ApiEnvelope::ok(compact_local_snapshot(
        context.app.snapshot().await,
    ))))
}

async fn session_stream(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<
    Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>,
    (StatusCode, Json<ApiError>),
> {
    authorize_api(&context, &headers, &uri)?;
    let initial_state = context.app.clone();
    let updates_state = context.app.clone();
    let receiver = context.app.subscribe();

    let initial = stream::once(async move {
        Ok::<Event, Infallible>(snapshot_event(compact_local_snapshot(
            initial_state.snapshot().await,
        )))
    });

    let updates = stream::unfold(
        (updates_state, receiver),
        |(state, mut receiver)| async move {
            if receiver.changed().await.is_err() {
                return None;
            }

            Some((
                Ok::<Event, Infallible>(snapshot_event(compact_local_snapshot(
                    state.snapshot().await,
                ))),
                (state, receiver),
            ))
        },
    );

    Ok(Sse::new(initial.chain(updates)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

async fn list_threads(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<ThreadsQuery>,
) -> Result<Json<ApiEnvelope<ThreadsResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let limit = query.limit.unwrap_or(100).clamp(1, 200);
    context
        .app
        .list_threads(limit, query.cwd)
        .await
        .map(|threads| Json(ApiEnvelope::ok(threads)))
        .map_err(|error| {
            if is_path_policy_error(&error) {
                bad_request(error)
            } else {
                bad_gateway(error)
            }
        })
}

async fn thread_transcript(
    Path(thread_id): Path<String>,
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<ThreadTranscriptQuery>,
) -> Result<Json<ApiEnvelope<ThreadTranscriptResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .read_thread_transcript(ReadThreadTranscriptInput {
            thread_id,
            cursor: query.cursor,
            before: query.before,
        })
        .await
        .map(|transcript| Json(ApiEnvelope::ok(transcript)))
        .map_err(|error| {
            if is_path_policy_error(&error) {
                bad_request(error)
            } else {
                bad_gateway(error)
            }
        })
}

async fn update_allowed_roots(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<AllowedRootsInput>,
) -> Result<Json<ApiEnvelope<AllowedRootsReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .update_allowed_roots(input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

async fn archive_thread(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(thread_id): Path<String>,
) -> Result<Json<ApiEnvelope<ThreadArchiveReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .archive_thread(&thread_id)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(|error| {
            if error.starts_with("cannot archive") {
                bad_request(error)
            } else {
                bad_gateway(error)
            }
        })
}

async fn delete_thread_permanently(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(thread_id): Path<String>,
) -> Result<Json<ApiEnvelope<ThreadDeleteReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .delete_thread_permanently(&thread_id)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(|error| {
            if error.starts_with("cannot permanently delete") {
                bad_request(error)
            } else {
                bad_gateway(error)
            }
        })
}

async fn start_session(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<StartSessionInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .start_session(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(compact_local_snapshot(snapshot))))
        .map_err(|error| {
            if is_path_policy_error(&error) {
                bad_request(error)
            } else {
                bad_gateway(error)
            }
        })
}

async fn resume_session(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<ResumeSessionInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .resume_session(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(compact_local_snapshot(snapshot))))
        .map_err(|error| {
            if is_path_policy_error(&error) {
                bad_request(error)
            } else {
                bad_gateway(error)
            }
        })
}

async fn send_message(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<SendMessageInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .send_message(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(compact_local_snapshot(snapshot))))
        .map_err(bad_request)
}

async fn session_heartbeat(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<HeartbeatInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .heartbeat_session(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(compact_local_snapshot(snapshot))))
        .map_err(bad_request)
}

async fn take_over_session(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<TakeOverInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .take_over_control(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(compact_local_snapshot(snapshot))))
        .map_err(bad_request)
}

async fn decide_approval(
    Path(request_id): Path<String>,
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<ApprovalDecisionInput>,
) -> Result<Json<ApiEnvelope<ApprovalReceipt>>, impl IntoResponse> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .decide_approval(&request_id, input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(|error| match error {
            ApprovalError::NoPendingRequest => (
                StatusCode::NOT_FOUND,
                Json(ApiError::new(
                    "no_pending_request",
                    "There is no approval request waiting for a remote decision.",
                )),
            ),
            ApprovalError::Bridge(message) => (
                StatusCode::BAD_GATEWAY,
                Json(ApiError::new("approval_failed", message)),
            ),
        })
}

async fn start_pairing(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<PairingStartInput>,
) -> Result<Json<ApiEnvelope<PairingTicketView>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .start_pairing(input)
        .await
        .map(|ticket| Json(ApiEnvelope::ok(ticket)))
        .map_err(bad_request)
}

async fn revoke_device(
    Path(device_id): Path<String>,
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<RevokeDeviceReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .revoke_device(&device_id)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

async fn revoke_other_devices(
    Path(device_id): Path<String>,
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<BulkRevokeDevicesReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .revoke_other_devices(&device_id)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

async fn decide_pairing_request(
    Path(pairing_id): Path<String>,
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<PairingDecisionInput>,
) -> Result<Json<ApiEnvelope<PairingDecisionReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .decide_pairing_request(&pairing_id, input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

fn authorize_api(
    context: &AppContext,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    context.auth.authorize(headers, uri)
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("workspace root should resolve")
}

fn bad_request(message: String) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError::new("bad_request", message)),
    )
}

fn bad_gateway(message: String) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_GATEWAY,
        Json(ApiError::new("codex_bridge_error", message)),
    )
}

fn is_path_policy_error(message: &str) -> bool {
    message.contains("outside this relay's allowed roots")
}

fn snapshot_event(snapshot: SessionSnapshot) -> Event {
    Event::default()
        .event("session")
        .json_data(snapshot)
        .unwrap_or_else(|error| {
            Event::default().event("session").data(format!(
                "{{\"ok\":false,\"error\":\"failed_to_encode_snapshot:{error}\"}}"
            ))
        })
}

fn compact_local_snapshot(snapshot: SessionSnapshot) -> SessionSnapshot {
    snapshot.compact_for(SessionSnapshotCompactProfile::LocalWeb)
}

fn parse_optional_bool_env(name: &str) -> Result<bool, String> {
    match std::env::var(name) {
        Ok(value) => parse_bool(name, value.trim()),
        Err(std::env::VarError::NotPresent) => Ok(false),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid utf-8")),
    }
}

fn parse_bool(name: &str, value: &str) -> Result<bool, String> {
    match value.to_ascii_lowercase().as_str() {
        "" => Ok(false),
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!(
            "{name} must be one of: 1, true, yes, on, 0, false, no, off"
        )),
    }
}

async fn with_security_headers(
    State(context): State<AppContext>,
    request: Request,
    next: Next,
) -> Response {
    let is_https = request_uses_https(request.headers(), Some(request.uri()));
    let mut response = next.run(request).await;
    apply_standard_security_headers(
        response.headers_mut(),
        &context.security_headers.content_security_policy,
        &context.security_headers.strict_transport_security,
        context.security_headers.enable_hsts,
        is_https,
    );
    response
}

async fn with_csrf_protection(
    State(context): State<AppContext>,
    request: Request,
    next: Next,
) -> Response {
    if let Err(error) = authorize_csrf_protection(
        &context.auth,
        request.method(),
        request.headers(),
        request.uri(),
    ) {
        return error.into_response();
    }

    next.run(request).await
}

fn authorize_csrf_protection(
    auth: &AuthConfig,
    method: &Method,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if !uri.path().starts_with("/api/") || method_is_safe(method) || !auth.enabled() {
        return Ok(());
    }

    if auth.authenticates_with_bearer(headers) || !auth.authenticates_with_cookie(headers) {
        return Ok(());
    }

    if !has_valid_csrf_header(headers) {
        return Err(forbidden_csrf(
            "Cookie-authenticated requests must include X-Agent-Relay-CSRF.",
        ));
    }

    if request_is_same_origin(headers, uri) {
        return Ok(());
    }

    Err(forbidden_csrf(
        "Cookie-authenticated requests must come from the same Origin or Referer.",
    ))
}

fn method_is_safe(method: &Method) -> bool {
    matches!(
        *method,
        Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE
    )
}

fn has_valid_csrf_header(headers: &HeaderMap) -> bool {
    headers
        .get(CSRF_HEADER_NAME)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == CSRF_HEADER_VALUE)
}

fn request_is_same_origin(headers: &HeaderMap, uri: &Uri) -> bool {
    let Some(expected_origin) = request_origin(headers, Some(uri)) else {
        return false;
    };

    if headers.contains_key(header::ORIGIN) {
        return header_origin(headers, header::ORIGIN)
            .is_some_and(|origin| origin == expected_origin);
    }

    header_origin(headers, header::REFERER).is_some_and(|origin| origin == expected_origin)
}

fn forbidden_csrf(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::FORBIDDEN,
        Json(ApiError::new("csrf_rejected", message.into())),
    )
}

#[cfg(test)]
mod tests;
