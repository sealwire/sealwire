//! Product-neutral cloud activation credential handling.
//!
//! The user-facing prompt calls this a "SealWire Cloud access key". Internally
//! it is an enrollment token — never a public license business type. Secrets
//! are not logged, not stored in registration JSON, and are scrubbed from the
//! process environment immediately after read.

use std::fs::{self, File, OpenOptions};
use std::io::{self, IsTerminal, Read, Write};
use std::path::Path;

use zeroize::Zeroize;

/// Preferred generic env override for cloud activation (consumed then removed).
pub(crate) const CLOUD_ACCESS_KEY_ENV: &str = "SEALWIRE_CLOUD_ACCESS_KEY";
/// One-shot token file path env (mode 0600 best-effort; unlinked after read).
pub(crate) const CLOUD_ACCESS_KEY_FILE_ENV: &str = "SEALWIRE_CLOUD_ACCESS_KEY_FILE";
/// Removed legacy commercial env name. Scrubbed from the process and children for
/// safety only — never treated as an activation input or compatibility surface.
pub(crate) const REMOVED_LEGACY_LICENSE_CODE_ENV: &str = "RELAY_LICENSE_CODE";
/// Set only by `sealwire cloud` / `cloud-activate`. Generic `--broker` must not set this.
pub(crate) const CLOUD_ACTIVATION_ENV: &str = "RELAY_CLOUD_ACTIVATION";
/// Witness envs set by the Node launcher after a successful cloud-activate only.
pub(crate) const CLOUD_REQUIRE_CACHED_REGISTRATION_ENV: &str =
    "RELAY_CLOUD_REQUIRE_CACHED_REGISTRATION";
pub(crate) const CLOUD_EXPECTED_CONTROL_URL_ENV: &str = "RELAY_CLOUD_EXPECTED_CONTROL_URL";
pub(crate) const CLOUD_EXPECTED_RELAY_ID_ENV: &str = "RELAY_CLOUD_EXPECTED_RELAY_ID";
pub(crate) const CLOUD_EXPECTED_ROOM_ID_ENV: &str = "RELAY_CLOUD_EXPECTED_ROOM_ID";
pub(crate) const CLOUD_EXPECTED_BEARER_FP_ENV: &str = "RELAY_CLOUD_EXPECTED_BEARER_FP";

pub(crate) const MAX_ACTIVATION_TOKEN_BYTES: usize = 512;

/// Zeroizing activation secret. Never Debug/Clone the plaintext.
pub(crate) struct ActivationSecret {
    bytes: Vec<u8>,
}

impl ActivationSecret {
    pub(crate) fn from_bytes(mut raw: Vec<u8>) -> Result<Self, String> {
        // Trim ASCII whitespace in place without creating an intermediate String.
        while raw.first().is_some_and(u8::is_ascii_whitespace) {
            raw.remove(0);
        }
        while raw.last().is_some_and(u8::is_ascii_whitespace) {
            raw.pop();
        }
        if raw.is_empty() {
            raw.zeroize();
            return Err("cloud access key must not be blank".to_string());
        }
        if raw.len() > MAX_ACTIVATION_TOKEN_BYTES {
            raw.zeroize();
            return Err(format!(
                "cloud access key exceeds {MAX_ACTIVATION_TOKEN_BYTES} bytes"
            ));
        }
        if std::str::from_utf8(&raw).is_err() {
            raw.zeroize();
            return Err("cloud access key must be valid UTF-8".to_string());
        }
        Ok(Self { bytes: raw })
    }

    pub(crate) fn from_str(raw: &str) -> Result<Self, String> {
        Self::from_bytes(raw.as_bytes().to_vec())
    }

    pub(crate) fn as_str(&self) -> &str {
        std::str::from_utf8(&self.bytes).unwrap_or("")
    }

    fn zero(&mut self) {
        self.bytes.zeroize();
        self.bytes.clear();
    }
}

impl Drop for ActivationSecret {
    fn drop(&mut self) {
        self.zero();
    }
}

impl std::fmt::Debug for ActivationSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ActivationSecret([redacted])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivationCredentialSource {
    Env,
    File,
    Tty,
}

