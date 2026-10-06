use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn isolated_relay(root: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_relay-server"));
    command
        .env_clear()
        .current_dir(root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("BIND_HOST", "127.0.0.1")
        .env("PORT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    command
}

/// Runs a relay expected to refuse to start, and returns what it printed.
fn refused_start(mut command: Command) -> String {
    let mut child = command.spawn().expect("start isolated relay");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().expect("stop isolated test relay");
            child.wait().unwrap();
            panic!("relay did not refuse to start");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
    assert!(!stderr.contains("Codex app-server bridge"), "{stderr}");
    stderr
}

#[test]
fn an_unreadable_database_reports_its_path_without_a_panic_or_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("sealwire.db");
    let original = b"not a sqlite database, and long enough to have a header";
    std::fs::write(&path, original).unwrap();
    let mut command = isolated_relay(root.path());
    command.env("RELAY_STATE_DB", &path);
    let stderr = refused_start(command);
    assert!(
        stderr.contains("relay-server: failed to start:"),
        "{stderr}"
    );
    assert!(stderr.contains(&path.display().to_string()), "{stderr}");
    assert_eq!(std::fs::read(&path).unwrap(), original);
}

// Starting empty beside an older build's files would enroll a new relay identity and
// strand every paired phone; the files are left for the import.
#[test]
fn state_files_of_an_older_build_are_refused_until_imported() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join(".agent-relay");
    std::fs::create_dir_all(&state).unwrap();
    let legacy = state.join("session.json");
    std::fs::write(&legacy, "{}").unwrap();
    let stderr = refused_start(isolated_relay(root.path()));
    assert!(stderr.contains("migrate-storage"), "{stderr}");
    assert!(stderr.contains(&legacy.display().to_string()), "{stderr}");
    assert_eq!(std::fs::read_to_string(&legacy).unwrap(), "{}");
    assert!(
        !root.path().join(".sealwire").exists(),
        "a refused start must not create the new state directory, or the import could not \
         move the old one into its place"
    );
}

#[test]
fn settings_that_named_state_files_are_refused() {
    let root = tempfile::tempdir().unwrap();
    for name in [
        "RELAY_STATE_PATH",
        "RELAY_BROKER_IDENTITY_PATH",
        "RELAY_BROKER_REGISTRATION_PATH",
        "RELAY_CONTENT_IDENTITY_PATH",
        "RELAY_VAPID_KEY_PATH",
    ] {
        let mut command = isolated_relay(root.path());
        command.env(name, root.path().join("old-state-file"));
        let stderr = refused_start(command);
        assert!(
            stderr.contains(name) && stderr.contains("RELAY_STATE_DB"),
            "{stderr}"
        );
    }
}

// Otherwise a Cloud command run with the old settings mints an identity in a fresh
// default database while the real one still waits to be imported.
#[test]
fn cloud_commands_refuse_settings_that_named_state_files() {
    let root = tempfile::tempdir().unwrap();
    let old = root.path().join("old-state");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(old.join("session.json"), "{}").unwrap();
    for subcommand in ["cloud-access-release", "cloud-activate"] {
        let mut command = isolated_relay(root.path());
        command
            .arg(subcommand)
            .env("RELAY_STATE_PATH", old.join("session.json"))
            .env("RELAY_BROKER_CONTROL_URL", "http://127.0.0.1:9")
            .env("RELAY_CLOUD_ACTIVATION", "1");
        let output = command.output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_ne!(output.status.code(), Some(0), "{subcommand}: {stderr}");
        assert!(
            stderr.contains("RELAY_STATE_PATH"),
            "{subcommand}: {stderr}"
        );
        assert!(
            !root.path().join(".sealwire").exists(),
            "{subcommand} created a new state directory: {stderr}"
        );
    }
}

#[test]
fn retired_local_access_settings_are_refused_before_loading_state() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("sealwire.db");
    std::fs::write(&path, "not a database").unwrap();
    for name in [
        "RELAY_API_TOKEN",
        "RELAY_ALLOW_INSECURE_NO_AUTH",
        "RELAY_ALLOWED_HOSTS",
    ] {
        let mut command = isolated_relay(root.path());
        command
            .env("RELAY_STATE_DB", &path)
            .env(name, "retired-setting");
        let stderr = refused_start(command);
        assert!(
            stderr.contains(name) && stderr.contains("no longer supported"),
            "{stderr}"
        );
    }
    assert_eq!(std::fs::read_to_string(path).unwrap(), "not a database");
}

// The Cloud commands open the database themselves, before the relay's own path checks.
// One reached through a symlink out of the workspace must be refused, not written.
#[cfg(unix)]
#[test]
fn cloud_commands_refuse_a_database_reached_through_a_symlink_out_of_the_workspace() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let outside = root.path().join("outside");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, workspace.join(".sealwire")).unwrap();
    for subcommand in ["cloud-access-release", "cloud-activate"] {
        let mut command = isolated_relay(root.path());
        command
            .current_dir(&workspace)
            .arg(subcommand)
            .env("RELAY_STATE_DB", ".sealwire/sealwire.db")
            .env("RELAY_BROKER_CONTROL_URL", "http://127.0.0.1:9")
            .env("RELAY_CLOUD_ACTIVATION", "1");
        let output = command.output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_ne!(output.status.code(), Some(0), "{subcommand}: {stderr}");
        assert!(
            !outside.join("sealwire.db").exists(),
            "{subcommand} wrote a database outside the workspace: {stderr}"
        );
    }
}
