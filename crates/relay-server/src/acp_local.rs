//! Local session storage for ACP providers, which is the only place a delete
//! can happen.
//!
//! ACP has no delete. `cursor-agent 2026.08.04` advertises
//! `sessionCapabilities: { list: {} }` and answers `-32601 Method not found` to
//! `session/delete`, `session/remove`, `session/archive` and `session/destroy`.
//! So the bridge does what [`crate::codex_local`] does for Codex: it deletes the
//! store the agent reads back, and `session/list` stops returning the session
//! because it is genuinely gone rather than because the relay is hiding it.
//!
//! That distinction is the whole point. A relay-side tombstone would leave the
//! session resumable from `cursor-agent` itself and would resurrect the row the
//! moment the tombstone was lost — which is what "delete" quietly meant before.
//!
//! Storage is per-vendor, not per-protocol, so this is keyed by provider rather
//! than being offered to every ACP agent. An ACP provider with no entry here
//! reports delete as unsupported instead of guessing at a directory layout and
//! removing something it does not understand.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use crate::codex_local::LocalThreadDeleteSummary;

/// Cursor's config directory, resolved the way `cursor-agent` resolves it:
/// `CURSOR_CONFIG_DIR`, else `XDG_CONFIG_HOME/cursor`, else `~/.cursor`.
///
/// Mirroring the order matters in both directions. Getting it wrong high (a
/// missed `CURSOR_CONFIG_DIR`) means deleting out of the user's real store while
/// they are pointed at another one; getting it wrong low means reporting success
/// for a directory the agent never reads.
fn cursor_config_dir_within(
    config_dir: Option<OsString>,
    xdg_config_home: Option<OsString>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    // `.trim()`-equivalent: cursor treats a blank value as unset, and a shell
    // script clearing a var with `CURSOR_CONFIG_DIR=` is the common way to get
    // one.
    if let Some(value) = config_dir.filter(|value| !is_blank(value)) {
        return Some(PathBuf::from(value));
    }
    if let Some(value) = xdg_config_home.filter(|value| !is_blank(value)) {
        return Some(PathBuf::from(value).join("cursor"));
    }
    home.map(|home| home.join(".cursor"))
}

fn is_blank(value: &OsString) -> bool {
    value.to_string_lossy().trim().is_empty()
}

fn cursor_sessions_dir() -> Result<PathBuf, String> {
    cursor_config_dir_within(
        std::env::var_os("CURSOR_CONFIG_DIR"),
        std::env::var_os("XDG_CONFIG_HOME"),
        crate::state_paths::home_dir().as_deref(),
    )
    .map(|config| config.join("acp-sessions"))
    .ok_or_else(|| "could not resolve the local Cursor config directory".to_string())
}

/// Where `provider_key`'s ACP sessions live, or `None` for a provider whose
/// on-disk layout this module does not know.
fn sessions_dir_for(provider_key: &str) -> Result<Option<PathBuf>, String> {
    match provider_key {
        "cursor" => cursor_sessions_dir().map(Some),
        _ => Ok(None),
    }
}

/// Reject anything that is not a single, plain directory name.
///
/// The thread id arrives from the client and is about to be joined onto a path
/// and recursively removed, so this is the guard standing between a request body
/// and `remove_dir_all`. It is deliberately an ALLOWLIST — ASCII alphanumerics,
/// `-` and `_` — rather than a list of the sequences known to be dangerous.
///
/// A denylist got this wrong once already. `..` and the separators were refused,
/// and "exactly one path component" looked like it closed the rest, but on
/// Windows `"C:"` is a single component (a `Prefix`) containing no separator —
/// and `PathBuf::push` documents that a path with a prefix and no root *replaces
/// self entirely*. `<store>/acp-sessions`.join("C:") is therefore `C:`, and the
/// recursive delete would run against that drive's working directory instead of
/// inside Cursor storage.
///
/// The allowlist closes that whole class rather than that one instance: a colon
/// can never reach a `join`, so the escape cannot come back if the component
/// rule is ever relaxed. It is also the reason this is testable on a Unix CI
/// box, where `"C:"` is an ordinary (and legal) filename — a structural check
/// alone would silently pass everywhere the bug does not reproduce.
///
/// The component check below stays as a second line, in case the allowlist is
/// ever widened. Real Cursor ids are UUIDs, so nothing legitimate is refused;
/// an id shape Cursor might adopt later fails loudly here rather than deleting
/// the wrong thing.
fn session_dir_name(thread_id: &str) -> Result<&str, String> {
    let plain_token = !thread_id.is_empty()
        && thread_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');

    // Belt and braces: one component, and that component a normal name — not a
    // Windows `Prefix`, a root, `.` or `..`.
    let single_plain_component = {
        let mut components = Path::new(thread_id).components();
        matches!(
            (components.next(), components.next()),
            (Some(std::path::Component::Normal(name)), None) if name == thread_id
        )
    };

    if !plain_token || !single_plain_component {
        return Err(format!("{thread_id:?} is not a valid ACP session id"));
    }
    Ok(thread_id)
}

