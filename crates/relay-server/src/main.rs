mod acp;
mod acp_local;
mod auth;
mod broker;
mod claude;
mod codex;
mod codex_local;
mod fake_provider;
mod file_changes;
mod host_guard;
mod instance_lock;
mod orchestrator_tools;
mod protocol;
#[cfg(test)]
mod protocol_tests;
mod provider;
mod state;
mod state_paths;
mod teams;
mod usage;

use std::{convert::Infallible, time::Duration};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use auth::AuthConfig;
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
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
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures_util::stream::{self, StreamExt};
use host_guard::HostPolicy;
use protocol::{
    AllowedRootsInput, AllowedRootsReceipt, ApiEnvelope, ApiError, ApplyFileChangeInput,
    ApplyFileChangeReceipt, ApprovalDecisionInput, ApprovalReceipt, AskUserAnswerReceipt,
    AuthSessionInput, AuthSessionView, BulkRevokeDevicesReceipt, CommentHandBackInput,
    CommentMutationReceipt, CommentResolveInput, CreateCommentInput, DeleteThreadInput,
    DevicesResponse, ForkSessionInput, HealthResponse, HeartbeatInput, ListCommentsQuery,
    ListCommentsResponse, ListReviewTicksQuery, ListReviewTicksResponse, ModelOptionView,
    PairingDecisionInput, PairingDecisionReceipt, PairingStartInput, PairingTicketView,
    ProjectActionInput, ProjectActionReceipt, ProjectsResponse, ReadThreadEntryDetailInput,
    ReadThreadTranscriptInput, RenameThreadInput, RepairWorkspaceInput, RequestReviewInput,
    RequestReviewReceipt, ResolvedWorkspace, ResumeSessionInput, ReviewActionInput,
    ReviewDeleteReceipt, ReviewsResponse, RevokeDeviceReceipt, SendMessageInput, SessionSnapshot,
    SessionSnapshotCompactProfile, SetThreadFlagInput, StartSessionInput, StartTeamInput,
    StartTeamReceipt, StartWorkflowInput, StartWorkflowReceipt, StopTurnInput,
    SubmitAskUserAnswerInput, TakeOverInput, TeamActionInput, TeamActionReceipt, TeamFileResponse,
    TeamMarkInput, TeamsResponse, ThreadArchiveReceipt, ThreadDeleteReceipt,
    ThreadEntryDetailResponse, ThreadFlagReceipt, ThreadRenameReceipt, ThreadSettingsView,
    ThreadTranscriptResponse, ThreadWorkspaceInput, ThreadsQuery, ThreadsResponse,
    TickReviewFileInput, TranscriptDeltaEvent, UpdateSessionSettingsInput, WatchThreadsInput,
    WorkflowActionInput, WorkflowActionReceipt, WorkflowsResponse, WorkspaceDiffResponse,
    WorkspaceGitContextView, WorkspaceTrustInput, WorkspaceTrustReceipt,
};
use provider::ProviderImage;
use relay_http::{
    apply_standard_security_headers, parse_optional_string_env, request_origin, request_uses_https,
    SecurityHeadersConfig,
};
use serde::Deserialize;
use state::{AppState, ApprovalError, AskUserAnswerError, TeamAction2};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{info, warn};

use axum::http::HeaderValue;

const CSP_CONNECT_SRC_ENV: &str = "RELAY_CSP_CONNECT_SRC";
const ENABLE_HSTS_ENV: &str = "RELAY_ENABLE_HSTS";
const HSTS_VALUE_ENV: &str = "RELAY_HSTS_VALUE";
const LAUNCH_ID_ENV: &str = "SEALWIRE_LAUNCH_ID";
/// Set by `sealwire --beta`.
const SEALWIRE_BETA_ENV: &str = "SEALWIRE_BETA";
const WEB_ROOT_ENV: &str = "RELAY_WEB_ROOT";
const CSRF_HEADER_NAME: &str = "x-agent-relay-csrf";
const CSRF_HEADER_VALUE: &str = "1";
const MAX_LOCAL_MESSAGE_BODY_BYTES: usize = 24 * 1024 * 1024;
const MAX_LOCAL_MESSAGE_IMAGES: usize = 4;
const MAX_LOCAL_MESSAGE_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_LOCAL_MESSAGE_IMAGE_TOTAL_BYTES: usize = 16 * 1024 * 1024;

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
    launch_id: Option<String>,
    security_headers: SecurityHeadersConfig,
    host_policy: HostPolicy,
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

/// `device_id` for a plain thread-addressed read. Optional so the local surface
/// can call without one; `thread_settings_view` scopes on whatever it gets.
#[derive(Debug, Deserialize)]
struct DeviceQuery {
    device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WorkspaceDiffQuery {
    /// Viewed session; absent = global/active cwd.
    thread_id: Option<String>,
    /// Diff preview; must be an enumerated root. Does not pin the session.
    view_root: Option<String>,
}

/// Session workspace (not a free path — that is `/api/workspace/git-context`).
#[derive(Debug, Deserialize)]
struct ThreadWorkspaceQuery {
    thread_id: String,
    /// Optional; local operator has no device identity.
    device_id: Option<String>,
    /// Off by default because it costs a `git status` per worktree: only the open
    /// picker, which actually shows the numbers, asks.
    #[serde(default)]
    roots_status: bool,
}

#[derive(Debug, Deserialize)]
struct LocalSendMessageInput {
    #[serde(flatten)]
    message: SendMessageInput,
    #[serde(default)]
    images: Vec<LocalImageInput>,
}

#[derive(Debug, Deserialize)]
struct LocalStartSessionInput {
    #[serde(flatten)]
    session: StartSessionInput,
    #[serde(default)]
    images: Vec<LocalImageInput>,
}

// Images ride the LOCAL fork wrapper only. The shared `ForkSessionInput` that
// the broker forwards for a remote fork stays image-free, so a paired phone
// cannot push image bytes through this endpoint.
#[derive(Debug, Deserialize)]
struct LocalForkSessionInput {
    #[serde(flatten)]
    fork: ForkSessionInput,
    #[serde(default)]
    images: Vec<LocalImageInput>,
}

#[derive(Debug, Deserialize)]
struct LocalImageInput {
    data_url: String,
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
    let host_policy = HostPolicy::from_env_for_bind_host(host)
        .unwrap_or_else(|error| panic!("relay-server host allowlist is invalid: {error}"));
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

