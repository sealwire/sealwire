#![cfg(unix)]

use std::{process::Stdio, time::Duration};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
};

struct Host {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    id: u64,
    events: std::collections::VecDeque<Value>,
}

impl Host {
    fn launch(state: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_relay-server"))
            .arg("terminal-host")
            .env("RELAY_STATE_DB", state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()).lines(),
            child,
            id: 0,
            events: std::collections::VecDeque::new(),
        }
    }

    async fn call(&mut self, mut value: Value) -> Value {
        self.id += 1;
        value["id"] = json!(self.id);
        self.input
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
        loop {
            let line = tokio::time::timeout(Duration::from_secs(5), self.output.next_line())
                .await
                .expect("host reply")
                .unwrap()
                .expect("host still running");
            let value: Value = serde_json::from_str(&line).unwrap();
            if value.get("event").is_some() {
                self.events.push_back(value);
                continue;
            }
            assert_eq!(value["id"], self.id);
            return value;
        }
    }

    async fn next_event(&mut self) -> Value {
        if let Some(event) = self.events.pop_front() {
            return event;
        }
        serde_json::from_str(&self.output.next_line().await.unwrap().expect("host event")).unwrap()
    }
}

#[tokio::test]
async fn cli_exit_ends_the_terminal_host_without_waiting_for_another_command() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("unused.db");
    let mut host = Host::launch(&state);
    let started = host.call(json!({"type":"spawn", "binary":"/bin/sh", "args":["-c", "exit 0"], "session":"host-test", "cwd":dir.path()})).await;
    assert_eq!(started["ok"], true);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), host.child.wait())
            .await
            .expect("host must observe CLI exit")
            .unwrap()
            .success()
    );
    assert!(!state.exists());
}

#[tokio::test]
async fn terminal_host_pushes_output_and_preserves_the_final_screen_on_exit() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::launch(&dir.path().join("unused.db"));
    host.call(json!({"type":"spawn", "binary":"/bin/sh", "args":["-c", "stty -echo; read line; printf 'PUSH_你好'; read line; printf '\\r\\nFINAL_完了'"], "session":"push", "cwd":dir.path()})).await;
    host.call(json!({"type":"input", "device_id":"phone", "input_stream_id":"view", "input_seq":1, "data":"first\n"})).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if host.next_event().await["event"] == "output" {
                break;
            }
        }
    })
    .await
    .expect("unsolicited output notification");
    host.call(json!({"type":"input", "device_id":"phone", "input_stream_id":"view", "input_seq":2, "data":"exit\n"})).await;
    let final_frame = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = host.next_event().await;
            if value["event"] == "exited" {
                break value["frame"].clone();
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(final_frame["exited"], true);
    let bytes = STANDARD
        .decode(final_frame["data"].as_str().unwrap())
        .unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("FINAL_完了"));
    assert!(host.child.wait().await.unwrap().success());
}

#[tokio::test]
async fn renewing_input_rejects_old_retries_and_preserves_the_running_pty() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::launch(&dir.path().join("unused.db"));
    assert_eq!(host.call(json!({"type":"spawn", "binary":"/bin/sh", "args":["-c", "stty -echo; printf READY; exec cat"], "session":"host-test", "cwd":dir.path()})).await["ok"], true);
    let frame = host.call(json!({"type":"read"})).await["result"].clone();
    let previous = frame["terminal_id"].clone();
    for n in 0..128 {
        assert_eq!(host.call(json!({"type":"input", "terminal_id":previous, "device_id":"phone", "input_stream_id":format!("view-{n}"), "input_seq":1, "data":""})).await["ok"], true);
    }
    assert_eq!(
        host.call(json!({"type":"read"})).await["result"]["input_streams"],
        128
    );
    let renewed = host.call(json!({"type":"renew-input"})).await;
    assert_eq!(renewed["ok"], true);
    let current = renewed["result"]["terminal_id"].clone();
    assert_ne!(current, previous);
    let stale = host.call(json!({"type":"input", "terminal_id":previous, "device_id":"other-device", "input_stream_id":"view-0", "input_seq":1, "data":"STALE\n"})).await;
    assert_eq!(stale["ok"], false);
    assert!(stale["error"].as_str().unwrap().contains("changed"));
    assert_eq!(
        host.call(json!({"type":"status", "terminal_id":current}))
            .await["result"]["actor"],
        "phone"
    );
    assert_eq!(host.call(json!({"type":"input", "terminal_id":current, "device_id":"phone", "input_stream_id":"new-view", "input_seq":1, "data":"NEXT\n"})).await["ok"], true);
    let mut screen = String::new();
    for _ in 0..100 {
        use base64::Engine;
        let reply = host.call(json!({"type":"read"})).await;
        let data = base64::engine::general_purpose::STANDARD
            .decode(reply["result"]["data"].as_str().unwrap())
            .unwrap();
        screen = String::from_utf8_lossy(&data).into_owned();
        if screen.contains("NEXT") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(screen.contains("NEXT"));
    assert!(!screen.contains("STALE"));
    drop(host.input);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), host.child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}
