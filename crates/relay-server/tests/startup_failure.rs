use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn invalid_state_reports_its_path_and_cause_without_a_panic_or_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("session.json");
    let original = b"invalid state JSON";
    std::fs::write(&path, original).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_relay-server"));
    command
        .env_clear()
        .current_dir(root.path())
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("RELAY_STATE_PATH", &path)
        .env("BIND_HOST", "127.0.0.1")
        .env("PORT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    let mut child = command.spawn().expect("start isolated relay");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().expect("stop isolated test relay");
            child.wait().unwrap();
            panic!("relay did not refuse the invalid state");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(
        stderr.contains("relay-server: failed to start:"),
        "{stderr}"
    );
    assert!(stderr.contains(&path.display().to_string()), "{stderr}");
    assert!(
        stderr.contains("failed to decode persisted state"),
        "{stderr}"
    );
    assert!(!stderr.contains("panicked"), "{stderr}");
    assert!(!stderr.contains("Codex app-server bridge"), "{stderr}");
    assert_eq!(std::fs::read(&path).unwrap(), original);
}

#[test]
fn retired_local_access_settings_are_refused_before_loading_state() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("session.json");
    std::fs::write(&path, "invalid state JSON").unwrap();
    for name in [
        "RELAY_API_TOKEN",
        "RELAY_ALLOW_INSECURE_NO_AUTH",
        "RELAY_ALLOWED_HOSTS",
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_relay-server"));
        command
            .env_clear()
            .current_dir(root.path())
            .env("HOME", root.path())
            .env("USERPROFILE", root.path())
            .env("RELAY_STATE_PATH", &path)
            .env("BIND_HOST", "127.0.0.1")
            .env("PORT", "0")
            .env(name, "retired-setting")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system_root);
        }
        let output = command.output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(1), "{stderr}");
        assert!(
            stderr.contains(name) && stderr.contains("no longer supported"),
            "{stderr}"
        );
        assert!(!stderr.contains("panicked"), "{stderr}");
    }
    assert_eq!(std::fs::read_to_string(path).unwrap(), "invalid state JSON");
}
