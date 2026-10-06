//! Where the relay keeps its state: one database per relay, shared by every launch
//! directory.
//!
//! Everything durable the relay owns (sessions, projects, paired phones, tasks, the
//! broker identity and the push key) lives in one SQLite file, by default
//! `~/.sealwire/sealwire.db`. Anchoring it to the home directory keeps `cd ~/proj-b &&
//! sealwire` from opening a blank relay; keeping the identity in the same file means it
//! cannot be split from the state that depends on it. `RELAY_STATE_DB` names another
//! database, which is how a scratch or test relay stays apart from the real one.
//!
//! Provider caches (`acp-models-*.json`, `cursor-data/`, ...) sit beside the database.

use std::{
    ffi::OsString,
    io,
    path::{Path, PathBuf},
};

/// Directory name for the shared (home-anchored) state directory.
pub(crate) const STATE_DIR_NAME: &str = ".sealwire";
pub(crate) const STATE_DB_FILE_NAME: &str = "sealwire.db";

/// What older builds named the state directory, and the files they kept there. Read
/// only by `migrate-storage` and by the startup check that refuses to start without it.
// TODO(2026-12): remove with `migrate-storage`.
pub(crate) const LEGACY_STATE_DIR_NAME: &str = ".agent-relay";
pub(crate) const SESSION_FILE_NAME: &str = "session.json";
pub(crate) const PUBLIC_BROKER_REGISTRATION_FILE: &str = "public-broker-registration.json";
pub(crate) const PUBLIC_BROKER_IDENTITY_FILE: &str = "public-broker-identity.json";
pub(crate) const VAPID_KEY_FILE: &str = "vapid.key";
pub(crate) const RELAY_CONTENT_IDENTITY_FILE: &str = "relay-content-identity.json";

pub(crate) const STATE_PATH_ENV: &str = "RELAY_STATE_PATH";
pub(crate) const STATE_DB_ENV: &str = "RELAY_STATE_DB";

/// Settings that named a state file; the state is in the database now.
const RETIRED_STATE_SETTINGS: [&str; 5] = [
    STATE_PATH_ENV,
    "RELAY_BROKER_IDENTITY_PATH",
    "RELAY_BROKER_REGISTRATION_PATH",
    "RELAY_CONTENT_IDENTITY_PATH",
    "RELAY_VAPID_KEY_PATH",
];

pub(crate) fn refuse_retired_state_settings() -> Result<(), String> {
    for name in RETIRED_STATE_SETTINGS {
        if override_path(std::env::var_os(name)).is_some() {
            return Err(format!(
                "{name} is no longer used: relay state is kept in a database set by \
                 {STATE_DB_ENV}. Import the old files once with `sealwire migrate-storage`, \
                 then remove {name}."
            ));
        }
    }
    Ok(())
}

