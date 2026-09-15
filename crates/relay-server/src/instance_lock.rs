//! Enforces "one live relay-server per `RELAY_STATE_PATH`" so a second
//! process for the same session file refuses to start rather than becoming a
//! second concurrent writer (which corrupts/forks `session.json`).
//!
//! `dev:restart:*` scripts `pkill` the previous relay-server first, so
//! they're unaffected. `npx sealwire` and the desktop app don't — starting a
//! second relay for the same workspace now fails with a clear message
//! instead of silently running a duplicate.
//!
//! ## Deliberately simple: refuse, don't attach
//!
//! An earlier iteration had the loser *attach* to the already-running
//! instance instead (compatibility comparison, a probe over `/api/health`,
//! etc.) — too much surface area for a single-user local tool. Cut back to
//! the essential guarantee: the lock stops two writers; to reuse a running
//! relay, open its URL directly. The owner-info file exists only so the
//! "already running" message can name the existing one's pid/port.
//!
//! ## The safety mechanism is an OS-level file lock
//!
//! [`acquire`] holds an **exclusive OS file lock** (`flock` on Unix,
//! `LockFileEx` on Windows, via `fs4`) on a `.lock` file derived from the
//! state path's *resolved* identity (see [`resolve_identity`]) for the life
//! of the process. Losing it (`WouldBlock`) is the authoritative "someone
//! else owns this" signal, and it can never leave a stale lock behind:
//! exiting or crashing releases it automatically.
//!
//! ## Threat model: a maliciously crafted workspace, not a live equal-privilege adversary
//!
//! What's defended: a symlink or hard link already sitting on disk — e.g.
//! committed into a cloned repo (`.gitignore` doesn't stop `git add -f`) —
//! before relay-server ever runs. `resolve_identity` validates the whole
//! path once at startup; every leaf write after that (`.lock`,
//! `.owner.json`, persistence's `.tmp`) is independently atomic against a
//! pre-planted symlink/hard-link at that exact name.
//!
//! What's *not* defended: an agent session actively racing relay-server
//! after startup — e.g. swapping `.agent-relay` for a symlink mid-session so
//! the next persistence save re-resolves the path through it and lands
//! `session.json` outside the workspace. Closing that needs every write pinned
//! to a directory handle opened once (`openat`-style, e.g. via `cap-std`)
//! rather than a path re-resolved fresh on each save.
//!
//! This is a deliberate risk-acceptance, not an oversight — but note the
//! reason is narrower than "the agent has no privilege boundary anyway". Under
//! a `workspace-write` sandbox the agent genuinely *cannot* write outside the
//! workspace itself, so relay-server (which runs unsandboxed) is a confused
//! deputy here: an in-workspace action (the symlink swap) yields an
//! out-of-workspace write the agent couldn't perform directly. What keeps it
//! out of scope regardless: the escape is a *fixed* filename with
//! relay-controlled content (not an arbitrary-path write, not RCE); the
//! default `untrusted` approval policy makes the shell commands that swap the
//! directory prompt the user, so it only opens up under autonomous /
//! no-approval operation against untrusted input; and this is a single-user
//! local tool with no cross-tenant boundary. Revisit — and reach for the
//! `openat` pinning above — if that calculus changes: agents run unattended
//! against untrusted repos by default, elevated privileges, or one process
//! serving multiple users' workspaces.

use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};

use fs4::FileExt;
use serde::{Deserialize, Serialize};

/// Owner metadata written after binding, purely so a losing process's
/// "already running" message can name where the winner is. Not a
/// credential, not load-bearing. Kept in a separate, never-locked file (not
/// `.lock` itself) because Windows's exclusive range lock would also block
/// a loser from reading it out of the locked file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct OwnerInfo {
    pub(crate) pid: u32,
    pub(crate) port: u16,
}

/// Holds the exclusive lock for as long as it's alive; drop it only when
/// the process is done serving.
pub(crate) struct InstanceLockGuard {
    #[allow(dead_code)] // held only to keep the OS lock alive until Drop
    file: File,
    owner_info_path: PathBuf,
}

