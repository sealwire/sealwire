//! The relay's broker identity, registration and push key, kept in the state database
//! beside everything else, so moving the database moves the whole identity.

use std::path::Path;

use rusqlite::Connection;

pub(crate) const PUBLIC_REGISTRATION: &str = "public_registration";
pub(crate) const PUBLIC_RELAY_IDENTITY: &str = "public_relay_identity";
pub(crate) const RELAY_CONTENT_IDENTITY: &str = "relay_content_identity";
/// The id of a kind with one entry per database: the self-hosted key, and the Cloud
/// entries an older build wrote before each broker had its own.
const ONLY: &str = "";
const PENDING_RELEASE_META: &str = "public_pending_release";

pub(crate) struct StoredCredential {
    pub(crate) secret: String,
    pub(crate) info: Option<String>,
}

/// Run `run` in one transaction on the database at `db`.
pub(crate) fn transact<T>(
    db: &Path,
    run: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let store = crate::state::open_state_database(db)?;
    store.with_connection(|conn| {
        let tx = conn
            .transaction()
            .map_err(|error| format!("begin {}: {error}", db.display()))?;
        let value = run(&tx)?;
        tx.commit()
            .map_err(|error| format!("commit {}: {error}", db.display()))?;
        Ok(value)
    })
}

pub(crate) fn read_in(conn: &Connection, kind: &str) -> Result<Option<StoredCredential>, String> {
    crate::state::read_credential(conn, kind, ONLY)
        .map(|found| found.map(|(secret, info)| StoredCredential { secret, info }))
        .map_err(|error| format!("read {kind}: {error}"))
}

pub(crate) fn write_in(
    conn: &Connection,
    kind: &str,
    secret: &str,
    info: Option<&str>,
) -> Result<(), String> {
    crate::state::put_credential(conn, kind, ONLY, secret, info, crate::state::unix_now())
        .map_err(|error| format!("write {kind}: {error}"))
}

pub(crate) fn read(db: &Path, kind: &str) -> Result<Option<StoredCredential>, String> {
    transact(db, |conn| read_in(conn, kind))
}

pub(crate) fn write(db: &Path, kind: &str, secret: &str, info: Option<&str>) -> Result<(), String> {
    transact(db, |conn| write_in(conn, kind, secret, info))
}

/// A Cloud-style broker's registration or identity, found by the control origin in its
/// `info`. Each broker has its own, so one database can be enrolled with several.
fn row_for_origin(
    conn: &Connection,
    kind: &str,
    control_url: &str,
) -> Result<Option<(String, StoredCredential)>, String> {
    let wanted = super::access_release::normalize_control_origin(control_url)?;
    let mut found = None;
    for (id, secret, info) in crate::state::list_credentials(conn, kind)
        .map_err(|error| format!("read {kind}: {error}"))?
    {
        let origin = info
            .as_deref()
            .and_then(|info| serde_json::from_str::<serde_json::Value>(info).ok())
            .and_then(|info| info.get("control_url")?.as_str().map(str::to_string))
            .ok_or_else(|| format!("{kind} entry {id:?} names no control url"))
            .and_then(|url| super::access_release::normalize_control_origin(&url))?;
        if origin == wanted {
            if found.is_some() {
                return Err(format!("{kind} has two entries for {wanted}"));
            }
            found = Some((id, StoredCredential { secret, info }));
        }
    }
    Ok(found)
}

pub(crate) fn read_for_origin_in(
    conn: &Connection,
    kind: &str,
    control_url: &str,
) -> Result<Option<StoredCredential>, String> {
    row_for_origin(conn, kind, control_url).map(|found| found.map(|(_, stored)| stored))
}

/// `info` must name `control_url`, or the entry could never be found again.
pub(crate) fn write_for_origin_in(
    conn: &Connection,
    kind: &str,
    control_url: &str,
    secret: &str,
    info: &str,
) -> Result<(), String> {
    let id = match row_for_origin(conn, kind, control_url)? {
        Some((id, _)) => id,
        None => super::access_release::normalize_control_origin(control_url)?,
    };
    crate::state::put_credential(
        conn,
        kind,
        &id,
        secret,
        Some(info),
        crate::state::unix_now(),
    )
    .map_err(|error| format!("write {kind}: {error}"))
}

pub(crate) fn delete_for_origin_in(
    conn: &Connection,
    kind: &str,
    control_url: &str,
) -> Result<bool, String> {
    let Some((id, _)) = row_for_origin(conn, kind, control_url)? else {
        return Ok(false);
    };
    crate::state::delete_credential(conn, kind, &id)
        .map(|removed| removed > 0)
        .map_err(|error| format!("delete {kind}: {error}"))
}

pub(crate) fn read_for_origin(
    db: &Path,
    kind: &str,
    control_url: &str,
) -> Result<Option<StoredCredential>, String> {
    transact(db, |conn| read_for_origin_in(conn, kind, control_url))
}

pub(crate) fn write_for_origin(
    db: &Path,
    kind: &str,
    control_url: &str,
    secret: &str,
    info: &str,
) -> Result<(), String> {
    transact(db, |conn| {
        write_for_origin_in(conn, kind, control_url, secret, info)
    })
}

/// One per broker, so unbinding one cannot erase another's unconfirmed release.
fn pending_release_key(control_url: &str) -> Result<String, String> {
    let origin = super::access_release::normalize_control_origin(control_url)?;
    Ok(format!("{PENDING_RELEASE_META}:{origin}"))
}

pub(crate) fn read_pending_release(db: &Path, control_url: &str) -> Result<Option<String>, String> {
    let key = pending_release_key(control_url)?;
    transact(db, |conn| {
        crate::state::read_meta(conn, &key)
            .map_err(|error| format!("read pending release: {error}"))
    })
}

pub(crate) fn write_pending_release(
    db: &Path,
    control_url: &str,
    marker: &str,
) -> Result<(), String> {
    let key = pending_release_key(control_url)?;
    transact(db, |conn| {
        crate::state::write_meta(conn, &key, marker)
            .map_err(|error| format!("write pending release: {error}"))
    })
}

pub(crate) fn clear_pending_release(db: &Path, control_url: &str) -> Result<(), String> {
    let key = pending_release_key(control_url)?;
    transact(db, |conn| {
        conn.execute("DELETE FROM meta WHERE key = ?1", [&key])
            .map(|_| ())
            .map_err(|error| format!("clear pending release: {error}"))
    })
}