/// True when `sealwire cloud` (or cloud-activate) requested explicit cloud activation.
pub(crate) fn cloud_activation_required() -> bool {
    matches!(
        std::env::var(CLOUD_ACTIVATION_ENV).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

/// Resolve an activation credential for explicit cloud enrollment only.
///
/// Precedence: file env → cloud access key env → TTY prompt (only when
/// `allow_tty` and hidden input is available). Env vars are removed from the
/// process immediately after a successful read. Removed legacy
/// `RELAY_LICENSE_CODE` is never accepted as an input (scrub-only).
pub(crate) fn resolve_activation_credential(
    allow_tty: bool,
) -> Result<Option<(ActivationSecret, ActivationCredentialSource)>, String> {
    // Defense in depth: scrub the removed legacy name so it cannot linger for
    // children, but never read it as a credential.
    scrub_env_key(REMOVED_LEGACY_LICENSE_CODE_ENV);

    if let Some(path) = take_env_path_string(CLOUD_ACCESS_KEY_FILE_ENV) {
        let secret = read_token_file(Path::new(&path))?;
        return Ok(Some((secret, ActivationCredentialSource::File)));
    }
    if let Some(secret) = take_env_secret(CLOUD_ACCESS_KEY_ENV)? {
        return Ok(Some((secret, ActivationCredentialSource::Env)));
    }
    if allow_tty {
        match hidden_input_availability() {
            HiddenInputAvailability::Available if std::io::stdin().is_terminal() => {
                let secret = prompt_cloud_access_key()?;
                return Ok(Some((secret, ActivationCredentialSource::Tty)));
            }
            HiddenInputAvailability::Unavailable => {
                return Err("interactive cloud activation requires hidden input; \
                     set SEALWIRE_CLOUD_ACCESS_KEY or SEALWIRE_CLOUD_ACCESS_KEY_FILE instead"
                    .to_string());
            }
            HiddenInputAvailability::Available => {}
        }
    }
    Ok(None)
}

/// True when any activation override env is currently set (before consume).
pub(crate) fn activation_override_env_present() -> bool {
    env_nonempty(CLOUD_ACCESS_KEY_ENV) || env_nonempty(CLOUD_ACCESS_KEY_FILE_ENV)
}

/// Scrub raw activation secret env vars even when unused (defense in depth).
/// Never clones secret plaintext into a second String solely to zeroize it.
/// Also scrubs the removed legacy name so children never inherit it.
pub(crate) fn scrub_activation_env() {
    scrub_env_key(CLOUD_ACCESS_KEY_ENV);
    scrub_env_key(CLOUD_ACCESS_KEY_FILE_ENV);
    scrub_env_key(REMOVED_LEGACY_LICENSE_CODE_ENV);
}

/// Scrub cloud-activation mode and launch-witness envs (not raw secrets).
pub(crate) fn scrub_cloud_mode_and_witness_env() {
    scrub_env_key(CLOUD_ACTIVATION_ENV);
    scrub_env_key(CLOUD_REQUIRE_CACHED_REGISTRATION_ENV);
    scrub_env_key(CLOUD_EXPECTED_CONTROL_URL_ENV);
    scrub_env_key(CLOUD_EXPECTED_RELAY_ID_ENV);
    scrub_env_key(CLOUD_EXPECTED_ROOM_ID_ENV);
    scrub_env_key(CLOUD_EXPECTED_BEARER_FP_ENV);
}

/// Unconditional scrub for normal/generic long-lived relay startup and children.
/// Removes raw secrets, `RELAY_CLOUD_ACTIVATION`, and all witness variables.
/// Only the short-lived `cloud-activate` subcommand may honor those flags.
pub(crate) fn scrub_all_cloud_activation_env_for_normal_start() {
    scrub_activation_env();
    scrub_cloud_mode_and_witness_env();
}

/// Discard a one-shot access-key file without retaining its contents.
/// Used on the already-linked rejection path so the file cannot linger forever.
pub(crate) fn discard_oneshot_activation_file_input() {
    let Some(path) = take_env_path_string(CLOUD_ACCESS_KEY_FILE_ENV) else {
        return;
    };
    // Never open or overwrite a caller-selected path on this discard-only
    // branch. remove_file unlinks a directory entry rather than following it,
    // but inspect first so symlink and non-regular inputs are refused and left
    // in place for the caller to resolve.
    let path = Path::new(&path);
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return;
    }
    let _ = fs::remove_file(path);
}

fn scrub_env_key(key: &str) {
    // Fail-closed on non-Unicode: still remove so children cannot inherit.
    let Some(value) = std::env::var_os(key) else {
        return;
    };
    std::env::remove_var(key);
    zeroize_os_string(value);
}

/// Best-effort wipe of an `OsString` without building a second UTF-8 `String`.
fn zeroize_os_string(value: std::ffi::OsString) {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        let mut bytes = value.into_vec();
        bytes.zeroize();
        drop(bytes);
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        let mut wide: Vec<u16> = value.encode_wide().collect();
        drop(value);
        wide.zeroize();
        drop(wide);
    }
    #[cfg(not(any(unix, windows)))]
    {
        drop(value);
    }
}

