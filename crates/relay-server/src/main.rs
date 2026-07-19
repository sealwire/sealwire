mod auth;
mod broker;
mod claude;
mod codex;
mod codex_local;
mod fake_provider;
mod file_changes;
mod protocol;
#[cfg(test)]
mod protocol_tests;
mod provider;
mod state;

use std::{convert::Infallible, time::Duration};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use auth::AuthConfig;
use axum::{
    body::Body,
    extract::{Path, Query, Request, State},
    http::header::HeaderName,
    http::{header, HeaderMap, Method, StatusCode, Uri},
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
    AllowedRootsInput, AllowedRootsReceipt, ApiEnvelope, ApiError, ApplyFileChangeInput,
    ApplyFileChangeReceipt, ApprovalDecisionInput, ApprovalReceipt, AskUserAnswerReceipt,
    AuthSessionInput, AuthSessionView, BulkRevokeDevicesReceipt, DeleteThreadInput,
    ForkSessionInput, HealthResponse, HeartbeatInput, ModelOptionView, PairingDecisionInput,
    PairingDecisionReceipt, PairingStartInput, PairingTicketView, ReadThreadEntryDetailInput,
    ReadThreadTranscriptInput, RequestReviewInput, RequestReviewReceipt, ResumeSessionInput,
    ReviewActionInput, ReviewDeleteReceipt, ReviewsResponse, RevokeDeviceReceipt, SendMessageInput,
    SessionSnapshot, SessionSnapshotCompactProfile, StartSessionInput, StopTurnInput,
    SubmitAskUserAnswerInput, TakeOverInput, ThreadArchiveReceipt, ThreadDeleteReceipt,
    ThreadEntryDetailResponse, ThreadTranscriptResponse, ThreadsQuery, ThreadsResponse,
    UpdateSessionSettingsInput, WorkspaceDiffResponse,
};
use relay_http::{
    apply_standard_security_headers, header_origin, parse_optional_string_env, request_origin,
    request_uses_https, SecurityHeadersConfig,
};
use serde::Deserialize;
use state::{AppState, ApprovalError, AskUserAnswerError};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{info, warn};

#[cfg(test)]
use axum::http::HeaderValue;

const CSP_CONNECT_SRC_ENV: &str = "RELAY_CSP_CONNECT_SRC";
const ENABLE_HSTS_ENV: &str = "RELAY_ENABLE_HSTS";
const HSTS_VALUE_ENV: &str = "RELAY_HSTS_VALUE";
const WEB_ROOT_ENV: &str = "RELAY_WEB_ROOT";
const CSRF_HEADER_NAME: &str = "x-agent-relay-csrf";
const CSRF_HEADER_VALUE: &str = "1";

struct EmbeddedWebAsset {
    path: &'static str,
    bytes: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/embedded_web_assets.rs"));

#[derive(Clone, Debug)]
enum WebAssets {
    Embedded,
    Directory(PathBuf),
}

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

#[derive(Debug, Deserialize)]
struct ThreadEntryDetailQuery {
    field: Option<String>,
    cursor: Option<usize>,
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
    let web_assets = default_web_assets();
    log_web_assets(&web_assets);
    let context = AppContext {
        app: state,
        auth,
        security_headers,
    };
    let app = build_router(context, web_assets);
    let address = SocketAddr::from((host, port));

    info!("relay-server listening on http://{}:{}", host, port);

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind tcp listener");

