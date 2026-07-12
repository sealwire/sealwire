//! License gate for the public broker.
//!
//! Enforcement mechanism: the broker validates a license code at relay enrollment
//! and checks the relay's license is still active when issuing ws-tokens. Deciding
//! which codes to issue, setting tiers/pricing, and admin operations are left to a
//! private operator plane — this module only provides the safely-callable
//! "validate and redeem" and "check relay access" primitives.
//!
//! Schema (auto-created):
//!   licenses(code, relay_id, tier, grant_days, redeem_by, expires_at, revoked_at, created_at)
//!
//! Issue a code (private operator):
//!   INSERT INTO licenses (code, label, tier, grant_days)
//!     VALUES ('ABCD-EFGH-IJKL', 'alice', 'free', 30);
//!
//! Revoke:
//!   UPDATE licenses SET revoked_at = extract(epoch from now())::bigint WHERE code = '...';

use std::time::{SystemTime, UNIX_EPOCH};

use relay_util::trimmed_option_string;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
#[cfg(test)]
use std::sync::{Arc, Mutex as StdMutex};
use tracing::{info, warn};

/// Postgres URL for the licenses table. Point at the same DB as the control plane.
/// When unset, license gating is disabled.
pub const LICENSES_POSTGRES_URL_ENV: &str = "RELAY_BROKER_PUBLIC_POSTGRES_URL";

/// When set to `1` / `true`, relay enrollment requires a valid license code and
/// ws-tokens are denied for relays whose license has expired or been revoked.
pub const REQUIRE_LICENSE_ENV: &str = "RELAY_BROKER_REQUIRE_LICENSE_CODE";

