use super::*;

impl PublicControlPlane {
    pub(super) async fn refresh_postgres_credentials(
        &self,
        challenge: &CredentialRefreshChallengeResponse,
        verify_key: &str,
        now: u64,
    ) -> Result<(CredentialRefreshResponse, String, Option<String>), String> {
        let PublicControlPersistence::Postgres {
            pool,
            gate,
            last_saved,
            needs_reload,
            ..
        } = &self.inner.persistence
        else {
            unreachable!("scoped refresh requires PostgreSQL");
        };
        let cached = {
            let store = self.inner.state.lock().await;
            refresh_cache_records(&store, challenge)
        };
        let commit_started = AtomicBool::new(false);
        let result = gate.run_refresh(async {
            let mut tx = pool.begin().await.map_err(postgres_refresh_error)?;
            let mut store = PublicControlStateStore::default();
            // Match the persistence writer's lock order: relay, client, device, client grant.
            if let Some(room) = &challenge.broker_room_id {
                let row = sqlx::query("SELECT * FROM public_relay_registrations WHERE broker_room_id = $1 FOR UPDATE")
                    .bind(room).fetch_optional(&mut *tx).await.map_err(postgres_refresh_error)?
                    .ok_or_else(invalid_refresh)?;
                let relay = decode_relay_registration(row)?;
                store.relay_registrations_by_hash.insert(relay.refresh_token_hash.clone(), relay);
            }
            let row = sqlx::query("SELECT * FROM public_client_identities WHERE client_id = $1 FOR UPDATE")
                .bind(&challenge.client_id).fetch_optional(&mut *tx).await.map_err(postgres_refresh_error)?
                .ok_or_else(invalid_refresh)?;
            let client = decode_client_identity(row)?;
            if client.client_verify_key != verify_key { return Err(invalid_refresh()); }
            store.client_registrations_by_hash.insert(client.refresh_token_hash.clone(), client);
            if let Some(room) = &challenge.broker_room_id {
                let relay = store.relay_registrations_by_hash.values().next().unwrap();
                let row = sqlx::query("SELECT * FROM public_device_grants WHERE relay_id = $1 AND broker_room_id = $2 AND device_id = $3 FOR UPDATE")
                    .bind(&relay.relay_id).bind(room).bind(&challenge.device_id).fetch_optional(&mut *tx)
                    .await.map_err(postgres_refresh_error)?.ok_or_else(invalid_refresh)?;
                let device = decode_device_grant(row)?;
                store.grants_by_hash.insert(device.refresh_token_hash.clone(), device);
                let row = sqlx::query("SELECT * FROM public_client_relay_grants WHERE client_id = $1 AND relay_id = $2 AND broker_room_id = $3 FOR UPDATE")
                    .bind(&challenge.client_id).bind(&relay.relay_id).bind(room).fetch_optional(&mut *tx)
                    .await.map_err(postgres_refresh_error)?.ok_or_else(invalid_refresh)?;
                let grant = decode_client_relay_grant(row)?;
                store.upsert_client_relay_grant(grant);
            }
            let previous = store.clone();
            let response = self.rotate_signed_credentials(&mut store, challenge, verify_key, now)?;
            update_refreshed_credentials(&mut tx, &previous, &store).await?;
            commit_started.store(true, Ordering::SeqCst);
            tx.commit().await.map_err(postgres_refresh_error)?;
            Ok((response, store))
        }).await;
        let (response, refreshed) = result.map_err(|error| {
            if matches!(error, PublicControlDbGateError::Busy) {
                return error.into_message();
            }
            // Only a COMMIT failure is ambiguous; rejected or rolled-back requests change no rows.
            if commit_started.load(Ordering::SeqCst) {
                needs_reload.store(true, Ordering::SeqCst);
            }
            let message = error.into_message();
            if message == invalid_refresh() {
                return message;
            }
            warn!(error = %message, "public control-plane credential refresh failed");
            sanitize_persistence_error(message)
        })?;
        let mut store = self.inner.state.lock().await;
        let mut snapshot = last_saved.lock().await;
        if refresh_cache_records(&store, challenge) == cached {
            merge_refresh_records(&mut store, challenge, &refreshed);
            merge_refresh_records(&mut snapshot, challenge, &refreshed);
        } else {
            // A concurrent local revoke or rotation takes precedence over this cache update.
            needs_reload.store(true, Ordering::SeqCst);
        }
        Ok(response)
    }
}

