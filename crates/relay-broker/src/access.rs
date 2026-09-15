//! Broker access strategy seam.
//!
//! The public broker does not encode product tiers or pricing policy. Call sites
//! that gate enrollment, relay leases, and device grants consult an injected
//! [`BrokerAccessStrategy`]. The standard public default is open/self-host;
//! required/private deployments inject their own implementation (or
//! [`UnavailableAccessStrategy`] when a backing service is required but missing).

use std::net::IpAddr;
use std::sync::Arc;

use async_trait::async_trait;
use axum::http::StatusCode;
use tracing::warn;

/// Which control-plane operation is asking the access strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessOperation {
    EnrollmentComplete,
    RelayLease,
    DeviceGrant,
    /// Authenticated relay asked to tear down its access binding.
    AccessRelease,
    /// Websocket join after a verified relay ticket (before seating).
    RelaySocketJoin,
    /// Websocket join after a verified device/surface ticket tied to a relay room.
    DeviceSocketJoin,
}

/// Product-neutral request context for access decisions (abuse controls, audit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessRequestContext {
    /// Client address as seen by the handler (`ConnectInfo` peer today).
    pub remote_ip: IpAddr,
    pub operation: AccessOperation,
}

impl AccessRequestContext {
    pub fn new(remote_ip: IpAddr, operation: AccessOperation) -> Self {
        Self {
            remote_ip,
            operation,
        }
    }
}

/// Stable, client-visible denial class. Closed set — private policy picks one of
/// these rather than inventing ad-hoc HTTP statuses in handlers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessDenialCode {
    /// Malformed / incomplete client request for this operation.
    BadRequest,
    /// Resource conflict (e.g. enrollment token already bound elsewhere).
    Conflict,
    /// Authenticated caller is not permitted (expired, revoked, forbidden).
    Forbidden,
    /// Too many attempts; may carry [`AccessDenial::retry_after_secs`].
    RateLimited,
    /// Backing access service unavailable or misconfigured (fail closed).
    Unavailable,
    /// Unexpected internal failure. Public response stays generic.
    Internal,
    /// Credential / token material rejected (transition parity with scrubbed 401s).
    Unauthorized,
    /// Named resource does not exist (admin/operator lookups).
    NotFound,
}

/// Typed access denial: safe public fields + optional internal cause for logs.
#[derive(Debug, Clone)]
pub struct AccessDenial {
    code: AccessDenialCode,
    /// Safe, stable public message (never SQL / backend detail).
    public_message: String,
    /// Optional Retry-After hint (seconds) for [`AccessDenialCode::RateLimited`].
    retry_after_secs: Option<u64>,
    /// Log-only cause; never serialized to HTTP clients.
    internal_cause: Option<String>,
}

impl AccessDenial {
    pub fn bad_request(public_message: impl Into<String>) -> Self {
        Self::new(AccessDenialCode::BadRequest, public_message)
    }

    pub fn conflict(public_message: impl Into<String>) -> Self {
        Self::new(AccessDenialCode::Conflict, public_message)
    }

    pub fn forbidden(public_message: impl Into<String>) -> Self {
        Self::new(AccessDenialCode::Forbidden, public_message)
    }

    pub fn rate_limited(public_message: impl Into<String>, retry_after_secs: Option<u64>) -> Self {
        let mut denial = Self::new(AccessDenialCode::RateLimited, public_message);
        denial.retry_after_secs = retry_after_secs;
        denial
    }

    pub fn unavailable() -> Self {
        Self::new(
            AccessDenialCode::Unavailable,
            "access service unavailable; try again later",
        )
    }

    pub fn internal() -> Self {
        Self::new(AccessDenialCode::Internal, "access check failed")
    }

    /// Scrubbed unauthorized response (matches historical public_api_error 401 body).
    pub fn unauthorized() -> Self {
        Self::new(AccessDenialCode::Unauthorized, "request failed")
    }

    /// Named resource missing (stable 404 for operator/admin surfaces).
    pub fn not_found(public_message: impl Into<String>) -> Self {
        Self::new(AccessDenialCode::NotFound, public_message)
    }

    fn new(code: AccessDenialCode, public_message: impl Into<String>) -> Self {
        Self {
            code,
            public_message: public_message.into(),
            retry_after_secs: None,
            internal_cause: None,
        }
    }

    pub fn with_internal(mut self, cause: impl Into<String>) -> Self {
        self.internal_cause = Some(cause.into());
        self
    }

    pub fn code(&self) -> AccessDenialCode {
        self.code
    }

    pub fn public_message(&self) -> &str {
        &self.public_message
    }

    pub fn retry_after_secs(&self) -> Option<u64> {
        self.retry_after_secs
    }

    pub fn internal_cause(&self) -> Option<&str> {
        self.internal_cause.as_deref()
    }

