use std::{
    collections::HashMap,
    ffi::OsStr,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot, Mutex},
    time::{timeout, Duration},
};

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

pub(super) enum Event {
    Record(Value),
    Diagnostic(String),
    Closed(String),
    Barrier(oneshot::Sender<()>),
}

pub(super) struct Connection {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Pending,
    sequence: AtomicU64,
    events: mpsc::UnboundedSender<Event>,
    pub closed: Arc<AtomicBool>,
}

impl Connection {
    pub async fn spawn(
        binary: &OsStr,
        cwd: &Path,
        args: &[String],
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Event>), String> {
        Self::spawn_with_env(binary, cwd, args, &[]).await
    }

    pub async fn spawn_with_env(
        binary: &OsStr,
        cwd: &Path,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Event>), String> {
        let mut command = Command::new(binary);
        command
            .args(["--mode", "rpc"])
            .args(args)
            .env_remove("SEALWIRE_PI_MCP")
            .env_remove("RELAY_API_TOKEN")
            .env_remove("SEALWIRE_ASK_TOKEN")
            .env_remove("SEALWIRE_SEAT_RUN_ID")
            .env_remove("SEALWIRE_DEVICE_ID")
            .envs(env.iter().cloned())
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Pi's SIGTERM handler also terminates its detached bash process groups.
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(not(unix))]
        command.kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to start Pi: {e}"))?;
        let stdin = child.stdin.take().ok_or("Pi stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Pi stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Pi stderr unavailable")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let (events, receiver) = mpsc::unbounded_channel();
        let reader_pending = pending.clone();
        let reader_closed = closed.clone();
        let diagnostics = events.clone();
        let barriers = events.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut bytes = Vec::new();
            while let Ok(count) = reader.read_until(b'\n', &mut bytes).await {
                if count == 0 {
                    break;
                }
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                tracing::warn!("Pi stderr: {line}");
                bytes.clear();
                let _ = diagnostics.send(Event::Diagnostic(line));
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let reason = loop {
                let line = match lines.next_line().await {
                    Ok(Some(line)) => line,
                    Ok(None) => break "Pi RPC stream closed".to_string(),
                    Err(e) => break format!("Pi RPC read failed: {e}"),
                };
                if line.is_empty() {
                    continue;
                }
                let record: Value = match serde_json::from_str(&line) {
                    Ok(value) => value,
                    Err(e) => break format!("Invalid Pi RPC record: {e}"),
                };
                if record["type"] == "response" {
                    let id = record["id"].as_str().unwrap_or_default();
                    if let Some(sender) = reader_pending.lock().await.remove(id) {
                        let result = if record["success"] == true {
                            Ok(record["data"].clone())
                        } else {
                            Err(record["error"]
                                .as_str()
                                .unwrap_or("Pi command failed")
                                .to_string())
                        };
                        let _ = sender.send(result);
                    }
                } else if events.send(Event::Record(record)).is_err() {
                    break "Pi event consumer closed".to_string();
                }
            };
            reader_closed.store(true, Ordering::Release);
            for (_, sender) in reader_pending.lock().await.drain() {
                let _ = sender.send(Err(reason.clone()));
            }
            let _ = events.send(Event::Closed(reason));
        });
        Ok((
            Arc::new(Self {
                child: Mutex::new(child),
                stdin: Mutex::new(Some(stdin)),
                pending,
                sequence: AtomicU64::new(1),
                closed,
                events: barriers,
            }),
            receiver,
        ))
    }

    pub async fn write(&self, record: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        let stdin = stdin.as_mut().ok_or("Pi connection is closed")?;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("Pi RPC write failed: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Pi RPC flush failed: {e}"))
    }

    pub async fn request(&self, mut record: Value) -> Result<Value, String> {
        // Prompt preflight can compact history or await hooks; abort waits for tool shutdown.
        let unbounded = matches!(record["type"].as_str(), Some("prompt" | "abort"));
        let id = format!("pi-{}", self.sequence.fetch_add(1, Ordering::Relaxed));
        record["id"] = json!(id);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if self.closed.load(Ordering::Acquire) {
                return Err("Pi connection is closed".into());
            }
            pending.insert(id.clone(), sender);
        }
        let result = async {
            self.write(record).await?;
            receiver
                .await
                .map_err(|_| "Pi response channel closed".to_string())?
        };
        let result = if unbounded {
            result.await
        } else {
            timeout(Duration::from_secs(30), result)
                .await
                .unwrap_or_else(|_| Err("Pi RPC command timed out".into()))
        };
        self.pending.lock().await.remove(&id);
        result
    }

    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let mut child = self.child.lock().await;
        // EOF removes Pi's signal handlers before awaiting shutdown hooks.
        // Signal first, while its handler can still kill detached tool processes.
        terminate(&mut child);
        if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
            kill_group(&mut child);
            let _ = child.wait().await;
        }
        self.stdin.lock().await.take();
    }

    pub async fn kill(&self) {
        self.closed.store(true, Ordering::Release);
        let mut child = self.child.lock().await;
        kill_group(&mut child);
        let _ = child.wait().await;
        self.stdin.lock().await.take();
    }

    pub async fn drain_events(&self) -> Result<(), String> {
        let (sender, receiver) = oneshot::channel();
        self.events
            .send(Event::Barrier(sender))
            .map_err(|_| "Pi event consumer closed")?;
        receiver
            .await
            .map_err(|_| "Pi event consumer closed".into())
    }
}

fn kill_group(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
            let _ = child.start_kill();
        }
    }
}

fn terminate(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
            let _ = child.start_kill();
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        terminate(self.child.get_mut());
    }
}