async fn update_refreshed_credentials(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    previous: &PublicControlStateStore,
    refreshed: &PublicControlStateStore,
) -> Result<(), String> {
    // A waiting SELECT FOR UPDATE follows an updated row; DELETE + INSERT looks like revocation.
    let old = previous
        .client_registrations_by_hash
        .values()
        .next()
        .unwrap();
    let client = refreshed
        .client_registrations_by_hash
        .values()
        .next()
        .unwrap();
    let updated = sqlx::query("UPDATE public_client_identities SET refresh_token_hash = $1, created_at = $2, superseded_tokens = $3 WHERE client_id = $4 AND refresh_token_hash = $5")
        .bind(&client.refresh_token_hash).bind(u64_to_i64(client.created_at, "created_at")?)
        .bind(encode_superseded(&client.superseded)?).bind(&client.client_id)
        .bind(&old.refresh_token_hash).execute(&mut **tx).await.map_err(postgres_refresh_error)?;
    require_changed_credential(updated.rows_affected())?;
    if let Some(device) = refreshed.grants_by_hash.values().next() {
        let old = previous.grants_by_hash.values().next().unwrap();
        let updated = sqlx::query("UPDATE public_device_grants SET refresh_token_hash = $1, created_at = $2, last_seen = $3, superseded_tokens = $4 WHERE relay_id = $5 AND broker_room_id = $6 AND device_id = $7 AND refresh_token_hash = $8")
            .bind(&device.refresh_token_hash).bind(u64_to_i64(device.created_at, "created_at")?)
            .bind(device.last_seen.and_then(|value| i64::try_from(value).ok()))
            .bind(encode_superseded(&device.superseded)?).bind(&device.relay_id)
            .bind(&device.broker_room_id).bind(&device.device_id).bind(&old.refresh_token_hash)
            .execute(&mut **tx).await.map_err(postgres_refresh_error)?;
        require_changed_credential(updated.rows_affected())?;
    }
    Ok(())
}

fn invalid_refresh() -> String {
    "credential refresh is invalid".to_string()
}

fn postgres_refresh_error(error: sqlx::Error) -> String {
    format!("public control-plane credential refresh database failure: {error}")
}

fn refresh_cache_records(
    store: &PublicControlStateStore,
    challenge: &CredentialRefreshChallengeResponse,
) -> (
    Option<PersistedClientIdentity>,
    Option<PersistedDeviceGrant>,
) {
    (
        store.client_identity_for_id(&challenge.client_id),
        store
            .grants_by_hash
            .values()
            .find(|grant| {
                Some(&grant.broker_room_id) == challenge.broker_room_id.as_ref()
                    && Some(&grant.device_id) == challenge.device_id.as_ref()
            })
            .cloned(),
    )
}

fn merge_refresh_records(
    store: &mut PublicControlStateStore,
    challenge: &CredentialRefreshChallengeResponse,
    refreshed: &PublicControlStateStore,
) {
    store.remove_client_identity_by_client_id(&challenge.client_id);
    store
        .client_registrations_by_hash
        .extend(refreshed.client_registrations_by_hash.clone());
    if challenge.broker_room_id.is_some() {
        store.grants_by_hash.retain(|_, grant| {
            Some(&grant.broker_room_id) != challenge.broker_room_id.as_ref()
                || Some(&grant.device_id) != challenge.device_id.as_ref()
        });
        store
            .grants_by_hash
            .extend(refreshed.grants_by_hash.clone());
    }
}