    /// Machine-readable `error` field for the public JSON body.
    pub fn public_error_code(&self) -> &'static str {
        match self.code {
            AccessDenialCode::BadRequest => "bad_request",
            AccessDenialCode::Conflict => "conflict",
            AccessDenialCode::Forbidden => "forbidden",
            AccessDenialCode::RateLimited => "rate_limited",
            AccessDenialCode::Unavailable => "unavailable",
            AccessDenialCode::Internal => "internal",
            AccessDenialCode::Unauthorized => "unauthorized",
            AccessDenialCode::NotFound => "not_found",
        }
    }

    /// Closed HTTP status mapping for access denials.
    pub fn http_status(&self) -> StatusCode {
        match self.code {
            AccessDenialCode::BadRequest => StatusCode::BAD_REQUEST,
            AccessDenialCode::Conflict => StatusCode::CONFLICT,
            AccessDenialCode::Forbidden => StatusCode::FORBIDDEN,
            AccessDenialCode::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            AccessDenialCode::Unavailable | AccessDenialCode::Internal => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            AccessDenialCode::Unauthorized => StatusCode::UNAUTHORIZED,
            AccessDenialCode::NotFound => StatusCode::NOT_FOUND,
        }
    }

    /// Log the internal cause (if any) without exposing it to the caller.
    pub fn log_internal(&self) {
        if let Some(cause) = &self.internal_cause {
            warn!(
                code = self.public_error_code(),
                %cause,
                "broker access denial (internal cause)"
            );
        }
    }
}

/// Outcome of pre-enrollment authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnrollmentBindDecision {
    /// No post-enrollment bind step is required.
    Skip,
    /// Call [`BrokerAccessStrategy::bind_enrollment`] after enrollment succeeds.
    Bind,
    /// Enrollment token is already bound to this relay; skip bind.
    AlreadyBound,
}

/// Outcome of device-grant authorization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceAccessDecision {
    /// Cap on active devices for this relay. `None` means uncapped.
    pub device_limit: Option<u32>,
}

/// Object-safe async access policy for the public broker control plane.
///
/// Names stay product-neutral: no Plus/Pro/pricing. Implementors decide how
/// enrollment tokens, relay leases, and device caps are evaluated.
#[async_trait]
pub trait BrokerAccessStrategy: Send + Sync {
    /// Authorize (and classify) an enrollment attempt before the control plane
    /// persists a registration. `enrollment_token` is optional; open strategies
    /// ignore it. `existing_relay_id` is set when re-enrolling an identity that
    /// already has a registration.
    async fn authorize_enrollment(
        &self,
        ctx: &AccessRequestContext,
        enrollment_token: Option<&str>,
        existing_relay_id: Option<&str>,
    ) -> Result<EnrollmentBindDecision, AccessDenial>;

    /// Bind an enrollment token to `relay_id` after a successful enrollment.
    /// Only called when [`authorize_enrollment`] returned [`EnrollmentBindDecision::Bind`].
    async fn bind_enrollment(
        &self,
        ctx: &AccessRequestContext,
        enrollment_token: &str,
        relay_id: &str,
        existing_relay_id: Option<&str>,
    ) -> Result<(), AccessDenial>;

    /// Authorize a relay lease (e.g. issuing a relay ws-token).
    async fn authorize_relay(
        &self,
        ctx: &AccessRequestContext,
        relay_id: &str,
    ) -> Result<(), AccessDenial>;

    /// Authorize a device grant and resolve any device cap for the relay.
    async fn authorize_device(
        &self,
        ctx: &AccessRequestContext,
        relay_id: &str,
    ) -> Result<DeviceAccessDecision, AccessDenial>;

    /// Tear down access for an authenticated relay (release its access binding).
    /// Public call sites invoke this only after relay bearer auth. Default is a
    /// no-op so open/self-host injectors stay functional.
    async fn release_access(
        &self,
        _ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<(), AccessDenial> {
        Ok(())
    }
}

/// Self-host / open default: every gate allows, no bind step, uncapped devices.
#[derive(Debug, Default, Clone, Copy)]
pub struct OpenAccessStrategy;

#[async_trait]
impl BrokerAccessStrategy for OpenAccessStrategy {
    async fn authorize_enrollment(
        &self,
        _ctx: &AccessRequestContext,
        _enrollment_token: Option<&str>,
        _existing_relay_id: Option<&str>,
    ) -> Result<EnrollmentBindDecision, AccessDenial> {
        Ok(EnrollmentBindDecision::Skip)
    }

    async fn bind_enrollment(
        &self,
        _ctx: &AccessRequestContext,
        _enrollment_token: &str,
        _relay_id: &str,
        _existing_relay_id: Option<&str>,
    ) -> Result<(), AccessDenial> {
        Ok(())
    }

