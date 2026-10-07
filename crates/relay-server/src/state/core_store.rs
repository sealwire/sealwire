//! The relay's durable state as rows of `sealwire.db`: one row per entity.
//!
//! What is durable is still decided by `PersistedRelayState::from_relay`; this module
//! only turns that view into rows and back. A commit writes the rows that differ from
//! the last commit, so a change that touches nothing durable writes nothing.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use super::persistence::PersistedRelayState;
use super::PERSISTED_STATE_VERSION;

/// Settings live in one table keyed by name; every other table holds one entity per row.
pub(crate) const SETTINGS_TABLE: &str = "relay_setting";

pub(crate) const ENTITY_TABLES: [&str; 23] = [
    SETTINGS_TABLE,
    "session_settings",
    "session_fork",
    "session_binding",
    "session_workspace",
    "session_turn_base_sha",
    "session_turn_base_cwd",
    "session_last_activity",
    "session_project",
    "session_custom_name",
    "session_flagged",
    "device_record",
    "paired_device",
    "push_subscription",
    "reviewer_thread",
    "project",
    "job_review",
    "job_ask",
    "job_handover",
    "job_goal",
    "job_workflow",
    "job_team_run",
    "orchestrator_proposal",
];

/// The credential kind holding each paired device's payload secret.
pub(crate) const DEVICE_PAYLOAD_SECRET: &str = "device_payload";
const PAYLOAD_SECRET_FIELD: &str = "payload_secret";

pub(crate) const META_CORE_ORIGIN: &str = "core_origin";
pub(crate) const META_TRANSCRIPT_CLOCK_CEILING: &str = "transcript_clock_ceiling";

#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct CoreRows {
    entities: BTreeMap<(&'static str, String), String>,
    device_secrets: BTreeMap<String, String>,
}