    axum::serve(listener, app)
        .await
        .expect("server exited unexpectedly");
}

fn build_router(context: AppContext, web_assets: WebAssets) -> Router {
    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/providers", get(list_providers))
        .route("/api/providers/:provider/models", get(list_provider_models))
        .route(
            "/api/auth/session",
            get(auth_session_status)
                .post(auth_session_login)
                .delete(auth_session_logout),
        )
        .route("/api/session", get(session_snapshot))
        .route("/api/workspace/diff", get(workspace_diff))
        .route("/api/stream", get(session_stream))
        .route("/api/threads", get(list_threads))
        .route("/api/threads/:thread_id/transcript", get(thread_transcript))
        .route(
            "/api/threads/:thread_id/entries/:item_id/detail",
            get(thread_entry_detail),
        )
        .route("/api/allowed-roots", post(update_allowed_roots))
        .route("/api/threads/:thread_id/archive", post(archive_thread))
        .route(
            "/api/threads/:thread_id/delete",
            post(delete_thread_permanently),
        )
        .route("/api/file-changes/:item_id/apply", post(apply_file_change))
        .route("/api/session/start", post(start_session))
        .route("/api/session/fork", post(fork_session))
        .route("/api/session/resume", post(resume_session))
        .route("/api/session/settings", post(update_session_settings))
        .route("/api/session/heartbeat", post(session_heartbeat))
        .route("/api/session/take-over", post(take_over_session))
        .route("/api/session/message", post(send_message))
        .route("/api/session/stop", post(stop_active_turn))
        .route("/api/session/review", post(request_review))
        .route("/api/session/review/resolve", post(resolve_review))
        .route("/api/session/reviews", get(list_reviews))
        .route(
            "/api/session/reviews/:review_id/delete",
            post(delete_review),
        )
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
        .route(
            "/api/ask-user-questions/:request_id/answer",
            post(submit_ask_user_answer),
        );

    let router = match web_assets {
        WebAssets::Embedded => router
            .route("/", get(serve_embedded_index))
            .route("/static/*path", get(serve_embedded_static_asset)),
        WebAssets::Directory(web_root) => router
            .route_service("/", ServeFile::new(web_root.join("index.html")))
            .nest_service("/static", ServeDir::new(web_root)),
    };

    router
        .with_state(context.clone())
        .layer(middleware::from_fn_with_state(
            context.clone(),
            with_csrf_protection,
        ))
        .layer(middleware::from_fn_with_state(
            context,
            with_security_headers,
        ))
        .layer(middleware::from_fn(with_cache_headers))
        .layer(TraceLayer::new_for_http())
}

/// Cache policy for the static web surface. Without this the HTML shell is served
/// with no `Cache-Control`, so browsers (notably iOS Safari / installed PWAs)
/// heuristically cache `index.html` — which pins them to the OLD content-hashed
/// asset filenames it references, so a rebuilt bundle never loads even though the
/// runtime-fetched `build-meta.json` reports the new build. The fix: the HTML shell
/// and other non-hashed files always revalidate (`no-cache`), while Vite's
/// content-hashed bundles under `/static/assets/` are immutable and cache forever.
/// Decide the `Cache-Control` value for a static-surface response, or `None` to
/// leave the header untouched. Pure so the policy is unit-testable without
/// driving the router.
///
/// - `/api/*` (JSON + the SSE stream) manage their own freshness — untouched.
/// - Only SUCCESSFUL responses are stamped: a 404 for a missing hashed asset
///   under `/static/assets/` must never be cached as `immutable` for a year (it
///   would pin a negative response).
/// - Content-hashed bundles are immutable; everything else revalidates.
fn cache_control_for(path: &str, status: StatusCode) -> Option<&'static str> {
    if path.starts_with("/api/") || !status.is_success() {
        return None;
    }
    if path.starts_with("/static/assets/") {
        Some("public, max-age=31536000, immutable")
    } else {
        Some("no-cache")
    }
}

async fn with_cache_headers(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    if let Some(value) = cache_control_for(&path, response.status()) {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static(value),
        );
    }
    response
}

async fn serve_embedded_index() -> Response {
    embedded_asset_response("index.html")
}

async fn serve_embedded_static_asset(Path(path): Path<String>) -> Response {
    embedded_asset_response(&path)
}

fn embedded_asset_response(path: &str) -> Response {
    let Some(path) = normalize_embedded_asset_path(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(asset) = embedded_asset(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    Response::builder()
        .header(
            header::CONTENT_TYPE,
            embedded_asset_content_type(asset.path),
        )
        .body(Body::from(asset.bytes))
        .expect("embedded asset response should build")
}

fn normalize_embedded_asset_path(path: &str) -> Option<&str> {
    let path = path.trim_start_matches('/');
    if path.is_empty()
        || path.contains('\\')
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(path)
}

fn embedded_asset(path: &str) -> Option<&'static EmbeddedWebAsset> {
    EMBEDDED_WEB_ASSETS.iter().find(|asset| asset.path == path)
}

fn embedded_asset_content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        _ => "application/octet-stream",
    }
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

async fn health(State(context): State<AppContext>) -> Json<ApiEnvelope<HealthResponse>> {
    let snapshot = context.app.snapshot().await;
    Json(ApiEnvelope::ok(HealthResponse {
        status: "ok",
        service: "relay-server",
        provider: snapshot.provider,
    }))
}

