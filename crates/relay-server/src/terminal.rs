use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{Arc, Mutex},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

pub fn supported_providers() -> Vec<String> {
    vec!["codex".to_string(), "claude_code".to_string()]
}

const OUTPUT_BYTES: usize = 1024 * 1024;
const READ_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInput {
    pub thread_id: String,
    pub device_id: Option<String>,
    pub terminal_id: Option<String>,
    pub data: Option<String>,
    pub input_stream_id: Option<String>,
    pub input_seq: Option<u64>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub offset: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalFrame {
    pub terminal_id: String,
    pub thread_id: String,
    pub cols: u16,
    pub rows: u16,
    pub offset: u64,
    pub reset: bool,
    pub data: String,
    pub exited: bool,
    pub exit_code: Option<u32>,
}

struct Output {
    bytes: VecDeque<u8>,
    offset: u64,
    screen: vt100::Parser,
    cols: u16,
    rows: u16,
    exited: bool,
    exit_code: Option<u32>,
}

impl Output {
    fn append(&mut self, bytes: &[u8]) {
        self.screen.process(bytes);
        self.offset += bytes.len() as u64;
        self.bytes.extend(bytes);
        let excess = self.bytes.len().saturating_sub(OUTPUT_BYTES);
        self.bytes.drain(..excess);
    }

    fn frame(&self, terminal: &Terminal, requested: Option<u64>) -> TerminalFrame {
        let start = self.offset - self.bytes.len() as u64;
        let reset = requested.is_none_or(|offset| offset < start || offset > self.offset);
        let (bytes, offset) = if reset {
            (self.screen.screen().state_formatted(), self.offset)
        } else {
            let requested = requested.unwrap();
            let bytes: Vec<_> = self
                .bytes
                .iter()
                .skip((requested - start) as usize)
                .take(READ_BYTES)
                .copied()
                .collect();
            let offset = requested + bytes.len() as u64;
            (bytes, offset)
        };
        TerminalFrame {
            terminal_id: terminal.id.clone(),
            thread_id: terminal.thread_id.clone(),
            cols: self.cols,
            rows: self.rows,
            offset,
            reset,
            data: STANDARD.encode(bytes),
            exited: self.exited,
            exit_code: self.exit_code,
        }
    }
}

struct Process {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    input_sequences: HashMap<(String, String), u64>,
}

pub struct Terminal {
    pub id: String,
    pub thread_id: String,
    actor: Mutex<String>,
    process: Mutex<Process>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Mutex<Output>,
    exited: tokio::sync::watch::Sender<bool>,
}

impl Terminal {
    pub fn spawn(
        thread_id: String,
        actor: String,
        command: CommandBuilder,
        cols: u16,
        rows: u16,
    ) -> Result<Arc<Self>, String> {
        let pair = native_pty_system()
            .openpty(size(cols, rows)?)
            .map_err(|error| format!("Cannot open terminal: {error}"))?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Cannot start native terminal: {error}"))?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let terminal = Arc::new(Self {
            id: crate::state::new_uuid_v4(),
            thread_id,
            actor: Mutex::new(actor),
            process: Mutex::new(Process {
                master: pair.master,
                writer,
                input_sequences: HashMap::new(),
            }),
            killer: Mutex::new(child.clone_killer()),
            output: Mutex::new(Output {
                bytes: VecDeque::new(),
                offset: 0,
                screen: vt100::Parser::new(rows, cols, 0),
                cols,
                rows,
                exited: false,
                exit_code: None,
            }),
            exited: tokio::sync::watch::channel(false).0,
        });
        let target = Arc::downgrade(&terminal);
        std::thread::spawn(move || {
            let mut buf = [0; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(len) => {
                        let Some(target) = target.upgrade() else {
                            break;
                        };
                        let mut output = target.output.lock().unwrap();
                        output.append(&buf[..len]);
                        if buf[..len].windows(4).any(|b| b == b"\x1b[6n") {
                            let (row, col) = output.screen.screen().cursor_position();
                            drop(output);
                            let _ = target
                                .write_raw(format!("\x1b[{};{}R", row + 1, col + 1).as_bytes());
                        }
                    }
                    Err(error) => {
                        tracing::debug!(%error, "terminal output closed");
                        break;
                    }
                }
            }
        });
        let target = Arc::downgrade(&terminal);
        std::thread::spawn(move || {
            let result = child.wait();
            if let Some(target) = target.upgrade() {
                let mut output = target.output.lock().unwrap();
                output.exited = true;
                output.exit_code = result.ok().map(|status| status.exit_code());
                target.exited.send_replace(true);
            }
        });
        Ok(terminal)
    }

    pub fn actor(&self) -> String {
        self.actor.lock().unwrap().clone()
    }

    pub fn write(&self, actor: &str, data: &str, stream: &str, seq: u64) -> Result<bool, String> {
        if data.len() > READ_BYTES {
            return Err("Terminal input exceeds 32 KiB".to_string());
        }
        if stream.is_empty() || stream.len() > 128 || seq == 0 {
            return Err("Terminal input needs a stream id and sequence".to_string());
        }
        if self.is_exited() {
            return Err("The native terminal has exited".to_string());
        }
        let mut process = self.process.lock().unwrap();
        let key = (actor.to_string(), stream.to_string());
        let previous = process.input_sequences.get(&key).copied().unwrap_or(0);
        if seq <= previous {
            return Ok(false);
        }
        if seq != previous + 1 {
            return Err("Terminal input sequence has a gap; reconnect before typing".to_string());
        }
        if previous == 0 && process.input_sequences.len() >= 128 {
            return Err(
                "Too many terminal input streams; close and reopen this terminal".to_string(),
            );
        }
        *self.actor.lock().unwrap() = actor.to_string();
        process
            .writer
            .write_all(data.as_bytes())
            .map_err(|error| error.to_string())?;
        process.writer.flush().map_err(|error| error.to_string())?;
        process.input_sequences.insert(key, seq);
        Ok(true)
    }

    pub fn is_exited(&self) -> bool {
        self.output.lock().unwrap().exited
    }

    async fn wait_for_exit(&self) {
        let _ = self.exited.subscribe().wait_for(|exited| *exited).await;
    }

    fn write_raw(&self, data: &[u8]) -> Result<(), String> {
        let mut process = self.process.lock().unwrap();
        process
            .writer
            .write_all(data)
            .map_err(|error| error.to_string())?;
        process.writer.flush().map_err(|error| error.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.process
            .lock()
            .unwrap()
            .master
            .resize(size(cols, rows)?)
            .map_err(|error| error.to_string())?;
        let mut output = self.output.lock().unwrap();
        output.screen.screen_mut().set_size(rows, cols);
        output.cols = cols;
        output.rows = rows;
        Ok(())
    }

    pub fn close(&self) -> Result<(), String> {
        self.killer
            .lock()
            .unwrap()
            .kill()
            .map_err(|error| error.to_string())
    }

    pub fn read(&self, offset: Option<u64>) -> TerminalFrame {
        self.output.lock().unwrap().frame(self, offset)
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        if let Err(error) = self.killer.get_mut().unwrap().kill() {
            tracing::debug!(%error, "terminal process already closed");
        }
    }
}

fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(20..=500).contains(&cols) || !(5..=200).contains(&rows) {
        return Err("Terminal size must be 20–500 columns and 5–200 rows".to_string());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_reconnect_restores_screen_after_scrollback_is_evicted() {
        let mut output = Output {
            bytes: VecDeque::new(),
            offset: 0,
            screen: vt100::Parser::new(24, 80, 0),
            cols: 80,
            rows: 24,
            exited: false,
            exit_code: None,
        };
        output.append(&vec![b'x'; OUTPUT_BYTES + 100]);
        output.append(b"\x1b[2J\x1b[Hsame session\x1b[3;7H");
        assert_eq!(output.bytes.len(), OUTPUT_BYTES);
        let mut restored = vt100::Parser::new(24, 80, 0);
        restored.process(&output.screen.screen().state_formatted());
        assert_eq!(restored.screen().contents(), "same session");
        assert_eq!(restored.screen().cursor_position(), (2, 6));
    }
    #[cfg(unix)]
    #[test]
    fn retried_native_input_is_written_once_and_gaps_are_refused() {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "stty -echo; printf READY; exec cat"]);
        let terminal =
            Terminal::spawn("test".to_string(), "desktop".to_string(), command, 80, 24).unwrap();
        let wait_for = |text: &str| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                let screen = terminal.output.lock().unwrap().screen.screen().contents();
                if screen.contains(text) {
                    return screen;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "missing {text}: {screen}"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        };
        wait_for("READY");
        terminal.write("phone", "ONCE\n", "stream", 1).unwrap();
        wait_for("ONCE");
        terminal.write("phone", "ONCE\n", "stream", 1).unwrap();
        assert!(terminal
            .write("phone", "GAP\n", "stream", 3)
            .unwrap_err()
            .contains("gap"));
        terminal.write("phone", "NEXT\n", "stream", 2).unwrap();
        let screen = wait_for("NEXT");
        assert_eq!(screen.matches("ONCE").count(), 1);
        assert!(!screen.contains("GAP"));
        assert_eq!(terminal.actor(), "phone");
        terminal.close().unwrap();
    }
}