pub(crate) fn ensure_state_directory(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        return crate::windows_state_permissions::ensure_directory(
            path,
            path.file_name().is_some_and(|name| name == STATE_DIR_NAME),
        );
    }
    #[cfg(not(windows))]
    {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(path)?;
        #[cfg(unix)]
        if path.file_name().is_some_and(|name| name == STATE_DIR_NAME) {
            use std::os::unix::fs::PermissionsExt;
            // Explicit state paths may live in a shared directory such as /tmp.
            // Only the relay's dedicated directory may have existing permissions changed.
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
}

/// `$HOME` (or `%USERPROFILE%`), when it is usable as an anchor. An unset or
/// relative value is rejected rather than silently rebuilding the per-cwd
/// behaviour under a different name.
pub(crate) fn home_dir() -> Option<PathBuf> {
    ["HOME", "USERPROFILE"].into_iter().find_map(|key| {
        std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    })
}

/// Treats an unset/blank override as absent, so `RELAY_STATE_PATH=` (a common
/// way to "clear" a var in a shell script) falls back to the default instead of
/// resolving to the current directory.
fn override_path(value: Option<OsString>) -> Option<PathBuf> {
    let value = value?;
    match value.to_str() {
        Some(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
        }
        // Not UTF-8 — can't trim, but a non-empty path is still a path.
        None => (!value.is_empty()).then(|| PathBuf::from(value)),
    }
}

/// Pure core of [`session_file_path`], with the environment passed in.
///
/// `cwd` is used for two things only: resolving a *relative* override (same as
/// any relative path a process opens), and as a last-resort anchor when there
/// is no home directory at all (containers running as a user with no `$HOME`).
fn session_file_within(
    override_value: Option<OsString>,
    home: Option<&Path>,
    cwd: &Path,
) -> PathBuf {
    match override_path(override_value) {
        Some(explicit) => cwd.join(explicit),
        None => home
            .unwrap_or(cwd)
            .join(LEGACY_STATE_DIR_NAME)
            .join(SESSION_FILE_NAME),
    }
}

/// Whether the session file is where older builds kept it by default, rather than
/// somewhere `RELAY_STATE_PATH` named.
pub(crate) fn session_file_is_default() -> bool {
    override_path(std::env::var_os(STATE_PATH_ENV)).is_none()
}

/// The directory an older build used in place of `state_dir`, when `state_dir` is a
/// `.sealwire` directory: `~/.agent-relay` beside `~/.sealwire`.
pub(crate) fn legacy_state_dir_beside(state_dir: &Path) -> Option<PathBuf> {
    (state_dir.file_name()? == STATE_DIR_NAME)
        .then(|| state_dir.with_file_name(LEGACY_STATE_DIR_NAME))
}

/// Where an older build kept `session.json`: `RELAY_STATE_PATH` if set, else
/// `~/.agent-relay/session.json`. Only the one-time import reads it.
pub(crate) fn session_file_path(cwd: &Path) -> PathBuf {
    session_file_within(std::env::var_os(STATE_PATH_ENV), home_dir().as_deref(), cwd)
}

fn state_db_within(override_value: Option<OsString>, home: Option<&Path>, cwd: &Path) -> PathBuf {
    match override_path(override_value) {
        Some(explicit) => cwd.join(explicit),
        None => home
            .unwrap_or(cwd)
            .join(STATE_DIR_NAME)
            .join(STATE_DB_FILE_NAME),
    }
}

/// The relay's database: `RELAY_STATE_DB` if set, else `~/.sealwire/sealwire.db`.
pub(crate) fn state_db_path(cwd: &Path) -> PathBuf {
    state_db_within(std::env::var_os(STATE_DB_ENV), home_dir().as_deref(), cwd)
}

/// The directory holding the database, where provider caches and the identity
/// files of older builds live.
pub(crate) fn state_dir(cwd: &Path) -> PathBuf {
    state_db_path(cwd)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| cwd.join(STATE_DIR_NAME))
}

#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};

/// Serializes the tests that read/write process-global env vars. These
/// resolvers are env-driven and `cargo test` runs tests as threads of one
/// process, so without this two tests mutating `HOME` / `RELAY_STATE_PATH`
/// race. Shared across modules because the consumers (persistence, broker,
/// push) each test the same vars from their own test module.
#[cfg(test)]
pub(crate) fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Restores the env var a test overrode, even on panic.
#[cfg(test)]
pub(crate) struct EnvVarGuard {
    key: &'static str,
    previous: Option<OsString>,
}

#[cfg(test)]
impl EnvVarGuard {
    /// Sets `key` to `value` (or removes it when `None`) until dropped.
    pub(crate) fn set(key: &'static str, value: Option<&Path>) -> Self {
        let previous = std::env::var_os(key);
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
        Self { key, previous }
    }
}

