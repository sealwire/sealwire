use super::*;
use crate::terminal::{Terminal, TerminalFrame, TerminalInput};
use futures_util::{SinkExt, StreamExt};
use portable_pty::CommandBuilder;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

impl AppState {
    async fn terminal_scope(&self, thread: &str, device: &str) -> Result<String, String> {
        let thread = self.canonical_session_id(thread).await?;
        let relay = self.relay.read().await;
        if relay.orchestrator_acting_device_is_revoked(device) {
            return Err("This device has been revoked".to_string());
        }
        let cwd = relay
            .thread_cwd(&thread)
            .ok_or("Unknown terminal session")?;
        relay.workspace_scope(Some(device)).ensure(&cwd)?;
        Ok(thread)
    }

    pub async fn open_terminal(&self, input: TerminalInput) -> Result<TerminalFrame, String> {
        let device = require_device_id(input.device_id.clone())?;
        let thread = self.terminal_scope(&input.thread_id, &device).await?;
        let target = self.resolve_session_target(&thread).await?;
        if target.provider == "claude_code" {
            let mut routes = self.claude_terminal_routes.lock().await;
            let events = if !routes.contains(&thread) {
                target.bridge().native_terminal_events()
            } else {
                None
            };
            let value = self
                .claude_terminal_request(&thread, &device, "terminal/open", &input)
                .await?;
            if let Some(events) = events {
                routes.insert(thread.clone());
                let app = self.clone();
                let thread = thread.clone();
                tokio::spawn(async move {
                    app.serve_native_claude(thread, events).await;
                });
            }
            return serde_json::from_value(value).map_err(|error| error.to_string());
        }
        let mut terminals = self.terminals.lock().await;
        if let Some(terminal) = terminals.get(&thread) {
            if !terminal.is_exited() {
                return Ok(terminal.read(None));
            }
        }
        terminals.retain(|_, terminal| !terminal.is_exited());
        if terminals.len() >= 8 {
            return Err(
                "At most 8 native terminals may be open; close one before opening another"
                    .to_string(),
            );
        }
        let target = self.resolve_session_target(&thread).await?;
        let binary = target
            .bridge()
            .native_terminal_binary()
            .ok_or("Native terminal is not available for this provider")?;
        let cwd = self
            .relay
            .read()
            .await
            .thread_cwd(&thread)
            .ok_or("Session has no workspace")?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| error.to_string())?;
        let token = crate::state::new_uuid_v4();
        let endpoint = format!(
            "ws://{}",
            listener.local_addr().map_err(|error| error.to_string())?
        );
        let mut command = CommandBuilder::new(binary);
        command.args([
            "--remote",
            &endpoint,
            "--remote-auth-token-env",
            "SEALWIRE_NATIVE_CODEX_TOKEN",
            "--no-alt-screen",
            "resume",
            &target.provider_handle,
        ]);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("SEALWIRE_NATIVE_CODEX_TOKEN", &token);
        let terminal = Terminal::spawn(
            thread.clone(),
            device,
            command,
            input.cols.unwrap_or(100),
            input.rows.unwrap_or(30),
        )?;
        let frame = terminal.read(None);
        terminals.insert(thread.clone(), terminal.clone());
        let app = self.clone();
        let weak = Arc::downgrade(&terminal);
        drop(terminals);
        tokio::spawn(async move {
            let accepted = tokio::time::timeout(Duration::from_secs(30), listener.accept()).await;
            let Ok(Ok((socket, _))) = accepted else {
                return;
            };
            let upgraded = tokio_tungstenite::accept_hdr_async(
                socket,
                move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                      response| {
                    if request
                        .headers()
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        != Some(format!("Bearer {token}").as_str())
                        || request.headers().contains_key("origin")
                    {
                        return Err(axum::http::Response::builder()
                            .status(403)
                            .body(Some("Invalid native terminal connection".to_string()))
                            .unwrap());
                    }
                    Ok(response)
                },
            )
            .await;
            let Ok(socket) = upgraded else { return };
            let Some(terminal) = weak.upgrade() else {
                return;
            };
            if let Err(error) = app.serve_native_codex(terminal, socket).await {
                app.push_runtime_log("error", format!("Native terminal disconnected: {error}"))
                    .await;
            }
        });
        Ok(frame)
    }

    pub async fn read_terminal(&self, input: TerminalInput) -> Result<TerminalFrame, String> {
        let device = require_device_id(input.device_id.clone())?;
        let thread = self.terminal_scope(&input.thread_id, &device).await?;
        if self.resolve_session_target(&thread).await?.provider == "claude_code" {
            let value = self
                .claude_terminal_request(&thread, &device, "terminal/read", &input)
                .await?;
            return serde_json::from_value(value).map_err(|error| error.to_string());
        }
        let terminal = self
            .terminals
            .lock()
            .await
            .get(&thread)
            .cloned()
            .ok_or("The native terminal is not open")?;
        if input.terminal_id.as_deref() != Some(&terminal.id) {
            return Err("The native terminal has changed; attach again".to_string());
        }
        Ok(terminal.read(input.offset))
    }

    pub async fn write_terminal(&self, input: TerminalInput) -> Result<(), String> {
        let device = require_device_id(input.device_id.clone())?;
        let thread = self.terminal_scope(&input.thread_id, &device).await?;
        if self.resolve_session_target(&thread).await?.provider == "claude_code" {
            let control = input.data.as_deref().is_some_and(|data| {
                data == "\x1b"
                    || data
                        .chars()
                        .any(|ch| matches!(ch, '\x03' | '\x04' | '\x1a'))
            });
            if control {
                let result = self
                    .claude_terminal_request(&thread, &device, "terminal/control", &input)
                    .await?;
                if result["applied"] == true && result["needs_stop"] == true {
                    self.stop_active_turn(StopTurnInput {
                        thread_id: thread,
                        device_id: Some(device),
                    })
                    .await?;
                    self.commit_core().await?;
                }
            } else {
                self.claude_terminal_request(&thread, &device, "terminal/input", &input)
                    .await?;
            }
            return Ok(());
        }
        let terminal = self
            .terminals
            .lock()
            .await
            .get(&thread)
            .cloned()
            .ok_or("The native terminal is not open")?;
        if input.terminal_id.as_deref() != Some(&terminal.id) {
            return Err("The native terminal has changed; attach again".to_string());
        }
        tokio::task::spawn_blocking(move || {
            if let Some(data) = input.data {
                terminal.write(
                    &device,
                    &data,
                    input
                        .input_stream_id
                        .as_deref()
                        .ok_or("Terminal input needs a stream id")?,
                    input.input_seq.ok_or("Terminal input needs a sequence")?,
                )?;
            }
            if let (Some(cols), Some(rows)) = (input.cols, input.rows) {
                terminal.resize(cols, rows)?;
            }
            Ok(())
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub async fn close_terminal(&self, input: TerminalInput) -> Result<(), String> {
        let device = require_device_id(input.device_id.clone())?;
        let thread = self.terminal_scope(&input.thread_id, &device).await?;
        if self.resolve_session_target(&thread).await?.provider == "claude_code" {
            self.claude_terminal_request(&thread, &device, "terminal/close", &input)
                .await?;
            return Ok(());
        }
        let mut terminals = self.terminals.lock().await;
        let terminal = terminals
            .get(&thread)
            .ok_or("The native terminal is not open")?;
        if input.terminal_id.as_deref() != Some(&terminal.id) {
            return Err("The native terminal has changed; attach again".to_string());
        }
        terminal.close()?;
        terminals.remove(&thread);
        Ok(())
    }

    pub(super) async fn release_thread_terminal(&self, thread: &str) {
        if let Some(terminal) = self.terminals.lock().await.remove(thread) {
            if let Err(error) = terminal.close() {
                tracing::debug!(%error, "native terminal already closed");
            }
        }
    }

    async fn claude_terminal_request(
        &self,
        thread: &str,
        device: &str,
        method: &str,
        input: &TerminalInput,
    ) -> Result<Value, String> {
        let target = self.resolve_session_target(thread).await?;
        let mut params = serde_json::to_value(input).map_err(|error| error.to_string())?;
        params["provider_session_id"] = json!(target.provider_handle);
        params["device_id"] = json!(device);
        let mut value = target
            .bridge()
            .native_terminal_request(method, params)
            .await?;
        if value.get("thread_id").is_some() {
            value["thread_id"] = json!(thread);
        }
        Ok(value)
    }

    async fn serve_native_claude(
        &self,
        thread: String,
        mut events: tokio::sync::broadcast::Receiver<Value>,
    ) {
        while let Ok(event) = events.recv().await {
            let Ok(target) = self.resolve_session_target(&thread).await else {
                break;
            };
            if event["provider_session_id"].as_str() != Some(target.provider_handle.as_str()) {
                continue;
            }
            let request = event["id"].as_str().unwrap_or_default();
            let device = event["device_id"].as_str().unwrap_or_default();
            let result = async {
                self.terminal_scope(&thread, device).await?;
                let _slot = self.acquire_session_slot()?;
                let text = event["text"].as_str().ok_or("Native input has no text")?;
                self.send_message_with_native_request(
                    SendMessageInput {
                        thread_id: thread.clone(),
                        device_id: Some(device.to_string()),
                        text: text.to_string(),
                        model: None,
                        effort: None,
                    },
                    &[],
                    None,
                    Some(request),
                )
                .await?;
                self.commit_core().await
            }
            .await;
            if let Err(error) = result {
                let _ = target.bridge().native_terminal_request("native/decision", json!({ "provider_session_id": target.provider_handle, "request_id": request, "error": error })).await;
            }
        }
        self.claude_terminal_routes.lock().await.remove(&thread);
    }

    async fn serve_native_codex(
        &self,
        terminal: Arc<Terminal>,
        mut socket: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) -> Result<(), String> {
        let target = self.resolve_session_target(&terminal.thread_id).await?;
        let mut events = target
            .bridge()
            .native_terminal_events()
            .ok_or("Provider has no native events")?;
        let mut pending = HashSet::new();
        loop {
            tokio::select! {
                incoming = socket.next() => {
                    let Some(incoming) = incoming else { break };
                    let incoming = incoming.map_err(|error| error.to_string())?;
                    if let Message::Text(text) = incoming {
                        let request: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
                        let id = request.get("id").cloned();
                        if let Some(method) = request.get("method").and_then(Value::as_str) {
                            if id.is_none() { continue; }
                            let result = self.native_codex_request(&terminal.thread_id, &terminal.actor(), method, request.get("params").cloned().unwrap_or_else(|| json!({}))).await;
                            let response = match result {
                                Ok(result) => json!({ "id": id, "result": result }),
                                Err(message) => json!({ "id": id, "error": { "code": -32000, "message": message } }),
                            };
                            socket.send(Message::Text(response.to_string())).await.map_err(|error| error.to_string())?;
                        } else if let Some(id) = id {
                            if let Err(error) = self.native_codex_approval(&terminal.thread_id, &terminal.actor(), &id, &request["result"]).await {
                                self.push_runtime_log("error", format!("Native approval refused: {error}")).await;
                            }
                        }
                    } else if incoming.is_close() { break; }
                }
                event = events.recv() => {
                    let event = event.map_err(|error| format!("Native event stream lost: {error}"))?;
                    let handle = event["params"]["threadId"].as_str().or_else(|| event["params"]["thread"]["id"].as_str());
                    let resolved = event["method"] == "serverRequest/resolved"
                        && pending.remove(&event["params"]["requestId"].to_string());
                    if handle == Some(target.provider_handle.as_str()) || resolved {
                        if let Some(id) = event.get("id") {
                            pending.insert(id.to_string());
                        }
                        self.terminal_scope(&terminal.thread_id, &terminal.actor()).await?;
                        socket.send(Message::Text(event.to_string())).await.map_err(|error| error.to_string())?;
                    }
                }
            }
        }
        Ok(())
    }

    pub(super) async fn native_codex_request(
        &self,
        thread: &str,
        device: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let thread = self.terminal_scope(thread, device).await?;
        let target = self.resolve_session_target(&thread).await?;
        if let Some(requested) = params.get("threadId").and_then(Value::as_str) {
            if requested != target.provider_handle {
                return Err("Use Sealwire session navigation to switch terminals".to_string());
            }
        }
        match method {
            "initialize" => target.bridge().native_terminal_request(method, params).await,
            "thread/start" | "thread/resume" => {
                let data = target.bridge().native_terminal_request("thread/read", json!({ "threadId": target.provider_handle, "includeTurns": true })).await?;
                let settings = self.thread_settings_view(Some(device.to_string()), &thread).await?;
                let cwd = data["thread"]["cwd"].clone();
                let sandbox = match crate::codex::resolve_codex_policy(&settings.approval_policy, &settings.sandbox).1 {
                    "danger-full-access" => json!({ "type": "dangerFullAccess" }),
                    "read-only" => json!({ "type": "readOnly", "networkAccess": false }),
                    _ => json!({ "type": "workspaceWrite", "writableRoots": [cwd], "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false }),
                };
                Ok(json!({ "thread": data["thread"], "model": settings.model, "modelProvider": data["thread"]["modelProvider"], "reasoningEffort": settings.reasoning_effort, "approvalPolicy": crate::codex::resolve_codex_policy(&settings.approval_policy, &settings.sandbox).0, "approvalsReviewer": "user", "sandbox": sandbox, "cwd": cwd, "serviceTier": null }))
            }
            "thread/read" | "thread/turns/list" | "thread/items/list" => target.bridge().native_terminal_request(method, params).await,
            "thread/list" => {
                let data = target.bridge().native_terminal_request("thread/read", json!({ "threadId": target.provider_handle, "includeTurns": false })).await?;
                Ok(json!({ "data": [data["thread"]], "nextCursor": null }))
            }
            "turn/start" => {
                let _slot = self.acquire_session_slot()?;
                let settings = self.thread_settings_view(Some(device.to_string()), &thread).await?;
                let (approval, sandbox) = crate::codex::resolve_codex_policy(&settings.approval_policy, &settings.sandbox);
                if params.get("approvalPolicy").is_some_and(|value| !value.is_null() && value != approval)
                    || params.get("sandboxPolicy").is_some_and(|value| !value.is_null() && value["type"] != match sandbox {
                        "danger-full-access" => "dangerFullAccess", "read-only" => "readOnly", _ => "workspaceWrite",
                    }) {
                    return Err("Change permissions with the Sealwire session controls before sending".to_string());
                }
                if params["collaborationMode"]["mode"] == "plan" {
                    return Err("Use the Sealwire goal controls to start a managed plan".to_string());
                }
                let items = params["input"].as_array().ok_or("Native turn has no input")?;
                let mut text = Vec::new();
                let mut images = Vec::new();
                let mut skill = None;
                for item in items {
                    match item["type"].as_str() {
                        Some("text") => text.push(item["text"].as_str().ok_or("Invalid native text")?.to_string()),
                        Some("image") => images.push(crate::LocalImageInput { data_url: item["url"].as_str().ok_or("Invalid native image")?.to_string() }),
                        Some("localImage") => {
                            use base64::Engine;
                            use tokio::io::AsyncReadExt;
                            let cwd = self.relay.read().await.thread_cwd(&thread).ok_or("Session has no workspace")?;
                            let path = std::path::Path::new(item["path"].as_str().ok_or("Invalid native image path")?).canonicalize().map_err(|error| error.to_string())?;
                            let root = std::path::Path::new(&cwd).canonicalize().map_err(|error| error.to_string())?;
                            if !path.starts_with(root) { return Err("Upload images outside the workspace with the Sealwire composer".to_string()); }
                            let mut bytes = Vec::new();
                            tokio::fs::File::open(&path).await.map_err(|error| error.to_string())?.take(crate::MAX_LOCAL_MESSAGE_IMAGE_BYTES as u64 + 1).read_to_end(&mut bytes).await.map_err(|error| error.to_string())?;
                            let media_type = match path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
                                "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", _ => return Err("Unsupported native image type".to_string()),
                            };
                            images.push(crate::LocalImageInput { data_url: format!("data:{media_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)) });
                        }
                        Some("skill") => {
                            if skill.is_some() { return Err("Choose one skill per message, as in the Sealwire composer".to_string()); }
                            skill = Some(crate::protocol::SkillInvocationInput { name: item["name"].as_str().ok_or("Invalid native skill")?.to_string(), path: item["path"].as_str().map(str::to_string) });
                        }
                        _ => return Err("This native input type is not supported by the Sealwire composer".to_string()),
                    }
                }
                let images = crate::parse_local_message_images(images)?;
                let (_, turn) = self.send_message_inner_with_turn(SendMessageInput {
                    text: text.join("\n"), thread_id: thread, device_id: Some(device.to_string()),
                    model: None,
                    effort: None,
                }, &images, skill.as_ref()).await?;
                self.commit_core().await?;
                let turn = turn.ok_or("Provider did not return a turn id")?;
                Ok(json!({ "turn": { "id": turn, "items": [], "status": "inProgress", "error": null } }))
            }
            "turn/interrupt" => {
                self.stop_active_turn(StopTurnInput { thread_id: thread, device_id: Some(device.to_string()) }).await?;
                self.commit_core().await?;
                Ok(json!({}))
            }
            "config/read" | "configRequirements/read" | "account/read" | "account/rateLimits/read" | "model/list" | "mcpServerStatus/list" => target.bridge().native_terminal_request(method, params).await,
            "skills/list" => {
                let cwd = self.relay.read().await.thread_cwd(&thread).ok_or("Session has no workspace")?;
                target.bridge().native_terminal_request(method, json!({ "cwds": [cwd] })).await
            }
            _ => Err(format!("Native `{method}` is not available in this managed session; use the Sealwire session controls")),
        }
    }

    async fn native_codex_approval(
        &self,
        thread: &str,
        device: &str,
        raw_id: &Value,
        result: &Value,
    ) -> Result<(), String> {
        let id = match raw_id {
            Value::String(id) => id.clone(),
            other => other.to_string(),
        };
        let pending = self
            .relay
            .read()
            .await
            .pending_approvals
            .get(&id)
            .cloned()
            .filter(|pending| pending.thread_id == thread && pending.raw_request_id == *raw_id)
            .ok_or("No pending approval for this terminal")?;
        let (decision, scope) = if matches!(pending.kind, crate::state::ApprovalKind::Permissions) {
            let granted = result
                .get("permissions")
                .ok_or("Native response has no permissions")?;
            let decision = if granted == &json!({}) {
                ApprovalDecision::Deny
            } else if Some(granted) == pending.requested_permissions.as_ref() {
                ApprovalDecision::Approve
            } else {
                return Err(
                    "Use the Sealwire approval card to change the requested permissions"
                        .to_string(),
                );
            };
            let scope = match result["scope"].as_str() {
                Some("session") => Some(crate::protocol::ApprovalScope::Session),
                Some("turn") | None => None,
                _ => return Err("Invalid native permission scope".to_string()),
            };
            (decision, scope)
        } else {
            match result["decision"].as_str() {
                Some("accept") => (ApprovalDecision::Approve, None),
                Some("acceptForSession") => (
                    ApprovalDecision::Approve,
                    Some(crate::protocol::ApprovalScope::Session),
                ),
                Some("decline") => (ApprovalDecision::Deny, None),
                Some("cancel") => (ApprovalDecision::Cancel, None),
                _ => {
                    return Err(
                        "Use the Sealwire approval card for this permission request".to_string()
                    )
                }
            }
        };
        self.decide_approval(
            &id,
            ApprovalDecisionInput {
                decision,
                scope,
                device_id: Some(device.to_string()),
            },
        )
        .await
        .map_err(|error| format!("{error:?}"))?;
        self.commit_core().await?;
        Ok(())
    }
}