    // One live relay-server per RELAY_STATE_PATH: a second process for the
    // same session file must not become a concurrent writer (that corrupts /
    // forks session.json). The dev restart scripts `pkill` the previous relay
    // before starting, so they never find the lock held. `npx sealwire` and
    // the desktop app don't, so for them a second start for the same workspace
    // refuses with a clear message pointing at the one already running. See
    // instance_lock's module docs (real OS file lock; refuse, don't attach).
    // Escape hatch (RELAY_DISABLE_INSTANCE_LOCK) for anything that genuinely
    // needs multiple instances on one state path (e.g. some test harnesses).
    //
    // Relay state is shared per machine (`~/.agent-relay/`), not per launch
    // directory — see `state_paths`. An absent shared session file just starts a
    // fresh one: there is deliberately no migration from a pre-existing
    // `<cwd>/.agent-relay/`, which would mean owning atomicity, cross-process
    // serialization, partial-copy recovery and identity-cloning-a-live-relay —
    // a lot of machinery guarding a one-time event.
    let state_path = state::resolved_state_path();
    // Resolve (canonicalize) RELAY_STATE_PATH and pin the env var to the
    // result BEFORE AppState::new() (and therefore PersistenceStore) reads it
    // — see instance_lock::resolve_identity: otherwise persistence's first
    // atomic save (rename onto an existing symlink replaces the symlink) would
    // sever a symlinked state path, and a later process re-resolving it would
    // take a different lock, reintroducing the duplicate-writer bug.
    let state_path = instance_lock::resolve_identity(&state_path).unwrap_or_else(|error| {
        eprintln!("relay-server: {error}");
        std::process::exit(1);
    });
    std::env::set_var("RELAY_STATE_PATH", &state_path);

    let lock_guard = if instance_lock::disabled_via_env() {
        None
    } else {
        match instance_lock::acquire(&state_path) {
            Ok(instance_lock::LockOutcome::Acquired(guard)) => Some(guard),
            Ok(instance_lock::LockOutcome::AlreadyRunning(owner)) => {
                let location = owner
                    .map(|owner| format!(" (pid {}, port {})", owner.pid, owner.port))
                    .unwrap_or_default();
                // Relay state is shared per machine now, so "already running"
                // is no longer scoped to the directory you launched from —
                // say so, and point at the way to get a second relay anyway.
                eprintln!(
                    "relay-server: another relay is already running{location} against the state \
                     file this one would use ({}). Relay state is shared across launch \
                     directories, so this is expected when one is already up — use it, stop it \
                     first, or give this one its own RELAY_STATE_PATH to run an isolated second \
                     relay.",
                    state_path.display()
                );
                std::process::exit(1);
            }
            Err(error) => {
                panic!(
                    "failed to acquire the relay-server instance lock for {state_path:?}: {error}"
                );
            }
        }
    };

    let state = AppState::new()
        .await
        .expect("failed to initialize Codex app-server bridge");
    // Register the private orchestration engines, when this build has them. The
    // engines take the state as their `RelayPort`; the registry goes onto the
    // clone everything downstream uses, so it must be installed before the state
    // is shared. Without the feature there is simply no engine, and every guard
    // that asks the registry a question gets the "nothing is running" answer.
    #[cfg(feature = "private")]
    let state = {
        let task_list = std::sync::Arc::new(sealwire_private::TaskListEngine::new(state.clone()));
        let team = std::sync::Arc::new(sealwire_private::TeamEngine::default());
        state
            .with_orchestrators(vec![task_list])
            .with_team_driver(team)
            .with_private_review_anchors(std::sync::Arc::new(sealwire_private::ReviewAnchorsImpl))
    };

    // Needs BOTH the user's opt-in and a build that can run the feature: on the
    // flag alone a stub build gets a live Task screen wired to an engine that is
    // not there.
    let beta_features_enabled = parse_optional_bool_env(SEALWIRE_BETA_ENV)
        .unwrap_or_else(|error| panic!("invalid {SEALWIRE_BETA_ENV}: {error}"))
        && cfg!(feature = "private");
    state.set_beta_features_enabled(beta_features_enabled).await;
    if beta_features_enabled {
        info!("beta features are ON for this launch (SEALWIRE_BETA)");
    }

    // One place where startup's background loops begin, so tests compose it the
    // same way. Placement is free: the team driver is shared between clones.
    state.spawn_configured_watchdogs();

    let web_assets = default_web_assets();
    log_web_assets(&web_assets);
    let context = AppContext {
        app: state,
        auth,
        launch_id: std::env::var(LAUNCH_ID_ENV)
            .ok()
            .filter(|value| !value.is_empty()),
        security_headers,
        host_policy,
    };
    let app = build_router(context, web_assets);
    let address = SocketAddr::from((host, port));

    info!("relay-server listening on http://{}:{}", host, port);

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind tcp listener");

    // Best-effort {pid, port} so a later process that loses the lock can point
    // the user at this one; never load-bearing (the OS lock is the guarantee).
    if let Some(guard) = &lock_guard {
        if let Err(error) = guard.record_owner(port) {
            warn!("failed to record relay-server instance lock owner info: {error}");
        }
    }

