use axum::{
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::net::IpAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::protocol::{ApiError, AuthSessionView};

const API_TOKEN_ENV: &str = "RELAY_API_TOKEN";
const ALLOW_INSECURE_NO_AUTH_ENV: &str = "RELAY_ALLOW_INSECURE_NO_AUTH";
const SESSION_COOKIE_NAME: &str = "agent_relay_session";
const SESSION_COOKIE_CONTEXT: &[u8] = b"agent-relay-session";
const SESSION_COOKIE_TTL_SECS: u64 = 60 * 60 * 24 * 30;

type SessionCookieMac = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct AuthConfig {
    token: Option<String>,
    insecure_no_auth_override: bool,
}

impl AuthConfig {
    pub fn from_env_for_bind_host(bind_host: IpAddr) -> Result<Self, String> {
        Self::from_parts(
            normalized(std::env::var(API_TOKEN_ENV).ok()),
            std::env::var(ALLOW_INSECURE_NO_AUTH_ENV).ok(),
            bind_host,
        )
    }

    pub fn enabled(&self) -> bool {
        self.token.is_some()
    }

    pub fn insecure_no_auth_override_active(&self) -> bool {
        self.insecure_no_auth_override
    }

    pub fn session_view(&self, headers: &HeaderMap) -> AuthSessionView {
        let auth_required = self.enabled();
        let cookie_session = self
            .token
            .as_deref()
            .is_some_and(|expected| has_valid_session_cookie(headers, expected));
        let authenticated = !auth_required
            || cookie_session
            || self
                .token
                .as_deref()
                .is_some_and(|expected| bearer_token(headers) == Some(expected));

        AuthSessionView {
            auth_required,
            authenticated,
            cookie_session,
        }
    }

    pub fn issue_session_cookie(
        &self,
        provided_token: &str,
        secure: bool,
    ) -> Result<Option<HeaderValue>, (StatusCode, Json<ApiError>)> {
        let Some(expected) = self.token.as_deref() else {
            return Ok(None);
        };

        if provided_token.trim() != expected {
            return Err(unauthorized());
        }

        let expires_at = now_seconds().saturating_add(SESSION_COOKIE_TTL_SECS);
        let cookie_value =
            mint_session_cookie_value(expected, expires_at).map_err(|_| unauthorized())?;
        HeaderValue::from_str(&build_set_cookie_value(
            &cookie_value,
            secure,
            SESSION_COOKIE_TTL_SECS,
        ))
        .map(Some)
        .map_err(|_| unauthorized())
    }

    pub fn clear_session_cookie(&self, secure: bool) -> HeaderValue {
        HeaderValue::from_str(&build_clear_cookie_value(secure))
            .expect("clear-cookie header should be valid")
    }

    pub fn authorize(
        &self,
        headers: &HeaderMap,
        _uri: &Uri,
    ) -> Result<(), (StatusCode, Json<ApiError>)> {
        let Some(expected) = self.token.as_deref() else {
            return Ok(());
        };

        let header_token = bearer_token(headers);
        if header_token == Some(expected) || has_valid_session_cookie(headers, expected) {
            Ok(())
        } else {
            Err(unauthorized())
        }
    }

    pub fn authenticates_with_bearer(&self, headers: &HeaderMap) -> bool {
        self.token
            .as_deref()
            .is_some_and(|expected| bearer_token(headers) == Some(expected))
    }

    pub fn authenticates_with_cookie(&self, headers: &HeaderMap) -> bool {
        self.token
            .as_deref()
            .is_some_and(|expected| has_valid_session_cookie(headers, expected))
    }
}

impl AuthConfig {
    pub(crate) fn from_parts(
        token: Option<String>,
        allow_insecure_no_auth: Option<String>,
        bind_host: IpAddr,
    ) -> Result<Self, String> {
        let insecure_no_auth_override =
            parse_bool_env(ALLOW_INSECURE_NO_AUTH_ENV, allow_insecure_no_auth)?;
        if !bind_host.is_loopback() && token.is_none() && !insecure_no_auth_override {
            return Err(format!(
                "{API_TOKEN_ENV} is required when BIND_HOST is non-loopback; set {ALLOW_INSECURE_NO_AUTH_ENV}=1 only for explicit insecure development"
            ));
        }

        Ok(Self {
            token,
            insecure_no_auth_override,
        })
    }
}

fn normalized(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let header_value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    header_value.strip_prefix("Bearer ")
}

fn has_valid_session_cookie(headers: &HeaderMap, expected_token: &str) -> bool {
    session_cookie(headers)
        .and_then(|cookie| verify_session_cookie_value(expected_token, cookie).ok())
        .is_some()
}

fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name.trim() == SESSION_COOKIE_NAME {
            return Some(value.trim());
        }
    }
    None
}

