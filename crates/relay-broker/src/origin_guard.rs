//! Edge-only origin gate. With a CDN (Cloudflare) in front, the platform origin
//! (e.g. `*.up.railway.app`) is still publicly routable, so the broker refuses any
//! request that lacks the secret header only the edge adds.

use axum::{
    extract::{Request, State},
    http::{HeaderMap, HeaderName, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use sha2::{Digest, Sha256};
use tracing::{debug, error, info};

pub const ORIGIN_AUTH_SECRET_ENV: &str = "RELAY_BROKER_ORIGIN_AUTH_SECRET";
pub const ORIGIN_AUTH_HEADER_ENV: &str = "RELAY_BROKER_ORIGIN_AUTH_HEADER";
pub const REQUIRE_ORIGIN_AUTH_ENV: &str = "RELAY_BROKER_REQUIRE_ORIGIN_AUTH";
pub const DEFAULT_ORIGIN_AUTH_HEADER: &str = "x-relay-origin-auth";
pub const MIN_ORIGIN_AUTH_SECRET_LEN: usize = 32;

const MAX_ORIGIN_AUTH_SECRET_LEN: usize = 512;
// Catches placeholders like `change-me-change-me-…` that pass the length check.
const MIN_ORIGIN_AUTH_SECRET_DISTINCT_BYTES: usize = 10;
const MAX_HEADER_NAME_LEN: usize = 64;

// Railway's deploy healthcheck calls the origin directly, so it never carries the edge header.
const EXEMPT_PATHS: &[&str] = &["/api/health"];

// Setting any of these at the edge would clobber auth, framing, the WebSocket upgrade,
// or a header the proxy itself owns.
const RESERVED_HEADER_NAMES: &[&str] = &[
    "authorization",
    "connection",
    "cookie",
    "expect",
    "forwarded",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "true-client-ip",
    "upgrade",
    "user-agent",
    "via",
    "x-real-ip",
];
const RESERVED_HEADER_PREFIXES: &[&str] = &[
    "access-control-",
    "cf-",
    "content-",
    "proxy-",
    "sec-",
    "x-forwarded-",
];

/// Whether `path` is reachable without the edge header (deploy readiness only).
pub fn origin_auth_exempt_path(path: &str) -> bool {
    EXEMPT_PATHS.contains(&path)
}

#[derive(Clone)]
enum Mode {
    Disabled,
    // Only a digest is kept, so the secret never sits in router state or `Debug` output.
    Enforced {
        header: HeaderName,
        secret_digest: [u8; 32],
    },
    Misconfigured,
}

/// Origin-auth policy for the public broker router. Build with [`OriginGuard::from_env`].
#[derive(Clone)]
pub struct OriginGuard {
    mode: Mode,
}

impl std::fmt::Debug for OriginGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.mode {
            Mode::Disabled => f.write_str("OriginGuard::Disabled"),
            Mode::Enforced { header, .. } => f
                .debug_struct("OriginGuard::Enforced")
                .field("header", header)
                .finish_non_exhaustive(),
            Mode::Misconfigured => f.write_str("OriginGuard::Misconfigured"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OriginAuthFailure {
    Missing,
    Duplicate,
    Mismatch,
}

impl OriginAuthFailure {
    fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Duplicate => "duplicate",
            Self::Mismatch => "mismatch",
        }
    }
}

impl OriginGuard {
    pub(crate) fn disabled() -> Self {
        Self {
            mode: Mode::Disabled,
        }
    }

    /// Refuses everything but readiness; what a bad config degrades to at runtime.
    pub(crate) fn fail_closed() -> Self {
        Self {
            mode: Mode::Misconfigured,
        }
    }

    /// Strict env parse. `Err` never contains the secret.
    ///
    /// A variable that is present but empty is an error rather than "unset": an
    /// unresolved platform variable reference expands to exactly that.
    pub fn from_env() -> Result<Self, String> {
        Self::from_env_values(
            read_env(ORIGIN_AUTH_HEADER_ENV)?.as_deref(),
            read_env(ORIGIN_AUTH_SECRET_ENV)?.as_deref(),
            read_env(REQUIRE_ORIGIN_AUTH_ENV)?.as_deref(),
        )
    }

    /// [`Self::from_env`] over raw values; `None` = variable absent.
    pub(crate) fn from_env_values(
        header: Option<&str>,
        secret: Option<&str>,
        require: Option<&str>,
    ) -> Result<Self, String> {
        // Same rule as the secret: an empty flag is a broken reference, not "off".
        if require.is_some_and(|value| value.trim().is_empty()) {
            return Err(format!("{REQUIRE_ORIGIN_AUTH_ENV} is set but empty"));
        }
        let require = crate::parse_bool_value(REQUIRE_ORIGIN_AUTH_ENV, require, false)?;
        Self::from_config(header, secret, require)
    }

    /// `None` = variable absent; `Some("")` = present but empty (an error).
    pub fn from_config(
        header: Option<&str>,
        secret: Option<&str>,
        require: bool,
    ) -> Result<Self, String> {
        let Some(secret) = secret else {
            if require {
                return Err(format!(
                    "{REQUIRE_ORIGIN_AUTH_ENV} is on but {ORIGIN_AUTH_SECRET_ENV} is not set"
                ));
            }
            if header.is_some() {
                return Err(format!(
                    "{ORIGIN_AUTH_HEADER_ENV} is set but {ORIGIN_AUTH_SECRET_ENV} is not"
                ));
            }
            return Ok(Self::disabled());
        };
        validate_secret(secret)?;
        let header = validate_header_name(header.unwrap_or(DEFAULT_ORIGIN_AUTH_HEADER))?;
        Ok(Self {
            mode: Mode::Enforced {
                header,
                secret_digest: Sha256::digest(secret.as_bytes()).into(),
            },
        })
    }

    /// Builder entry: a bad config must not leave the origin open, so it becomes [`Self::fail_closed`].
    pub(crate) fn from_env_or_fail_closed() -> Self {
        match Self::from_env() {
            Ok(guard) => {
                if let Mode::Enforced { header, .. } = &guard.mode {
                    info!(header = %header, "broker origin auth enforced");
                }
                guard
            }
            Err(error) => {
                error!(
                    %error,
                    "broker origin auth misconfigured; refusing every request except readiness"
                );
                Self::fail_closed()
            }
        }
    }

    pub fn is_enforced(&self) -> bool {
        matches!(self.mode, Mode::Enforced { .. })
    }

    pub fn is_misconfigured(&self) -> bool {
        matches!(self.mode, Mode::Misconfigured)
    }

    pub(crate) fn verify(&self, headers: &HeaderMap) -> Result<(), OriginAuthFailure> {
        let Mode::Enforced {
            header,
            secret_digest,
        } = &self.mode
        else {
            return Ok(());
        };
        let mut values = headers.get_all(header).iter();
        let Some(value) = values.next() else {
            return Err(OriginAuthFailure::Missing);
        };
        // The edge *sets* the header, so a second copy means it came from somewhere else.
        if values.next().is_some() {
            return Err(OriginAuthFailure::Duplicate);
        }
        // Comparing fixed-size digests keeps the timing independent of the secret's length.
        let presented: [u8; 32] = Sha256::digest(value.as_bytes()).into();
        if crate::constant_time_eq(&presented, secret_digest) {
            Ok(())
        } else {
            Err(OriginAuthFailure::Mismatch)
        }
    }

    fn header(&self) -> Option<&HeaderName> {
        match &self.mode {
            Mode::Enforced { header, .. } => Some(header),
            _ => None,
        }
    }
}

fn read_env(name: &str) -> Result<Option<String>, String> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid UTF-8")),
    }
}