/// Permanently delete `thread_id` from `provider_key`'s local ACP store.
///
/// Errors when the provider has no known local store, and when the session is
/// not there — an already-deleted session must not report a second success, or
/// a double click reads as having removed something it did not.
pub fn delete_thread_permanently(
    provider_key: &str,
    display_name: &str,
    thread_id: &str,
) -> Result<LocalThreadDeleteSummary, String> {
    let Some(sessions_dir) = sessions_dir_for(provider_key)? else {
        return Err(format!(
            "{display_name} does not support deleting sessions over ACP"
        ));
    };
    delete_session_dir(&sessions_dir, thread_id)
}

pub fn delete_thread_permanently_if_present(
    provider_key: &str,
    display_name: &str,
    thread_id: &str,
) -> Result<Option<LocalThreadDeleteSummary>, String> {
    let Some(sessions_dir) = sessions_dir_for(provider_key)? else {
        return Err(format!(
            "{display_name} does not support deleting sessions over ACP"
        ));
    };
    delete_session_dir_if_present(&sessions_dir, thread_id)
}

/// Pure core, with the store root passed in so it is testable against a temp
/// directory rather than the developer's real Cursor sessions.
fn delete_session_dir(
    sessions_dir: &Path,
    thread_id: &str,
) -> Result<LocalThreadDeleteSummary, String> {
    delete_session_dir_if_present(sessions_dir, thread_id)?
        .ok_or_else(|| format!("session {thread_id} was not found in local Cursor storage"))
}