impl std::fmt::Debug for CoreRows {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreRows")
            .field("entities", &self.entities)
            .field(
                "device_secrets",
                &self.device_secrets.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// The rows as last written, and the order of the capture they were written from.
#[derive(Default)]
pub(crate) struct CommittedCore {
    rows: CoreRows,
    order: u64,
}

/// The durable state copied under the relay lock, to be written once it is released, so
/// a slow disk never holds up the relay.
pub(crate) struct CoreCapture {
    store: crate::usage::store::UsageStore,
    state: PersistedRelayState,
    order: u64,
}

impl CoreCapture {
    pub(super) fn new(store: &crate::usage::store::UsageStore, state: PersistedRelayState) -> Self {
        Self {
            order: store.next_capture_order(),
            store: store.clone(),
            state,
        }
    }

    pub(crate) fn commit(self) -> Result<(), String> {
        commit_captured(&self.store, &self.state, self.order).map(|_| ())
    }
}

impl CoreRows {
    pub(crate) fn is_empty(&self) -> bool {
        self.entities.is_empty() && self.device_secrets.is_empty()
    }

    fn put<T: Serialize>(
        &mut self,
        table: &'static str,
        key: &str,
        value: &T,
    ) -> Result<(), String> {
        let body =
            canonical_json(value).map_err(|error| format!("encode {table} row {key}: {error}"))?;
        self.entities.insert((table, key.to_string()), body);
        Ok(())
    }

    fn put_setting<T: Serialize>(&mut self, key: &str, value: &T) -> Result<(), String> {
        self.put(SETTINGS_TABLE, key, value)
    }

    fn rows(&self, table: &'static str) -> impl Iterator<Item = (&str, &str)> {
        self.entities
            .range((table, String::new())..)
            .take_while(move |((name, _), _)| *name == table)
            .map(|((_, key), body)| (key.as_str(), body.as_str()))
    }

    fn setting<T: DeserializeOwned + Default>(&self, key: &str) -> Result<T, String> {
        match self.entities.get(&(SETTINGS_TABLE, key.to_string())) {
            Some(body) => {
                serde_json::from_str(body).map_err(|error| format!("decode setting {key}: {error}"))
            }
            None => Ok(T::default()),
        }
    }

    fn map<T: DeserializeOwned>(&self, table: &'static str) -> Result<HashMap<String, T>, String> {
        self.rows(table)
            .map(|(key, body)| {
                serde_json::from_str(body)
                    .map(|value| (key.to_string(), value))
                    .map_err(|error| format!("decode {table} row {key}: {error}"))
            })
            .collect()
    }
}

/// Sorted keys, so an unchanged entity always encodes to the same text and a
/// `HashMap` inside it does not turn into a write on every commit.
fn canonical_json<T: Serialize>(value: &T) -> serde_json::Result<String> {
    serde_json::to_string(&serde_json::to_value(value)?)
}

pub(crate) fn rows_of(state: &PersistedRelayState) -> Result<CoreRows, String> {
    let mut rows = CoreRows::default();
    rows.put_setting("active_thread_id", &state.active_thread_id)?;
    rows.put_setting("current_cwd", &state.current_cwd)?;
    rows.put_setting("model", &state.model)?;
    rows.put_setting("approval_policy", &state.approval_policy)?;
    rows.put_setting("sandbox", &state.sandbox)?;
    rows.put_setting("reasoning_effort", &state.reasoning_effort)?;
    rows.put_setting("provider_name", &state.provider_name)?;
    rows.put_setting("allowed_roots", &state.allowed_roots)?;
    rows.put_setting("usage_daily_cap", &state.usage_daily_cap)?;
    rows.put_setting("usage_budget_policy", &state.usage_budget_policy)?;
    rows.put_setting("trusted_workspaces", &state.trusted_workspaces)?;
    rows.put_setting(
        "allowed_roots_trust_migrated",
        &state.allowed_roots_trust_migrated,
    )?;
    rows.put_setting("orchestrator_thread_id", &state.orchestrator_thread_id)?;
    rows.put_setting("orchestrator_device_id", &state.orchestrator_device_id)?;
    rows.put_setting(
        "orchestrator_system_prompt",
        &state.orchestrator_system_prompt,
    )?;
    rows.put_setting(
        "orchestrator_system_prompt_version",
        &state.orchestrator_system_prompt_version,
    )?;
    rows.put_setting("projects_revision", &state.projects_revision)?;

    for (key, value) in &state.thread_settings {
        rows.put("session_settings", key, value)?;
    }
    for (key, value) in &state.thread_forked_from {
        rows.put("session_fork", key, value)?;
    }
    for (key, value) in &state.session_bindings {
        rows.put("session_binding", key, value)?;
    }
    for (key, value) in &state.thread_workspace {
        rows.put("session_workspace", key, value)?;
    }
    for (key, value) in &state.thread_last_turn_base_sha {
        rows.put("session_turn_base_sha", key, value)?;
    }
    for (key, value) in &state.thread_last_turn_base_cwd {
        rows.put("session_turn_base_cwd", key, value)?;
    }
    for (key, value) in &state.thread_last_activity_at {
        rows.put("session_last_activity", key, value)?;
    }
    for (key, value) in &state.thread_project_id {
        rows.put("session_project", key, value)?;
    }
    for (key, value) in &state.thread_custom_name {
        rows.put("session_custom_name", key, value)?;
    }
    for key in &state.thread_flagged {
        rows.put("session_flagged", key, &true)?;
    }
    for (key, value) in &state.device_records {
        rows.put("device_record", key, value)?;
    }
    for (key, device) in &state.paired_devices {
        let mut body = serde_json::to_value(device)
            .map_err(|error| format!("encode paired_device row {key}: {error}"))?;
        if let Some(fields) = body.as_object_mut() {
            fields.remove(PAYLOAD_SECRET_FIELD);
        }
        rows.put("paired_device", key, &body)?;
        rows.device_secrets
            .insert(key.clone(), device.payload_secret.clone());
    }
    for (key, value) in &state.push_subscriptions {
        rows.put("push_subscription", key, value)?;
    }
    for (key, value) in &state.reviewer_threads {
        rows.put("reviewer_thread", key, value)?;
    }
    for (key, value) in &state.projects {
        rows.put("project", key, value)?;
    }
    for (key, value) in &state.review_jobs {
        rows.put("job_review", key, value)?;
    }
    for (key, value) in &state.asks {
        rows.put("job_ask", key, value)?;
    }
    for (key, value) in &state.handovers {
        rows.put("job_handover", key, value)?;
    }
    for (key, value) in &state.goals {
        rows.put("job_goal", key, value)?;
    }
    for (key, value) in &state.workflow_jobs {
        rows.put("job_workflow", key, value)?;
    }
    for (key, value) in &state.team_runs {
        rows.put("job_team_run", key, value)?;
    }
    for (position, card) in state.orchestrator_proposals.iter().enumerate() {
        rows.put(
            "orchestrator_proposal",
            &card.id,
            &serde_json::json!({ "position": position, "card": card }),
        )?;
    }
    Ok(rows)
}

/// `None` when nothing has been committed yet: a relay that has never saved starts
/// from its defaults, which are not the same as an all-empty saved state.
pub(crate) fn state_from_rows(
    rows: &CoreRows,
    transcript_clock: u64,
) -> Result<Option<PersistedRelayState>, String> {
    if rows.rows(SETTINGS_TABLE).next().is_none() {
        return Ok(None);
    }
    let mut paired_devices = HashMap::new();
    for (key, body) in rows.rows("paired_device") {
        let mut value: serde_json::Value = serde_json::from_str(body)
            .map_err(|error| format!("decode paired_device row {key}: {error}"))?;
        let secret = rows
            .device_secrets
            .get(key)
            .ok_or_else(|| format!("paired device {key} has no payload secret"))?;
        if let Some(fields) = value.as_object_mut() {
            fields.insert(
                PAYLOAD_SECRET_FIELD.to_string(),
                serde_json::Value::String(secret.clone()),
            );
        }
        let device = serde_json::from_value(value)
            .map_err(|error| format!("decode paired_device row {key}: {error}"))?;
        paired_devices.insert(key.to_string(), device);
    }
    let mut proposals = Vec::new();
    for (key, body) in rows.rows("orchestrator_proposal") {
        #[derive(serde::Deserialize)]
        struct Positioned {
            position: usize,
            card: crate::protocol::OrchestratorProposalView,
        }
        let row: Positioned = serde_json::from_str(body)
            .map_err(|error| format!("decode orchestrator_proposal row {key}: {error}"))?;
        proposals.push((row.position, row.card));
    }
    proposals.sort_by_key(|(position, _)| *position);
    let thread_flagged: HashSet<String> = rows
        .rows("session_flagged")
        .map(|(key, _)| key.to_string())
        .collect();

    Ok(Some(PersistedRelayState {
        schema_version: PERSISTED_STATE_VERSION,
        active_thread_id: rows.setting("active_thread_id")?,
        // The controller lease outlives no restart, and status/flags are never read back.
        active_controller_device_id: None,
        active_controller_last_seen_at: None,
        current_status: "idle".to_string(),
        active_flags: Vec::new(),
        current_cwd: rows.setting("current_cwd")?,
        model: rows.setting("model")?,
        approval_policy: rows.setting("approval_policy")?,
        sandbox: rows.setting("sandbox")?,
        reasoning_effort: rows.setting("reasoning_effort")?,
        provider_name: rows.setting("provider_name")?,
        thread_settings: rows.map("session_settings")?,
        thread_forked_from: rows.map("session_fork")?,
        session_bindings: rows.map("session_binding")?,
        thread_workspace: rows.map("session_workspace")?,
        thread_last_turn_base_sha: rows.map("session_turn_base_sha")?,
        thread_last_turn_base_cwd: rows.map("session_turn_base_cwd")?,
        thread_last_activity_at: rows.map("session_last_activity")?,
        allowed_roots: rows.setting("allowed_roots")?,
        usage_daily_cap: rows.setting("usage_daily_cap")?,
        usage_budget_policy: rows.setting("usage_budget_policy")?,
        trusted_workspaces: rows.setting("trusted_workspaces")?,
        allowed_roots_trust_migrated: rows.setting("allowed_roots_trust_migrated")?,
        device_records: rows.map("device_record")?,
        paired_devices,
        reviewer_threads: rows.map("reviewer_thread")?,
        review_jobs: rows.map("job_review")?,
        asks: rows.map("job_ask")?,
        handovers: rows.map("job_handover")?,
        goals: rows.map("job_goal")?,
        workflow_jobs: rows.map("job_workflow")?,
        team_runs: rows.map("job_team_run")?,
        orchestrator_thread_id: rows.setting("orchestrator_thread_id")?,
        orchestrator_device_id: rows.setting("orchestrator_device_id")?,
        orchestrator_system_prompt: rows.setting("orchestrator_system_prompt")?,
        orchestrator_system_prompt_version: rows.setting("orchestrator_system_prompt_version")?,
        orchestrator_proposals: proposals.into_iter().map(|(_, card)| card).collect(),
        push_subscriptions: rows.map("push_subscription")?,
        projects: rows.map("project")?,
        thread_project_id: rows.map("session_project")?,
        thread_custom_name: rows.map("session_custom_name")?,
        thread_flagged,
        projects_revision: rows.setting("projects_revision")?,
        transcript_clock,
    }))
}

pub(crate) fn read_rows(conn: &Connection) -> rusqlite::Result<CoreRows> {
    let mut rows = CoreRows::default();
    for table in ENTITY_TABLES {
        let mut statement = conn.prepare(&format!("SELECT key, body FROM {table}"))?;
        let found = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in found {
            let (key, body) = row?;
            rows.entities.insert((table, key), body);
        }
    }
    let mut statement = conn.prepare("SELECT id, secret FROM credential WHERE kind = ?1")?;
    let found = statement.query_map([DEVICE_PAYLOAD_SECRET], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in found {
        let (id, secret) = row?;
        rows.device_secrets.insert(id, secret);
    }
    Ok(rows)
}

/// Write the rows that differ between `before` and `after`. Returns how many changed.
pub(crate) fn write_diff(
    tx: &Connection,
    before: &CoreRows,
    after: &CoreRows,
    now: u64,
) -> rusqlite::Result<usize> {
    let mut changed = 0;
    for ((table, key), body) in &after.entities {
        if before.entities.get(&(*table, key.clone())) != Some(body) {
            tx.execute(
                &format!("INSERT OR REPLACE INTO {table} (key, body) VALUES (?1, ?2)"),
                params![key, body],
            )?;
            changed += 1;
        }
    }
    for (table, key) in before.entities.keys() {
        if !after.entities.contains_key(&(*table, key.clone())) {
            tx.execute(&format!("DELETE FROM {table} WHERE key = ?1"), [key])?;
            changed += 1;
        }
    }
    for (id, secret) in &after.device_secrets {
        if before.device_secrets.get(id) != Some(secret) {
            put_credential(tx, DEVICE_PAYLOAD_SECRET, id, secret, None, now)?;
            changed += 1;
        }
    }
    for id in before.device_secrets.keys() {
        if !after.device_secrets.contains_key(id) {
            delete_credential(tx, DEVICE_PAYLOAD_SECRET, id)?;
            changed += 1;
        }
    }
    Ok(changed)
}

pub(crate) fn put_credential(
    conn: &Connection,
    kind: &str,
    id: &str,
    secret: &str,
    info: Option<&str>,
    now: u64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO credential (kind, id, secret, info, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![kind, id, secret, info, now as i64],
    )?;
    Ok(())
}

pub(crate) fn read_credential(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> rusqlite::Result<Option<(String, Option<String>)>> {
    conn.query_row(
        "SELECT secret, info FROM credential WHERE kind = ?1 AND id = ?2",
        params![kind, id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

/// Every `(id, secret, info)` stored under `kind`.
pub(crate) fn list_credentials(
    conn: &Connection,
    kind: &str,
) -> rusqlite::Result<Vec<(String, String, Option<String>)>> {
    let mut statement = conn.prepare("SELECT id, secret, info FROM credential WHERE kind = ?1")?;
    let rows = statement.query_map([kind], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    rows.collect()
}

/// Each paired device and the relay key its pairing QR named; `None` when not recorded.
pub(crate) fn paired_device_relay_keys(
    conn: &Connection,
) -> Result<Vec<(String, Option<String>)>, String> {
    let mut statement = conn
        .prepare("SELECT key, body FROM paired_device")
        .map_err(|error| format!("read paired devices: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("read paired devices: {error}"))?;
    #[derive(serde::Deserialize)]
    struct Pinned {
        #[serde(default)]
        pairing_broker: Option<super::PairingBroker>,
    }
    let mut keys = Vec::new();
    for row in rows {
        let (device_id, body) = row.map_err(|error| format!("read paired devices: {error}"))?;
        let pinned: Pinned = serde_json::from_str(&body)
            .map_err(|error| format!("decode paired_device row {device_id}: {error}"))?;
        keys.push((
            device_id,
            pinned.pairing_broker.map(|broker| broker.relay_verify_key),
        ));
    }
    Ok(keys)
}

pub(crate) fn delete_credential(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM credential WHERE kind = ?1 AND id = ?2",
        params![kind, id],
    )
}

pub(crate) fn read_meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
}

pub(crate) fn write_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

pub(crate) fn read_clock_ceiling(conn: &Connection) -> Result<u64, String> {
    match read_meta(conn, META_TRANSCRIPT_CLOCK_CEILING)
        .map_err(|error| format!("read transcript clock: {error}"))?
    {
        Some(value) => value
            .parse()
            .map_err(|error| format!("decode transcript clock {value:?}: {error}")),
        None => Ok(0),
    }
}

/// Only ever raises the stored ceiling.
pub(crate) fn raise_clock_ceiling(conn: &Connection, ceiling: u64) -> Result<u64, String> {
    let stored = read_clock_ceiling(conn)?;
    let next = stored.max(ceiling);
    if next != stored {
        write_meta(conn, META_TRANSCRIPT_CLOCK_CEILING, &next.to_string())
            .map_err(|error| format!("reserve transcript clock: {error}"))?;
    }
    Ok(next)
}

/// Read the committed state and keep it as the base the next commit diffs against.
pub(crate) fn load(
    store: &crate::usage::store::UsageStore,
) -> Result<Option<PersistedRelayState>, String> {
    store.with_core(|core, conn| {
        let rows = read_rows(conn).map_err(|error| format!("read relay state: {error}"))?;
        let clock = read_clock_ceiling(conn)?;
        let state = state_from_rows(&rows, clock)?;
        core.rows = rows;
        Ok(state)
    })
}

/// Write what changed since the last commit, in one transaction.
#[cfg(test)]
pub(crate) fn commit(
    store: &crate::usage::store::UsageStore,
    state: &PersistedRelayState,
) -> Result<usize, String> {
    commit_captured(store, state, store.next_capture_order())
}

/// A capture older than the one last written is already covered by it: the state only
/// moves forward, so writing the older one would put a change back.
fn commit_captured(
    store: &crate::usage::store::UsageStore,
    state: &PersistedRelayState,
    order: u64,
) -> Result<usize, String> {
    let rows = rows_of(state)?;
    store.with_core(|core, conn| {
        if order < core.order || core.rows == rows {
            core.order = core.order.max(order);
            return Ok(0);
        }
        let tx = conn
            .transaction()
            .map_err(|error| format!("begin: {error}"))?;
        let changed = write_diff(&tx, &core.rows, &rows, super::unix_now())
            .map_err(|error| format!("write relay state: {error}"))?;
        tx.commit().map_err(|error| format!("commit: {error}"))?;
        core.rows = rows;
        core.order = order;
        Ok(changed)
    })
}

/// File names older builds kept relay state under. One of these beside a database
/// that has never held state means the state has not been imported yet.
pub(crate) fn is_legacy_state_file(name: &str) -> bool {
    name == "session.json"
        || name.ends_with("-session.json")
        || name.ends_with("public-broker-identity.json")
        || name.ends_with("public-broker-registration.json")
        || name == "relay-content-identity.json"
        || name.ends_with("vapid.key")
}

/// Old-format state a fresh database would be started beside: in the database's own
/// directory, and in the `~/.agent-relay` an older build used where `~/.sealwire` is now.
pub(crate) fn legacy_state_files_beside(db_path: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Some(dir) = db_path.parent() else {
        return Vec::new();
    };
    let mut found = files_in(dir, is_legacy_state_file);
    if let Some(old_dir) = crate::state_paths::legacy_state_dir_beside(dir) {
        found.extend(files_in(&old_dir, |name| {
            is_legacy_state_file(name) || name == "sealwire.db" || name == "token-usage.db"
        }));
    }
    found.sort();
    found
}

fn files_in(dir: &std::path::Path, wanted: impl Fn(&str) -> bool) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_name().to_str().is_some_and(&wanted))
        .map(|entry| entry.path())
        .collect()
}

/// How the database came to hold relay state, without changing the file: `None` for a
/// database that is missing, older than the core tables, or never initialized.
pub(crate) fn peek_core_origin(db_path: &std::path::Path) -> Result<Option<String>, String> {
    if !db_path.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open {}: {error}", db_path.display()))?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("read {}: {error}", db_path.display()))?;
    if version < 17 {
        return Ok(None);
    }
    read_meta(&conn, META_CORE_ORIGIN)
        .map_err(|error| format!("read {}: {error}", db_path.display()))
}

/// Refuse to start an uninitialized database beside state an older build left behind:
/// starting empty there would enroll a new relay identity and strand paired phones.
pub(crate) fn refuse_unimported_legacy_state(db_path: &std::path::Path) -> Result<(), String> {
    if peek_core_origin(db_path)?.is_some() {
        return Ok(());
    }
    let leftovers = legacy_state_files_beside(db_path);
    if leftovers.is_empty() {
        return Ok(());
    }
    let names = leftovers
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "{} has not been set up yet, and relay state in the old format is still waiting to be \
         imported ({names}). Import it first with `sealwire migrate-storage` \
         (`relay-server migrate-storage` in a source checkout), or move those files away to \
         start with an empty relay.",
        db_path.display()
    ))
}

/// The database this process may use: symlinks resolved, one leading out of the
/// workspace refused, and never beside old state that has not been imported.
pub(crate) fn checked_state_db_path(cwd: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let configured = crate::state_paths::state_db_path(cwd);
    let resolved = crate::instance_lock::resolve_identity(&configured)
        .map_err(|error| format!("{}: {error}", configured.display()))?;
    refuse_unimported_legacy_state(&resolved)?;
    Ok(resolved)
}

pub(crate) fn mark_fresh_if_uninitialized(
    store: &crate::usage::store::UsageStore,
) -> Result<(), String> {
    store.with_connection(|conn| {
        if read_meta(conn, META_CORE_ORIGIN)
            .map_err(|error| format!("read meta: {error}"))?
            .is_none()
        {
            write_meta(conn, META_CORE_ORIGIN, "fresh")
                .map_err(|error| format!("write meta: {error}"))?;
        }
        Ok(())
    })
}

#[cfg(test)]
pub(crate) fn assert_rows_round_trip(state: &PersistedRelayState) {
    let rows = rows_of(state).expect("state encodes to rows");
    let back = state_from_rows(&rows, state.transcript_clock)
        .expect("rows decode")
        .expect("a saved state has settings rows");
    assert_eq!(
        rows_of(&back).expect("decoded state encodes"),
        rows,
        "saving this state to the database and reading it back changed it"
    );
}

/// Open the relay's database the way every process must: never beside state an older
/// build left unimported, and marked as holding relay state from then on.
pub(crate) fn open_state_database(
    db_path: &std::path::Path,
) -> Result<crate::usage::store::UsageStore, String> {
    refuse_unimported_legacy_state(db_path)?;
    let store = crate::usage::store::UsageStore::open_at(db_path)?;
    mark_fresh_if_uninitialized(&store)
        .map_err(|error| format!("failed to set up {}: {error}", db_path.display()))?;
    Ok(store)
}

/// What the one-time import of `session.json` wrote.
// TODO(2026-12): remove with `migrate-storage` once every relay has been imported.
pub(crate) struct CoreImport {
    pub(crate) rows_per_table: BTreeMap<&'static str, usize>,
    pub(crate) paired_devices: usize,
    pub(crate) transcript_clock: u64,
}

/// Write an older build's `session.json` into an empty database and read it back.
/// `conn` is inside the caller's transaction, so a mismatch leaves nothing behind.
pub(crate) fn import_legacy_session(conn: &Connection, json: &[u8]) -> Result<CoreImport, String> {
    let state: PersistedRelayState = serde_json::from_slice(json)
        .map_err(|error| format!("failed to decode persisted state: {error}"))?;
    if state.schema_version != PERSISTED_STATE_VERSION {
        return Err(format!(
            "unsupported persisted state version: {}",
            state.schema_version
        ));
    }
    let existing = read_rows(conn).map_err(|error| format!("read relay state: {error}"))?;
    if !existing.is_empty() {
        return Err("the database already holds relay state".to_string());
    }
    let rows = rows_of(&state)?;
    write_diff(conn, &CoreRows::default(), &rows, super::unix_now())
        .map_err(|error| format!("write relay state: {error}"))?;
    raise_clock_ceiling(conn, state.transcript_clock)?;

    let written = read_rows(conn).map_err(|error| format!("read back relay state: {error}"))?;
    let loaded = state_from_rows(&written, read_clock_ceiling(conn)?)?
        .ok_or_else(|| "nothing was written".to_string())?;
    if rows_of(&loaded)? != rows || loaded.transcript_clock < state.transcript_clock {
        return Err(
            "the relay state read back from the database differs from session.json".to_string(),
        );
    }

    let mut rows_per_table = BTreeMap::new();
    for (table, _) in rows.entities.keys() {
        *rows_per_table.entry(*table).or_default() += 1;
    }
    Ok(CoreImport {
        rows_per_table,
        paired_devices: rows.device_secrets.len(),
        transcript_clock: loaded.transcript_clock,
    })
}
