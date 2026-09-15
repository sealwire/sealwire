//! Local serialization for cloud activate / unbind against the registration cache.
//!
//! Separate from the long-lived relay instance lock so `cloud unbind` can run
//! while relay-server is up. Hold across read → HTTP → cache/marker mutation.
//!
//! Generic auto-enrollment also acquires this lock around enroll+save so it
//! cannot race activate/unbind on the same registration/identity files.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use fs4::FileExt;
use sha2::{Digest, Sha256};

use super::{
    load_public_relay_registration_raw, PersistedPublicRelayRegistration,
    PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION,
};

const LIFECYCLE_LOCK_FILE: &str = "public-broker-lifecycle.lock";
pub(crate) const BEARER_FINGERPRINT_HEX_CHARS: usize = 16;

/// Held exclusive OS lock for one activate/unbind/enroll critical section.
pub(crate) struct BrokerLifecycleLock {
    #[allow(dead_code)] // keep OS lock alive until Drop
    file: File,
}

impl BrokerLifecycleLock {
    /// Blocking exclusive lock keyed next to the registration cache.
    ///
    /// On Unix the lock file is created with mode 0600 (no create-then-chmod),
    /// and existing symlink / non-regular / multi-hardlink entries are refused.
    /// The flock is taken before the final path/inode check so a replacement
    /// between validation and lock cannot leave two processes holding different
    /// inodes for the same path.
    pub(crate) fn acquire_for_registration(registration_path: &Path) -> Result<Self, String> {
        let lock_path = lifecycle_lock_path(registration_path);
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create lifecycle lock directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let file = acquire_lifecycle_lock_file(&lock_path)?;
        Ok(Self { file })
    }
}

fn lifecycle_lock_path(registration_path: &Path) -> PathBuf {
    registration_path
        .parent()
        .map(|parent| parent.join(LIFECYCLE_LOCK_FILE))
        .unwrap_or_else(|| PathBuf::from(LIFECYCLE_LOCK_FILE))
}

#[cfg(not(unix))]
fn refuse_lock_path_if_unsafe(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "failed to inspect broker lifecycle lock {}: {error}",
                path.display()
            ))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "broker lifecycle lock {} is a symlink; refusing",
            path.display()
        ));
    }
    if !metadata.file_type().is_file() {
        return Err(format!(
            "broker lifecycle lock {} is not a regular file; refusing",
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(format!(
                "broker lifecycle lock {} has {} hard links; refusing",
                path.display(),
                metadata.nlink()
            ));
        }
    }
    Ok(())
}

fn acquire_lifecycle_lock_file(path: &Path) -> Result<File, String> {
    acquire_lifecycle_lock_file_with_hooks(path, || {}, || {})
}

fn open_lifecycle_lock_file_with_hook<F>(path: &Path, after_open: F) -> Result<File, String>
where
    F: FnOnce(),
{
    #[cfg(not(unix))]
    refuse_lock_path_if_unsafe(path)?;

    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NOFOLLOW closes the lstat/open race: even if the directory entry is
        // exchanged for a symlink immediately before open, the kernel refuses
        // it rather than opening (and later locking/chmodding) its target.
        opts.mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the reparse point itself so post-open validation can reject it
        // rather than following it to an unrelated file.
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = opts.open(path).map_err(|error| {
        format!(
            "failed to open broker lifecycle lock {}: {error}",
            path.display()
        )
    })?;
    after_open();
    validate_opened_lifecycle_lock(path, &file)?;
    Ok(file)
}

fn acquire_lifecycle_lock_file_with_hooks<F1, F2>(
    path: &Path,
    after_open: F1,
    after_validate_before_lock: F2,
) -> Result<File, String>
where
    F1: FnOnce(),
    F2: FnOnce(),
{
    let file = open_lifecycle_lock_file_with_hook(path, after_open)?;
    after_validate_before_lock();
    FileExt::lock(&file).map_err(|error| {
        format!(
            "failed to acquire broker lifecycle lock {}: {error}",
            path.display()
        )
    })?;
    // Final path/inode check under the flock: a replacement between the first
    // validation and this point leaves us locking an unlinked inode while a
    // peer could open the live path. Refuse rather than proceed.
    if let Err(error) = validate_opened_lifecycle_lock(path, &file) {
        let _ = FileExt::unlock(&file);
        return Err(error);
    }
    Ok(file)
}