    axum::serve(listener, app)
        .await
        .expect("server exited unexpectedly");
    // `lock_guard` (if any) is dropped here, releasing the OS lock as the
    // process exits — kept alive up to this point on purpose (see
    // InstanceLockGuard's doc comment).
}

fn build_router(context: AppContext, web_assets: WebAssets) -> Router {
    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/usage", get(usage_report))
        .route("/api/teams", get(team_catalog))
        .route("/api/orchestrator/ensure", post(ensure_orchestrator))
        .route("/api/orchestrator/reset", post(reset_orchestrator))
        .route(
            "/api/orchestrator/proposals",
            post(propose_orchestrator_task),
        )
        .route(
            "/api/orchestrator/proposals/:proposal_id/confirm",
            post(confirm_orchestrator_proposal),
        )
        .route("/api/session/delegate", post(delegate_to_agent))
        .route("/api/session/goal", post(set_session_goal))
        .route("/api/orchestrator/tools", get(list_orchestrator_tools))
        .route(
            "/api/orchestrator/tools/:tool_name/call",
            post(call_orchestrator_tool),
        )
        .route(
            "/api/orchestrator/proposals/:proposal_id/revise",
            post(revise_orchestrator_proposal),
        )
        .route(
            "/api/orchestrator/proposals/:proposal_id/dismiss",
            post(dismiss_orchestrator_proposal),
        )
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
        .route("/api/workspace/git-context", get(workspace_git_context))
        .route(
            "/api/thread/workspace",
            get(thread_workspace).post(pin_thread_workspace),
        )
        .route("/api/threads/:thread_id/settings", get(thread_settings))
        .route("/api/stream", get(session_stream))
        .route("/api/threads", get(list_threads))
        .route("/api/threads/:thread_id/transcript", get(thread_transcript))
        .route(
            "/api/threads/:thread_id/entries/:item_id/detail",
            get(thread_entry_detail),
        )
        .route("/api/allowed-roots", post(update_allowed_roots))
        .route("/api/usage/budget", post(update_usage_budget))
        .route("/api/workspace/trust", post(set_workspace_trust))
        .route("/api/projects", get(fetch_projects).post(project_action))
        .route("/api/devices", get(list_devices))
        .route(
            "/api/threads/:thread_id/workspace/repair",
            post(repair_thread_workspace),
        )
        .route("/api/threads/:thread_id/rename", post(rename_thread))
        .route("/api/threads/:thread_id/flag", post(flag_thread))
        .route("/api/threads/:thread_id/archive", post(archive_thread))
        .route(
            "/api/threads/:thread_id/delete",
            post(delete_thread_permanently),
        )
        .route("/api/file-changes/:item_id/apply", post(apply_file_change))
        .route(
            "/api/session/start",
            post(start_session).layer(DefaultBodyLimit::max(MAX_LOCAL_MESSAGE_BODY_BYTES)),
        )
        .route(
            "/api/session/fork",
            post(fork_session).layer(DefaultBodyLimit::max(MAX_LOCAL_MESSAGE_BODY_BYTES)),
        )
        .route("/api/session/resume", post(resume_session))
        .route("/api/session/settings", post(update_session_settings))
        .route("/api/session/heartbeat", post(session_heartbeat))
        .route("/api/session/watch-threads", post(session_watch_threads))
        .route("/api/session/take-over", post(take_over_session))
        .route(
            "/api/session/message",
            post(send_message).layer(DefaultBodyLimit::max(MAX_LOCAL_MESSAGE_BODY_BYTES)),
        )
        .route("/api/session/stop", post(stop_active_turn))
        .route("/api/session/review", post(request_review))
        .route("/api/session/workflow", post(start_workflow))
        .route("/api/session/review/resolve", post(resolve_review))
        .route("/api/session/workflow/resolve", post(resolve_workflow))
        .route("/api/session/reviews", get(list_reviews))
        .route("/api/session/workflows", get(list_workflows))
        .route("/api/session/team", post(start_team))
        .route("/api/session/team/pause", post(pause_team))
        .route("/api/session/team/stop", post(stop_team))
        .route("/api/session/team/cancel", post(cancel_team))
        .route("/api/session/team/mark", post(mark_team))
        .route("/api/session/team/delete", post(delete_team))
        .route("/api/session/team/resume", post(resume_team))
        .route("/api/session/team/resolve", post(resolve_team))
        .route("/api/session/teams", get(list_teams))
        .route("/api/session/team/diff", get(team_diff))
        .route("/api/session/team/file", get(team_file))
        .route("/api/comments", get(list_comments).post(create_comment))
        .route("/api/comments/:comment_id/resolve", post(resolve_comment))
        .route(
            "/api/comments/:comment_id/hand-back",
            post(hand_back_comment),
        )
        .route(
            "/api/review-ticks",
            get(list_review_ticks).post(tick_review_file),
        )
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

    let host_policy_context = context.clone();
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
        // Outermost on purpose: a request addressed to a hostname we do not
        // answer to should never reach routing, a handler, or the body reader.
        .layer(middleware::from_fn_with_state(
            host_policy_context,
            with_host_allowlist,
        ))
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
        launch_id: context.launch_id.clone(),
    }))
}

#[derive(Debug, Deserialize)]
struct UsageReportQuery {
    since: u64,
    until: u64,
    #[serde(default = "default_usage_bucket")]
    bucket: String,
    compare: Option<String>,
}

fn default_usage_bucket() -> String {
    "day".to_string()
}

async fn usage_report(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<UsageReportQuery>,
) -> Result<Json<ApiEnvelope<crate::usage::report::UsageReport>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .usage_report(
            query.since,
            query.until,
            &query.bucket,
            query.compare.as_deref(),
        )
        .await
        .map(|report| Json(ApiEnvelope::ok(report)))
        .map_err(bad_request)
}

async fn team_catalog(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<crate::teams::TeamCatalogReport>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    Ok(Json(ApiEnvelope::ok(context.app.team_catalog().await)))
}

async fn ensure_orchestrator(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<crate::protocol::EnsureOrchestratorInput>,
) -> Result<
    Json<ApiEnvelope<crate::protocol::EnsureOrchestratorReceipt>>,
    (StatusCode, Json<ApiError>),
> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .ensure_orchestrator(input.device_id)
        .await
        .map(|thread_id| {
            Json(ApiEnvelope::ok(
                crate::protocol::EnsureOrchestratorReceipt { thread_id },
            ))
        })
        .map_err(bad_request)
}

/// Retire the pinned Orchestrator and open a fresh one.
///
/// Separate from `ensure` on purpose: `ensure` is idempotent and must stay so —
/// every Tasks open calls it. This is the one that throws the old thread away, so
/// it takes a deliberate press rather than riding on a screen load.
async fn reset_orchestrator(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<crate::protocol::EnsureOrchestratorInput>,
) -> Result<
    Json<ApiEnvelope<crate::protocol::EnsureOrchestratorReceipt>>,
    (StatusCode, Json<ApiError>),
> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .reset_orchestrator(input.device_id)
        .await
        .map(|thread_id| {
            Json(ApiEnvelope::ok(
                crate::protocol::EnsureOrchestratorReceipt { thread_id },
            ))
        })
        .map_err(bad_request)
}

async fn propose_orchestrator_task(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<crate::protocol::ProposeOrchestratorTaskInput>,
) -> Result<
    Json<ApiEnvelope<crate::protocol::ProposeOrchestratorTaskReceipt>>,
    (StatusCode, Json<ApiError>),
> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .propose_orchestrator_task(input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

async fn confirm_orchestrator_proposal(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(proposal_id): Path<String>,
    Json(input): Json<crate::protocol::ConfirmOrchestratorProposalInput>,
) -> Result<Json<ApiEnvelope<crate::protocol::StartTeamReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .confirm_orchestrator_proposal(&proposal_id, input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

/// `POST /api/session/delegate` — the human door.
///
/// Separate from the tool route because it means something different: a person
/// typed a few words, so the asking agent is driven to turn them into a brief
/// first. The tool route must NOT do that — an agent already wrote its message.
/// `POST /api/session/goal` — the only way an objective is ever written.
///
/// There is deliberately no agent-facing TOOL: an agent that can edit its own
/// goal will edit it to one it can finish. That stops drift, not an adversary —
/// this route is reachable by anything that can reach loopback, shells included.
#[derive(serde::Deserialize)]
struct GoalInput {
    thread_id: String,
    /// Empty cancels: "/goal" with nothing after it stops the current one.
    #[serde(default)]
    objective: String,
}

#[derive(serde::Deserialize)]
struct DelegateInput {
    thread_id: String,
    message: String,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
}

#[derive(serde::Deserialize)]
struct OrchestratorToolCallInput {
    #[serde(default)]
    arguments: serde_json::Value,
    #[serde(default)]
    device_id: Option<String>,
    /// Routes to the seat toolset and scopes answers to that run. Caller-
    /// supplied, so it narrows what a seat gets — it does not authenticate one.
    #[serde(default)]
    seat_run_id: Option<String>,
    /// Proof of which session is calling. Only ever present in the env of the
    /// bridge subprocess the relay launched, so unlike `seat_run_id` it really
    /// does identify the caller — a thread id would not, since every client can
    /// read the thread list.
    #[serde(default)]
    ask_token: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct OrchestratorToolListQuery {
    #[serde(default)]
    ask_token: Option<String>,
    #[serde(default)]
    seat_run_id: Option<String>,
}

async fn set_session_goal(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<GoalInput>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let outcome = if input.objective.trim().is_empty() {
        context
            .app
            .cancel_goal(&input.thread_id)
            .await
            .map(|()| "Goal stopped.".to_string())
    } else {
        context
            .app
            .set_goal(&input.thread_id, &input.objective)
            .await
            .map(|()| "Goal set. This session will work toward it and come back when it is done, stuck, or needs you.".to_string())
    };
    Ok(Json(
        crate::state::app::orchestrator_dispatch::tool_result_envelope(outcome),
    ))
}

async fn delegate_to_agent(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<DelegateInput>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let outcome = context
        .app
        .ask_agent(
            &input.thread_id,
            relay_api::delegation::AskRequest {
                peer_thread_id: input.agent,
                provider: input.provider,
                model: input.model,
                effort: input.effort,
                message: input.message,
                // The whole reason this route exists.
                expand_with_context: true,
            },
        )
        .await
        .map(|peer| {
            format!(
                "Asked. That agent's id is {peer}; you will be sent its answer when it is done."
            )
        })
        .map_err(|error| error.message());
    Ok(Json(
        crate::state::app::orchestrator_dispatch::tool_result_envelope(outcome),
    ))
}

async fn list_orchestrator_tools(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<OrchestratorToolListQuery>,
) -> Result<Json<ApiEnvelope<serde_json::Value>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    // Precedence mirrors the bridge's: a seat first, then an ordinary session,
    // then the Orchestrator. Only one env key is ever set, so at most one matches.
    let tools = match (query.seat_run_id, query.ask_token) {
        (Some(_), _) => context.app.list_team_seat_tools().await,
        (None, Some(_)) => context.app.list_peer_tools().await,
        (None, None) => context.app.list_orchestrator_tools().await,
    };
    Ok(Json(ApiEnvelope::ok(serde_json::json!({ "tools": tools }))))
}

/// A refused tool call is a 200 carrying `isError`, not a 4xx.
///
/// MCP models a tool that says no as a RESULT — the model reads the reason and
/// corrects itself. Mapping it to an HTTP error would surface to the model as a
/// transport failure, which it can only respond to by retrying the same call.
async fn call_orchestrator_tool(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(tool_name): Path<String>,
    Json(input): Json<OrchestratorToolCallInput>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    if let Some(token) = input.ask_token.as_deref() {
        let outcome = context
            .app
            .call_peer_tool(&tool_name, &input.arguments, token)
            .await;
        return Ok(Json(
            crate::state::app::orchestrator_dispatch::tool_result_envelope(outcome),
        ));
    }
    let outcome = match input.seat_run_id.as_deref() {
        Some(run_id) => {
            context
                .app
                .call_team_seat_tool(&tool_name, &input.arguments, run_id)
                .await
        }
        None => {
            context
                .app
                .call_orchestrator_tool(&tool_name, &input.arguments, input.device_id)
                .await
        }
    };
    Ok(Json(
        crate::state::app::orchestrator_dispatch::tool_result_envelope(outcome),
    ))
}

async fn revise_orchestrator_proposal(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(proposal_id): Path<String>,
    Json(input): Json<crate::protocol::ReviseOrchestratorProposalInput>,
) -> Result<
    Json<ApiEnvelope<crate::protocol::ProposeOrchestratorTaskReceipt>>,
    (StatusCode, Json<ApiError>),
> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .revise_orchestrator_proposal(&proposal_id, input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

async fn dismiss_orchestrator_proposal(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(proposal_id): Path<String>,
    Json(input): Json<crate::protocol::DismissOrchestratorProposalInput>,
) -> Result<Json<ApiEnvelope<()>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .dismiss_orchestrator_proposal(&proposal_id, input)
        .await
        .map(|()| Json(ApiEnvelope::ok(())))
        .map_err(bad_request)
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
    Query(query): Query<WorkspaceDiffQuery>,
) -> Result<Json<ApiEnvelope<WorkspaceDiffResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .workspace_diff(None, query.thread_id, query.view_root)
        .await
        .map(|response| Json(ApiEnvelope::ok(response)))
        .map_err(|error| classify_session_error(error))
}

/// `cwd` is required and caller-supplied: no fallback to the relay's active cwd,
/// because answering about a different directory is worse than an error.
#[derive(Debug, Deserialize)]
struct WorkspaceGitContextQuery {
    cwd: String,
}

async fn workspace_git_context(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<WorkspaceGitContextQuery>,
) -> Result<Json<ApiEnvelope<WorkspaceGitContextView>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .workspace_git_context(None, query.cwd)
        .await
        .map(|response| Json(ApiEnvelope::ok(response)))
        // Both failures are the caller's, so 400. `classify_session_error` would file
        // the scope refusal as `bad_gateway` — a client mistake reported as ours.
        .map_err(bad_request)
}

/// Resolved working tree for this session.
async fn thread_workspace(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<ThreadWorkspaceQuery>,
) -> Result<Json<ApiEnvelope<ResolvedWorkspace>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let mut resolved = context
        .app
        .resolve_thread_workspace(&query.thread_id, query.device_id.as_deref())
        .await
        .map_err(|error| bad_request(error.into_message()))?;
    if query.roots_status {
        // After resolution, so the measured set is exactly the device-scoped roots the
        // picker will offer — never a tree this caller may not see.
        state::app::measure_root_changes(&context.app, &mut resolved.roots).await;
    }
    Ok(Json(ApiEnvelope::ok(resolved)))
}

/// Pin (`cwd`) or un-pin (`cwd: null`); response is the re-resolved state.
async fn pin_thread_workspace(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<ThreadWorkspaceInput>,
) -> Result<Json<ApiEnvelope<ResolvedWorkspace>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .pin_thread_workspace(input)
        .await
        .map(|resolved| Json(ApiEnvelope::ok(resolved)))
        .map_err(bad_request)
}

/// What a fork of this thread would inherit. Read-only, in-memory, and scoped to
/// the thread's own workspace by `thread_settings_view`.
async fn thread_settings(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(thread_id): Path<String>,
    Query(query): Query<DeviceQuery>,
) -> Result<Json<ApiEnvelope<ThreadSettingsView>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .thread_settings_view(query.device_id, &thread_id)
        .await
        .map(|response| Json(ApiEnvelope::ok(response)))
        .map_err(bad_request)
}

