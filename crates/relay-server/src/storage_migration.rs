//! `relay-server migrate-storage`: the one-time move of an older build's `session.json`
//! and identity files into the relay's database. It runs before the new relay starts;
//! the relay itself never reads the old files.
//!
//! The first run moves `~/.agent-relay` to `~/.sealwire`, then copies the old files into
//! the database and leaves them in place. `--finish`, run once the new relay has been
//! checked, removes them, refusing if any changed since the copy.
// TODO(2026-12): remove this module, its subcommand and the legacy readers it calls.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const META_IMPORT_SOURCES: &str = "import_sources";
const META_IMPORT_BACKUP: &str = "import_backup";
const META_IMPORTED_AT: &str = "imported_at";
const META_LEGACY_REMOVED_AT: &str = "legacy_removed_at";

pub(crate) struct MigrationPaths {
    pub(crate) session: PathBuf,
    pub(crate) broker: crate::broker::LegacyBrokerFiles,
    pub(crate) vapid: PathBuf,
    pub(crate) db: PathBuf,
    /// The older build's state directory, moved whole to the database's directory first,
    /// so provider data and caches kept beside the state move with it.
    pub(crate) move_from: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Source {
    path: PathBuf,
    sha256: String,
}

impl MigrationPaths {
    /// Where an older build kept each file (its environment overrides, else beside
    /// `session.json`), and the database it goes into. With neither `RELAY_STATE_PATH`
    /// nor `RELAY_STATE_DB` set, that is `~/.agent-relay` moving to `~/.sealwire`.
    pub(crate) fn from_env() -> Result<Self, String> {
        let cwd = std::env::current_dir()
            .and_then(|cwd| cwd.canonicalize())
            .map_err(|error| format!("failed to resolve current directory: {error}"))?;
        let overridden = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| cwd.join(value))
        };
        let explicit_db = overridden(crate::state_paths::STATE_DB_ENV);
        let legacy_session = crate::state_paths::session_file_path(&cwd);
        let moving = crate::state_paths::session_file_is_default() && explicit_db.is_none();
        let (dir, move_from) = if moving {
            let new_dir = crate::state_paths::state_dir(&cwd);
            let old_dir = legacy_session
                .parent()
                .map(Path::to_path_buf)
                .filter(|old_dir| old_dir.exists() && *old_dir != new_dir);
            (new_dir, old_dir)
        } else {
            let dir = legacy_session
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| format!("{} has no parent directory", legacy_session.display()))?;
            (dir, None)
        };
        let beside = |env: &str, file: &str| overridden(env).unwrap_or_else(|| dir.join(file));
        let session = dir.join(
            legacy_session
                .file_name()
                .ok_or_else(|| format!("{} has no file name", legacy_session.display()))?,
        );
        Ok(Self {
            broker: crate::broker::LegacyBrokerFiles {
                registration: beside(
                    "RELAY_BROKER_REGISTRATION_PATH",
                    crate::state_paths::PUBLIC_BROKER_REGISTRATION_FILE,
                ),
                identity: beside(
                    "RELAY_BROKER_IDENTITY_PATH",
                    crate::state_paths::PUBLIC_BROKER_IDENTITY_FILE,
                ),
                content_identity: beside(
                    "RELAY_CONTENT_IDENTITY_PATH",
                    crate::state_paths::RELAY_CONTENT_IDENTITY_FILE,
                ),
            },
            vapid: beside("RELAY_VAPID_KEY_PATH", crate::state_paths::VAPID_KEY_FILE),
            db: explicit_db.unwrap_or_else(|| dir.join(crate::state_paths::STATE_DB_FILE_NAME)),
            session,
            move_from,
        })
    }

    /// The same files after `from` was moved to `to`.
    fn relocated(&self, from: &Path, to: &Path) -> MigrationPaths {
        let moved = |path: &Path| {
            path.strip_prefix(from)
                .map(|rest| to.join(rest))
                .unwrap_or_else(|_| path.to_path_buf())
        };
        MigrationPaths {
            session: moved(&self.session),
            broker: crate::broker::LegacyBrokerFiles {
                registration: moved(&self.broker.registration),
                identity: moved(&self.broker.identity),
                content_identity: moved(&self.broker.content_identity),
            },
            vapid: moved(&self.vapid),
            db: moved(&self.db),
            move_from: None,
        }
    }

    fn sources(&self) -> [&Path; 5] {
        [
            &self.session,
            &self.broker.registration,
            &self.broker.identity,
            &self.broker.content_identity,
            &self.vapid,
        ]
    }
}

