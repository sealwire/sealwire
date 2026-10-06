//! One shared state directory per machine — not one per launch directory.
//!
//! Every durable thing the relay owns (`session.json`, the public-broker
//! registration/identity, the VAPID key) used to be resolved as
//! `<cwd>/.agent-relay/<file>`. That made the *directory you happened to run
//! from* the identity of your relay: `cd ~/proj-b && sealwire` silently opened
//! a blank world — no threads, no projects, no paired phones, and a fresh VAPID
//! key that invalidated every push subscription your phone already held.
//!
//! So the default is anchored to the user's home directory
//! (`~/.agent-relay/`), which does not move when you `cd`. Two rules keep the
//! escape hatches honest:
//!
//! 1. An explicit path always wins (`RELAY_STATE_PATH`, and the per-file
//!    `RELAY_BROKER_*_PATH` / `RELAY_VAPID_KEY_PATH` overrides) — that is how a
//!    scratch or test relay stays isolated from the real one.
//! 2. The sibling files follow whichever directory the *session file* lands in.
//!    Pointing `RELAY_STATE_PATH` at a scratch directory therefore moves the
//!    whole identity set together, instead of splitting a scratch session file
//!    away from the real relay's broker identity and push key.
//!
//! Nothing here is workspace-scoped: the relay has always been multi-workspace
//! (threads carry their own `cwd`, the sidebar groups by folder, Projects group
//! across folders). The per-cwd state file was the odd one out.

use std::{
    ffi::OsString,
    io,
    path::{Path, PathBuf},
};

use tracing::warn;

/// Directory name for the shared (home-anchored) state directory.
///
/// An absent shared session file simply starts a fresh one — there is no
/// migration path, by design.
pub(crate) const STATE_DIR_NAME: &str = ".agent-relay";
pub(crate) const SESSION_FILE_NAME: &str = "session.json";
pub(crate) const PUBLIC_BROKER_REGISTRATION_FILE: &str = "public-broker-registration.json";
pub(crate) const PUBLIC_BROKER_IDENTITY_FILE: &str = "public-broker-identity.json";
pub(crate) const VAPID_KEY_FILE: &str = "vapid.key";
pub(crate) const RELAY_CONTENT_IDENTITY_FILE: &str = "relay-content-identity.json";

pub(crate) const STATE_PATH_ENV: &str = "RELAY_STATE_PATH";

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
            .join(STATE_DIR_NAME)
            .join(SESSION_FILE_NAME),
    }
}

/// Where this process persists `session.json`: `RELAY_STATE_PATH` if set, else
/// `~/.agent-relay/session.json`.
pub(crate) fn session_file_path(cwd: &Path) -> PathBuf {
    session_file_within(std::env::var_os(STATE_PATH_ENV), home_dir().as_deref(), cwd)
}

/// The directory holding `session.json` — the anchor every sibling identity
/// file defaults into.
pub(crate) fn state_dir(cwd: &Path) -> PathBuf {
    let session_file = session_file_path(cwd);
    session_file
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| cwd.join(STATE_DIR_NAME))
}

/// A file that lives next to `session.json` unless its own env var overrides
/// it. `configured` is the already-read override value (each caller owns its
/// own env var name, passed as `env_var` so a bad one can be named in the
/// warning).
pub(crate) fn sibling_state_file(
    cwd: &Path,
    env_var: &str,
    configured: Option<OsString>,
    file_name: &str,
) -> PathBuf {
    let state_dir = state_dir(cwd);
    match override_path(configured) {
        Some(explicit) => {
            let resolved = cwd.join(&explicit);
            if let Some(warning) = split_identity_warning(env_var, &resolved, &state_dir) {
                warn!("{warning}");
            }
            resolved
        }
        None => state_dir.join(file_name),
    }
}

