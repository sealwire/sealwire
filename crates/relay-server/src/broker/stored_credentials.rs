//! The relay's broker identity, registration and push key, kept in the state database
//! beside everything else, so moving the database moves the whole identity.

use std::path::Path;

use rusqlite::Connection;

pub(crate) const PUBLIC_REGISTRATION: &str = "public_registration";
pub(crate) const PUBLIC_RELAY_IDENTITY: &str = "public_relay_identity";
pub(crate) const RELAY_CONTENT_IDENTITY: &str = "relay_content_identity";
/// Each of these kinds has one entry per database.
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

pub(crate) fn delete_in(conn: &Connection, kind: &str) -> Result<bool, String> {
    crate::state::delete_credential(conn, kind, ONLY)
        .map(|removed| removed > 0)
        .map_err(|error| format!("delete {kind}: {error}"))
}

pub(crate) fn read(db: &Path, kind: &str) -> Result<Option<StoredCredential>, String> {
    transact(db, |conn| read_in(conn, kind))
}

pub(crate) fn write(db: &Path, kind: &str, secret: &str, info: Option<&str>) -> Result<(), String> {
    transact(db, |conn| write_in(conn, kind, secret, info))
}

pub(crate) fn paired_device_count_in(conn: &Connection) -> Result<i64, String> {
    crate::state::count_credentials(conn, crate::state::DEVICE_PAYLOAD_SECRET)
        .map_err(|error| format!("count paired devices: {error}"))
}

pub(crate) fn read_pending_release(db: &Path) -> Result<Option<String>, String> {
    transact(db, |conn| {
        crate::state::read_meta(conn, PENDING_RELEASE_META)
            .map_err(|error| format!("read pending release: {error}"))
    })
}

pub(crate) fn write_pending_release(db: &Path, marker: &str) -> Result<(), String> {
    transact(db, |conn| {
        crate::state::write_meta(conn, PENDING_RELEASE_META, marker)
            .map_err(|error| format!("write pending release: {error}"))
    })
}

pub(crate) fn clear_pending_release(db: &Path) -> Result<(), String> {
    transact(db, |conn| {
        conn.execute("DELETE FROM meta WHERE key = ?1", [PENDING_RELEASE_META])
            .map(|_| ())
            .map_err(|error| format!("clear pending release: {error}"))
    })
}
