use super::*;
mod api;
mod bridge;
pub(super) use api::Api;
pub(crate) use bridge::OpenCodeBridge;

impl AcpBridge {
    async fn list_opencode_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        let _discovery = self.discovery_lock.lock().await;
        let api = self
            .opencode_api
            .as_ref()
            .ok_or("OpenCode HTTP API is unavailable")?;
        let mut threads = Vec::new();
        let mut last_error = None;
        let mut succeeded = false;
        for cwd in self.opencode_history_directories().await {
            let mut cursor = None;
            for _ in 0..MAX_LIST_PAGES {
                let mut query = vec![("limit", "100".into()), ("roots", "true".into())];
                if let Some(value) = cursor {
                    query.push(("cursor", value));
                }
                let page = match timeout(
                    Duration::from_secs(15),
                    api.request(
                        reqwest::Method::GET,
                        "/experimental/session",
                        &cwd,
                        &query,
                        None,
                    ),
                )
                .await
                .map_err(|_| format!("OpenCode history timed out in {cwd}"))
                .and_then(|result| result)
                {
                    Ok(page) => {
                        succeeded = true;
                        page
                    }
                    Err(error) => {
                        let mut relay = self.state.write().await;
                        relay.push_log(
                            "warn",
                            format!("Could not list OpenCode history in {cwd}: {error}"),
                        );
                        relay.notify();
                        last_error = Some(error);
                        break;
                    }
                };
                let rows = page
                    .as_array()
                    .ok_or("OpenCode returned an invalid session list")?;
                for row in rows {
                    if row["directory"].as_str() != Some(cwd.as_str())
                        || !row["time"]["archived"].is_null()
                    {
                        continue;
                    }
                    let Some(id) = row["id"].as_str() else {
                        continue;
                    };
                    let mut thread = protocol::thread_summary(
                        &json!({"sessionId": id, "cwd": cwd, "title": row["title"]}),
                        "opencode",
                        crate::state::unix_now(),
                    )
                    .unwrap();
                    thread.updated_at = row["time"]["updated"].as_u64().unwrap_or_default() / 1000;
                    threads.push(thread);
                }
                if rows.len() < 100 {
                    break;
                }
                cursor = rows
                    .last()
                    .and_then(|row| row["time"]["updated"].as_u64())
                    .map(|v| v.to_string());
                if cursor.is_none() {
                    break;
                }
            }
        }
        if !succeeded {
            if let Some(error) = last_error {
                return Err(error);
            }
        }
        threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let mut seen = std::collections::HashSet::new();
        threads.retain(|thread| seen.insert(thread.id.clone()));
        absorb_thread_cwds(&mut *self.sessions.lock().await, &threads);
        threads.truncate(limit);
        Ok(threads)
    }

    pub(super) async fn opencode_history_directories(&self) -> Vec<String> {
        let runtimes: Vec<_> = self
            .sessions
            .lock()
            .await
            .iter()
            .map(|(id, session)| (id.clone(), session.cwd.clone(), session.attached))
            .collect();
        let mut directories = {
            let relay = self.state.read().await;
            let mut directories = relay.history_working_directories("opencode");
            directories.extend(runtimes.into_iter().filter_map(|(id, cwd, attached)| {
                (attached || relay.session_for_provider_handle("opencode", &id).is_some())
                    .then_some(cwd)
            }));
            directories
        };
        directories.retain(|cwd| !cwd.is_empty());
        directories.sort();
        directories.dedup();
        let mut existing = Vec::new();
        for cwd in directories {
            if tokio::fs::metadata(&cwd)
                .await
                .is_ok_and(|meta| meta.is_dir())
            {
                existing.push(cwd);
            }
        }
        existing
    }

    pub(super) async fn ensure_opencode_attached(&self, id: &str) -> Result<(), String> {
        let (mut approval, mut sandbox) = {
            let sessions = self.sessions.lock().await;
            if sessions.get(id).is_some_and(|s| s.attached) {
                return Ok(());
            }
            let session = sessions.get(id);
            (
                session
                    .map(|s| s.approval_policy.clone())
                    .filter(|p| !p.is_empty())
                    .unwrap_or_else(|| "on-request".into()),
                session
                    .map(|s| s.sandbox.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "workspace-write".into()),
            )
        };
        let settings = {
            let relay = self.state.read().await;
            let session_id = relay
                .session_for_provider_handle(self.provider_name, id)
                .unwrap_or_else(|| id.to_string());
            relay.thread_settings(&session_id)
        };
        if let Some(settings) = settings {
            approval = settings.approval_policy;
            sandbox = settings.sandbox;
        }
        if !self.capabilities.lock().await.load_session {
            return Err("OpenCode does not support reattaching a closed session".into());
        }
        self.resume_thread(id, &approval, &sandbox).await
    }

    pub(super) async fn cleanup_opencode_session(&self, id: &str) {
        let close = self
            .send_request("session/close", json!({"sessionId": id}))
            .await;
        let deleted = self.delete_opencode_session(id).await;
        forget_session(&self.sessions, id).await;
        if let Err(error) = close.and(deleted.map(|_| ())) {
            let mut relay = self.state.write().await;
            relay.push_log(
                "warn",
                format!("Could not clean up unused OpenCode session {id}: {error}"),
            );
            relay.notify();
        }
    }

    pub(super) async fn discover_opencode_models(
        &self,
        cwd: &str,
        update_catalog: bool,
    ) -> Result<String, String> {
        if !self.capabilities.lock().await.close_session {
            return Err(
                "OpenCode must support ACP session/close for model discovery; update OpenCode"
                    .into(),
            );
        }
        // Listing takes the same lock so the temporary session never reaches the sidebar.
        let _discovery = self.discovery_lock.lock().await;
        let result = self
            .send_request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
            .await?;
        let id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or("OpenCode returned no sessionId during model discovery")?;
        let mut session = SessionRuntime::default();
        absorb_session_settings(&mut session, &result);
        if update_catalog {
            self.absorb_catalog(&result, true).await;
        }

        self.cleanup_opencode_session(id).await;
        if session.model.is_empty() {
            return Err(
                "OpenCode did not report a default model; configure a model with `opencode`".into(),
            );
        }
        Ok(session.model)
    }

    pub(super) async fn delete_opencode_session(&self, id: &str) -> Result<bool, String> {
        if !id.starts_with("ses_") || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err("Invalid OpenCode session id".into());
        }
        let mut command = Command::new(crate::provider::resolve_binary(self.binary_name));
        command
            .args(["session", "delete", id])
            .current_dir(discovery_directory().await?)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let output = timeout(Duration::from_secs(30), command.output())
            .await
            .map_err(|_| "OpenCode session deletion timed out".to_string())?
            .map_err(|error| format!("Could not delete OpenCode session: {error}"))?;
        if !output.status.success() {
            let error = plain_cli_error(&String::from_utf8_lossy(&output.stderr));
            if output.status.code() == Some(1)
                && error.trim() == format!("Error: Session not found: {id}")
            {
                return Ok(false);
            }
            return Err(format!(
                "OpenCode session deletion failed: {}",
                error.trim()
            ));
        }
        Ok(true)
    }
}

pub(super) async fn discovery_directory() -> Result<std::path::PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let directory = crate::state_paths::state_dir(&cwd).join("opencode-discovery");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| error.to_string())?;
    Ok(directory)
}

fn plain_cli_error(value: &str) -> String {
    let mut text = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            text.push(ch);
        }
    }
    text
}