impl InstanceLockGuard {
    pub(crate) fn record_owner(&self, port: u16) -> io::Result<()> {
        let info = OwnerInfo {
            pid: std::process::id(),
            port,
        };
        write_new_exclusive(&self.owner_info_path, &serde_json::to_vec(&info)?)
    }
}

pub(crate) enum LockOutcome {
    /// We hold the exclusive lock — safe to bind and serve.
    Acquired(InstanceLockGuard),
    /// Another live process already holds this state path's lock. `Some`
    /// when its `{pid, port}` could be read; either way the caller refuses.
    AlreadyRunning(Option<OwnerInfo>),
}

/// Total symlink hops a single resolution will follow before refusing —
/// bounds a cyclic or pathological chain (legitimate chains are 0 or 1 hop).
const MAX_SYMLINK_HOPS: u8 = 40;

/// Resolves `state_path` to the identity `.lock`/`.owner.json` are derived
/// from, and that `main` pins `RELAY_STATE_PATH` to before anything else
/// reads it. See [`resolve_identity_within`] for the symlink handling.
pub(crate) fn resolve_identity(state_path: &Path) -> io::Result<PathBuf> {
    let cwd = std::env::current_dir()?;
    resolve_identity_within(state_path, &cwd)
}

/// Same as [`resolve_identity`], but with an explicit workspace root instead
/// of always `current_dir()` — lets tests exercise this against a temp
/// directory without touching the real (global, test-shared) process cwd.
///
/// A plain `std::fs::canonicalize` would almost do this job, except it (a)
/// follows a symlink at any level unconditionally, with no escape boundary —
/// a workspace can commit `.agent-relay` (or `session.json`) as a symlink
/// out of the workspace, and canonicalize would happily follow it — and (b)
/// requires the whole path to already exist, which breaks a *dangling*
/// symlink (`alias.json -> not-created-yet.json`) that should still resolve
/// to a stable identity.
///
/// So: components at or below `workspace_root` get a strict rule (a symlink
/// may only point at a sibling in the same directory it's declared in —
/// escaping elsewhere is refused); everything above/outside `workspace_root`
/// (ordinary OS structure like macOS's `/var` -> `/private/var`, which no
/// cloned repo can influence) is followed trustingly.
fn resolve_identity_within(state_path: &Path, workspace_root: &Path) -> io::Result<PathBuf> {
    let absolute = workspace_root.join(state_path);
    let mut hops = 0u8;

    if !absolute.starts_with(workspace_root) {
        // Not under the declared workspace at all — most concretely, an
        // absolute `RELAY_STATE_PATH` override. A cloned repo's content
        // can't set env vars for the process, so this is user-chosen, not
        // attacker-controlled: resolve trustingly.
        return resolve_components(PathBuf::new(), absolute.components(), None, &mut hops);
    }

    let trusted_root =
        resolve_components(PathBuf::new(), workspace_root.components(), None, &mut hops)?;
    let suffix = absolute
        .strip_prefix(workspace_root)
        .expect("checked by starts_with above");
    resolve_components(
        trusted_root.clone(),
        suffix.components(),
        Some(&trusted_root),
        &mut hops,
    )
}