fn delete_session_dir_if_present(
    sessions_dir: &Path,
    thread_id: &str,
) -> Result<Option<LocalThreadDeleteSummary>, String> {
    let session_dir = sessions_dir.join(session_dir_name(thread_id)?);
    if !session_dir.is_dir() {
        return Ok(None);
    }

    fs::remove_dir_all(&session_dir).map_err(|error| {
        format!(
            "failed to remove session directory {}: {error}",
            session_dir.display()
        )
    })?;

    Ok(Some(LocalThreadDeleteSummary {
        deleted_paths: vec![session_dir],
        // The "row" for an ACP session IS its directory: `session/list` reads
        // the directories, there is no separate index to prune.
        deleted_thread_row: true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sessions_root() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("acp-sessions");
        fs::create_dir_all(&root).expect("sessions dir");
        (temp, root)
    }

    fn seed_session(root: &Path, id: &str) -> PathBuf {
        let dir = root.join(id);
        fs::create_dir_all(&dir).expect("session dir");
        fs::write(dir.join("meta.json"), r#"{"schemaVersion":1,"cwd":"/tmp"}"#).expect("meta");
        fs::write(dir.join("store.db"), b"sqlite").expect("store");
        dir
    }

    #[test]
    fn deleting_a_session_removes_its_whole_directory() {
        let (_temp, root) = sessions_root();
        let doomed = seed_session(&root, "11111111-1111-4111-8111-111111111111");
        let keeper = seed_session(&root, "22222222-2222-4222-8222-222222222222");

        let summary = delete_session_dir(&root, "11111111-1111-4111-8111-111111111111")
            .expect("delete should succeed");

        assert!(!doomed.exists(), "the session directory should be gone");
        assert!(keeper.exists(), "an unrelated session must be left alone");
        assert_eq!(summary.deleted_paths, vec![doomed]);
        assert!(summary.deleted_thread_row);
    }

    #[test]
    fn deleting_a_missing_session_is_an_error_not_a_silent_success() {
        let (_temp, root) = sessions_root();

        let error = delete_session_dir(&root, "33333333-3333-4333-8333-333333333333")
            .expect_err("a missing session must not report success");

        assert!(
            error.contains("was not found"),
            "the message should say it was not there, got: {error}"
        );
        assert!(
            delete_session_dir_if_present(&root, "33333333-3333-4333-8333-333333333333")
                .expect("idempotent task delete")
                .is_none(),
            "the task-only delete contract must distinguish an already-absent seat"
        );
    }

    /// The id is client-supplied and ends up in `remove_dir_all`, so a traversal
    /// attempt has to be refused before the join, not after.
    #[test]
    fn a_traversing_session_id_is_refused_before_anything_is_removed() {
        let (temp, root) = sessions_root();
        let outside = temp.path().join("precious");
        fs::create_dir_all(&outside).expect("outside dir");
        fs::write(outside.join("keep.txt"), b"keep").expect("file");

        for id in ["..", "../precious", "..\\precious", "", ".", "a/b"] {
            let error = delete_session_dir(&root, id)
                .expect_err(&format!("{id:?} should be refused as a session id"));
            assert!(
                error.contains("not a valid ACP session id"),
                "{id:?} should be refused as malformed, got: {error}"
            );
        }

        // NOTE: keep this list in sync with the Windows-prefix test below, which
        // covers the ids that are only dangerous on the platform CI does not run.
        assert!(
            outside.join("keep.txt").exists(),
            "nothing outside was touched"
        );
    }

    /// The escape a "no separators, exactly one component" rule does NOT close.
    ///
    /// On Windows `"C:"` is one component and contains no separator, and
    /// `PathBuf::push` replaces the whole path when the pushed path carries a
    /// prefix — so the join lands on `C:` and the recursive delete runs against
    /// that drive's working directory, outside Cursor storage entirely.
    ///
    /// This test is the reason the guard is a character allowlist rather than a
    /// structural check: on Unix, where this runs, `"C:"` is a perfectly ordinary
    /// filename and every structural rule accepts it. Only refusing the colon
    /// outright fails here as well as there.
    #[test]
    fn a_windows_drive_prefix_is_refused_on_every_platform() {
        let (temp, root) = sessions_root();
        let outside = temp.path().join("precious");
        fs::create_dir_all(&outside).expect("outside dir");
        fs::write(outside.join("keep.txt"), b"keep").expect("file");

        for id in [
            "C:",              // the escape itself: prefix, no root, no separator
            "c:",              // case is not what makes it a prefix
            "C:precious",      // drive-relative
            r"C:\precious",    // drive-absolute
            r"\\?\C:",         // verbatim prefix
            r"\\server\share", // UNC
            "COM1:",           // device name with a colon
            "session:1",       // a colon anywhere at all
        ] {
            let error = delete_session_dir(&root, id)
                .expect_err(&format!("{id:?} must never reach a path join"));
            assert!(
                error.contains("not a valid ACP session id"),
                "{id:?} should be refused as malformed, got: {error}"
            );
        }

        assert!(
            outside.join("keep.txt").exists(),
            "nothing outside the sessions directory was touched"
        );
    }

    /// The ids that must still work, so the guard above cannot be "fixed" by
    /// refusing everything.
    #[test]
    fn a_real_session_id_still_passes_the_guard() {
        for id in [
            "84ba0da5-8de7-4fd1-91e4-a4106b93f3ee", // a real Cursor session id
            "e2e0de1e-7e00-4000-8000-00000000de1e",
            "plain_token_123",
        ] {
            assert_eq!(
                session_dir_name(id).expect("a plain token is a valid session id"),
                id
            );
        }
    }

    #[test]
    fn an_acp_provider_without_a_known_store_reports_unsupported() {
        let error = delete_thread_permanently("some-other-acp-agent", "Some Agent", "abc")
            .expect_err("an unknown ACP provider has no local store");

        assert!(
            error.contains("Some Agent") && error.contains("does not support deleting"),
            "the message should name the provider, got: {error}"
        );
    }

    /// Cursor's own order, which this has to match exactly — reading the wrong
    /// directory means deleting out of a store the user is not pointed at.
    #[test]
    fn the_config_dir_follows_cursors_own_resolution_order() {
        let home = PathBuf::from("/home/u");

        assert_eq!(
            cursor_config_dir_within(Some("/explicit".into()), Some("/xdg".into()), Some(&home)),
            Some(PathBuf::from("/explicit")),
            "CURSOR_CONFIG_DIR wins"
        );
        assert_eq!(
            cursor_config_dir_within(None, Some("/xdg".into()), Some(&home)),
            Some(PathBuf::from("/xdg/cursor")),
            "XDG_CONFIG_HOME is next, with a `cursor` segment"
        );
        assert_eq!(
            cursor_config_dir_within(None, None, Some(&home)),
            Some(PathBuf::from("/home/u/.cursor")),
            "the home-anchored default is last"
        );
        // A shell clearing a var with `CURSOR_CONFIG_DIR=` must fall through
        // rather than resolve to the empty path.
        assert_eq!(
            cursor_config_dir_within(Some("  ".into()), None, Some(&home)),
            Some(PathBuf::from("/home/u/.cursor")),
            "a blank override is treated as unset"
        );
        assert_eq!(
            cursor_config_dir_within(None, None, None),
            None,
            "with no home there is nothing to guess"
        );
    }
}