pub(crate) fn run() -> i32 {
    let finish = std::env::args()
        .skip(2)
        .any(|argument| argument == "--finish");
    let result = MigrationPaths::from_env().and_then(|paths| {
        if finish {
            finish_import(&paths)
        } else {
            import(&paths)
        }
    });
    match result {
        Ok(report) => {
            println!("{report}");
            0
        }
        Err(error) => {
            eprintln!("relay-server migrate-storage: {error}");
            1
        }
    }
}

fn hold_instance_lock(
    path: &Path,
    who: &str,
) -> Result<crate::instance_lock::InstanceLockGuard, String> {
    match crate::instance_lock::acquire(path) {
        Ok(crate::instance_lock::LockOutcome::Acquired(guard)) => Ok(guard),
        Ok(crate::instance_lock::LockOutcome::AlreadyRunning(_)) => Err(format!(
            "{who} is running on {}; stop it first",
            path.display()
        )),
        Err(error) => Err(format!("failed to lock {}: {error}", path.display())),
    }
}

fn sha256_of(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(hex(&Sha256::digest(bytes)))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to read {}: {error}", path.display())),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn side_file(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", path.display()))
}

/// Remove a database file and the WAL files SQLite keeps beside it.
fn remove_database_files(path: &Path) {
    for file in [
        path.to_path_buf(),
        side_file(path, "-wal"),
        side_file(path, "-shm"),
    ] {
        let _ = std::fs::remove_file(file);
    }
}

/// Row counts of every table, to prove the import kept the history only the database had.
fn table_counts(conn: &Connection) -> Result<Vec<(String, i64)>, String> {
    let names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
        })
        .map_err(|error| format!("list tables: {error}"))?;
    names
        .into_iter()
        .map(|name| {
            conn.query_row(&format!("SELECT COUNT(*) FROM \"{name}\""), [], |row| {
                row.get(0)
            })
            .map(|count| (name, count))
            .map_err(|error| format!("count rows: {error}"))
        })
        .collect()
}

fn import(paths: &MigrationPaths) -> Result<String, String> {
    let mut moved = Vec::new();
    // Taken before the move, on the files an older relay and the `cloud` commands lock;
    // the locks move with the directory, so nothing can start in between.
    let mut relocated = None;
    let (_old_relay, _lifecycle) = if let Some(old_dir) = &paths.move_from {
        let new_dir = paths
            .db
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", paths.db.display()))?;
        let old_session = old_dir.join(crate::state_paths::SESSION_FILE_NAME);
        if !old_session.exists() {
            return Err(format!(
                "there is no relay state at {}. Set RELAY_STATE_PATH to the session file to import.",
                old_session.display()
            ));
        }
        let old_relay = hold_instance_lock(&old_session, "an older relay")?;
        let lifecycle = crate::broker::hold_lifecycle_lock(&old_session)?;
        clear_lock_only_directory(new_dir, &paths.db)?;
        std::fs::rename(old_dir, new_dir).map_err(|error| {
            format!(
                "failed to move {} to {}: {error}",
                old_dir.display(),
                new_dir.display()
            )
        })?;
        moved.push(format!(
            "Moved {} to {}.",
            old_dir.display(),
            new_dir.display()
        ));
        // Paths named into the old directory, including explicit ones, now live in the new.
        relocated = Some(paths.relocated(old_dir, new_dir));
        // A database still under its first name is renamed now that it sits beside its state.
        if crate::usage::store::database_path(&paths.session) != paths.db {
            return Err(format!(
                "could not rename the old token-usage.db in {} to sealwire.db",
                new_dir.display()
            ));
        }
        (old_relay, lifecycle)
    } else {
        if !paths.session.exists() {
            return Err(format!(
                "there is no relay state at {}. Set RELAY_STATE_PATH to the session file to import.",
                paths.session.display()
            ));
        }
        (
            hold_instance_lock(&paths.session, "an older relay")?,
            crate::broker::hold_lifecycle_lock(&paths.db)?,
        )
    };
    let result = import_in_place(relocated.as_ref().unwrap_or(paths), _lifecycle);
    match (result, paths.move_from.as_ref()) {
        (Ok(report), _) => Ok([moved, vec![report]].concat().join("\n")),
        (Err(error), Some(old_dir)) => Err(format!(
            "{error} The old files are now in {}; move that directory back to {} to use the \
             older version again.",
            paths
                .db
                .parent()
                .map(Path::display)
                .map(|dir| dir.to_string())
                .unwrap_or_default(),
            old_dir.display()
        )),
        (Err(error), None) => Err(error),
    }
}

