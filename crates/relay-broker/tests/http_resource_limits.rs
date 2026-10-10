#![cfg(unix)]

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
async fn exhausting_file_descriptors_does_not_stop_the_broker() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let mut broker = BrokerProcess(Some(
        Command::new("/bin/sh")
            .args([
                "-c",
                "ulimit -n 64; exec \"$1\"",
                "broker-resource-test",
                env!("CARGO_BIN_EXE_relay-broker"),
            ])
            .env_clear()
            .env("BIND_HOST", "127.0.0.1")
            .env("PORT", address.port().to_string())
            .env("RELAY_BROKER_AUTH_MODE", "self_hosted")
            .env(
                "RELAY_BROKER_TICKET_SECRET",
                "test-only-83fa10eb71624d1ca682db190eb4c259",
            )
            .env("RELAY_BROKER_MAX_HTTP_CONNECTIONS_PER_IP", "1024")
            .env("RELAY_BROKER_HEADER_READ_TIMEOUT_SECS", "2")
            .env("RELAY_BROKER_HTTP_CONNECTION_TIMEOUT_SECS", "3")
            .env("RUST_LOG", "relay_broker=error")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    ));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();
    let health = format!("http://{address}/api/health");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if client.get(&health).send().await.is_ok() {
                break;
            }
            assert!(
                broker.0.as_mut().unwrap().try_wait().unwrap().is_none(),
                "broker exited during startup"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let mut sockets = Vec::new();
    for _ in 0..100 {
        sockets.push(tokio::net::TcpStream::connect(address).await.unwrap());
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        broker.0.as_mut().unwrap().try_wait().unwrap().is_none(),
        "an accept error must not terminate the broker"
    );
    drop(sockets);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if client
                .get(&health)
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("HTTP serving must resume when descriptors are released");
    let mut child = broker.0.take().unwrap();
    child.kill().unwrap();
    let output = child.wait_with_output().unwrap();
    let logs = String::from_utf8(output.stdout).unwrap();
    assert!(
        logs.contains("broker TCP accept failed"),
        "the test must hit the accept error: {logs}"
    );
}