/// Query for `/api/stream`. `device_id` identifies the surface so its declared thread
/// watch set can filter the delta stream; without one the connection still gets
/// snapshots, just no low-latency tail.
#[derive(Debug, Deserialize)]
struct SessionStreamQuery {
    #[serde(default)]
    device_id: Option<String>,
    /// Per-TAB id. Two tabs share a device id (it lives in localStorage), so the delta
    /// filter has to key off the connection or the tab that declared last would silence
    /// the other.
    #[serde(default)]
    surface_id: Option<String>,
    /// The client's generation for this connection (its connect timestamp). Lets a
    /// stale page's in-flight declaration be refused after a reload.
    #[serde(default)]
    surface_generation: Option<u64>,
}

async fn session_stream(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<SessionStreamQuery>,
) -> Result<
    Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>,
    (StatusCode, Json<ApiError>),
> {
    authorize_api(&context, &headers, &uri)?;
    let initial_state = context.app.clone();
    let updates_state = context.app.clone();
    let delta_state = context.app.clone();
    let receiver = context.app.subscribe();
    let delta_receiver = context.app.subscribe_transcript_deltas().await;
    let surface_id = query
        .surface_id
        .or(query.device_id)
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());

    // Every local surface renders the identical LocalWeb-compacted snapshot, so the build
    // is shared across one notify's fan-out instead of repeated per connection. Building
    // takes the relay WRITE lock, so a per-connection build made N surfaces contend N
    // times for that exclusive lock on every notify.
    //
    // The FIRST frame is exempt: a connecting surface gets a point-in-time snapshot,
    // because same-revision snapshots still differ in `server_time`/`devices_revision`,
    // and this frame lands on top of whatever the client just fetched from `/api/session`.
    let initial = stream::once(async move {
        Ok::<Event, Infallible>(snapshot_event(
            &initial_state.fresh_local_snapshot_payload().await,
        ))
    });

    let updates = stream::unfold(
        (updates_state, receiver),
        |(state, mut receiver)| async move {
            if receiver.changed().await.is_err() {
                return None;
            }

            Some((
                Ok::<Event, Infallible>(snapshot_event(&state.local_snapshot_payload().await)),
                (state, receiver),
            ))
        },
    );

    // The live tail. Snapshots alone made the local surface's in-flight text stop at
    // the snapshot transcript cap until the turn ended; deltas carry the tail
    // uncapped, and (via the watch set) for every thread the surface has on screen —
    // not just the one globally-active thread.
    // Dropping this guard (client disconnect, tab close, navigation) removes this
    // surface's watch set. Without it a closed tab keeps its threads in the publish set
    // forever, and a local-only relay keeps producing deltas nobody reads.
    let generation = match surface_id.as_deref() {
        Some(id) => {
            context
                .app
                .open_surface_generation(id, query.surface_generation)
                .await
        }
        None => 0,
    };
    let cleanup = SurfaceWatchGuard {
        app: context.app.clone(),
        surface_id: surface_id.clone(),
        generation,
    };

    let deltas = stream::unfold(
        (delta_state, delta_receiver, surface_id, cleanup),
        |(state, mut receiver, surface_id, cleanup)| async move {
            // No surface id means no watch set to filter against, so this connection
            // gets snapshots only. End the delta stream rather than waking on every
            // delta just to discard it.
            let watcher = surface_id.clone()?;
            loop {
                let delta = match receiver.recv().await {
                    Ok(delta) => delta,
                    // Lagged: this connection fell behind and frames were DROPPED. The
                    // next snapshot alone does not repair it — a compacted snapshot is a
                    // preview, and a longer stale local body beats it in the merge, so
                    // the client would keep a permanently short tail. Tell the client
                    // explicitly so it refetches the authoritative transcript.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(dropped)) => {
                        return Some((
                            Ok::<Event, Infallible>(transcript_lagged_event(dropped)),
                            (state, receiver, surface_id, cleanup),
                        ));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                };
                if !state
                    .surface_watches_thread(&watcher, &delta.thread_id)
                    .await
                {
                    continue;
                }
                return Some((
                    Ok::<Event, Infallible>(transcript_delta_event(&delta)),
                    (state, receiver, surface_id, cleanup),
                ));
            }
        },
    );

    Ok(
        Sse::new(initial.chain(stream::select(updates, deltas))).keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        ),
    )
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
        .list_threads_matching(limit, None, query.q.as_deref(), None)
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

/// POST, so the CSRF layer covers it — and there is deliberately no broker action
/// alongside it, which is what keeps the grant a local act.
async fn set_workspace_trust(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<WorkspaceTrustInput>,
) -> Result<Json<ApiEnvelope<WorkspaceTrustReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .set_workspace_trust(input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

async fn update_usage_budget(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<crate::protocol::UsageBudgetInput>,
) -> Result<Json<ApiEnvelope<crate::protocol::UsageBudgetReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .update_usage_budget(input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
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

async fn project_action(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<ProjectActionInput>,
) -> Result<Json<ApiEnvelope<ProjectActionReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .project_action(input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

// The dedicated, uncompacted Projects payload (list + membership + revision),
// decoupled from the byte-budgeted session snapshot.
async fn fetch_projects(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<ProjectsResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    Ok(Json(ApiEnvelope::ok(context.app.fetch_projects().await)))
}

async fn rename_thread(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(thread_id): Path<String>,
    // A REQUIRED body, deliberately unlike the neighbouring archive/delete handlers.
    //
    // They take `Option<Json<_>>`, whose rejection type in axum 0.7 is `Infallible` and
    // whose body is `T::from_request(..).await.ok()` — it swallows EVERY rejection: a
    // missing or wrong `Content-Type`, malformed JSON, a wrong value type, an oversized
    // body. For archive, all of those collapse to a benign default ("keep reviewer
    // threads"). Here they would collapse to `RenameThreadInput::default()`, i.e.
    // `name: None`, which this endpoint reads as a RESET — so a client that merely
    // forgot its content-type header would get `200 OK` and have the user's title
    // silently deleted.
    //
    // Rather than try to tell "no body" apart from "unparseable body" (the wrong
    // content-type case is genuinely ambiguous), the bodyless convenience is dropped:
    // a reset is the explicit `{"name": null}`, which is what both surfaces already
    // send. Anything unparseable now gets axum's own 400/415 instead of destroying data.
    Json(input): Json<RenameThreadInput>,
) -> Result<Json<ApiEnvelope<ThreadRenameReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .rename_thread(&thread_id, input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        // Every failure here is a rejected REQUEST (name too long, reviewer thread,
        // limit reached) — the rename never touches a provider, so there is no upstream
        // to blame with a 502.
        .map_err(bad_request)
}

/// Toggle a session's follow-up flag. `flagged` is a plain `bool`, not `Option<T>`,
/// so — unlike `rename_thread` — a derived `Deserialize` already fails closed on a
/// missing key; no hand-rolled parsing needed here.
async fn flag_thread(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(thread_id): Path<String>,
    Json(input): Json<SetThreadFlagInput>,
) -> Result<Json<ApiEnvelope<ThreadFlagReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .set_thread_flag(&thread_id, input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        // Same reasoning as rename_thread: every failure here is a rejected REQUEST,
        // never a provider error.
        .map_err(bad_request)
}

/// Re-create a thread's vanished workspace, then hand back the fresh snapshot so the
/// caller's banner turns back into a composer without a second round trip.
async fn repair_thread_workspace(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(thread_id): Path<String>,
    // Optional body: the repair carries no choices (the recorded path is the only one
    // that can work), so an absent body is a complete request, not a degraded one.
    body: Option<Json<RepairWorkspaceInput>>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let input = body.map(|Json(input)| input).unwrap_or_default();
    context
        .app
        .repair_thread_workspace(&thread_id, input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(snapshot)))
        // Nothing upstream is involved — this creates a directory (or runs `git worktree
        // add`) on this host. A failure is this request's, so it is never a 502.
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
    Json(input): Json<LocalStartSessionInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let images = parse_local_message_images(input.images).map_err(bad_request)?;
    context
        .app
        .start_session_with_images(input.session, images)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(compact_local_snapshot(snapshot))))
        .map_err(|error| classify_session_error(error))
}