/// Make way for the move: a new directory holding nothing but lock files (a refused or
/// crashed start) is removed; one holding anything else stops the move.
fn clear_lock_only_directory(new_dir: &Path, db: &Path) -> Result<(), String> {
    let entries = match std::fs::read_dir(new_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to read {}: {error}", new_dir.display())),
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    let others: Vec<&String> = names
        .iter()
        .filter(|name| !name.ends_with(".lock") && !name.ends_with(".owner.json"))
        .collect();
    if !others.is_empty() {
        return Err(format!(
            "{} already exists and holds {}. Move those aside and run this again.",
            new_dir.display(),
            others
                .iter()
                .map(|name| name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    // Proves no relay holds those locks before they are removed; taking it adds its own.
    drop(hold_instance_lock(db, "a relay")?);
    for entry in std::fs::read_dir(new_dir)
        .map_err(|error| format!("failed to read {}: {error}", new_dir.display()))?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".lock") || name.ends_with(".owner.json") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    std::fs::remove_dir(new_dir)
        .map_err(|error| format!("failed to remove {}: {error}", new_dir.display()))
}

/// Compared by real path: a second lock on the same file through another spelling would
/// wait on the lock this process already holds.
fn same_directory(a: &Path, b: &Path) -> bool {
    let dir = |path: &Path| {
        path.parent()
            .map(|dir| dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf()))
    };
    dir(a) == dir(b)
}

/// Import the state in the database's own directory; the caller holds the locks.
fn import_in_place(
    paths: &MigrationPaths,
    _lifecycle: crate::broker::LifecycleGuard,
) -> Result<String, String> {
    let _relay = hold_instance_lock(&paths.db, "a relay")?;
    let _other_lifecycle = if !same_directory(&paths.broker.registration, &paths.db) {
        Some(crate::broker::hold_lifecycle_lock(
            &paths.broker.registration,
        )?)
    } else {
        None
    };

    match crate::state::peek_core_origin(&paths.db)?.as_deref() {
        Some("imported") => {
            return Ok(format!(
                "{} already holds the imported relay state. Once the relay has been checked, \
                 run `sealwire migrate-storage --finish` to remove the old files.",
                paths.db.display()
            ))
        }
        Some(other) => {
            return Err(format!(
                "{} already holds relay state ({other}); refusing to import over it",
                paths.db.display()
            ))
        }
        None => {}
    }

    let mut sources = Vec::new();
    for path in paths.sources() {
        if let Some(sha256) = sha256_of(path)? {
            sources.push(Source {
                path: path.to_path_buf(),
                sha256,
            });
        }
    }
    let json = std::fs::read(&paths.session)
        .map_err(|error| format!("failed to read {}: {error}", paths.session.display()))?;

    let stamp = crate::state::unix_now();
    let name = paths
        .db
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} has no file name", paths.db.display()))?;
    let working = paths.db.with_file_name(format!("{name}.importing-{stamp}"));
    let backup = paths
        .db
        .with_file_name(format!("{name}.pre-import-{stamp}"));
    // The history to start from: the named database, else the one the older relay kept
    // beside its session file (under either of its names).
    let source = if paths.db.exists() {
        paths.db.clone()
    } else {
        crate::usage::store::database_path(&paths.session)
    };
    let had_database = paths.db.exists();
    let copied_from_elsewhere = !had_database && source.exists();

    // The import is built in a copy, so a failure anywhere leaves the database as it was.
    let history = if copied_from_elsewhere {
        // Read-only: the older relay's database is copied, not changed.
        let original = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("open {}: {error}", source.display()))?;
        let history = table_counts(&original)?;
        original
            .execute("VACUUM INTO ?1", [working.display().to_string()])
            .map_err(|error| format!("copy {}: {error}", source.display()))?;
        history
    } else if had_database {
        let original = Connection::open(&paths.db)
            .map_err(|error| format!("open {}: {error}", paths.db.display()))?;
        let busy: i64 = original
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .map_err(|error| format!("checkpoint {}: {error}", paths.db.display()))?;
        if busy != 0 {
            return Err(format!("{} is still in use", paths.db.display()));
        }
        let history = table_counts(&original)?;
        original
            .execute("VACUUM INTO ?1", [working.display().to_string()])
            .map_err(|error| format!("copy {}: {error}", paths.db.display()))?;
        history
    } else {
        Vec::new()
    };

    let built = build_import(
        paths,
        &working,
        &json,
        &sources,
        &history,
        had_database.then_some(&backup),
    );
    let mut report = match built {
        Ok(report) => report,
        Err(error) => {
            remove_database_files(&working);
            return Err(format!("{error}. Nothing was changed."));
        }
    };

    if had_database {
        for suffix in ["-wal", "-shm"] {
            let side = side_file(&paths.db, suffix);
            if std::fs::metadata(&side).is_ok_and(|meta| meta.len() > 0) && suffix == "-wal" {
                remove_database_files(&working);
                return Err(format!(
                    "{} still has unsaved changes; nothing was changed",
                    side.display()
                ));
            }
            let _ = std::fs::remove_file(side);
        }
        std::fs::rename(&paths.db, &backup)
            .map_err(|error| format!("move {} aside: {error}", paths.db.display()))?;
        restrict(&backup);
    }
    std::fs::rename(&working, &paths.db).map_err(|error| {
        format!(
            "the import is complete in {} but could not be moved to {}: {error}",
            working.display(),
            paths.db.display()
        )
    })?;

    if copied_from_elsewhere {
        report.push(format!(
            "  history copied from {}, which is left as it was",
            source.display()
        ));
    }
    let mut lines = vec![format!("Imported into {}:", paths.db.display())];
    lines.extend(report);
    lines.push(String::new());
    lines.push("The old files were left where they are:".to_string());
    lines.extend(
        sources
            .iter()
            .map(|source| format!("  {}", source.path.display())),
    );
    if had_database {
        lines.push(format!(
            "The database before the import is kept at {}.",
            backup.display()
        ));
    }
    lines.push(
        "Start the relay and check it. Then run `sealwire migrate-storage --finish` \
         (`relay-server migrate-storage --finish` in a source checkout) to remove the old \
         files and that copy."
            .to_string(),
    );
    Ok(lines.join("\n"))
}

fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    {
        let _ = crate::windows_state_permissions::restrict_existing(path, false);
    }
}