#[cfg(test)]
impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(previous) => std::env::set_var(self.key, previous),
            None => std::env::remove_var(self.key),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home_anchored(home: &Path, file: &str) -> PathBuf {
        home.join(STATE_DIR_NAME).join(file)
    }

    fn legacy_home_anchored(home: &Path, file: &str) -> PathBuf {
        home.join(LEGACY_STATE_DIR_NAME).join(file)
    }

    #[test]
    fn the_launch_directory_does_not_change_the_session_file() {
        let home = Path::new("/home/dev");
        let from_a = session_file_within(None, Some(home), Path::new("/work/a"));
        let from_b = session_file_within(None, Some(home), Path::new("/work/b"));

        assert_eq!(from_a, from_b);
        assert_eq!(from_a, legacy_home_anchored(home, SESSION_FILE_NAME));
    }

    #[test]
    fn an_absolute_override_wins() {
        assert_eq!(
            session_file_within(
                Some(OsString::from("/scratch/session.json")),
                Some(Path::new("/home/dev")),
                Path::new("/work/a"),
            ),
            Path::new("/scratch/session.json"),
        );
    }

    // Relative overrides are the documented form in the README
    // (`RELAY_STATE_PATH=.agent-relay/public-session.json`), and they have
    // always meant "relative to where I launched" — keep it that way.
    #[test]
    fn a_relative_override_still_resolves_against_the_launch_directory() {
        assert_eq!(
            session_file_within(
                Some(OsString::from(".agent-relay/scratch.json")),
                Some(Path::new("/home/dev")),
                Path::new("/work/a"),
            ),
            Path::new("/work/a/.agent-relay/scratch.json"),
        );
    }

    // `RELAY_STATE_PATH=` in a shell script means "unset", not "the current
    // directory" — resolving a blank value would put session.json at the cwd
    // root and re-fork state per directory.
    #[test]
    fn a_blank_override_is_treated_as_unset() {
        let home = Path::new("/home/dev");
        assert_eq!(
            session_file_within(
                Some(OsString::from("   ")),
                Some(home),
                Path::new("/work/a")
            ),
            legacy_home_anchored(home, SESSION_FILE_NAME),
        );
    }

    // No `$HOME` at all (some containers): fall back to the launch directory
    // rather than writing to `/.agent-relay` or failing to start.
    #[test]
    fn without_a_home_directory_it_falls_back_to_the_launch_directory() {
        assert_eq!(
            session_file_within(None, None, Path::new("/work/a")),
            Path::new("/work/a/.agent-relay/session.json"),
        );
    }

    #[test]
    fn the_old_directory_is_only_looked_for_beside_a_sealwire_directory() {
        assert_eq!(
            legacy_state_dir_beside(Path::new("/home/dev/.sealwire")),
            Some(PathBuf::from("/home/dev/.agent-relay"))
        );
        assert_eq!(legacy_state_dir_beside(Path::new("/tmp/scratch")), None);
    }

    #[test]
    fn the_database_is_shared_across_launch_directories_unless_named() {
        let home = Path::new("/home/dev");
        let from_a = state_db_within(None, Some(home), Path::new("/work/a"));
        assert_eq!(
            from_a,
            state_db_within(None, Some(home), Path::new("/work/b"))
        );
        assert_eq!(from_a, home_anchored(home, STATE_DB_FILE_NAME));
        assert_eq!(
            state_db_within(
                Some(OsString::from("scratch/relay.db")),
                Some(home),
                Path::new("/work/a")
            ),
            Path::new("/work/a/scratch/relay.db"),
        );
        assert_eq!(
            state_db_within(Some(OsString::from("  ")), Some(home), Path::new("/work/a")),
            from_a,
            "a blank setting means unset"
        );
    }

    // A relative `HOME` would silently reintroduce per-cwd state.
    #[test]
    fn a_relative_home_is_rejected() {
        let _lock = env_lock();
        let _home = EnvVarGuard::set("HOME", Some(Path::new("relative/home")));
        let _profile = EnvVarGuard::set("USERPROFILE", None);

        assert!(home_dir().is_none());
    }
}
