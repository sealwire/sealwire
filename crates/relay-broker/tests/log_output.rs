use std::process::{Child, Command, Stdio};
use std::time::Duration;

struct BrokerProcess(Option<Child>);

impl Drop for BrokerProcess {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tokio::test]
async fn a_room_name_cannot_forge_a_log_line() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let mut broker = BrokerProcess(Some(
        Command::new(env!("CARGO_BIN_EXE_relay-broker"))
            .env_clear()
            .env("BIND_HOST", "127.0.0.1")
            .env("PORT", address.port().to_string())
            .env("RELAY_BROKER_AUTH_MODE", "self_hosted")
            .env(
                "RELAY_BROKER_TICKET_SECRET",
                "test-only-83fa10eb71624d1ca682db190eb4c259",
            )
            .env("RUST_LOG", "relay_broker=debug")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    ));
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if reqwest::get(format!("http://{address}/api/health"))
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("isolated broker should start");
    use futures_util::StreamExt;
    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "ws://{address}/ws/probe%0AFORGED_LOG_LINE?role=surface"
    ))
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let mut child = broker.0.take().unwrap();
    child.kill().unwrap();
    let output = child.wait_with_output().unwrap();
    let logs = String::from_utf8(output.stdout).unwrap();
    let records: Vec<serde_json::Value> = logs
        .lines()
        .map(|line| serde_json::from_str(line).expect("every log line must be a JSON record"))
        .collect();
    assert!(
        records
            .iter()
            .any(|record| record["fields"]["broker_room_id"] == "probe\nFORGED_LOG_LINE"),
        "{logs}"
    );
    assert!(!logs.lines().any(|line| line == "FORGED_LOG_LINE"));
}