fn build_import(
    paths: &MigrationPaths,
    working: &Path,
    json: &[u8],
    sources: &[Source],
    history: &[(String, i64)],
    backup: Option<&PathBuf>,
) -> Result<Vec<String>, String> {
    let store = crate::usage::store::UsageStore::open_at(working)?;
    let mut report = store.with_connection(|conn| {
        let tx = conn
            .transaction()
            .map_err(|error| format!("begin import: {error}"))?;
        let core = crate::state::import_legacy_session(&tx, json)
            .map_err(|error| format!("{}: {error}", paths.session.display()))?;
        let mut report = vec![format!(
            "  relay state: {} paired device(s), transcript revisions resume after {}; {}",
            core.paired_devices,
            core.transcript_clock,
            core.rows_per_table
                .iter()
                .map(|(table, count)| format!("{table} {count}"))
                .collect::<Vec<_>>()
                .join(", ")
        )];
        report.extend(
            crate::broker::import_legacy_broker_files(&tx, &paths.broker)?
                .into_iter()
                .map(|line| format!("  {line}")),
        );
        if let Some(public_key) = crate::state::import_legacy_vapid_file(&tx, &paths.vapid)? {
            report.push(format!("  push key: public key {public_key}"));
        }
        let sources_json = serde_json::to_string(sources).map_err(|error| error.to_string())?;
        let meta = |key: &str, value: &str| {
            crate::state::write_meta(&tx, key, value)
                .map_err(|error| format!("write {key}: {error}"))
        };
        meta(crate::state::META_CORE_ORIGIN, "imported")?;
        meta(META_IMPORT_SOURCES, &sources_json)?;
        meta(META_IMPORTED_AT, &crate::state::unix_now().to_string())?;
        if let Some(backup) = backup {
            meta(META_IMPORT_BACKUP, &backup.display().to_string())?;
        }
        tx.commit()
            .map_err(|error| format!("commit import: {error}"))?;
        Ok(report)
    })?;

    let kept = store.with_connection(|conn| table_counts(conn))?;
    for (table, count) in history {
        let now = kept
            .iter()
            .find(|(name, _)| name == table)
            .map(|(_, count)| *count);
        if now != Some(*count) {
            return Err(format!(
                "table {table} had {count} rows before the import and {} after",
                now.unwrap_or(0)
            ));
        }
    }
    if !history.is_empty() {
        report.push(format!(
            "  history already in the database kept: {}",
            history
                .iter()
                .filter(|(_, count)| *count > 0)
                .map(|(table, count)| format!("{table} {count}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    store.with_connection(|conn| {
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .map_err(|error| format!("checkpoint the import: {error}"))
    })?;
    drop(store);
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(side_file(working, suffix));
    }
    Ok(report)
}

fn finish_import(paths: &MigrationPaths) -> Result<String, String> {
    if crate::state::peek_core_origin(&paths.db)?.as_deref() != Some("imported") {
        return Err(format!(
            "nothing was imported into {}; run `sealwire migrate-storage` first",
            paths.db.display()
        ));
    }
    let (sources, backup, removed_at) = {
        let conn = Connection::open_with_flags(&paths.db, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("open {}: {error}", paths.db.display()))?;
        let read = |key: &str| {
            crate::state::read_meta(&conn, key).map_err(|error| format!("read {key}: {error}"))
        };
        let sources: Vec<Source> =
            serde_json::from_str(&read(META_IMPORT_SOURCES)?.unwrap_or_default())
                .map_err(|error| format!("read the list of imported files: {error}"))?;
        (
            sources,
            read(META_IMPORT_BACKUP)?,
            read(META_LEGACY_REMOVED_AT)?,
        )
    };
    if removed_at.is_some() {
        return Ok("The old files were already removed.".to_string());
    }
    let _old_relay = hold_instance_lock(&paths.session, "an older relay")?;

    let mut present = Vec::new();
    for source in &sources {
        match sha256_of(&source.path)? {
            Some(sha256) if sha256 == source.sha256 => present.push(&source.path),
            Some(_) => {
                return Err(format!(
                    "{} changed after it was imported (was an older relay started?). \
                     Nothing was removed.",
                    source.path.display()
                ))
            }
            None => {}
        }
    }
    let mut lines = vec!["Removed:".to_string()];
    for path in present {
        std::fs::remove_file(path)
            .map_err(|error| format!("failed to remove {}: {error}", path.display()))?;
        lines.push(format!("  {}", path.display()));
    }
    if let Some(backup) = backup.map(PathBuf::from).filter(|backup| backup.exists()) {
        remove_database_files(&backup);
        lines.push(format!("  {}", backup.display()));
    }
    let store = crate::state::open_state_database(&paths.db)?;
    store.with_connection(|conn| {
        crate::state::write_meta(
            conn,
            META_LEGACY_REMOVED_AT,
            &crate::state::unix_now().to_string(),
        )
        .map_err(|error| format!("record the removal: {error}"))
    })?;
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests;