async fn fork_session(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<LocalForkSessionInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let images = parse_local_message_images(input.images).map_err(bad_request)?;
    context
        .app
        .fork_session_with_images(input.fork, images)
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
    Json(input): Json<LocalSendMessageInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let images = parse_local_message_images(input.images).map_err(bad_request)?;
    context
        .app
        .send_message_with_images(input.message, images)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(compact_local_snapshot(snapshot))))
        .map_err(bad_request)
}

fn parse_local_message_images(inputs: Vec<LocalImageInput>) -> Result<Vec<ProviderImage>, String> {
    if inputs.len() > MAX_LOCAL_MESSAGE_IMAGES {
        return Err(format!(
            "a message may include at most {MAX_LOCAL_MESSAGE_IMAGES} images"
        ));
    }

    let mut total_bytes = 0usize;
    let mut images = Vec::with_capacity(inputs.len());
    for input in inputs {
        let payload = input
            .data_url
            .strip_prefix("data:")
            .ok_or_else(|| "image attachment must be a data URL".to_string())?;
        let (metadata, encoded) = payload
            .split_once(',')
            .ok_or_else(|| "image attachment data URL is malformed".to_string())?;
        let (media_type, encoding) = metadata
            .split_once(';')
            .ok_or_else(|| "image attachment data URL is malformed".to_string())?;
        if encoding != "base64" {
            return Err("image attachment must use base64 encoding".to_string());
        }
        if !matches!(
            media_type,
            "image/gif" | "image/jpeg" | "image/png" | "image/webp"
        ) {
            return Err(format!("unsupported image attachment type `{media_type}`"));
        }

        let bytes = BASE64_STANDARD
            .decode(encoded)
            .map_err(|_| "image attachment contains invalid base64".to_string())?;
        if bytes.len() > MAX_LOCAL_MESSAGE_IMAGE_BYTES {
            return Err(format!(
                "each image attachment must be at most {} MB",
                MAX_LOCAL_MESSAGE_IMAGE_BYTES / (1024 * 1024)
            ));
        }
        total_bytes = total_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| "image attachment size overflow".to_string())?;
        if total_bytes > MAX_LOCAL_MESSAGE_IMAGE_TOTAL_BYTES {
            return Err(format!(
                "image attachments must be at most {} MB in total",
                MAX_LOCAL_MESSAGE_IMAGE_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        if !image_bytes_match_media_type(media_type, &bytes) {
            return Err(format!(
                "image attachment bytes do not match `{media_type}`"
            ));
        }

        images.push(ProviderImage {
            media_type: media_type.to_string(),
            data: BASE64_STANDARD.encode(bytes),
        });
    }
    Ok(images)
}

fn image_bytes_match_media_type(media_type: &str, bytes: &[u8]) -> bool {
    match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
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

async fn start_workflow(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<StartWorkflowInput>,
) -> Result<Json<ApiEnvelope<StartWorkflowReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .start_code_workflow(input)
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

async fn resolve_workflow(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<WorkflowActionInput>,
) -> Result<Json<ApiEnvelope<WorkflowActionReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .resolve_blocked_workflow(input)
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

async fn list_workflows(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<WorkflowsResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    Ok(Json(ApiEnvelope::ok(context.app.workflows(None).await)))
}

async fn start_team(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<StartTeamInput>,
) -> Result<Json<ApiEnvelope<StartTeamReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .start_team(input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

/// The five whole-run actions share one body; only the verb differs.
async fn team_action(
    context: AppContext,
    headers: HeaderMap,
    uri: Uri,
    action: TeamAction2,
    input: TeamActionInput,
) -> Result<Json<ApiEnvelope<TeamActionReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .team_action(action, input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(bad_request)
}

async fn pause_team(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<TeamActionInput>,
) -> Result<Json<ApiEnvelope<TeamActionReceipt>>, (StatusCode, Json<ApiError>)> {
    team_action(context, headers, uri, TeamAction2::Pause, input).await
}

async fn stop_team(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<TeamActionInput>,
) -> Result<Json<ApiEnvelope<TeamActionReceipt>>, (StatusCode, Json<ApiError>)> {
    team_action(context, headers, uri, TeamAction2::Stop, input).await
}

async fn cancel_team(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<TeamActionInput>,
) -> Result<Json<ApiEnvelope<TeamActionReceipt>>, (StatusCode, Json<ApiError>)> {
    team_action(context, headers, uri, TeamAction2::Cancel, input).await
}

async fn mark_team(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<TeamMarkInput>,
) -> Result<Json<ApiEnvelope<TeamActionReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let receipt = context.app.mark_team(input).await.map_err(bad_request)?;
    Ok(Json(ApiEnvelope::ok(receipt)))
}

async fn delete_team(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<TeamActionInput>,
) -> Result<Json<ApiEnvelope<TeamActionReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let receipt = context.app.delete_team(input).await.map_err(bad_request)?;
    Ok(Json(ApiEnvelope::ok(receipt)))
}

async fn resume_team(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<TeamActionInput>,
) -> Result<Json<ApiEnvelope<TeamActionReceipt>>, (StatusCode, Json<ApiError>)> {
    team_action(context, headers, uri, TeamAction2::Resume, input).await
}

async fn resolve_team(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<TeamActionInput>,
) -> Result<Json<ApiEnvelope<TeamActionReceipt>>, (StatusCode, Json<ApiError>)> {
    team_action(context, headers, uri, TeamAction2::Resolve, input).await
}

async fn list_teams(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<TeamsResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    Ok(Json(ApiEnvelope::ok(context.app.teams().await)))
}

/// Query for `/api/session/team/diff`.
///
/// `base` is a key from the response's own `bases` list rather than a ref or a
/// commit: a caller-supplied revision would be an argument to `git` chosen by
/// whoever can reach the route, and the useful answers are all named already.
#[derive(Debug, Deserialize)]
struct TeamDiffQuery {
    team_run_id: Option<String>,
    /// Omitted = against the target branch, which is the question people ask.
    base: Option<String>,
    device_id: Option<String>,
}

/// Query for `/api/session/team/file`.
#[derive(Debug, Deserialize)]
struct TeamFileQuery {
    team_run_id: Option<String>,
    base: Option<String>,
    path: String,
    side: String,
    device_id: Option<String>,
}

/// What a task team changed, against a base the caller picks.
async fn team_diff(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<TeamDiffQuery>,
) -> Result<Json<ApiEnvelope<crate::protocol::TeamDiffResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .team_diff(query.team_run_id.as_deref(), query.base, query.device_id)
        .await
        .map(|response| Json(ApiEnvelope::ok(response)))
        .map_err(bad_request)
}

/// One file from a task worktree or its diff base.
async fn team_file(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<TeamFileQuery>,
) -> Result<Json<ApiEnvelope<TeamFileResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .team_file(
            query.team_run_id.as_deref(),
            query.base,
            query.path,
            query.side,
            query.device_id,
        )
        .await
        .map(|response| Json(ApiEnvelope::ok(response)))
        .map_err(bad_request)
}