fn take_env_path_string(key: &str) -> Option<String> {
    // File path env is not the secret itself; still remove immediately.
    let mut value = std::env::var(key).ok()?;
    std::env::remove_var(key);
    let trimmed = value.trim();
    if trimmed.is_empty() {
        value.zeroize();
        None
    } else {
        let out = trimmed.to_string();
        value.zeroize();
        Some(out)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HiddenInputAvailability {
    Available,
    Unavailable,
}

/// Decision core for interactive prompts: only prompt when echo can be disabled.
pub(crate) fn hidden_input_availability() -> HiddenInputAvailability {
    // rpassword disables echo on Unix and Windows consoles.
    HiddenInputAvailability::Available
}

fn take_env_secret(key: &str) -> Result<Option<ActivationSecret>, String> {
    match std::env::var_os(key) {
        None => return Ok(None),
        Some(os) => {
            std::env::remove_var(key);
            let Some(mut value) = os.into_string().ok() else {
                return Err(format!(
                    "{key} contained non-UTF-8 bytes; refusing rather than inheriting it"
                ));
            };
            let result = ActivationSecret::from_str(&value);
            value.zeroize();
            return result.map(Some);
        }
    }
}

fn env_nonempty(key: &str) -> bool {
    std::env::var_os(key)
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

fn read_token_file(path: &Path) -> Result<ActivationSecret, String> {
    let mut file = File::open(path).map_err(|e| {
        format!(
            "failed to read cloud access key file {}: {e}",
            path.display()
        )
    })?;
    let unlink = |path: &Path| {
        let _ = fs::remove_file(path);
    };

    let mut buf = vec![0u8; MAX_ACTIVATION_TOKEN_BYTES + 1];
    let mut total = 0usize;
    loop {
        match file.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                if total > MAX_ACTIVATION_TOKEN_BYTES {
                    buf.zeroize();
                    unlink(path);
                    return Err(format!(
                        "cloud access key file exceeds {MAX_ACTIVATION_TOKEN_BYTES} bytes"
                    ));
                }
            }
            Err(error) => {
                buf.zeroize();
                unlink(path);
                return Err(format!(
                    "failed to read cloud access key file {}: {error}",
                    path.display()
                ));
            }
        }
    }
    unlink(path);
    buf.truncate(total);
    ActivationSecret::from_bytes(buf)
}

/// Exclusive-create a mode-0600 one-shot token file (test/helper).
#[cfg(test)]
pub(crate) fn write_token_file_0600(path: &Path, token: &str) -> Result<(), String> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(path)
        .map_err(|e| format!("failed to create token file {}: {e}", path.display()))?;
    file.write_all(token.as_bytes())
        .map_err(|e| format!("failed to write token file {}: {e}", path.display()))?;
    Ok(())
}