fn validate_opened_lifecycle_lock(path: &Path, file: &File) -> Result<(), String> {
    let metadata = file.metadata().map_err(|error| {
        format!(
            "failed to inspect opened broker lifecycle lock {}: {error}",
            path.display()
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "broker lifecycle lock {} is not a regular file; refusing",
            path.display()
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        if metadata.nlink() != 1 {
            return Err(format!(
                "broker lifecycle lock {} has {} hard links; refusing",
                path.display(),
                metadata.nlink()
            ));
        }

        // Repair legacy lock files through the already-open descriptor. This
        // is fchmod, not a path chmod, so a swapped symlink is never followed.
        if metadata.mode() & 0o777 != 0o600 {
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| {
                    format!(
                        "failed to secure broker lifecycle lock {}: {error}",
                        path.display()
                    )
                })?;
            let secured = file.metadata().map_err(|error| {
                format!(
                    "failed to verify broker lifecycle lock permissions {}: {error}",
                    path.display()
                )
            })?;
            if secured.mode() & 0o777 != 0o600 {
                return Err(format!(
                    "broker lifecycle lock {} is not mode 0600; refusing",
                    path.display()
                ));
            }
        }

        // Verify the directory entry still names the descriptor we opened.
        // This catches a replacement in the remaining open/fstat window and
        // also gives the regression hook below a deterministic assertion.
        let path_metadata = std::fs::symlink_metadata(path).map_err(|error| {
            format!(
                "broker lifecycle lock {} changed while opening: {error}",
                path.display()
            )
        })?;
        if path_metadata.file_type().is_symlink()
            || !path_metadata.file_type().is_file()
            || path_metadata.dev() != metadata.dev()
            || path_metadata.ino() != metadata.ino()
        {
            return Err(format!(
                "broker lifecycle lock {} changed while opening; refusing",
                path.display()
            ));
        }
    }

    Ok(())
}

pub(crate) fn bearer_fingerprint(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        .chars()
        .take(BEARER_FINGERPRINT_HEX_CHARS)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegistrationIdentity {
    pub(crate) control_url: String,
    pub(crate) relay_id: String,
    pub(crate) broker_room_id: String,
    pub(crate) bearer_fingerprint: String,
}

impl RegistrationIdentity {
    pub(crate) fn from_persisted(
        persisted: &PersistedPublicRelayRegistration,
        normalized_control_url: &str,
    ) -> Self {
        Self {
            control_url: normalized_control_url.to_string(),
            relay_id: persisted.relay_id.clone(),
            broker_room_id: persisted.broker_room_id.clone(),
            bearer_fingerprint: bearer_fingerprint(&persisted.relay_refresh_token),
        }
    }
}

/// Delete registration only if it still matches the expected identity+fingerprint.
/// Returns true when the matching file was removed; false when missing/replaced.
pub(crate) fn delete_registration_if_matches(
    path: &Path,
    expected: &RegistrationIdentity,
) -> Result<bool, String> {
    let Some(current) = load_public_relay_registration_raw(path)? else {
        return Ok(false);
    };
    if current.schema_version != PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION {
        return Err(format!(
            "unsupported broker registration cache schema {} in {}",
            current.schema_version,
            path.display()
        ));
    }
    let current_fp = bearer_fingerprint(&current.relay_refresh_token);
    let matches = current.relay_id == expected.relay_id
        && current.broker_room_id == expected.broker_room_id
        && current_fp == expected.bearer_fingerprint
        && normalize_control_url_loose(&current.control_url) == expected.control_url;
    if !matches {
        return Ok(false);
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn normalize_control_url_loose(raw: &str) -> String {
    url::Url::parse(raw)
        .map(|mut url| {
            url.set_path("");
            url.set_query(None);
            url.set_fragment(None);
            url.as_str().trim_end_matches('/').to_string()
        })
        .unwrap_or_else(|_| raw.trim_end_matches('/').to_string())
}

/// Test/product-neutral helper: run a critical section under the lifecycle lock.
pub(crate) fn with_lifecycle_lock<T, F>(registration_path: &Path, f: F) -> Result<T, String>
where
    F: FnOnce() -> T,
{
    let _lock = BrokerLifecycleLock::acquire_for_registration(registration_path)?;
    Ok(f())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    fn write_reg(path: &Path, token: &str) {
        let payload = serde_json::to_vec_pretty(&PersistedPublicRelayRegistration {
            schema_version: PUBLIC_RELAY_REGISTRATION_SCHEMA_VERSION,
            control_url: "http://127.0.0.1:9".into(),
            relay_id: "relay-1".into(),
            broker_room_id: "room-1".into(),
            relay_refresh_token: token.into(),
        })
        .unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, payload).unwrap();
    }

    #[test]
    fn cas_delete_refuses_replaced_registration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("public-broker-registration.json");
        write_reg(&path, "token-a");
        let expected = RegistrationIdentity {
            control_url: "http://127.0.0.1:9".into(),
            relay_id: "relay-1".into(),
            broker_room_id: "room-1".into(),
            bearer_fingerprint: bearer_fingerprint("token-a"),
        };
        write_reg(&path, "token-b");
        assert_eq!(
            delete_registration_if_matches(&path, &expected).unwrap(),
            false
        );
        assert!(path.exists());
    }

    #[test]
    fn cas_delete_removes_matching_registration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("public-broker-registration.json");
        write_reg(&path, "token-a");
        let expected = RegistrationIdentity {
            control_url: "http://127.0.0.1:9".into(),
            relay_id: "relay-1".into(),
            broker_room_id: "room-1".into(),
            bearer_fingerprint: bearer_fingerprint("token-a"),
        };
        assert!(delete_registration_if_matches(&path, &expected).unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn lifecycle_lock_serializes_two_holders() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let barrier = Arc::new(Barrier::new(2));
        let saw_second_blocked = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let barrier_a = barrier.clone();
        let reg_a = reg.clone();
        let flag = saw_second_blocked.clone();
        let t1 = thread::spawn(move || {
            let _lock = BrokerLifecycleLock::acquire_for_registration(&reg_a).unwrap();
            barrier_a.wait();
            thread::sleep(Duration::from_millis(150));
            drop(_lock);
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        let barrier_b = barrier.clone();
        let reg_b = reg.clone();
        let t2 = thread::spawn(move || {
            barrier_b.wait();
            let started = std::time::Instant::now();
            let _lock = BrokerLifecycleLock::acquire_for_registration(&reg_b).unwrap();
            assert!(
                started.elapsed() >= Duration::from_millis(80),
                "second acquire should wait for the first holder"
            );
        });

        t1.join().unwrap();
        t2.join().unwrap();
        assert!(saw_second_blocked.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[test]
    fn lifecycle_lock_file_is_created_mode_0600() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let _lock = BrokerLifecycleLock::acquire_for_registration(&reg).unwrap();
        let lock_path = lifecycle_lock_path(&reg);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn lifecycle_lock_repairs_legacy_permissions_via_open_descriptor() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let lock_path = lifecycle_lock_path(&reg);
        std::fs::write(&lock_path, b"").unwrap();
        std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let _lock = BrokerLifecycleLock::acquire_for_registration(&reg).unwrap();
        let mode = std::fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn lifecycle_lock_refuses_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let lock_path = lifecycle_lock_path(&reg);
        let target = dir.path().join("elsewhere");
        std::fs::write(&target, b"x").unwrap();
        std::os::unix::fs::symlink(&target, &lock_path).unwrap();
        let err = match BrokerLifecycleLock::acquire_for_registration(&reg) {
            Ok(_) => panic!("symlink lock path must be refused"),
            Err(error) => error,
        };
        assert!(
            err.contains("symlink") || err.contains("Too many levels"),
            "got: {err}"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"x");
    }

    #[cfg(unix)]
    #[test]
    fn lifecycle_lock_detects_entry_replaced_after_open_without_touching_target() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let lock_path = lifecycle_lock_path(&reg);
        let target = dir.path().join("elsewhere");
        std::fs::write(&target, b"target-must-stay-unchanged").unwrap();

        let hook_path = lock_path.clone();
        let hook_target = target.clone();
        let error = open_lifecycle_lock_file_with_hook(&lock_path, move || {
            std::fs::remove_file(&hook_path).unwrap();
            std::os::unix::fs::symlink(&hook_target, &hook_path).unwrap();
        })
        .expect_err("replacement must be detected");

        assert!(error.contains("changed") || error.contains("refusing"));
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"target-must-stay-unchanged"
        );
    }

    #[cfg(unix)]
    #[test]
    fn lifecycle_lock_refuses_regular_inode_replaced_between_validate_and_flock() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let lock_path = lifecycle_lock_path(&reg);
        // Create the initial lock inode so the open/validate path is warm.
        std::fs::write(&lock_path, b"").unwrap();
        std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let original_ino = std::fs::metadata(&lock_path).unwrap().ino();

        let hook_path = lock_path.clone();
        let error = acquire_lifecycle_lock_file_with_hooks(
            &lock_path,
            || {},
            move || {
                std::fs::remove_file(&hook_path).unwrap();
                std::fs::write(&hook_path, b"replacement-inode").unwrap();
                std::fs::set_permissions(&hook_path, std::fs::Permissions::from_mode(0o600))
                    .unwrap();
                assert_ne!(
                    std::fs::metadata(&hook_path).unwrap().ino(),
                    original_ino,
                    "hook must install a distinct inode"
                );
            },
        )
        .expect_err("path/inode replacement after validate must fail closed");

        assert!(
            error.contains("changed") || error.contains("refusing"),
            "got: {error}"
        );
        // A second acquirer must be able to lock the live replacement inode —
        // the failed holder must not leave a stuck flock on the unlinked fd
        // that blocks the live path forever... actually unlinked inode flock
        // doesn't block the new inode. Prove the live path is acquirable.
        let _live = BrokerLifecycleLock::acquire_for_registration(&reg).unwrap();
    }

    /// Two activate-shaped critical sections: first writes A under lock; second
    /// waits, then observes already-linked and does not overwrite.
    #[test]
    fn two_simultaneous_activate_critical_sections_serialize() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        let writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(2));

        let make = |token: &'static str| {
            let reg = reg.clone();
            let writes = writes.clone();
            let start = start.clone();
            thread::spawn(move || {
                start.wait();
                let _lock = BrokerLifecycleLock::acquire_for_registration(&reg).unwrap();
                if reg.exists() {
                    return "already-linked".to_string();
                }
                // Simulated remote bind while holding the lock.
                thread::sleep(Duration::from_millis(40));
                write_reg(&reg, token);
                writes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                "wrote".to_string()
            })
        };

        let t1 = make("token-a");
        let t2 = make("token-b");
        let r1 = t1.join().unwrap();
        let r2 = t2.join().unwrap();
        let outcomes = [r1.as_str(), r2.as_str()];
        assert!(outcomes.contains(&"wrote"));
        assert!(outcomes.contains(&"already-linked"));
        assert_eq!(writes.load(std::sync::atomic::Ordering::SeqCst), 1);
        let raw = std::fs::read_to_string(&reg).unwrap();
        assert!(
            raw.contains("token-a") ^ raw.contains("token-b"),
            "exactly one coherent registration must remain: {raw}"
        );
    }

    /// Activate-vs-unbind both take the lock: unbind-old then activate-new is
    /// serializable; never a stale delete of the newer registration.
    #[test]
    fn activate_then_unbind_current_is_serializable() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        write_reg(&reg, "token-current");
        let expected = RegistrationIdentity {
            control_url: "http://127.0.0.1:9".into(),
            relay_id: "relay-1".into(),
            broker_room_id: "room-1".into(),
            bearer_fingerprint: bearer_fingerprint("token-current"),
        };
        let barrier = Arc::new(Barrier::new(2));

        let reg_a = reg.clone();
        let barrier_a = barrier.clone();
        let activate = thread::spawn(move || {
            let _lock = BrokerLifecycleLock::acquire_for_registration(&reg_a).unwrap();
            barrier_a.wait();
            thread::sleep(Duration::from_millis(60));
            // Re-bind same identity with new bearer under lock.
            write_reg(&reg_a, "token-newer");
        });

        let reg_u = reg.clone();
        let barrier_u = barrier.clone();
        let expected_u = expected.clone();
        let unbind = thread::spawn(move || {
            barrier_u.wait();
            let _lock = BrokerLifecycleLock::acquire_for_registration(&reg_u).unwrap();
            // Unbind still thinks it holds token-current; CAS must refuse newer.
            delete_registration_if_matches(&reg_u, &expected_u).unwrap()
        });

        activate.join().unwrap();
        let deleted = unbind.join().unwrap();
        // Depending on lock order: if unbind runs first it deletes current then
        // activate writes newer; if activate runs first CAS refuses. Either way
        // we must not lose a coherent end state via stale overwrite races.
        if deleted {
            // Unbind won the race and cleared current; activate then wrote newer.
            assert!(reg.exists());
            let raw = std::fs::read_to_string(&reg).unwrap();
            assert!(raw.contains("token-newer"));
        } else {
            // Activate replaced first; unbind CAS left newer intact.
            assert!(reg.exists());
            let raw = std::fs::read_to_string(&reg).unwrap();
            assert!(raw.contains("token-newer"));
            assert!(!raw.contains("token-current"));
        }
    }

    #[test]
    fn unbind_old_then_activate_new_under_lock() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("public-broker-registration.json");
        write_reg(&reg, "token-old");
        let expected = RegistrationIdentity {
            control_url: "http://127.0.0.1:9".into(),
            relay_id: "relay-1".into(),
            broker_room_id: "room-1".into(),
            bearer_fingerprint: bearer_fingerprint("token-old"),
        };
        with_lifecycle_lock(&reg, || {
            assert!(delete_registration_if_matches(&reg, &expected).unwrap());
            write_reg(&reg, "token-new");
        })
        .unwrap();
        let raw = std::fs::read_to_string(&reg).unwrap();
        assert!(raw.contains("token-new"));
        assert!(!raw.contains("token-old"));
    }
}