fn build_set_cookie_value(cookie_value: &str, secure: bool, max_age: u64) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE_NAME}={cookie_value}; HttpOnly; Path=/; SameSite=Strict; Max-Age={max_age}{secure_attr}"
    )
}

fn build_clear_cookie_value(secure: bool) -> String {
    build_set_cookie_value("", secure, 0)
}

fn mint_session_cookie_value(expected_token: &str, expires_at: u64) -> Result<String, String> {
    let claims = SessionCookieClaims {
        version: 1,
        expires_at,
    };
    let payload = serde_json::to_vec(&claims)
        .map_err(|error| format!("failed to encode session cookie payload: {error}"))?;
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload);
    let signature = sign_session_cookie(expected_token, payload_b64.as_bytes())?;
    Ok(format!("{payload_b64}.{signature}"))
}

fn verify_session_cookie_value(
    expected_token: &str,
    raw_cookie: &str,
) -> Result<SessionCookieClaims, String> {
    let (payload_b64, signature_b64) = raw_cookie
        .split_once('.')
        .ok_or_else(|| "session cookie is malformed".to_string())?;
    let mut mac = session_cookie_mac(expected_token)?;
    mac.update(payload_b64.as_bytes());
    let signature = URL_SAFE_NO_PAD
        .decode(signature_b64)
        .map_err(|error| format!("session cookie signature is invalid: {error}"))?;
    mac.verify_slice(&signature)
        .map_err(|_| "session cookie signature mismatch".to_string())?;

    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|error| format!("session cookie payload is invalid: {error}"))?;
    let claims: SessionCookieClaims = serde_json::from_slice(&payload)
        .map_err(|error| format!("session cookie claims are invalid: {error}"))?;
    if claims.version != 1 {
        return Err("session cookie version is unsupported".to_string());
    }
    if claims.expires_at <= now_seconds() {
        return Err("session cookie has expired".to_string());
    }
    Ok(claims)
}

fn sign_session_cookie(expected_token: &str, payload: &[u8]) -> Result<String, String> {
    let mut mac = session_cookie_mac(expected_token)?;
    mac.update(payload);
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn session_cookie_mac(expected_token: &str) -> Result<SessionCookieMac, String> {
    SessionCookieMac::new_from_slice(expected_token.as_bytes())
        .map_err(|_| "session cookie key is invalid".to_string())
        .map(|mut mac| {
            mac.update(SESSION_COOKIE_CONTEXT);
            mac
        })
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionCookieClaims {
    version: u8,
    expires_at: u64,
}

fn parse_bool_env(name: &str, value: Option<String>) -> Result<bool, String> {
    let Some(value) = normalized(value) else {
        return Ok(false);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!(
            "{name} must be one of: 1, true, yes, on, 0, false, no, off"
        )),
    }
}

fn unauthorized() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(ApiError::new(
            "unauthorized",
            "Missing or invalid API token.",
        )),
    )
}

#[cfg(test)]
mod tests;