pub async fn run_host() -> Result<(), String> {
    use serde_json::{json, Value};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    let mut terminal: Option<Arc<Terminal>> = None;
    let mut presentation_id = String::new();
    loop {
        let line = if let Some(terminal) = &terminal {
            tokio::select! {
                line = input.next_line() => line,
                () = terminal.wait_for_exit() => break,
            }
        } else {
            input.next_line().await
        };
        let Some(line) = line.map_err(|error| error.to_string())? else {
            break;
        };
        let cmd: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        let result: Result<serde_json::Value, String> =
            (|| match cmd["type"].as_str().unwrap_or_default() {
                "spawn" => {
                    if terminal.is_some() {
                        return Err("Terminal already started".to_string());
                    }
                    let mut command =
                        CommandBuilder::new(cmd["binary"].as_str().ok_or("Missing binary")?);
                    for arg in cmd["args"].as_array().ok_or("Missing arguments")? {
                        command.arg(arg.as_str().ok_or("Invalid argument")?);
                    }
                    command.cwd(cmd["cwd"].as_str().ok_or("Missing workspace")?);
                    command.env("TERM", "xterm-256color");
                    if let Some(env) = cmd["env"].as_object() {
                        for (key, value) in env {
                            command.env(key, value.as_str().ok_or("Invalid environment")?);
                        }
                    }
                    let spawned = Terminal::spawn(
                        cmd["session"]
                            .as_str()
                            .ok_or("Missing session")?
                            .to_string(),
                        "host".to_string(),
                        command,
                        100,
                        30,
                    )?;
                    presentation_id = spawned.id.clone();
                    terminal = Some(spawned);
                    Ok(json!({}))
                }
                "read" | "renew-input" => {
                    let terminal = terminal.as_ref().ok_or("Terminal not started")?;
                    if cmd["type"] == "renew-input" {
                        let mut process = terminal.process.lock().unwrap();
                        presentation_id = crate::state::new_uuid_v4();
                        process.input_sequences.clear();
                    }
                    let mut frame = terminal.read(cmd["offset"].as_u64());
                    frame.terminal_id = presentation_id.clone();
                    let mut value =
                        serde_json::to_value(frame).map_err(|error| error.to_string())?;
                    value["input_streams"] =
                        json!(terminal.process.lock().unwrap().input_sequences.len());
                    Ok(value)
                }
                "input" => {
                    if cmd
                        .get("terminal_id")
                        .is_some_and(|id| id != &presentation_id)
                    {
                        return Err("The native terminal changed; attach again".to_string());
                    }
                    let applied = terminal.as_ref().ok_or("Terminal not started")?.write(
                        cmd["device_id"].as_str().ok_or("Missing device")?,
                        cmd["data"].as_str().ok_or("Missing input")?,
                        cmd["input_stream_id"].as_str().ok_or("Missing stream")?,
                        cmd["input_seq"].as_u64().ok_or("Missing sequence")?,
                    )?;
                    Ok(json!({ "applied": applied }))
                }
                "resize" => {
                    let cols = u16::try_from(cmd["cols"].as_u64().ok_or("Missing columns")?)
                        .map_err(|error| error.to_string())?;
                    let rows = u16::try_from(cmd["rows"].as_u64().ok_or("Missing rows")?)
                        .map_err(|error| error.to_string())?;
                    terminal
                        .as_ref()
                        .ok_or("Terminal not started")?
                        .resize(cols, rows)?;
                    Ok(json!({}))
                }
                _ => Err("Unknown terminal host command".to_string()),
            })();
        let response = match result {
            Ok(result) => json!({ "id": cmd["id"], "ok": true, "result": result }),
            Err(error) => json!({ "id": cmd["id"], "ok": false, "error": error }),
        };
        output
            .write_all(format!("{response}\n").as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        output.flush().await.map_err(|error| error.to_string())?;
    }
    if let Some(terminal) = terminal {
        if !terminal.is_exited() {
            terminal.close()?;
        }
    }
    Ok(())
}