async fn list_comments(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<ListCommentsQuery>,
) -> Result<Json<ApiEnvelope<ListCommentsResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .list_review_comments(query.scope, query.device_id)
        .await
        .map(|response| Json(ApiEnvelope::ok(response)))
        .map_err(bad_request)
}

async fn create_comment(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<CreateCommentInput>,
) -> Result<Json<ApiEnvelope<CommentMutationReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .create_review_comment(input)
        .await
        .map(|comment| Json(ApiEnvelope::ok(CommentMutationReceipt { comment })))
        .map_err(bad_request)
}

async fn resolve_comment(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(comment_id): Path<String>,
    Json(input): Json<CommentResolveInput>,
) -> Result<Json<ApiEnvelope<CommentMutationReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .resolve_review_comment(comment_id, input)
        .await
        .map(|comment| Json(ApiEnvelope::ok(CommentMutationReceipt { comment })))
        .map_err(bad_request)
}

async fn hand_back_comment(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Path(comment_id): Path<String>,
    Json(input): Json<CommentHandBackInput>,
) -> Result<Json<ApiEnvelope<CommentMutationReceipt>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .hand_back_review_comment(comment_id, input)
        .await
        .map(|comment| Json(ApiEnvelope::ok(CommentMutationReceipt { comment })))
        .map_err(bad_request)
}

async fn list_review_ticks(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<ListReviewTicksQuery>,
) -> Result<Json<ApiEnvelope<ListReviewTicksResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .list_review_ticks(query)
        .await
        .map(|response| Json(ApiEnvelope::ok(response)))
        .map_err(bad_request)
}

async fn tick_review_file(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<TickReviewFileInput>,
) -> Result<Json<ApiEnvelope<relay_api::FileReviewTickView>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .tick_review_file(input)
        .await
        .map(|tick| Json(ApiEnvelope::ok(tick)))
        .map_err(bad_request)
}