async fn list_providers(State(context): State<AppContext>) -> Json<ApiEnvelope<Vec<String>>> {
    Json(ApiEnvelope::ok(context.app.available_providers()))
}

async fn list_provider_models(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(provider): Path<String>,
) -> Result<Json<ApiEnvelope<Vec<ModelOptionView>>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .provider_models(&provider)
        .await
        .map(|models| Json(ApiEnvelope::ok(models)))
        .map_err(bad_gateway)
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

async fn workspace_diff(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<WorkspaceDiffResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .workspace_diff(None)
        .await
        .map(|response| Json(ApiEnvelope::ok(response)))
        .map_err(|error| classify_session_error(error))
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
        .list_threads(limit, None)
        .await
        .map(|threads| Json(ApiEnvelope::ok(threads)))
        .map_err(bad_gateway)
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
            device_id: None,
        })
        .await
        .map(|transcript| Json(ApiEnvelope::ok(transcript)))
        .map_err(|error| classify_session_error(error))
}

async fn thread_entry_detail(
    Path((thread_id, item_id)): Path<(String, String)>,
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<ThreadEntryDetailQuery>,
) -> Result<Json<ApiEnvelope<ThreadEntryDetailResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .read_thread_entry_detail(ReadThreadEntryDetailInput {
            thread_id,
            item_id,
            field: query.field,
            cursor: query.cursor,
            device_id: None,
        })
        .await
        .map(|detail| Json(ApiEnvelope::ok(detail)))
        .map_err(|error| classify_session_error(error))
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
    // Optional body: absent → non-destructive default (keep reviewer threads as
    // normal, un-hidden threads); present → honour the user's explicit choice
    // (delete vs keep-as-normal). Archive must never silently delete a reviewer
    // transcript when no choice was transmitted.
    body: Option<Json<DeleteThreadInput>>,
) -> Result<Json<ApiEnvelope<ThreadArchiveReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let delete_reviewers = body.and_then(|Json(input)| input.delete_reviewers);
    context
        .app
        .archive_thread(&thread_id, delete_reviewers)
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
    // Optional body: absent (the pre-feature client) → default delete of reviewer
    // threads; present → honour the user's choice.
    body: Option<Json<DeleteThreadInput>>,
) -> Result<Json<ApiEnvelope<ThreadDeleteReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let delete_reviewers = body.and_then(|Json(input)| input.delete_reviewers);
    context
        .app
        .delete_thread_permanently(&thread_id, delete_reviewers)
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
        .map_err(|error| classify_session_error(error))
}

async fn fork_session(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<ForkSessionInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .fork_session(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(compact_local_snapshot(snapshot))))
        .map_err(|error| classify_session_error(error))
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
        .map_err(|error| classify_session_error(error))
}

async fn update_session_settings(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<UpdateSessionSettingsInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .update_session_settings(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(compact_local_snapshot(snapshot))))
        .map_err(bad_request)
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

async fn stop_active_turn(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<StopTurnInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .stop_active_turn(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(compact_local_snapshot(snapshot))))
        .map_err(bad_request)
}