    async fn authorize_relay(
        &self,
        _ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<(), AccessDenial> {
        Ok(())
    }

    async fn authorize_device(
        &self,
        _ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<DeviceAccessDecision, AccessDenial> {
        Ok(DeviceAccessDecision { device_limit: None })
    }
}

/// Fail-closed strategy used when access enforcement is required but the
/// backing service is unavailable (misconfigured / DB down at startup).
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableAccessStrategy;

impl UnavailableAccessStrategy {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl BrokerAccessStrategy for UnavailableAccessStrategy {
    async fn authorize_enrollment(
        &self,
        _ctx: &AccessRequestContext,
        _enrollment_token: Option<&str>,
        _existing_relay_id: Option<&str>,
    ) -> Result<EnrollmentBindDecision, AccessDenial> {
        Err(AccessDenial::unavailable())
    }

    async fn bind_enrollment(
        &self,
        _ctx: &AccessRequestContext,
        _enrollment_token: &str,
        _relay_id: &str,
        _existing_relay_id: Option<&str>,
    ) -> Result<(), AccessDenial> {
        Err(AccessDenial::unavailable())
    }

    async fn authorize_relay(
        &self,
        _ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<(), AccessDenial> {
        Err(AccessDenial::unavailable())
    }

    async fn authorize_device(
        &self,
        _ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<DeviceAccessDecision, AccessDenial> {
        Err(AccessDenial::unavailable())
    }

    async fn release_access(
        &self,
        _ctx: &AccessRequestContext,
        _relay_id: &str,
    ) -> Result<(), AccessDenial> {
        Err(AccessDenial::unavailable())
    }
}

/// Standard public `app()` entry: always open. Removed legacy commercial env vars
/// are ignored and must never select a commercial backend from public code.
pub fn standard_public_access_strategy() -> Arc<dyn BrokerAccessStrategy> {
    Arc::new(OpenAccessStrategy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ctx(op: AccessOperation) -> AccessRequestContext {
        AccessRequestContext::new(IpAddr::V4(Ipv4Addr::LOCALHOST), op)
    }

    #[tokio::test]
    async fn open_strategy_allows_everything() {
        let strategy = OpenAccessStrategy;
        assert_eq!(
            strategy
                .authorize_enrollment(&ctx(AccessOperation::EnrollmentComplete), None, None)
                .await
                .unwrap(),
            EnrollmentBindDecision::Skip
        );
        strategy
            .authorize_relay(&ctx(AccessOperation::RelayLease), "relay-1")
            .await
            .unwrap();
        assert_eq!(
            strategy
                .authorize_device(&ctx(AccessOperation::DeviceGrant), "relay-1")
                .await
                .unwrap(),
            DeviceAccessDecision { device_limit: None }
        );
    }

    #[tokio::test]
    async fn unavailable_strategy_is_fail_closed() {
        let strategy = UnavailableAccessStrategy::new();
        let err = strategy
            .authorize_enrollment(
                &ctx(AccessOperation::EnrollmentComplete),
                Some("CODE"),
                None,
            )
            .await
            .expect_err("must deny");
        assert_eq!(err.code(), AccessDenialCode::Unavailable);
        assert_eq!(err.http_status(), StatusCode::SERVICE_UNAVAILABLE);
        strategy
            .authorize_relay(&ctx(AccessOperation::RelayLease), "relay-1")
            .await
            .expect_err("must deny");
        strategy
            .authorize_device(&ctx(AccessOperation::DeviceGrant), "relay-1")
            .await
            .expect_err("must deny");
    }

    #[tokio::test]
    async fn standard_public_access_is_open_even_with_removed_legacy_env() {
        use std::sync::{Mutex, OnceLock};
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let keys = [
            "RELAY_BROKER_REQUIRE_LICENSE_CODE",
            "RELAY_BROKER_TIER_DEVICE_LIMITS",
            "RELAY_LICENSE_CODE",
        ];
        let prev: Vec<_> = keys.iter().map(|k| (*k, std::env::var(k).ok())).collect();
        std::env::set_var("RELAY_BROKER_REQUIRE_LICENSE_CODE", "1");
        std::env::set_var("RELAY_LICENSE_CODE", "ignored");

        let strategy = standard_public_access_strategy();
        let decision = strategy
            .authorize_enrollment(&ctx(AccessOperation::EnrollmentComplete), None, None)
            .await
            .expect("standard public selection must ignore removed commercial env");
        assert_eq!(decision, EnrollmentBindDecision::Skip);

        for (key, value) in prev {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }

    #[test]
    fn denial_http_status_table_is_closed() {
        assert_eq!(
            AccessDenial::conflict("x").http_status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            AccessDenial::forbidden("x").http_status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            AccessDenial::rate_limited("x", Some(30)).http_status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            AccessDenial::unavailable().http_status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            AccessDenial::unauthorized().http_status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            AccessDenial::not_found("missing").http_status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            AccessDenial::not_found("missing").public_error_code(),
            "not_found"
        );
    }
}