async fn list_devices(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<DevicesResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    Ok(Json(ApiEnvelope::ok(context.app.devices().await)))
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

/// Declare which threads this surface has on screen. Returns no snapshot: a watch
/// declaration changes nothing renderable, and the caller fires it on every navigation.
async fn session_watch_threads(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<WatchThreadsInput>,
) -> Result<Json<ApiEnvelope<()>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .set_watched_threads(input)
        .await
        .map(|()| Json(ApiEnvelope::ok(())))
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
/// Exact messages (or uniquely-scoped fragments) the SESSION layer emits for a
/// malformed request. Deliberately not broad needles like `"is required"`: that
/// also matches boot-time config errors and anything a provider happens to
/// phrase that way, which would blame the caller for an upstream failure. Every
/// entry here was taken from its producing call site.
const CALLER_ERROR_MARKERS: &[&str] = &[
    // state/app/fork.rs truncate_transcript_at (embeds the item id)
    "is not part of the source thread transcript",
    // state/app/providers.rs find_thread_provider (embeds the thread id)
    "was not found on any provider",
    // require_device_id and the per-input guards across the session layer
    "device_id is required",
    "thread_id is required",
    "review_job_id is required",
    "reviewer_provider is required",
];

/// Transient conflicts: the same request succeeds once the state changes.
const CONFLICT_MARKERS: &[&str] = &[
    // state/app/fork.rs FORK_BUSY_SOURCE_MSG and the send-during-turn guards
    "turn is in progress",
    // state/app/review.rs acquire_session_slot
    "a review is in progress",
    // The reviewed-thread lock, by CONSTANT so a reword cannot silently
    // regress it to 502.
    crate::state::REVIEW_LOCKED_THREAD_MSG,
];

/// `agent provider '<name>' is not available` (state/app/providers.rs). Matched
/// as a pair because `"is not available"` alone is a phrase a provider could
/// emit for an unrelated upstream failure.
fn is_unknown_provider_error(message: &str) -> bool {
    message.contains("agent provider") && message.contains("is not available")
}

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
    if is_unknown_provider_error(&message)
        || CALLER_ERROR_MARKERS
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

/// The payload is already serialized (and shared) by `local_snapshot_payload`, which is
/// what keeps one notify from costing N snapshot builds and N write-lock acquisitions.
fn snapshot_event(payload: &str) -> Event {
    Event::default().event("session").data(payload)
}

/// Removes a surface's thread-watch set when its SSE stream is dropped, however that
/// happens (clean close, navigation, network loss). Tying cleanup to the stream's
/// lifetime is the only way to catch all three.
struct SurfaceWatchGuard {
    app: AppState,
    surface_id: Option<String>,
    /// The generation this connection owns. Teardown only unsubscribes if it is still
    /// current — a refreshed tab reuses its surface id, and the old stream's drop can
    /// run after the new stream has already declared.
    generation: u64,
}

impl Drop for SurfaceWatchGuard {
    fn drop(&mut self) {
        let Some(surface_id) = self.surface_id.clone() else {
            return;
        };
        let app = self.app.clone();
        let generation = self.generation;
        tokio::spawn(async move {
            app.drop_watched_surface_generation(&surface_id, generation)
                .await;
        });
    }
}

/// Tells the client it missed delta frames, so it must refetch rather than trust its
/// local tail. Snapshots cannot cover this on their own: they are compacted previews,
/// and the merge deliberately keeps a longer local body over a shorter preview.
fn transcript_lagged_event(dropped: u64) -> Event {
    Event::default()
        .event("transcript_stream_lagged")
        .json_data(serde_json::json!({ "dropped": dropped }))
        .unwrap_or_else(|_| {
            Event::default()
                .event("transcript_stream_lagged")
                .data("{\"dropped\":0}")
        })
}

/// SSE frame for a live transcript append. The event name and field names match what
/// `frontend/local/session/stream.js` already parses.
fn transcript_delta_event(delta: &TranscriptDeltaEvent) -> Event {
    Event::default()
        .event("transcript_entry_delta")
        .json_data(delta)
        .unwrap_or_else(|error| {
            Event::default()
                .event("transcript_entry_delta")
                .data(format!(
                    "{{\"ok\":false,\"error\":\"failed_to_encode_delta:{error}\"}}"
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

/// Refuse any request addressed to a hostname this process does not answer to.
///
/// This is the DNS-rebinding guard. It cannot be expressed as an `Origin`
/// check: after a rebind the attacker's page sends `Host: evil.example` AND
/// `Origin: http://evil.example`, and since the expected origin is *derived*
/// from `Host` those two agree. Only pinning the hostname breaks the loop.
async fn with_host_allowlist(
    State(context): State<AppContext>,
    request: Request,
    next: Next,
) -> Response {
    let (allowed, host) = {
        let host = request
            .headers()
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .or_else(|| request.uri().authority().map(|value| value.as_str()));
        (
            context.host_policy.allows_host(host),
            host.unwrap_or("<none>").to_string(),
        )
    };

    if !allowed {
        // Without this the symptom of a legitimate custom hostname (a hosts-file
        // alias, a local reverse proxy) is an unexplained 421 on every request.
        warn!(
            "refused a request addressed to Host `{host}`; \
             set {} to add it if this hostname is yours",
            host_guard::ALLOWED_HOSTS_ENV
        );
        return (
            StatusCode::MISDIRECTED_REQUEST,
            Json(ApiError::new(
                "host_not_allowed",
                "This relay only answers to its own local hostnames.".to_string(),
            )),
        )
            .into_response();
    }

    next.run(request).await
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
    if !uri.path().starts_with("/api/") || method_is_safe(method) {
        return Ok(());
    }

    // A bearer token is not ambient authority: a hostile page cannot read it,
    // so it cannot be replayed through a confused deputy.
    if auth.authenticates_with_bearer(headers) {
        return Ok(());
    }

    if auth.enabled() && auth.authenticates_with_cookie(headers) {
        // Cookie credentials ARE ambient. Demand the custom header (which a
        // cross-origin page cannot set without a preflight this server never
        // grants) *and* a trusted origin.
        if !has_valid_csrf_header(headers) {
            return Err(forbidden_csrf(
                "Cookie-authenticated requests must include X-Agent-Relay-CSRF.",
            ));
        }

        return match classify_request_origin(headers, uri) {
            RequestOrigin::Trusted => Ok(()),
            _ => Err(forbidden_csrf(
                "Cookie-authenticated requests must come from the same Origin or Referer.",
            )),
        };
    }

    if auth.enabled() {
        // Authenticated by neither cookie nor bearer: `authorize_api` turns
        // this away on its own merits, and doing it there keeps the 401/403
        // distinction honest.
        return Ok(());
    }

    // No token configured — the laptop default, and the case the old
    // `!auth.enabled()` short-circuit skipped entirely. Every caller is
    // ambiently authorized here, so the browser check has to apply.
    //
    // Judging on a *declared* origin (rather than demanding one) is what keeps
    // this from breaking every non-browser client: curl, the Node e2e scripts
    // and the Tauri shell declare no origin, while a browser always attaches
    // one to a cross-site mutating request — including the CORS-simple form
    // posts that reach the body-less revoke routes.
    match classify_request_origin(headers, uri) {
        RequestOrigin::Untrusted => Err(forbidden_csrf(
            "Cross-origin requests are refused on the local API.",
        )),
        _ => Ok(()),
    }
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

/// What a request says about where it came from.
enum RequestOrigin {
    /// Neither `Origin` nor `Referer` was sent. A browser always declares one
    /// on a cross-site mutating request, so this is curl, a Node script, or
    /// the Tauri shell — not a page we could be a confused deputy for.
    Undeclared,
    Trusted,
    /// Declared and not trusted. Includes an origin that is *present but names
    /// nobody* — see the `null` case below.
    Untrusted,
}

/// Classify the origin a request declares.
///
/// Two things here are load-bearing and easy to undo by accident:
///
/// 1. **`Origin: null` is Untrusted, not Undeclared.** That is what a browser
///    sends from an opaque origin, and a page can arrange to be one. Note that
///    `relay_http::header_origin` maps `null` to `None`, exactly like an absent
///    header — so this reads the raw header rather than leaning on it.
///    Collapsing the two would admit such a page as "not a browser".
/// 2. **Referer is consulted only when `Origin` is absent entirely.** Origin is
///    the authoritative statement; if it is present and opaque, a friendly
///    Referer next to it is not a second opinion worth taking.
fn classify_request_origin(headers: &HeaderMap, uri: &Uri) -> RequestOrigin {
    // `.get()` is Some for a present-but-opaque header, so this falls through
    // to Referer only when Origin was genuinely not sent.
    let Some(raw) = headers
        .get(header::ORIGIN)
        .or_else(|| headers.get(header::REFERER))
    else {
        return RequestOrigin::Undeclared;
    };

    let Some(declared) = declared_origin_value(raw) else {
        return RequestOrigin::Untrusted;
    };

    if request_origin(headers, Some(uri)).is_some_and(|expected| expected == declared) {
        return RequestOrigin::Trusted;
    }

    // A cross-port loopback origin is the vite dev proxy (`changeOrigin: true`
    // rewrites Host, so `localhost:5173` -> `127.0.0.1:8787` is a legitimate
    // mismatch) — but loopback is NOT a trust boundary on its own. Any other
    // page served from this machine has a loopback origin too: a second dev
    // server, a static server showing an untrusted file, a local tool with an
    // XSS. The custom header is what separates them, because a cross-origin
    // page cannot set it without a CORS preflight this server never grants.
    // Every mutating call from the real frontend carries it already
    // (`frontend/local/api.js` `applyCsrfHeader`).
    let loopback = declared
        .parse::<Uri>()
        .ok()
        .and_then(|value| value.authority().map(|value| value.as_str().to_string()))
        .is_some_and(|authority| host_guard::authority_is_loopback(&authority));

    if loopback && has_valid_csrf_header(headers) {
        RequestOrigin::Trusted
    } else {
        RequestOrigin::Untrusted
    }
}

/// `scheme://authority` for an `Origin`/`Referer` value, or `None` when it
/// names no usable origin: `null`, empty, or unparseable.
fn declared_origin_value(value: &HeaderValue) -> Option<String> {
    let raw = value.to_str().ok()?.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("null") {
        return None;
    }

    let parsed = raw.parse::<Uri>().ok()?;
    Some(format!(
        "{}://{}",
        parsed.scheme_str()?,
        parsed.authority()?
    ))
}

fn forbidden_csrf(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::FORBIDDEN,
        Json(ApiError::new("csrf_rejected", message.into())),
    )
}

#[cfg(test)]
mod tests;