/// Parse `RELAY_BROKER_REQUIRE_LICENSE_CODE` from the environment. Exported so
/// `app()` can read it once independently of the store connection, which allows
/// fail-closed behaviour when the store is `None` due to a DB failure.
pub fn license_required_from_env() -> bool {
    std::env::var(REQUIRE_LICENSE_ENV)
        .ok()
        .as_deref()
        .map(str::trim)
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Outcome of `validate_code_or_reenroll`.
#[derive(Debug, PartialEq, Eq)]
pub enum LicenseEnrollmentAction {
    /// Code is unredeemed and valid; call `redeem` after enrollment.
    Fresh,
    /// Code is already bound to the relay identified by the supplied `existing_relay_id`.
    /// This happens when a relay loses its registration cache but keeps its identity key:
    /// re-enrollment with the same code should succeed without re-binding. Skip `redeem`.
    Renewal,
}

/// A license row in the in-memory store (test only).
#[cfg(test)]
#[derive(Clone)]
struct InMemoryLicense {
    code: String,
    relay_id: Option<String>,
    grant_days: Option<u64>,
    expires_at: Option<u64>,
    /// Per-license device cap (`None` = unlimited). Mirrors the `device_limit`
    /// column; the broker reads it to enforce the per-license device limit.
    device_limit: Option<u32>,
    revoked: bool,
    /// Set on the first successful `redeem` and never cleared — the single-use
    /// "consumed" marker. Distinct from `relay_id`, which is cleared when the
    /// binding is moved to a new code during re-licensing.
    redeemed_at: Option<u64>,
}

#[derive(Clone)]
enum LicenseBackend {
    Postgres(PgPool),
    #[cfg(test)]
    InMemory(Arc<StdMutex<Vec<InMemoryLicense>>>),
}

#[derive(Clone)]
pub struct LicenseStore {
    backend: LicenseBackend,
    /// When `true`, enrollment requires a valid code and ws-tokens check the
    /// relay's license. When `false`, license codes are optional (no-op if absent).
    pub required: bool,
    /// Test-only: make the next `redeem` call fail so the rollback path can be
    /// tested deterministically without needing real concurrency.
    #[cfg(test)]
    pub fail_next_redeem: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl LicenseStore {
    async fn new(pool: PgPool, required: bool) -> Result<Self, String> {
        initialize_licenses_schema(&pool).await?;
        Ok(Self {
            backend: LicenseBackend::Postgres(pool),
            required,
            #[cfg(test)]
            fail_next_redeem: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// Build an in-memory store for tests. Each entry is `(code, grant_days)`;
    /// `grant_days = None` means the license never expires. `required` mirrors
    /// `RELAY_BROKER_REQUIRE_LICENSE_CODE` — the test should also pass
    /// `license_required` explicitly to the app builder to be consistent.
    #[cfg(test)]
    pub fn for_test(entries: Vec<(&'static str, Option<u64>)>) -> Self {
        Self::for_test_with_required(entries, true)
    }

    #[cfg(test)]
    pub fn for_test_with_required(
        entries: Vec<(&'static str, Option<u64>)>,
        required: bool,
    ) -> Self {
        let licenses: Vec<InMemoryLicense> = entries
            .into_iter()
            .map(|(code, grant_days)| InMemoryLicense {
                code: code.to_string(),
                relay_id: None,
                grant_days,
                expires_at: None,
                device_limit: None,
                revoked: false,
                redeemed_at: None,
            })
            .collect();
        Self {
            backend: LicenseBackend::InMemory(Arc::new(StdMutex::new(licenses))),
            required,
            fail_next_redeem: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Pre-bind a code to a relay_id to simulate a code already redeemed (test only).
    #[cfg(test)]
    pub fn force_bind_for_test(&self, code: &str, relay_id: &str) {
        let LicenseBackend::InMemory(ref store) = self.backend else {
            panic!("force_bind_for_test only works with InMemory backend");
        };
        let mut guard = store
            .lock()
            .expect("in-memory license store should not be poisoned");
        if let Some(lic) = guard.iter_mut().find(|l| l.code == code) {
            lic.relay_id = Some(relay_id.to_string());
        } else {
            panic!("force_bind_for_test: code {code:?} not found in store");
        }
    }

    /// Set a code's `device_limit` (test only).
    #[cfg(test)]
    pub fn force_set_device_limit_for_test(&self, code: &str, device_limit: Option<u32>) {
        let LicenseBackend::InMemory(ref store) = self.backend else {
            panic!("force_set_device_limit_for_test only works with InMemory backend");
        };
        let mut guard = store
            .lock()
            .expect("in-memory license store should not be poisoned");
        if let Some(lic) = guard.iter_mut().find(|l| l.code == code) {
            lic.device_limit = device_limit;
        } else {
            panic!("force_set_device_limit_for_test: code {code:?} not found in store");
        }
    }

    /// Force a code's `expires_at` into the past so `clear_expired_or_revoked_binding`
    /// treats it as expired (test only).
    #[cfg(test)]
    pub fn force_expire_for_test(&self, code: &str) {
        let LicenseBackend::InMemory(ref store) = self.backend else {
            panic!("force_expire_for_test only works with InMemory backend");
        };
        let mut guard = store
            .lock()
            .expect("in-memory license store should not be poisoned");
        if let Some(lic) = guard.iter_mut().find(|l| l.code == code) {
            lic.expires_at = Some(1); // far in the past
        } else {
            panic!("force_expire_for_test: code {code:?} not found in store");
        }
    }

    /// Build from the environment.
    ///
    /// Returns:
    /// - `Ok(None)` — licensing is not configured; all enrollment is open.
    /// - `Ok(Some(store))` — store connected and ready; `store.required` reflects
    ///   whether `RELAY_BROKER_REQUIRE_LICENSE_CODE` is set.
    /// - `Err(msg)` — `RELAY_BROKER_REQUIRE_LICENSE_CODE=1` but the Postgres
    ///   connection or schema init failed. The broker **must not start in this
    ///   state** because enrollment would silently admit anyone. Callers should
    ///   treat this as a fatal misconfiguration.
    pub async fn from_env() -> Result<Option<Self>, String> {
        let required = std::env::var(REQUIRE_LICENSE_ENV)
            .ok()
            .as_deref()
            .map(str::trim)
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let url = match trimmed_option_string(std::env::var(LICENSES_POSTGRES_URL_ENV).ok()) {
            Some(url) => url,
            None if required => {
                return Err(format!(
                    "{REQUIRE_LICENSE_ENV}=1 but {LICENSES_POSTGRES_URL_ENV} is not set; \
                     refusing to start without a license backend"
                ));
            }
            None => return Ok(None),
        };
        match PgPoolOptions::new().max_connections(3).connect(&url).await {
            Ok(pool) => match Self::new(pool, required).await {
                Ok(store) => {
                    info!(required, "broker license store initialized");
                    Ok(Some(store))
                }
                Err(error) if required => Err(format!(
                    "license backend unavailable (schema init failed): {error}"
                )),
                Err(error) => {
                    warn!(%error, "license store schema init failed; license gating disabled");
                    Ok(None)
                }
            },
            Err(error) if required => Err(format!(
                "license backend unavailable (connection failed): {error}"
            )),
            Err(error) => {
                warn!(%error, "license store connection failed; license gating disabled");
                Ok(None)
            }
        }
    }

    /// Check that `code` exists, is unredeemed, not expired (redeem_by), and not
    /// revoked. Does NOT consume the code — call [`redeem`] after a successful
    /// enrollment to bind the relay_id.
    pub async fn validate_code(&self, code: &str) -> Result<(), String> {
        match &self.backend {
            LicenseBackend::Postgres(pool) => validate_code_pg(pool, code).await,
            #[cfg(test)]
            LicenseBackend::InMemory(store) => {
                let guard = store.lock().expect("in-memory license store poisoned");
                match guard.iter().find(|l| l.code == code) {
                    None => Err("license code is invalid".to_string()),
                    Some(l) if l.revoked => Err("license code has been revoked".to_string()),
                    Some(l) if l.redeemed_at.is_some() => {
                        Err("license code has already been used".to_string())
                    }
                    Some(_) => Ok(()),
                }
            }
        }
    }

    /// Like `validate_code` but also recognises the re-enrollment case: if the
    /// code is already bound to `existing_relay_id`, that means the same relay is
    /// re-enrolling after losing its registration cache. Return [`LicenseEnrollmentAction::Renewal`]
    /// so the caller can skip `redeem` (nothing to bind — the license is already
    /// associated with this relay).
    ///
    /// Returns `Err` if the code doesn't exist, is revoked, has already been bound
    /// to a *different* relay, or has expired at the redemption stage.
    pub async fn validate_code_or_reenroll(
        &self,
        code: &str,
        existing_relay_id: Option<&str>,
    ) -> Result<LicenseEnrollmentAction, String> {
        match &self.backend {
            LicenseBackend::Postgres(pool) => {
                validate_code_or_reenroll_pg(pool, code, existing_relay_id).await
            }
            #[cfg(test)]
            LicenseBackend::InMemory(store) => {
                let guard = store.lock().expect("in-memory license store poisoned");
                match guard.iter().find(|l| l.code == code) {
                    None => Err("license code is invalid".to_string()),
                    Some(l) if l.revoked => Err("license code has been revoked".to_string()),
                    // Actively bound to THIS relay → re-enrollment after cache loss.
                    Some(l)
                        if l.relay_id.is_some() && l.relay_id.as_deref() == existing_relay_id =>
                    {
                        Ok(LicenseEnrollmentAction::Renewal)
                    }
                    // Consumed once (redeemed_at set) → single-use, cannot be redeemed
                    // again even if its binding was cleared during re-licensing.
                    Some(l) if l.redeemed_at.is_some() => {
                        Err("license code has already been used".to_string())
                    }
                    Some(_) => Ok(LicenseEnrollmentAction::Fresh),
                }
            }
        }
    }

    /// Clear any expired or revoked license binding for `relay_id` (not the new
    /// code being redeemed). This unblocks the UNIQUE constraint on `relay_id` so
    /// a new code can be bound to the same relay after the old one expired/was
    /// revoked. Call this just before `redeem` when `existing_relay_id` is `Some`.
    pub async fn clear_expired_or_revoked_binding(
        &self,
        relay_id: &str,
        except_code: &str,
    ) -> Result<(), String> {
        match &self.backend {
            LicenseBackend::Postgres(pool) => {
                clear_expired_or_revoked_binding_pg(pool, relay_id, except_code).await
            }
            #[cfg(test)]
            LicenseBackend::InMemory(store) => {
                let mut guard = store.lock().expect("in-memory license store poisoned");
                let now = unix_now();
                for lic in guard.iter_mut() {
                    if lic.relay_id.as_deref() == Some(relay_id)
                        && lic.code != except_code
                        && (lic.revoked || lic.expires_at.is_some_and(|exp| exp < now))
                    {
                        lic.relay_id = None;
                    }
                }
                Ok(())
            }
        }
    }

    /// Atomically bind `relay_id` to `code` and set `expires_at` from `grant_days`.
    /// Fails (without side effects) if the code was used by a concurrent request.
    pub async fn redeem(&self, code: &str, relay_id: &str) -> Result<(), String> {
        #[cfg(test)]
        if self
            .fail_next_redeem
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            return Err("injected redeem failure (test)".to_string());
        }
        match &self.backend {
            LicenseBackend::Postgres(pool) => redeem_pg(pool, code, relay_id).await,
            #[cfg(test)]
            LicenseBackend::InMemory(store) => {
                let mut guard = store.lock().expect("in-memory license store poisoned");
                // Only redeem a code that has never been consumed (redeemed_at is
                // None), never revoked, and currently unbound.
                match guard.iter_mut().find(|l| {
                    l.code == code && l.relay_id.is_none() && !l.revoked && l.redeemed_at.is_none()
                }) {
                    None => Err("license code is invalid or has already been used".to_string()),
                    Some(lic) => {
                        let now = unix_now();
                        lic.relay_id = Some(relay_id.to_string());
                        lic.redeemed_at = Some(now);
                        lic.expires_at =
                            lic.grant_days.map(|days| now.saturating_add(days * 86400));
                        Ok(())
                    }
                }
            }
        }
    }

    /// Resolve the per-license device cap for the relay bound to `relay_id`.
    ///
    /// Returns `Ok(Some(n))` when the relay's license sets a `device_limit`,
    /// `Ok(None)` when it is unlimited (column NULL) or no license row is bound.
    /// Callers pass this into `issue_device_grant`; `None` means "do not cap".
    /// This is intentionally independent of expiry/revocation (the grant path
    /// does not gate on license validity today — see device-limit-plan.md Q7).
    pub async fn device_limit_for_relay(&self, relay_id: &str) -> Result<Option<u32>, String> {
        match &self.backend {
            LicenseBackend::Postgres(pool) => device_limit_for_relay_pg(pool, relay_id).await,
            #[cfg(test)]
            LicenseBackend::InMemory(store) => {
                let guard = store.lock().expect("in-memory license store poisoned");
                Ok(guard
                    .iter()
                    .find(|l| l.relay_id.as_deref() == Some(relay_id))
                    .and_then(|l| l.device_limit)
                    // Match the Postgres arm: a non-positive limit is treated as
                    // unlimited (defensive against misconfiguration), never "0 devices".
                    .filter(|limit| *limit > 0))
            }
        }
    }

    /// Check that the relay's license is still active (not expired, not revoked).
    /// Returns `Ok(())` if a valid license exists, `Err` otherwise.
    pub async fn check_relay_access(&self, relay_id: &str) -> Result<(), String> {
        match &self.backend {
            LicenseBackend::Postgres(pool) => check_relay_access_pg(pool, relay_id).await,
            #[cfg(test)]
            LicenseBackend::InMemory(store) => {
                let now = unix_now();
                let guard = store.lock().expect("in-memory license store poisoned");
                match guard
                    .iter()
                    .find(|l| l.relay_id.as_deref() == Some(relay_id))
                {
                    None => Err("no license found for this relay".to_string()),
                    Some(l) if l.revoked => Err("license has been revoked".to_string()),
                    Some(l) if l.expires_at.is_some_and(|exp| exp < now) => {
                        Err("license has expired".to_string())
                    }
                    Some(_) => Ok(()),
                }
            }
        }
    }
}

async fn validate_code_or_reenroll_pg(
    pool: &PgPool,
    code: &str,
    existing_relay_id: Option<&str>,
) -> Result<LicenseEnrollmentAction, String> {
    let now = unix_now() as i64;
    let row: Option<(Option<String>, Option<i64>, Option<i64>, Option<i64>)> = sqlx::query_as(
        r#"SELECT relay_id, redeem_by, revoked_at, redeemed_at FROM licenses WHERE code = $1"#,
    )
    .bind(code)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("failed to query licenses: {error}"))?;
    match row {
        None => Err("license code is invalid".to_string()),
        Some((_, _, Some(_), _)) => Err("license code has been revoked".to_string()),
        // Actively bound to THIS relay → re-enrollment after cache loss.
        Some((Some(ref bound_relay_id), _, _, _))
            if existing_relay_id.is_some_and(|eid| eid == bound_relay_id) =>
        {
            Ok(LicenseEnrollmentAction::Renewal)
        }
        // Consumed once (redeemed_at set) → single-use, even if the binding was
        // cleared during re-licensing (relay_id back to NULL).
        Some((_, _, _, Some(_))) => Err("license code has already been used".to_string()),
        Some((None, Some(redeem_by), _, None)) if redeem_by < now => {
            Err("license code has expired".to_string())
        }
        Some((None, _, _, None)) => Ok(LicenseEnrollmentAction::Fresh),
        // Bound to a different relay but somehow not marked consumed — defensive.
        Some((Some(_), _, _, _)) => Err("license code has already been used".to_string()),
    }
}

async fn clear_expired_or_revoked_binding_pg(
    pool: &PgPool,
    relay_id: &str,
    except_code: &str,
) -> Result<(), String> {
    sqlx::query(
        r#"
        UPDATE licenses
           SET relay_id = NULL
         WHERE relay_id   = $1
           AND code      != $2
           AND (revoked_at IS NOT NULL
                OR (expires_at IS NOT NULL AND expires_at < $3))
        "#,
    )
    .bind(relay_id)
    .bind(except_code)
    .bind(unix_now() as i64)
    .execute(pool)
    .await
    .map_err(|error| format!("failed to clear expired/revoked binding: {error}"))?;
    Ok(())
}

async fn validate_code_pg(pool: &PgPool, code: &str) -> Result<(), String> {
    let now = unix_now() as i64;
    let row: Option<(Option<i64>, Option<i64>, Option<i64>)> = sqlx::query_as(
        r#"SELECT redeem_by, revoked_at, redeemed_at FROM licenses WHERE code = $1"#,
    )
    .bind(code)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("failed to query licenses: {error}"))?;
    match row {
        None => Err("license code is invalid".to_string()),
        Some((_, Some(_), _)) => Err("license code has been revoked".to_string()),
        Some((_, _, Some(_))) => Err("license code has already been used".to_string()),
        Some((Some(redeem_by), _, None)) if redeem_by < now => {
            Err("license code has expired".to_string())
        }
        Some((_, _, None)) => Ok(()),
    }
}

async fn redeem_pg(pool: &PgPool, code: &str, relay_id: &str) -> Result<(), String> {
    let now = unix_now() as i64;
    let rows_updated: u64 = sqlx::query(
        r#"
        UPDATE licenses
           SET relay_id    = $1,
               redeemed_at = $2,
               expires_at  = CASE
                               WHEN grant_days IS NOT NULL
                               THEN $2 + (grant_days::bigint * 86400)
                               ELSE NULL
                             END
         WHERE code        = $3
           AND relay_id    IS NULL
           AND revoked_at  IS NULL
           AND redeemed_at IS NULL
           AND (redeem_by IS NULL OR redeem_by >= $2)
        "#,
    )
    .bind(relay_id)
    .bind(now)
    .bind(code)
    .execute(pool)
    .await
    .map_err(|error| format!("failed to redeem license code: {error}"))?
    .rows_affected();
    if rows_updated == 0 {
        Err("license code is invalid or has already been used".to_string())
    } else {
        Ok(())
    }
}

async fn device_limit_for_relay_pg(pool: &PgPool, relay_id: &str) -> Result<Option<u32>, String> {
    // `device_limit` is a Postgres `INTEGER` (int4) → decode as `i32`, NOT `i64`,
    // or SQLx raises a runtime type-mismatch the moment a non-NULL cap is read.
    let row: Option<(Option<i32>,)> =
        sqlx::query_as(r#"SELECT device_limit FROM licenses WHERE relay_id = $1"#)
            .bind(relay_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| format!("failed to query device_limit: {error}"))?;
    // NULL column or missing row → unlimited. A stored non-positive value is
    // treated as unlimited rather than "zero devices" (defensive against bad data).
    Ok(row
        .and_then(|(limit,)| limit)
        .and_then(|limit| u32::try_from(limit).ok())
        .filter(|limit| *limit > 0))
}

async fn check_relay_access_pg(pool: &PgPool, relay_id: &str) -> Result<(), String> {
    let now = unix_now() as i64;
    let row: Option<(Option<i64>, Option<i64>)> =
        sqlx::query_as(r#"SELECT expires_at, revoked_at FROM licenses WHERE relay_id = $1"#)
            .bind(relay_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| format!("failed to query licenses: {error}"))?;
    match row {
        None => Err("no license found for this relay".to_string()),
        Some((_, Some(_))) => Err("license has been revoked".to_string()),
        Some((Some(expires_at), _)) if expires_at < now => Err("license has expired".to_string()),
        Some(_) => Ok(()),
    }
}

async fn initialize_licenses_schema(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS licenses (
            code        TEXT PRIMARY KEY,
            label       TEXT,
            relay_id    TEXT UNIQUE,
            tier        TEXT NOT NULL DEFAULT 'free',
            grant_days  INTEGER,
            redeem_by   BIGINT,
            expires_at  BIGINT,
            revoked_at  BIGINT,
            redeemed_at BIGINT,
            device_limit INTEGER,
            created_at  BIGINT NOT NULL
                            DEFAULT (extract(epoch from now())::bigint)
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("failed to create licenses table: {error}"))?;
    // Add redeemed_at to pre-existing tables that were created before this column
    // (idempotent). It is the durable single-use marker.
    sqlx::query("ALTER TABLE licenses ADD COLUMN IF NOT EXISTS redeemed_at BIGINT")
        .execute(pool)
        .await
        .map_err(|error| format!("failed to add licenses.redeemed_at column: {error}"))?;
    // Backfill: any row already bound to a relay (relay_id IS NOT NULL) was consumed
    // before this column existed, so mark it consumed. Without this, clearing such a
    // row's binding during re-licensing would make a pre-migration code redeemable
    // again. Idempotent (only touches rows still missing the marker).
    sqlx::query(
        "UPDATE licenses
            SET redeemed_at = COALESCE(created_at, extract(epoch from now())::bigint)
          WHERE relay_id IS NOT NULL AND redeemed_at IS NULL",
    )
    .execute(pool)
    .await
    .map_err(|error| format!("failed to backfill licenses.redeemed_at: {error}"))?;
    sqlx::query("CREATE INDEX IF NOT EXISTS licenses_relay_id_idx ON licenses (relay_id)")
        .execute(pool)
        .await
        .map_err(|error| format!("failed to create licenses relay_id index: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;

    async fn test_store(pool: PgPool) -> LicenseStore {
        LicenseStore::new(pool, true).await.expect("store init")
    }

    /// Env-gated live-Postgres test. Run with:
    ///   RELAY_BROKER_TEST_POSTGRES_URL=postgres://sealwire:dev@127.0.0.1:5433/sealwire \
    ///     cargo test -p relay-broker license -- --nocapture
    async fn pg_pool() -> Option<PgPool> {
        let url = trimmed_option_string(std::env::var("RELAY_BROKER_TEST_POSTGRES_URL").ok())?;
        Some(
            PgPoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .expect("connect"),
        )
    }

    async fn insert_code(pool: &PgPool, code: &str, grant_days: Option<i32>) {
        sqlx::query(
            "INSERT INTO licenses (code, tier, grant_days)
             VALUES ($1, 'free', $2)
             ON CONFLICT (code) DO UPDATE SET
                relay_id = NULL, revoked_at = NULL, expires_at = NULL, redeemed_at = NULL",
        )
        .bind(code)
        .bind(grant_days)
        .execute(pool)
        .await
        .expect("insert");
    }

    async fn cleanup(pool: &PgPool, code: &str) {
        sqlx::query("DELETE FROM licenses WHERE code = $1")
            .bind(code)
            .execute(pool)
            .await
            .expect("cleanup");
    }

    #[tokio::test]
    async fn valid_code_can_be_redeemed_and_grants_access() {
        let Some(pool) = pg_pool().await else {
            eprintln!("skipping: set RELAY_BROKER_TEST_POSTGRES_URL");
            return;
        };
        let store = test_store(pool.clone()).await;
        let code = "TEST-VALID-001";
        let relay = "relay-test-valid-001";
        cleanup(&pool, code).await; // pre-clean in case a prior run left rows
        insert_code(&pool, code, Some(30)).await;

        store
            .validate_code(code)
            .await
            .expect("code should be valid");
        store
            .redeem(code, relay)
            .await
            .expect("redeem should succeed");
        let access = store.check_relay_access(relay).await;
        let double = store.redeem(code, "relay-other").await;
        cleanup(&pool, code).await; // cleanup before assert so it always runs
        access.expect("relay should have access");
        double.expect_err("double-redeem must fail");
    }

    #[tokio::test]
    async fn consumed_code_stays_consumed_after_binding_cleared() {
        // Regression: clearing an expired binding (during re-licensing) must NOT
        // make a single-use code redeemable again.
        let Some(pool) = pg_pool().await else {
            return;
        };
        let store = test_store(pool.clone()).await;
        let code = "TEST-CONSUMED-001";
        let relay = "relay-test-consumed-001";
        cleanup(&pool, code).await;
        insert_code(&pool, code, Some(30)).await;

        // Consume the code (sets redeemed_at + binds relay).
        store.redeem(code, relay).await.expect("redeem");

        // Force it expired, then clear its binding as re-licensing would.
        sqlx::query(
            "UPDATE licenses SET expires_at = extract(epoch from now())::bigint - 7200 WHERE code = $1",
        )
        .bind(code)
        .execute(&pool)
        .await
        .expect("expire");
        store
            .clear_expired_or_revoked_binding(relay, "SOME-OTHER-CODE")
            .await
            .expect("clear binding");

        // relay_id is now NULL, but the code must still be treated as consumed.
        let validate = store.validate_code_or_reenroll(code, None).await;
        let redeem_again = store.redeem(code, "relay-other").await;
        cleanup(&pool, code).await;

        assert!(
            validate.is_err(),
            "consumed code must not validate as fresh after binding cleared; got {validate:?}"
        );
        assert!(
            redeem_again.is_err(),
            "consumed code must not be redeemable again after binding cleared"
        );
    }

    #[tokio::test]
    async fn pre_migration_consumed_code_is_backfilled_and_stays_consumed() {
        // Regression: a row consumed BEFORE the redeemed_at column existed has
        // relay_id set but redeemed_at NULL. The schema-init backfill must mark it
        // consumed, so clearing its binding during re-licensing cannot resurrect it.
        let Some(pool) = pg_pool().await else {
            return;
        };
        let code = "TEST-PREMIGRATION-001";
        let relay = "relay-test-premigration-001";
        cleanup(&pool, code).await;

        // Simulate a pre-migration consumed row: bound + expired, but redeemed_at NULL.
        sqlx::query(
            "INSERT INTO licenses (code, tier, relay_id, expires_at, redeemed_at)
             VALUES ($1, 'free', $2, extract(epoch from now())::bigint - 7200, NULL)",
        )
        .bind(code)
        .bind(relay)
        .execute(&pool)
        .await
        .expect("insert pre-migration row");

        // Running schema init (as broker startup does) must backfill redeemed_at.
        let store = test_store(pool.clone()).await;

        // Clear the binding as re-licensing would (row is expired).
        store
            .clear_expired_or_revoked_binding(relay, "SOME-OTHER-CODE")
            .await
            .expect("clear binding");

        let validate = store.validate_code_or_reenroll(code, None).await;
        let redeem_again = store.redeem(code, "relay-other").await;
        cleanup(&pool, code).await;

        assert!(
            validate.is_err(),
            "backfilled pre-migration code must not validate as fresh; got {validate:?}"
        );
        assert!(
            redeem_again.is_err(),
            "backfilled pre-migration code must not be redeemable again"
        );
    }

    #[tokio::test]
    async fn unknown_code_is_rejected() {
        let Some(pool) = pg_pool().await else {
            return;
        };
        let store = test_store(pool).await;
        store
            .validate_code("DOES-NOT-EXIST")
            .await
            .expect_err("unknown code must fail");
    }

    #[tokio::test]
    async fn revoked_license_denies_relay_access() {
        let Some(pool) = pg_pool().await else {
            return;
        };
        let store = test_store(pool.clone()).await;
        let code = "TEST-REVOKED-001";
        let relay = "relay-test-revoked-001";
        cleanup(&pool, code).await; // pre-clean in case a prior run left rows
        insert_code(&pool, code, None).await;
        store.redeem(code, relay).await.expect("redeem");

        sqlx::query(
            "UPDATE licenses SET revoked_at = extract(epoch from now())::bigint WHERE code = $1",
        )
        .bind(code)
        .execute(&pool)
        .await
        .expect("revoke");

        let result = store.check_relay_access(relay).await;
        cleanup(&pool, code).await; // cleanup before assert so it always runs
        result.expect_err("revoked relay must be denied");
    }

    #[tokio::test]
    async fn expired_license_denies_relay_access() {
        let Some(pool) = pg_pool().await else {
            return;
        };
        let store = test_store(pool.clone()).await;
        let code = "TEST-EXPIRED-001";
        let relay = "relay-test-expired-001";
        cleanup(&pool, code).await; // pre-clean in case a prior run left rows
        insert_code(&pool, code, None).await;
        store.redeem(code, relay).await.expect("redeem");

        // Set expires_at 2 hours in the past for a clear margin.
        let affected = sqlx::query(
            "UPDATE licenses SET expires_at = extract(epoch from now())::bigint - 7200 WHERE code = $1",
        )
        .bind(code)
        .execute(&pool)
        .await
        .expect("expire")
        .rows_affected();
        assert_eq!(affected, 1, "expire UPDATE must touch exactly 1 row");

        let result = store.check_relay_access(relay).await;
        cleanup(&pool, code).await; // cleanup before assert so it always runs
        result.expect_err("expired relay must be denied");
    }

    #[tokio::test]
    async fn no_license_denies_relay_access() {
        let Some(pool) = pg_pool().await else {
            return;
        };
        let store = test_store(pool).await;
        store
            .check_relay_access("relay-no-license")
            .await
            .expect_err("must deny");
    }

    // In-memory (no Postgres needed): the device cap is read from the license
    // bound to the relay; NULL / no-license → unlimited (None).
    #[tokio::test]
    async fn device_limit_for_relay_reads_bound_license() {
        let store = LicenseStore::for_test(vec![("LIM-001", None)]);
        store.redeem("LIM-001", "relay-lim").await.expect("redeem");

        // Default: no device_limit set → unlimited.
        assert_eq!(
            store.device_limit_for_relay("relay-lim").await.unwrap(),
            None,
            "a license with no device_limit is unlimited"
        );

        // Operator sets a cap → it is returned for the bound relay.
        store.force_set_device_limit_for_test("LIM-001", Some(3));
        assert_eq!(
            store.device_limit_for_relay("relay-lim").await.unwrap(),
            Some(3)
        );

        // A non-positive limit is treated as unlimited, not "zero devices".
        store.force_set_device_limit_for_test("LIM-001", Some(0));
        assert_eq!(
            store.device_limit_for_relay("relay-lim").await.unwrap(),
            None,
            "device_limit 0 must be unlimited, consistent with the Postgres arm"
        );

        // A relay with no license row → unlimited (None), never an error.
        assert_eq!(
            store.device_limit_for_relay("relay-unknown").await.unwrap(),
            None
        );
    }
}