async fn request_review(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<RequestReviewInput>,
) -> Result<Json<ApiEnvelope<RequestReviewReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .request_review(input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

async fn resolve_review(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<ReviewActionInput>,
) -> Result<Json<ApiEnvelope<RequestReviewReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    // Stop/cancel the active review — works for ANY non-terminal review (blocked OR
    // just stuck mid-turn), not only the cleanup-failed `Blocked` case.
    context
        .app
        .cancel_review(input.review_job_id, input.device_id)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

async fn list_reviews(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<ReviewsResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    // The reviewer panel's dedicated, UNCOMPACTED channel: full review cards + reviewer
    // threads + a `reviews_revision` cache key. Decoupled from the byte-budgeted snapshot
    // so the panel survives live-turn compaction (which drains `active_review_jobs`).
    // `None`: this is the local operator surface (full access), mirroring `workspace_diff`.
    Ok(Json(ApiEnvelope::ok(context.app.reviews(None).await)))
}

async fn delete_review(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(review_id): Path<String>,
    Json(input): Json<ReviewActionInput>,
) -> Result<Json<ApiEnvelope<ReviewDeleteReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .delete_review(review_id, input.device_id)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
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

async fn submit_ask_user_answer(
    Path(request_id): Path<String>,
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<SubmitAskUserAnswerInput>,
) -> Result<Json<ApiEnvelope<AskUserAnswerReceipt>>, impl IntoResponse> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .submit_ask_user_answer(&request_id, input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(|error| match error {
            AskUserAnswerError::NoPendingRequest => (
                StatusCode::NOT_FOUND,
                Json(ApiError::new(
                    "no_pending_ask_user_question",
                    "There is no AskUserQuestion waiting for a remote answer.",
                )),
            ),
            AskUserAnswerError::NoAnswers => (
                StatusCode::BAD_REQUEST,
                Json(ApiError::new(
                    "no_answers",
                    "answers must include at least one entry",
                )),
            ),
            AskUserAnswerError::Bridge(message) => (
                StatusCode::BAD_GATEWAY,
                Json(ApiError::new("ask_user_question_failed", message)),
            ),
        })
}

async fn apply_file_change(
    Path(item_id): Path<String>,
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<ApplyFileChangeInput>,
) -> Result<Json<ApiEnvelope<ApplyFileChangeReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .apply_file_change(&item_id, input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
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

fn default_web_assets() -> WebAssets {
    select_default_web_assets(
        std::env::var(WEB_ROOT_ENV).ok(),
        cfg!(debug_assertions),
        workspace_root,
    )
}

fn select_default_web_assets(
    web_root_override: Option<String>,
    debug_assertions: bool,
    resolve_workspace_root: impl FnOnce() -> PathBuf,
) -> WebAssets {
    if let Some(web_root) = web_root_override.and_then(trimmed_string) {
        return WebAssets::Directory(PathBuf::from(web_root));
    }

    if debug_assertions {
        let workspace_web_root = resolve_workspace_root().join("web");
        if workspace_web_root.join("index.html").exists() {
            return WebAssets::Directory(workspace_web_root);
        }
    }

    WebAssets::Embedded
}

fn log_web_assets(web_assets: &WebAssets) {
    match web_assets {
        WebAssets::Directory(web_root) => {
            if web_root.join("index.html").exists() {
                info!(path = %web_root.display(), "relay web assets are served from disk");
            } else {
                warn!(
                    path = %web_root.join("index.html").display(),
                    "relay web assets are missing; run `npm run build` before opening the local UI"
                );
            }
        }
        WebAssets::Embedded => {
            if embedded_asset("index.html").is_some() {
                info!(
                    asset_count = EMBEDDED_WEB_ASSETS.len(),
                    "relay web assets are served from the embedded binary bundle"
                );
            } else {
                warn!(
                    "embedded relay web assets are missing; run `npm run build` before compiling relay-server"
                );
            }
        }
    }
}

fn trimmed_string(value: String) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
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
        Json(ApiError::new("provider_bridge_error", message)),
    )
}

/// Classify a session-layer failure into an HTTP status.
///
/// Everything non-path-policy used to collapse into 502
/// `provider_bridge_error`, which reads as "the upstream agent broke" and
/// invites a retry. Two of the classes here are not that: a caller error never
/// succeeds on retry, and a conflict succeeds only once the state changes.
/// Clients read `error.message`, so this changes semantics, not text.
///
/// Matching on message text is a stopgap — the session layer returns `String`
/// errors. A typed error enum is the real fix; until then these markers are the
/// exact phrases the session layer emits, and the fallback stays 502 so an
/// unrecognized failure is never mislabelled as the caller's fault.
const CALLER_ERROR_MARKERS: &[&str] = &[
    "is not part of the source thread transcript",
    "is required",
    "unknown thread",
];

const CONFLICT_MARKERS: &[&str] = &["turn is in progress", "a review is in progress"];

fn classify_session_error(message: String) -> (StatusCode, Json<ApiError>) {
    if is_path_policy_error(&message) {
        return bad_request(message);
    }
    if CONFLICT_MARKERS
        .iter()
        .any(|marker| message.contains(marker))
    {
        return (
            StatusCode::CONFLICT,
            Json(ApiError::new("session_conflict", message)),
        );
    }
    if CALLER_ERROR_MARKERS
        .iter()
        .any(|marker| message.contains(marker))
    {
        return bad_request(message);
    }
    bad_gateway(message)
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
