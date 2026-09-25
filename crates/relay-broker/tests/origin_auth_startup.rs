//! A bad origin-auth config must stop the broker before it listens: a deploy that
//! came up anyway would either serve the raw origin or refuse all app traffic.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use relay_broker::{ORIGIN_AUTH_HEADER_ENV, ORIGIN_AUTH_SECRET_ENV, REQUIRE_ORIGIN_AUTH_ENV};

// Long enough to pass the length rule, so only the placeholder rule rejects it.
const PLACEHOLDER_SECRET: &str = "change-me-change-me-change-me-change-me";

fn run_broker_expecting_exit(env: &[(&str, &str)]) -> (Option<i32>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_relay-broker"))
        .env_clear()
        .env("BIND_HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("RUST_LOG", "relay_broker=info")
        .envs(env.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("relay-broker should spawn");

    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().expect("child status") {
            break status;
        }
        if Instant::now() > deadline {
            child.kill().ok();
            child.wait().ok();
            panic!("relay-broker kept running with a bad origin-auth config: {env:?}");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut output = String::new();
    child
        .stdout
        .take()
        .expect("stdout")
        .read_to_string(&mut output)
        .ok();
    child
        .stderr
        .take()
        .expect("stderr")
        .read_to_string(&mut output)
        .ok();
    (status.code(), output)
}

#[test]
fn bad_origin_auth_config_stops_the_broker_before_it_listens() {
    let cases: [&[(&str, &str)]; 6] = [
        &[(ORIGIN_AUTH_SECRET_ENV, PLACEHOLDER_SECRET)],
        &[(ORIGIN_AUTH_SECRET_ENV, "")],
        &[(REQUIRE_ORIGIN_AUTH_ENV, "1")],
        &[(REQUIRE_ORIGIN_AUTH_ENV, "")],
        &[(REQUIRE_ORIGIN_AUTH_ENV, "  ")],
        &[(ORIGIN_AUTH_HEADER_ENV, "x-edge-auth")],
    ];
    for env in cases {
        let (code, output) = run_broker_expecting_exit(env);
        assert_ne!(code, Some(0), "{env:?} must exit non-zero\n{output}");
        assert!(
            output.contains("RELAY_BROKER_") && !output.contains("listening on"),
            "{env:?} should name the bad variable and never listen\n{output}"
        );
        assert!(
            !output.contains(PLACEHOLDER_SECRET),
            "startup output must not echo the secret\n{output}"
        );
    }
}

#[test]
fn a_valid_origin_auth_config_starts_enforcing_without_logging_the_secret() {
    use std::io::{BufRead, BufReader};

    // Test-only value; shaped like a real one so it passes validation.
    const SECRET: &str = "Test0nly-origin-secret-0123456789abcdefXYZ";
    let mut child = Command::new(env!("CARGO_BIN_EXE_relay-broker"))
        .env_clear()
        .env("BIND_HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("RUST_LOG", "relay_broker=info")
        .env(ORIGIN_AUTH_SECRET_ENV, SECRET)
        .env(REQUIRE_ORIGIN_AUTH_ENV, "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("relay-broker should spawn");

    let stdout = child.stdout.take().expect("stdout");
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !seen
        .iter()
        .any(|line: &String| line.contains("broker origin auth enforced"))
    {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(line) => seen.push(line),
            Err(_) => break,
        }
    }
    child.kill().ok();
    child.wait().ok();

    let output = seen.join("\n");
    assert!(output.contains("listening on"), "{output}");
    assert!(output.contains("broker origin auth enforced"), "{output}");
    assert!(
        !output.contains(SECRET),
        "startup logs must not echo the secret\n{output}"
    );
}