fn prompt_cloud_access_key() -> Result<ActivationSecret, String> {
    eprint!("SealWire Cloud access key: ");
    let _ = io::stderr().flush();
    let mut line = rpassword::read_password()
        .map_err(|e| format!("failed to read cloud access key with hidden input: {e}"))?;
    eprintln!();
    let result = ActivationSecret::from_str(&line);
    line.zeroize();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn activation_secret_debug_is_redacted() {
        let secret = ActivationSecret::from_str("super-secret-key").unwrap();
        let rendered = format!("{secret:?}");
        assert!(!rendered.contains("super-secret"));
        assert!(rendered.contains("redacted"));
    }

    #[test]
    fn activation_secret_rejects_blank_and_oversized() {
        assert!(ActivationSecret::from_str("   ").is_err());
        let big = "a".repeat(MAX_ACTIVATION_TOKEN_BYTES + 1);
        assert!(ActivationSecret::from_str(&big).is_err());
    }

    #[test]
    fn resolve_reads_env_and_removes_it() {
        let _guard = env_lock().lock().unwrap();
        scrub_activation_env();
        std::env::set_var(CLOUD_ACCESS_KEY_ENV, "  cloud-key-1  ");
        let (secret, source) = resolve_activation_credential(false)
            .unwrap()
            .expect("env credential");
        assert_eq!(secret.as_str(), "cloud-key-1");
        assert_eq!(source, ActivationCredentialSource::Env);
        assert!(std::env::var(CLOUD_ACCESS_KEY_ENV).is_err());
        scrub_activation_env();
    }

    #[test]
    fn resolve_ignores_removed_legacy_license_env() {
        let _guard = env_lock().lock().unwrap();
        scrub_activation_env();
        std::env::set_var(REMOVED_LEGACY_LICENSE_CODE_ENV, "legacy-code");
        assert!(
            resolve_activation_credential(false).unwrap().is_none(),
            "removed RELAY_LICENSE_CODE must never activate"
        );
        assert!(
            std::env::var(REMOVED_LEGACY_LICENSE_CODE_ENV).is_err(),
            "legacy name must still be scrubbed"
        );
        scrub_activation_env();
    }

    #[test]
    fn resolve_reads_token_file_and_unlinks() {
        let _guard = env_lock().lock().unwrap();
        scrub_activation_env();
        let dir = std::env::temp_dir().join(format!(
            "sealwire-token-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("key.txt");
        write_token_file_0600(&path, "file-key\n").unwrap();
        std::env::set_var(CLOUD_ACCESS_KEY_FILE_ENV, &path);
        let (secret, source) = resolve_activation_credential(false).unwrap().expect("file");
        assert_eq!(secret.as_str(), "file-key");
        assert_eq!(source, ActivationCredentialSource::File);
        assert!(!path.exists());
        assert!(std::env::var(CLOUD_ACCESS_KEY_FILE_ENV).is_err());
        let _ = fs::remove_dir_all(&dir);
        scrub_activation_env();
    }

    #[test]
    fn read_token_file_unlinks_on_oversized_stream() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        let big = "a".repeat(MAX_ACTIVATION_TOKEN_BYTES + 32);
        fs::write(&path, &big).unwrap();
        let err = read_token_file(&path).expect_err("oversized");
        assert!(err.contains("exceeds"));
        assert!(!path.exists(), "oversized file must be unlinked");
    }

    #[test]
    fn non_tty_without_credential_returns_none() {
        let _guard = env_lock().lock().unwrap();
        scrub_activation_env();
        assert!(resolve_activation_credential(false).unwrap().is_none());
    }

    #[test]
    fn hidden_input_decision_core_is_available() {
        assert_eq!(
            hidden_input_availability(),
            HiddenInputAvailability::Available
        );
    }

    #[test]
    fn scrub_activation_env_removes_non_unicode_fail_closed() {
        let _guard = env_lock().lock().unwrap();
        #[cfg(unix)]
        {
            use std::ffi::OsString;
            use std::os::unix::ffi::OsStringExt;
            let key = CLOUD_ACCESS_KEY_ENV;
            let bad = OsString::from_vec(vec![0xff, 0xfe, 0xfd]);
            std::env::set_var(key, &bad);
            scrub_activation_env();
            assert!(std::env::var_os(key).is_none());
        }
    }

    #[test]
    fn normal_start_scrub_unconditionally_clears_activation_env() {
        let _guard = env_lock().lock().unwrap();
        std::env::set_var(CLOUD_ACCESS_KEY_ENV, "must-not-reach-providers");
        std::env::set_var(REMOVED_LEGACY_LICENSE_CODE_ENV, "legacy-must-go");
        std::env::set_var(CLOUD_ACTIVATION_ENV, "1");
        std::env::set_var(CLOUD_REQUIRE_CACHED_REGISTRATION_ENV, "1");
        std::env::set_var(CLOUD_EXPECTED_BEARER_FP_ENV, "abcdef0123456789");
        let _startup = super::super::capture_and_scrub_activation_for_normal_start();
        assert!(std::env::var_os(CLOUD_ACCESS_KEY_ENV).is_none());
        assert!(std::env::var_os(REMOVED_LEGACY_LICENSE_CODE_ENV).is_none());
        assert!(std::env::var_os(CLOUD_ACTIVATION_ENV).is_none());
        assert!(std::env::var_os(CLOUD_REQUIRE_CACHED_REGISTRATION_ENV).is_none());
        assert!(std::env::var_os(CLOUD_EXPECTED_BEARER_FP_ENV).is_none());
    }

    #[test]
    fn generic_normal_start_scrubs_file_env_without_deleting_oneshot_file() {
        let _guard = env_lock().lock().unwrap();
        scrub_activation_env();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keep-me.key");
        write_token_file_0600(&path, "must-remain-on-disk\n").unwrap();
        std::env::set_var(CLOUD_ACCESS_KEY_FILE_ENV, &path);
        std::env::set_var(CLOUD_EXPECTED_RELAY_ID_ENV, "ambient-only");

        let _startup = super::super::capture_and_scrub_activation_for_normal_start();

        assert!(std::env::var_os(CLOUD_ACCESS_KEY_FILE_ENV).is_none());
        assert!(std::env::var_os(CLOUD_EXPECTED_RELAY_ID_ENV).is_none());
        assert_eq!(fs::read(&path).unwrap(), b"must-remain-on-disk\n");
    }

    #[test]
    fn discard_oneshot_file_unlinks_without_leaving_secret() {
        let _guard = env_lock().lock().unwrap();
        scrub_activation_env();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oneshot.txt");
        write_token_file_0600(&path, "oneshot-secret-key\n").unwrap();
        std::env::set_var(CLOUD_ACCESS_KEY_FILE_ENV, &path);
        discard_oneshot_activation_file_input();
        assert!(std::env::var_os(CLOUD_ACCESS_KEY_FILE_ENV).is_none());
        assert!(!path.exists(), "oneshot file must be unlinked");
    }

    #[cfg(unix)]
    #[test]
    fn discard_oneshot_file_refuses_symlink_and_preserves_target() {
        let _guard = env_lock().lock().unwrap();
        scrub_activation_env();
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("user-file.txt");
        let link = dir.path().join("oneshot-link.txt");
        fs::write(&target, b"user-data-must-not-change").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        std::env::set_var(CLOUD_ACCESS_KEY_FILE_ENV, &link);

        discard_oneshot_activation_file_input();

        assert!(std::env::var_os(CLOUD_ACCESS_KEY_FILE_ENV).is_none());
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"user-data-must-not-change");
    }

    #[test]
    fn discard_oneshot_file_refuses_non_regular_entry() {
        let _guard = env_lock().lock().unwrap();
        scrub_activation_env();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-a-file");
        fs::create_dir(&path).unwrap();
        std::env::set_var(CLOUD_ACCESS_KEY_FILE_ENV, &path);

        discard_oneshot_activation_file_input();

        assert!(std::env::var_os(CLOUD_ACCESS_KEY_FILE_ENV).is_none());
        assert!(path.is_dir());
    }

    #[test]
    fn discard_oneshot_hard_link_unlinks_only_selected_entry() {
        let _guard = env_lock().lock().unwrap();
        scrub_activation_env();
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original.key");
        let oneshot = dir.path().join("oneshot.key");
        fs::write(&original, b"key-material").unwrap();
        fs::hard_link(&original, &oneshot).unwrap();
        std::env::set_var(CLOUD_ACCESS_KEY_FILE_ENV, &oneshot);

        discard_oneshot_activation_file_input();

        assert!(!oneshot.exists());
        assert_eq!(fs::read(&original).unwrap(), b"key-material");
    }

    #[test]
    fn scrub_env_key_does_not_require_utf8_string_clone_on_unix() {
        let _guard = env_lock().lock().unwrap();
        #[cfg(unix)]
        {
            use std::ffi::OsString;
            use std::os::unix::ffi::OsStringExt;
            let key = CLOUD_ACCESS_KEY_ENV;
            let bad = OsString::from_vec(vec![0xff, 0xfe, 0xfd]);
            std::env::set_var(key, &bad);
            scrub_activation_env();
            assert!(std::env::var_os(key).is_none());
        }
    }
}