/// The upgrade hazard a shared state directory creates for configs written
/// against the old per-workspace default.
///
/// `RELAY_BROKER_REGISTRATION_PATH=.agent-relay/…` (the form the old
/// `.env.example` showed, and which real `.env.*.local` files still carry)
/// keeps resolving against the launch directory. If session.json has moved to
/// the home directory and that identity file has not, the set is *split*:
/// launching from another folder finds no registration, enrolls as a brand-new
/// relay, and strands every device already paired with the old one.
///
/// The test is "does it land outside the state directory", NOT "is it
/// relative". A wholly relative config (`scripts/restart-dev-cloud-pg.sh` sets
/// a relative state path *and* relative broker paths) moves as one unit and is
/// perfectly coherent — warning there would be a lie, and its advice would
/// break that script's deliberate isolation.
fn split_identity_warning(env_var: &str, resolved: &Path, state_dir: &Path) -> Option<String> {
    if resolved.parent() == Some(state_dir) {
        return None;
    }
    Some(format!(
        "{env_var} points at {}, which is outside the shared state directory {} that session.json \
         lives in — the relay's identity set is split across two places. Launching from a \
         different directory can then fail to find it, enroll as a new relay, and orphan \
         already-paired devices. Point it inside the state directory (or drop the override) \
         unless you meant to run a separate relay identity.",
        resolved.display(),
        state_dir.display(),
    ))
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

    #[test]
    fn the_launch_directory_does_not_change_the_session_file() {
        let home = Path::new("/home/dev");
        let from_a = session_file_within(None, Some(home), Path::new("/work/a"));
        let from_b = session_file_within(None, Some(home), Path::new("/work/b"));

        assert_eq!(from_a, from_b);
        assert_eq!(from_a, home_anchored(home, SESSION_FILE_NAME));
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
            home_anchored(home, SESSION_FILE_NAME),
        );
    }

    // No `$HOME` at all (some containers): fall back to the old per-cwd
    // behaviour rather than writing to `/.agent-relay` or failing to start.
    #[test]
    fn without_a_home_directory_it_falls_back_to_the_launch_directory() {
        assert_eq!(
            session_file_within(None, None, Path::new("/work/a")),
            Path::new("/work/a/.agent-relay/session.json"),
        );
    }

    // The upgrade hazard: a config written for the old per-workspace default
    // (the form the old .env.example showed) keeps working, but only in the
    // directory it was written for — session.json moved to the home directory
    // and this file did not. Honour it, never silently.
    #[test]
    fn an_identity_override_that_splits_the_set_is_warned_about() {
        let warning = split_identity_warning(
            "RELAY_BROKER_REGISTRATION_PATH",
            Path::new("/work/a/.agent-relay/public-broker-registration.json"),
            Path::new("/home/dev/.agent-relay"),
        )
        .expect("an override outside the state dir must warn");

        assert!(
            warning.contains("RELAY_BROKER_REGISTRATION_PATH"),
            "{warning}"
        );
        assert!(
            warning.contains("/work/a/.agent-relay/public-broker-registration.json"),
            "the warning must show where it actually landed: {warning}"
        );
        assert!(
            warning.contains("orphan already-paired devices"),
            "the warning must state the consequence, not just the fact: {warning}"
        );
    }

    // `scripts/restart-dev-cloud-pg.sh` sets a RELATIVE state path AND relative
    // broker paths, so every file moves together with the launch directory: the
    // set is NOT split. Warning here would fire twice on every dev start, and
    // its advice ("drop the override") would break the very isolation that
    // script exists to create.
    #[test]
    fn a_self_consistent_relative_config_is_not_warned_about() {
        let state_dir = Path::new("/work/a/.agent-relay");
        assert!(split_identity_warning(
            "RELAY_BROKER_REGISTRATION_PATH",
            Path::new("/work/a/.agent-relay/public-pg-broker-registration.json"),
            state_dir,
        )
        .is_none());
        assert!(split_identity_warning(
            "RELAY_BROKER_IDENTITY_PATH",
            Path::new("/work/a/.agent-relay/public-pg-broker-identity.json"),
            state_dir,
        )
        .is_none());
    }

    // The default path is built by joining, never by an override — it must not
    // trip the warning.
    #[test]
    fn the_default_sibling_path_is_silent_and_anchored_to_the_state_dir() {
        let _lock = env_lock();
        let home = tempfile::tempdir().unwrap();
        let _home = EnvVarGuard::set("HOME", Some(home.path()));
        let _state = EnvVarGuard::set(STATE_PATH_ENV, None);

        assert_eq!(
            sibling_state_file(
                Path::new("/work/a"),
                "RELAY_BROKER_IDENTITY_PATH",
                None,
                PUBLIC_BROKER_IDENTITY_FILE
            ),
            home.path()
                .join(STATE_DIR_NAME)
                .join(PUBLIC_BROKER_IDENTITY_FILE),
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