fn validate_secret(secret: &str) -> Result<(), String> {
    // Messages name the rule, never the value.
    if secret.is_empty() {
        return Err(format!("{ORIGIN_AUTH_SECRET_ENV} is set but empty"));
    }
    if !secret.bytes().all(is_secret_byte) {
        return Err(format!(
            "{ORIGIN_AUTH_SECRET_ENV} may only contain A-Z a-z 0-9 and - . _ ~ + / = (no whitespace)"
        ));
    }
    if secret.len() < MIN_ORIGIN_AUTH_SECRET_LEN || secret.len() > MAX_ORIGIN_AUTH_SECRET_LEN {
        return Err(format!(
            "{ORIGIN_AUTH_SECRET_ENV} must be {MIN_ORIGIN_AUTH_SECRET_LEN}-{MAX_ORIGIN_AUTH_SECRET_LEN} characters"
        ));
    }
    let mut seen = [false; 256];
    let distinct = secret
        .bytes()
        .filter(|byte| !std::mem::replace(&mut seen[*byte as usize], true))
        .count();
    if distinct < MIN_ORIGIN_AUTH_SECRET_DISTINCT_BYTES {
        return Err(format!(
            "{ORIGIN_AUTH_SECRET_ENV} looks like a placeholder; generate one with `openssl rand -base64 48`"
        ));
    }
    Ok(())
}

fn is_secret_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'+' | b'/' | b'=')
}

fn validate_header_name(raw: &str) -> Result<HeaderName, String> {
    if raw.is_empty() {
        return Err(format!("{ORIGIN_AUTH_HEADER_ENV} is set but empty"));
    }
    let name = raw.to_ascii_lowercase();
    let well_formed = name.len() <= MAX_HEADER_NAME_LEN
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-');
    if !well_formed {
        return Err(format!(
            "{ORIGIN_AUTH_HEADER_ENV} must be 1-{MAX_HEADER_NAME_LEN} characters of a-z, 0-9 and -"
        ));
    }
    if RESERVED_HEADER_NAMES.contains(&name.as_str())
        || RESERVED_HEADER_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
    {
        return Err(format!(
            "{ORIGIN_AUTH_HEADER_ENV} `{name}` is a standard or proxy-managed header; use a dedicated name such as `{DEFAULT_ORIGIN_AUTH_HEADER}`"
        ));
    }
    HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| format!("{ORIGIN_AUTH_HEADER_ENV} is not a valid header name"))
}

/// Middleware for the public router. Strips the header so no handler can echo or log it.
pub(crate) async fn enforce_origin_auth(
    State(guard): State<OriginGuard>,
    mut request: Request,
    next: Next,
) -> Response {
    let exempt = origin_auth_exempt_path(request.uri().path());
    let verdict = match guard.mode {
        Mode::Disabled => return next.run(request).await,
        // Readiness still runs so the health handler can report the broken config.
        Mode::Misconfigured if exempt => return next.run(request).await,
        Mode::Misconfigured => {
            return refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "service unavailable",
            )
        }
        Mode::Enforced { .. } => guard.verify(request.headers()),
    };
    if let Some(header) = guard.header() {
        request.headers_mut().remove(header);
    }
    match verdict {
        Ok(()) => next.run(request).await,
        Err(_) if exempt => next.run(request).await,
        Err(failure) => {
            debug!(
                reason = failure.as_str(),
                path = %request.uri().path(),
                "refusing request that did not come through the edge"
            );
            refusal(StatusCode::FORBIDDEN, "forbidden", "request failed")
        }
    }
}

fn refusal(status: StatusCode, error: &'static str, message: &'static str) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
        .into_response()
}

#[cfg(test)]
mod tests;
