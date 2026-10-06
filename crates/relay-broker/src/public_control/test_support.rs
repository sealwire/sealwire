use super::*;

pub(super) const SIMULATED_DATABASE_ERROR: &str =
    "error returned from database: invalid input syntax";

impl PublicControlPlane {
    pub fn set_relay_ws_ticket_challenge_ttl_for_test(&mut self, ttl_secs: u64) {
        let inner = Arc::get_mut(&mut self.inner).expect("plane is unshared");
        inner.relay_ws_ticket_challenge_ttl_secs = ttl_secs;
    }

    /// Whether any registration still exists for this relay/room pair.
    pub async fn has_relay_registration(&self, relay_id: &str, broker_room_id: &str) -> bool {
        let Ok(store) = self.lock_state().await else {
            return true; // fail closed: assume still present if we cannot check
        };
        store
            .relay_registrations_by_hash
            .values()
            .any(|reg| reg.relay_id == relay_id && reg.broker_room_id == broker_room_id)
    }

    /// Count device grants for a relay/room (test/assertion helper).
    pub async fn device_grant_count_for_test(&self, relay_id: &str, broker_room_id: &str) -> usize {
        let store = self.lock_state().await.expect("lock");
        store
            .grants_by_hash
            .values()
            .filter(|g| g.relay_id == relay_id && g.broker_room_id == broker_room_id)
            .count()
    }

    /// Count client↔relay grants for a relay/room (test/assertion helper).
    pub async fn client_relay_grant_count_for_test(
        &self,
        relay_id: &str,
        broker_room_id: &str,
    ) -> usize {
        let store = self.lock_state().await.expect("lock");
        store
            .client_relay_grants_by_key
            .values()
            .filter(|g| g.relay_id == relay_id && g.broker_room_id == broker_room_id)
            .count()
    }

    /// Arm N failing persistence saves (test-only).
    pub fn arm_save_failpoint_for_test(&self, count: u64) {
        self.inner
            .save_fail_remaining
            .store(count, std::sync::atomic::Ordering::SeqCst);
    }

    /// Arm N shared save+reload-unknown failures (test-only). Leaves memory as
    /// the intended next state (typically target-cleared) and returns
    /// reload-uncertain — never success.
    pub fn arm_reload_uncertain_failpoint_for_test(&self, count: u64) {
        self.inner
            .reload_uncertain_fail_remaining
            .store(count, std::sync::atomic::Ordering::SeqCst);
    }

    /// Install a one-shot pause at the start of revoke cleanup (test-only).
    pub fn arm_cleanup_pause_for_test(&self, hook: std::sync::Arc<dyn Fn() + Send + Sync>) {
        *self.inner.cleanup_pause.lock().expect("cleanup pause lock") = Some(hook);
    }

    /// Test-only: seed a client→relay grant directly, bypassing enrollment, to
    /// simulate an orphaned grant (no registration, no device grant) — the state a
    /// dangling `client_relay_grant` leaves behind.
    pub(super) async fn seed_client_relay_grant_for_test(&self, relay_id: &str, client_id: &str) {
        let mut store = self.lock_state().await.expect("lock state");
        store.upsert_client_relay_grant(PersistedClientRelayGrant {
            client_id: client_id.to_string(),
            relay_id: relay_id.to_string(),
            broker_room_id: format!("room-{relay_id}"),
            device_id: format!("dev-{client_id}"),
            granted_at: 0,
            relay_label: None,
            device_label: None,
        });
        self.persist(&mut store).await.expect("save");
    }
}

/// Pre-optimization full wipe-and-rebuild save. Kept ONLY so the persistence
/// benchmark can measure the targeted diff-save against the old behavior; it is
/// not wired into any live code path.
pub(super) async fn save_public_control_postgres_full_rebuild(
    pool: &PgPool,
    state: &PublicControlStateStore,
) -> Result<(), String> {
    let persisted = state.to_persisted();
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("failed to begin public control-plane transaction: {error}"))?;
    sqlx::query("DELETE FROM public_client_relay_grants")
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to clear public_client_relay_grants: {error}"))?;
    sqlx::query("DELETE FROM public_device_grants")
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to clear public_device_grants: {error}"))?;
    sqlx::query("DELETE FROM public_client_identities")
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to clear public_client_identities: {error}"))?;
    sqlx::query("DELETE FROM public_relay_registrations")
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to clear public_relay_registrations: {error}"))?;

    for registration in persisted.relay_registrations {
        sqlx::query(
            r#"
            INSERT INTO public_relay_registrations (
                refresh_token_hash, relay_id, broker_room_id, created_at, relay_label, relay_verify_key
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(registration.refresh_token_hash)
        .bind(registration.relay_id)
        .bind(registration.broker_room_id)
        .bind(u64_to_i64(registration.created_at, "created_at")?)
        .bind(registration.relay_label)
        .bind(registration.relay_verify_key)
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to insert public_relay_registrations: {error}"))?;
    }
    for client in persisted.client_registrations {
        sqlx::query(
            r#"
            INSERT INTO public_client_identities (
                refresh_token_hash, client_id, client_verify_key, created_at, client_label
            )
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(client.refresh_token_hash)
        .bind(client.client_id)
        .bind(client.client_verify_key)
        .bind(u64_to_i64(client.created_at, "created_at")?)
        .bind(client.client_label)
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to insert public_client_identities: {error}"))?;
    }
    for grant in persisted.device_grants {
        sqlx::query(
            r#"
            INSERT INTO public_device_grants (
                refresh_token_hash, relay_id, broker_room_id, device_id, created_at, last_seen
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(grant.refresh_token_hash)
        .bind(grant.relay_id)
        .bind(grant.broker_room_id)
        .bind(grant.device_id)
        .bind(u64_to_i64(grant.created_at, "created_at")?)
        .bind(grant.last_seen.and_then(|value| i64::try_from(value).ok()))
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to insert public_device_grants: {error}"))?;
    }
    for grant in persisted.client_relay_grants {
        sqlx::query(
            r#"
            INSERT INTO public_client_relay_grants (
                client_id, relay_id, broker_room_id, device_id, granted_at, relay_label, device_label
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(grant.client_id)
        .bind(grant.relay_id)
        .bind(grant.broker_room_id)
        .bind(grant.device_id)
        .bind(u64_to_i64(grant.granted_at, "granted_at")?)
        .bind(grant.relay_label)
        .bind(grant.device_label)
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("failed to insert public_client_relay_grants: {error}"))?;
    }
    tx.commit()
        .await
        .map_err(|error| format!("failed to commit public control-plane transaction: {error}"))?;
    Ok(())
}