/// Walks `components` from `base`, resolving symlinks and normalizing
/// `.`/`..` (popped, not appended literally — needed so a chained
/// `alias/../alias/x` lands back on `alias`'s own target, and so climbing
/// above `boundary` can be refused rather than silently walked past).
///
/// `boundary`, when set, is both the point `..` may not climb above and the
/// directory every symlink at or below it must stay within (see
/// [`resolve_symlink_aware`]); `None` means resolve trustingly, no escape
/// checks — used for `boundary` itself and for anything outside it.
fn resolve_components(
    mut resolved: PathBuf,
    components: std::path::Components,
    boundary: Option<&Path>,
    hops: &mut u8,
) -> io::Result<PathBuf> {
    for component in components {
        match component {
            Component::ParentDir => {
                if let Some(boundary) = boundary {
                    if resolved == boundary {
                        return Err(io::Error::other(format!(
                            "RELAY_STATE_PATH climbs (via \"..\") above its workspace root ({}) — \
                             refusing. Point RELAY_STATE_PATH at a location within the workspace.",
                            boundary.display()
                        )));
                    }
                }
                resolved.pop();
            }
            Component::CurDir => {}
            Component::Normal(leaf) => {
                resolved = resolve_symlink_aware(&resolved, leaf, boundary, hops)?;
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    Ok(resolved)
}

/// Resolves one path component under `parent`, following a symlink there if
/// present. With `boundary` set, a symlink's target must resolve back to
/// exactly `parent` (a sibling in the same directory — the legitimate
/// `alias -> real` case) or it's refused as escaping the workspace.
fn resolve_symlink_aware(
    parent: &Path,
    leaf: &OsStr,
    boundary: Option<&Path>,
    hops: &mut u8,
) -> io::Result<PathBuf> {
    let candidate = parent.join(leaf);
    let metadata = match std::fs::symlink_metadata(&candidate) {
        Ok(metadata) => metadata,
        // No entry at all — a fresh path, or a dangling target. Either way
        // this IS the identity (unlike `Path::exists()`, which follows
        // symlinks and reports `false` even for a dangling symlink itself).
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
        // A real failure (permission denied, ...), not "safe, must not
        // exist" — propagate rather than fail open.
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_symlink() {
        return Ok(candidate);
    }

    *hops += 1;
    if *hops > MAX_SYMLINK_HOPS {
        return Err(hop_limit_error(&candidate));
    }

    let target = std::fs::read_link(&candidate)?;
    let next = if target.is_absolute() {
        target
    } else {
        parent.join(&target)
    };

    let Some(boundary) = boundary else {
        return resolve_components(PathBuf::new(), next.components(), None, hops);
    };

    let next_parent = next.parent().unwrap_or(parent);
    let resolved_next_parent =
        resolve_components(PathBuf::new(), next_parent.components(), None, hops)?;
    if resolved_next_parent != parent {
        return Err(io::Error::other(format!(
            "RELAY_STATE_PATH resolves through a symlink ({} -> {}) that escapes the directory \
             it's declared in ({} vs {}). Use a symlink to a file/directory in the SAME directory \
             instead.",
            candidate.display(),
            next.display(),
            parent.display(),
            resolved_next_parent.display()
        )));
    }
    match next.file_name() {
        Some(next_leaf) => resolve_symlink_aware(parent, next_leaf, Some(boundary), hops),
        None => Ok(parent.to_path_buf()),
    }
}

fn hop_limit_error(path: &Path) -> io::Error {
    io::Error::other(format!(
        "RELAY_STATE_PATH involves more than {MAX_SYMLINK_HOPS} symlink hops while resolving {} — \
         likely a symlink cycle; refusing rather than treating it as resolved.",
        path.display()
    ))
}

/// A hard link is two independent directory entries for the same inode, so
/// unlike a symlink it can't be unified by path resolution — a second
/// hard-linked name would take its own lock, and persistence's first rename
/// through either name would fork the two into diverging files. Refuse
/// startup instead. No portable equivalent on Windows (documented gap).
#[cfg(unix)]
fn reject_if_hard_linked(identity: &Path) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = match std::fs::metadata(identity) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.nlink() > 1 {
        return Err(io::Error::other(format!(
            "RELAY_STATE_PATH ({}) has {} hard links — a relay launched through the other name \
             would take its own lock and fork the state file on its first save. Remove the extra \
             hard link (a symlink instead IS supported).",
            identity.display(),
            metadata.nlink()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn reject_if_hard_linked(_identity: &Path) -> io::Result<()> {
    Ok(())
}

fn lock_path_for(identity: &Path) -> PathBuf {
    let mut name = identity.as_os_str().to_os_string();
    name.push(".lock");
    PathBuf::from(name)
}

fn owner_info_path_for(identity: &Path) -> PathBuf {
    let mut name = identity.as_os_str().to_os_string();
    name.push(".owner.json");
    PathBuf::from(name)
}

/// Refuses to open the `.lock` file if it's a symlink (we're the only thing
/// that ever creates it). Check-then-act, not atomic — acceptable here
/// specifically because taking an flock through a hijacked path doesn't
/// overwrite content the way a write does, so the worst a race achieves is
/// a nuisance lock, not data corruption. Don't reuse this pattern for
/// anything that writes content — see [`write_new_exclusive`].
fn reject_if_symlink(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(io::Error::other(format!(
            "{} already exists as a symlink; refusing to open it.",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Writes `contents` to a brand-new file at `path`, atomically (`create_new`
/// / `O_CREAT|O_EXCL`) so there's no separate check to race and no way for a
/// pre-existing hard link to get silently truncated-through. If something's
/// already there: a symlink or (Unix) multiply-hard-linked file is treated
/// as tampering and refused outright (cleaning it up would hide exactly the
/// evidence this exists to surface); an ordinary single-linked file is
/// assumed to be our own stale leftover from a crash and is removed, then
/// retried (bounded — if something keeps reappearing this fast, refuse
/// rather than loop forever). Used by both `record_owner` here and
/// `state::persistence::save`'s temp file (via `spawn_blocking`, since that
/// caller is async and this is sync I/O).
pub(crate) fn write_new_exclusive(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_new_exclusive_with_mode(path, contents, None)
}

/// Like [`write_new_exclusive`], optionally applying a Unix file mode (e.g. 0o600)
/// on the newly created file before returning. Best-effort elsewhere.
pub(crate) fn write_new_exclusive_with_mode(
    path: &Path,
    contents: &[u8],
    mode: Option<u32>,
) -> io::Result<()> {
    const ATTEMPTS: u8 = 5;
    let mut last_error = None;
    for _ in 0..ATTEMPTS {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(mode);
        }
        match opts.open(path) {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(contents)?;
                #[cfg(unix)]
                if let Some(mode) = mode {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = file.set_permissions(std::fs::Permissions::from_mode(mode));
                }
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                refuse_if_tampered(path)?;
                match std::fs::remove_file(path) {
                    Ok(()) => {}
                    Err(removal_error) if removal_error.kind() == io::ErrorKind::NotFound => {}
                    Err(removal_error) => return Err(removal_error),
                }
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::other(format!(
            "{} kept reappearing across {ATTEMPTS} attempts to create it exclusively.",
            path.display()
        ))
    }))
}

/// A symlink, or (Unix — no portable link-count check on Windows, so a
/// pre-planted hard link there is instead cleaned up like a stale leftover,
/// still safely since removal never touches shared content) a
/// multiply-hard-linked file, means something other than us created this
/// entry. Refuse rather than remove it.
fn refuse_if_tampered(path: &Path) -> io::Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other(format!(
            "{} already exists as a symlink; refusing to remove/replace it.",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(io::Error::other(format!(
                "{} already exists with {} hard links; refusing to remove/replace it.",
                path.display(),
                metadata.nlink()
            )));
        }
    }
    Ok(())
}

/// Only a recognized truthy value disables the lock — deployment systems
/// commonly set boolean flags to an explicit `false`/`0`/empty, which must
/// not silently reintroduce the duplicate-writer bug.
pub(crate) fn disabled_via_env() -> bool {
    match std::env::var("RELAY_DISABLE_INSTANCE_LOCK") {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => false,
    }
}

/// Tries to become the exclusive owner of `state_path`'s lock.
pub(crate) fn acquire(state_path: &Path) -> io::Result<LockOutcome> {
    let cwd = std::env::current_dir()?;
    acquire_within(state_path, &cwd)
}

fn acquire_within(state_path: &Path, workspace_root: &Path) -> io::Result<LockOutcome> {
    let identity = resolve_identity_within(state_path, workspace_root)?;
    reject_if_hard_linked(&identity)?;
    let lock_path = lock_path_for(&identity);
    let owner_info_path = owner_info_path_for(&identity);
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    reject_if_symlink(&lock_path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)?;

    match FileExt::try_lock(&file) {
        Ok(()) => Ok(LockOutcome::Acquired(InstanceLockGuard {
            file,
            owner_info_path,
        })),
        // Only WouldBlock means contention; anything else (permission
        // denied, unsupported filesystem, ...) is a real failure to
        // propagate, not "another instance is running".
        Err(error) if is_lock_contention(&error) => {
            let info = std::fs::read(&owner_info_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<OwnerInfo>(&bytes).ok());
            Ok(LockOutcome::AlreadyRunning(info))
        }
        Err(error) => Err(error.into()),
    }
}

fn is_lock_contention(error: &fs4::TryLockError) -> bool {
    matches!(error, fs4::TryLockError::WouldBlock)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_of_two_concurrent_acquires_wins() {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join(".agent-relay/session.json");

        let first = acquire_within(&state_path, dir.path()).unwrap();
        let guard = match first {
            LockOutcome::Acquired(guard) => guard,
            LockOutcome::AlreadyRunning(_) => panic!("first acquire should win an unheld lock"),
        };

        let second = acquire_within(&state_path, dir.path()).unwrap();
        assert!(
            matches!(second, LockOutcome::AlreadyRunning(_)),
            "second acquire must not win while the first still holds the lock"
        );

        drop(guard);
    }

    #[test]
    fn releasing_the_lock_lets_a_later_acquire_win() {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join(".agent-relay/session.json");

        let first = acquire_within(&state_path, dir.path()).unwrap();
        drop(first);

        let second = acquire_within(&state_path, dir.path()).unwrap();
        assert!(matches!(second, LockOutcome::Acquired(_)));
    }

    #[test]
    fn already_running_reports_recorded_owner_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join(".agent-relay/session.json");

        let first = acquire_within(&state_path, dir.path()).unwrap();
        let guard = match first {
            LockOutcome::Acquired(guard) => guard,
            LockOutcome::AlreadyRunning(_) => panic!("first acquire should win an unheld lock"),
        };
        guard.record_owner(8787).unwrap();

        match acquire_within(&state_path, dir.path()).unwrap() {
            LockOutcome::AlreadyRunning(Some(info)) => {
                assert_eq!(info.port, 8787);
                assert_eq!(info.pid, std::process::id());
            }
            LockOutcome::AlreadyRunning(None) => panic!("owner info was recorded, expected Some"),
            LockOutcome::Acquired(_) => panic!("lock is still held, expected AlreadyRunning"),
        }
    }

    #[test]
    fn already_running_is_none_when_no_owner_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join(".agent-relay/session.json");

        let _guard = acquire_within(&state_path, dir.path()).unwrap();
        assert!(matches!(
            acquire_within(&state_path, dir.path()).unwrap(),
            LockOutcome::AlreadyRunning(None)
        ));
    }

    #[test]
    fn direct_symlink_to_the_state_file_contends_for_the_same_lock() {
        let dir = tempfile::tempdir().unwrap();
        let real_path = dir.path().join("session.json");
        std::fs::write(&real_path, b"{}").unwrap();
        let alias_path = dir.path().join("alias.json");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_path, &alias_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&real_path, &alias_path).unwrap();

        let _first = acquire_within(&real_path, dir.path()).unwrap();
        assert!(matches!(
            acquire_within(&alias_path, dir.path()).unwrap(),
            LockOutcome::AlreadyRunning(_)
        ));
    }

    #[test]
    fn resolve_identity_matches_for_symlinked_and_dotdot_paths_that_do_not_exist_yet() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("real")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("alias")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(dir.path().join("real"), dir.path().join("alias"))
            .unwrap();

        let via_real =
            resolve_identity_within(&dir.path().join("real/session.json"), dir.path()).unwrap();
        let via_alias =
            resolve_identity_within(&dir.path().join("alias/../alias/session.json"), dir.path())
                .unwrap();
        assert_eq!(via_real, via_alias);
    }

    // `alias.json -> missing.json` and `missing.json` must resolve to the
    // same identity even before `missing.json` exists.
    #[test]
    fn dangling_symlink_and_its_future_target_contend_for_the_same_lock() {
        let dir = tempfile::tempdir().unwrap();
        let target_path = dir.path().join("missing.json");
        let alias_path = dir.path().join("alias.json");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target_path, &alias_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target_path, &alias_path).unwrap();

        assert_eq!(
            resolve_identity_within(&alias_path, dir.path()).unwrap(),
            resolve_identity_within(&target_path, dir.path()).unwrap()
        );

        let _first = acquire_within(&alias_path, dir.path()).unwrap();
        assert!(matches!(
            acquire_within(&target_path, dir.path()).unwrap(),
            LockOutcome::AlreadyRunning(_)
        ));
    }

    #[test]
    fn state_path_symlink_escaping_its_directory_is_refused() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        std::fs::write(&victim, b"do not touch me").unwrap();

        let state_path = workspace.path().join(".agent-relay/session.json");
        std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, &state_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&victim, &state_path).unwrap();

        assert!(resolve_identity_within(&state_path, workspace.path()).is_err());
        assert!(acquire_within(&state_path, workspace.path()).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"do not touch me");
    }

    #[test]
    fn state_path_symlink_to_a_sibling_in_the_same_directory_is_still_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let real_path = dir.path().join("session.json");
        std::fs::write(&real_path, b"{}").unwrap();
        let alias_path = dir.path().join("alias.json");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_path, &alias_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&real_path, &alias_path).unwrap();

        assert_eq!(
            resolve_identity_within(&alias_path, dir.path()).unwrap(),
            resolve_identity_within(&real_path, dir.path()).unwrap()
        );
    }

    #[test]
    fn preplanted_owner_info_symlink_is_refused_and_target_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        std::fs::write(&victim, b"do not touch me").unwrap();

        let state_path = dir.path().join("session.json");
        std::fs::write(&state_path, b"{}").unwrap();
        let owner_info_path =
            owner_info_path_for(&resolve_identity_within(&state_path, dir.path()).unwrap());
        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, &owner_info_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&victim, &owner_info_path).unwrap();

        let guard = match acquire_within(&state_path, dir.path()).unwrap() {
            LockOutcome::Acquired(guard) => guard,
            LockOutcome::AlreadyRunning(_) => panic!("should have acquired an unheld lock"),
        };
        assert!(guard.record_owner(8787).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"do not touch me");
    }

    // A hard link passes a symlink-only check but shares content with its
    // victim via the inode; `refuse_if_tampered` must catch it via nlink().
    #[cfg(unix)]
    #[test]
    fn preplanted_owner_info_hard_link_is_refused_and_target_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim.txt");
        std::fs::write(&victim, b"do not touch me").unwrap();

        let state_path = dir.path().join("session.json");
        std::fs::write(&state_path, b"{}").unwrap();
        let owner_info_path =
            owner_info_path_for(&resolve_identity_within(&state_path, dir.path()).unwrap());
        std::fs::hard_link(&victim, &owner_info_path).unwrap();

        let guard = match acquire_within(&state_path, dir.path()).unwrap() {
            LockOutcome::Acquired(guard) => guard,
            LockOutcome::AlreadyRunning(_) => panic!("should have acquired an unheld lock"),
        };
        assert!(guard.record_owner(8787).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"do not touch me");
    }

    // An ordinary stale leftover (e.g. from a previous crash) must be
    // cleaned up and replaced, not treated as tampering.
    #[test]
    fn record_owner_recovers_from_an_ordinary_stale_leftover_file() {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join("session.json");
        std::fs::write(&state_path, b"{}").unwrap();
        let owner_info_path =
            owner_info_path_for(&resolve_identity_within(&state_path, dir.path()).unwrap());
        std::fs::write(&owner_info_path, b"stale leftover from a previous crash").unwrap();

        let guard = match acquire_within(&state_path, dir.path()).unwrap() {
            LockOutcome::Acquired(guard) => guard,
            LockOutcome::AlreadyRunning(_) => panic!("should have acquired an unheld lock"),
        };
        assert!(guard.record_owner(8787).is_ok());
    }

    #[test]
    fn preplanted_lock_file_symlink_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        std::fs::write(&victim, b"do not touch me").unwrap();

        let state_path = dir.path().join("session.json");
        std::fs::write(&state_path, b"{}").unwrap();
        let lock_path = lock_path_for(&resolve_identity_within(&state_path, dir.path()).unwrap());
        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, &lock_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&victim, &lock_path).unwrap();

        assert!(acquire_within(&state_path, dir.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn acquiring_through_a_hard_linked_state_path_refuses_to_start() {
        let dir = tempfile::tempdir().unwrap();
        let real_path = dir.path().join("session.json");
        std::fs::write(&real_path, b"{}").unwrap();
        let hardlink_path = dir.path().join("hardlink.json");
        std::fs::hard_link(&real_path, &hardlink_path).unwrap();

        assert!(acquire_within(&hardlink_path, dir.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_plain_non_hard_linked_state_path_is_unaffected() {
        let dir = tempfile::tempdir().unwrap();
        let real_path = dir.path().join("session.json");
        std::fs::write(&real_path, b"{}").unwrap();
        assert!(matches!(
            acquire_within(&real_path, dir.path()).unwrap(),
            LockOutcome::Acquired(_)
        ));
    }

    #[test]
    fn disabled_via_env_only_true_for_recognized_truthy_values() {
        for value in ["1", "true", "TRUE", "True", "yes", "on"] {
            std::env::set_var("RELAY_DISABLE_INSTANCE_LOCK", value);
            assert!(disabled_via_env(), "expected {value:?} to disable the lock");
        }
        for value in ["0", "false", "FALSE", "no", "off", "", "  ", "banana"] {
            std::env::set_var("RELAY_DISABLE_INSTANCE_LOCK", value);
            assert!(
                !disabled_via_env(),
                "expected {value:?} to NOT disable the lock"
            );
        }
        std::env::remove_var("RELAY_DISABLE_INSTANCE_LOCK");
        assert!(!disabled_via_env(), "unset must not disable the lock");
    }

    #[test]
    fn only_wouldblock_is_treated_as_contention() {
        assert!(is_lock_contention(&fs4::TryLockError::WouldBlock));
        assert!(!is_lock_contention(&fs4::TryLockError::Error(
            io::Error::new(io::ErrorKind::PermissionDenied, "nope")
        )));
    }

    // `.agent-relay` itself as a symlink out of the workspace must redirect
    // session.json/lock/owner-info together — refuse it, not just a
    // symlinked leaf file.
    #[test]
    fn symlinked_parent_directory_escaping_the_workspace_is_refused() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();

        let state_path = workspace.path().join(".agent-relay/session.json");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), workspace.path().join(".agent-relay")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), workspace.path().join(".agent-relay"))
            .unwrap();

        assert!(resolve_identity_within(&state_path, workspace.path()).is_err());
    }

    #[test]
    fn symlinked_parent_directory_to_a_sibling_within_the_workspace_is_still_allowed() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("real-state-dir")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            workspace.path().join("real-state-dir"),
            workspace.path().join(".agent-relay"),
        )
        .unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(
            workspace.path().join("real-state-dir"),
            workspace.path().join(".agent-relay"),
        )
        .unwrap();

        let via_alias = resolve_identity_within(
            &workspace.path().join(".agent-relay/session.json"),
            workspace.path(),
        )
        .unwrap();
        let via_real = resolve_identity_within(
            &workspace.path().join("real-state-dir/session.json"),
            workspace.path(),
        )
        .unwrap();
        assert_eq!(via_alias, via_real);
    }

    #[test]
    fn a_symlink_cycle_is_refused_once_the_hop_limit_is_exceeded() {
        let dir = tempfile::tempdir().unwrap();
        let a_path = dir.path().join("a");
        let b_path = dir.path().join("b");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&b_path, &a_path).unwrap();
            std::os::unix::fs::symlink(&a_path, &b_path).unwrap();
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(&b_path, &a_path).unwrap();
            std::os::windows::fs::symlink_file(&a_path, &b_path).unwrap();
        }

        assert!(resolve_identity_within(&a_path, dir.path()).is_err());
    }

    #[test]
    fn climbing_above_the_workspace_root_via_dotdot_is_refused() {
        let workspace = tempfile::tempdir().unwrap();
        let state_path = workspace.path().join("../escaped.json");

        assert!(resolve_identity_within(&state_path, workspace.path()).is_err());
    }

    // chmod-ing a directory to remove search permission makes stat-ing
    // anything inside it fail with EACCES rather than ENOENT — that must
    // propagate, not be treated as "doesn't exist".
    #[cfg(unix)]
    #[test]
    fn non_not_found_metadata_errors_propagate_instead_of_being_treated_as_missing() {
        use std::os::unix::fs::PermissionsExt;

        let workspace = tempfile::tempdir().unwrap();
        let blocked_dir = workspace.path().join("blocked");
        std::fs::create_dir_all(&blocked_dir).unwrap();
        let state_path = blocked_dir.join("session.json");

        std::fs::set_permissions(&blocked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        let result = resolve_identity_within(&state_path, workspace.path());
        // Restore before any assertion can panic and skip cleanup.
        std::fs::set_permissions(&blocked_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    }
}
