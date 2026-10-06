use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn relay_binary_does_not_embed_private_npm_script() {
    let manifest_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest_path).expect("read npm manifest"))
            .expect("parse npm manifest");
    let private_script = manifest["scripts"]["test:private-frontend"]
        .as_str()
        .expect("private npm script regression fixture");
    assert!(private_script.contains("sealwire-private"));

    let binary = std::fs::read(env!("CARGO_BIN_EXE_relay-server")).expect("read relay executable");
    assert!(
        !binary
            .windows(private_script.len())
            .any(|window| window == private_script.as_bytes()),
        "relay executable embeds the private npm script from package.json; compile only the product version"
    );
}

#[test]
fn outdated_relay_exits_before_opening_local_server() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock broker");
    let address = listener.local_addr().expect("mock broker address");
    listener
        .set_nonblocking(true)
        .expect("nonblocking mock broker");
    let broker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "no health request arrived");
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("accept health request: {error}"),
            }
        };
        socket
            .set_nonblocking(false)
            .expect("blocking accepted socket");
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        let mut request = [0_u8; 2048];
        let length = socket.read(&mut request).expect("read health request");
        assert!(
            String::from_utf8_lossy(&request[..length]).starts_with("GET /api/health "),
            "relay must check the broker before startup"
        );
        let body = serde_json::json!({
            "status": "ok",
            "service": "relay-broker",
            "broker_auth_mode": "self_hosted",
            "join_auth_ready": true,
            "minimum_relay_version": "999.0.0",
            "broker_protocol_version": relay_broker::protocol::BROKER_PROTOCOL_VERSION,
        })
        .to_string();
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .expect("send health response");
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_relay-server"))
        .env("RELAY_BROKER_URL", format!("ws://{address}"))
        .env_remove("RELAY_BROKER_CONTROL_URL")
        .env("PORT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start isolated relay");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().expect("poll relay exit").is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().expect("stop isolated test relay");
            panic!("relay did not exit after version refusal");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().expect("collect relay output");
    broker.join().expect("mock broker completed");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("minimum supported version is 999.0.0"),
        "{stderr}"
    );
    assert!(stderr.contains("npx sealwire@latest"), "{stderr}");
    assert!(stderr.contains("desktop users"), "{stderr}");
}
