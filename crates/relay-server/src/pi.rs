use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{
        ApprovalDecisionInput, ModelOptionView, ProviderSkillView, ThreadSummaryView,
        TranscriptEntryView,
    },
    provider::{
        ProviderBridge, ProviderImage, StartThreadRequest, StartThreadResult, ThreadSyncData,
        ThreadTranscriptPageData,
    },
    state::{PendingApproval, RelayState},
};

mod events;
mod history;
mod index;
mod mcp;
mod reaper;
#[cfg(test)]
mod tests;
mod transport;
mod ui;

use history::{Document, MessageIds};
use transport::Connection;

#[derive(Clone, Serialize, Deserialize)]
struct SessionRecord {
    id: String,
    cwd: String,
    path: PathBuf,
    system_prompt: Option<String>,
    created_at: u64,
}

struct Session {
    connection: Arc<Connection>,
    record: SessionRecord,
    operation: Arc<Mutex<()>>,
    runtime: Arc<Mutex<events::Runtime>>,
    trusted: bool,
    mcp: Option<Value>,
}

impl Session {
    async fn prompt(&self, state: Arc<RwLock<RelayState>>, text: String, images: Vec<Value>) {
        if self.runtime.lock().await.stopped {
            return;
        }
        let response = self
            .connection
            .request(json!({"type":"prompt","message":text,"images":images}))
            .await;
        let stopped = {
            let mut runtime = self.runtime.lock().await;
            runtime.prompt_pending = false;
            runtime.stopped
        };
        if stopped {
            self.close().await;
            let mut runtime = self.runtime.lock().await;
            events::finish(&mut *state.write().await, &self.record.id, &mut runtime);
            return;
        }
        let result = async {
            let data = response?;
            let info = self.connection.request(json!({"type":"get_state"})).await?;
            if info["sessionId"].as_str() != Some(self.record.id.as_str()) {
                return Err("Pi changed sessions outside Sealwire".into());
            }
            match data["disposition"].as_str() {
                Some("started") => Ok(()),
                Some("handled") => {
                    self.connection.drain_events().await?;
                    if info["isStreaming"] != true && info["isCompacting"] != true {
                        let mut runtime = self.runtime.lock().await;
                        if !runtime.extension_pending {
                            events::finish(
                                &mut *state.write().await,
                                &self.record.id,
                                &mut runtime,
                            );
                        }
                    }
                    Ok(())
                }
                _ => Err("Pi returned an unexpected prompt disposition".to_string()),
            }
        }
        .await;
        if let Err(error) = result {
            self.runtime.lock().await.failure = Some(error);
            self.close().await;
            let mut runtime = self.runtime.lock().await;
            events::finish(&mut *state.write().await, &self.record.id, &mut runtime);
        }
    }

    async fn cancel_dialogs(&self, state: &Arc<RwLock<RelayState>>) {
        let mut runtime = self.runtime.lock().await;
        for dialog in runtime.dialogs.values() {
            if let Err(error) = self
                .connection
                .write(
                    json!({"type":"extension_ui_response","id":dialog.native_id,"cancelled":true}),
                )
                .await
            {
                tracing::warn!("Cancel Pi dialog: {error}");
            }
        }
        ui::clear(&mut *state.write().await, &mut runtime.dialogs);
    }

    async fn close(&self) {
        let pending = {
            let runtime = self.runtime.lock().await;
            runtime.prompt_pending || runtime.extension_pending
        };
        let abort = async {
            self.connection
                .request(json!({"type":"clear_queue"}))
                .await?;
            self.connection.request(json!({"type":"abort"})).await
        };
        if !self.connection.closed.load(Ordering::Acquire) {
            match tokio::time::timeout(std::time::Duration::from_secs(2), abort).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => tracing::warn!("Pi abort before shutdown failed: {error}"),
                Err(error) => tracing::warn!("Pi abort before shutdown timed out: {error}"),
            }
        }
        if pending {
            // A preflight hook can launch the run even while Pi awaits its shutdown hooks.
            self.connection.kill().await;
        } else {
            self.connection.close().await;
        }
    }
}

pub(crate) struct PiBridge {
    state: Arc<RwLock<RelayState>>,
    binary: OsString,
    root: PathBuf,
    metadata: PathBuf,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    records: Mutex<HashMap<String, SessionRecord>>,
    indexes: Mutex<HashMap<String, Arc<index::Index>>>,
    discovered: Mutex<Option<tokio::time::Instant>>,
    attach: Arc<Mutex<()>>,
}

impl PiBridge {
    pub async fn spawn(state: Arc<RwLock<RelayState>>) -> Result<Self, String> {
        let binary = crate::provider::resolve_binary("pi");
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let agent_dir = std::env::var_os("PI_CODING_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                crate::state_paths::home_dir()
                    .unwrap_or_else(|| cwd.clone())
                    .join(".pi/agent")
            });
        let root = std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| agent_dir.join("sessions"));
        let root = absolute_path(root, &cwd);
        let metadata = crate::state_paths::state_dir(&cwd).join("pi-sessions");
        let bridge = Self {
            state,
            binary,
            root,
            metadata,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            records: Mutex::new(HashMap::new()),
            indexes: Mutex::new(HashMap::new()),
            discovered: Mutex::new(None),
            attach: Arc::new(Mutex::new(())),
        };
        let discovery = bridge.metadata.join("discovery");
        tokio::fs::create_dir_all(&discovery)
            .await
            .map_err(|e| e.to_string())?;
        let (probe, receiver) = Connection::spawn(
            &bridge.binary,
            &discovery,
            &["--no-session".into(), "--no-approve".into()],
        )
        .await?;
        events::spawn(
            receiver,
            probe.clone(),
            bridge.state.clone(),
            String::new(),
            Arc::new(Mutex::new(events::Runtime::default())),
        );
        let result = probe.request(json!({"type":"get_state"})).await;
        probe.close().await;
        result?;
        bridge
            .state
            .write()
            .await
            .set_provider_connection("pi", true);
        reaper::spawn(&bridge.sessions, &bridge.attach);
        Ok(bridge)
    }

    async fn trust_arg(&self, cwd: &str) -> String {
        let grants = { self.state.read().await.trust_grants() };
        if grants.admit(cwd).await.trusted().is_some() {
            "--approve"
        } else {
            "--no-approve"
        }
        .into()
    }

    async fn probe(&self, cwd: &str, command: Value) -> Result<Value, String> {
        let (connection, receiver) = Connection::spawn(
            &self.binary,
            Path::new(cwd),
            &["--no-session".into(), self.trust_arg(cwd).await],
        )
        .await?;
        events::spawn(
            receiver,
            connection.clone(),
            self.state.clone(),
            String::new(),
            Arc::new(Mutex::new(events::Runtime::default())),
        );
        let result = connection.request(command).await;
        connection.close().await;
        result
    }

    async fn discover(&self, force: bool) -> Result<(), String> {
        let mut discovered = self.discovered.lock().await;
        if !force
            && discovered.is_some_and(|time| time.elapsed() < std::time::Duration::from_secs(5))
        {
            return Ok(());
        }
        let mut found = Vec::new();
        for path in files_in(&self.metadata).await? {
            if path.extension().is_some_and(|e| e == "json") {
                let result = async {
                    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
                    serde_json::from_slice::<SessionRecord>(&bytes).map_err(|e| e.to_string())
                }
                .await;
                match result {
                    Ok(record) => found.push(record),
                    Err(error) => {
                        tracing::warn!("Read Pi session metadata {}: {error}", path.display())
                    }
                }
            }
        }
        let mut paths = Vec::new();
        for path in files_in(&self.root).await? {
            if path.is_dir() {
                paths.extend(files_in(&path).await?);
            } else {
                paths.push(path);
            }
        }
        for path in paths
            .into_iter()
            .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        {
            match index::header(&path).await {
                Ok(header) => found.push(SessionRecord {
                    id: header["id"].as_str().unwrap().into(),
                    cwd: header["cwd"].as_str().unwrap().into(),
                    created_at: file_time(&path).await,
                    path,
                    system_prompt: None,
                }),
                Err(error) => tracing::warn!("{error}"),
            }
        }
        let mut records = self.records.lock().await;
        for record in found {
            records.entry(record.id.clone()).or_insert(record);
        }
        *discovered = Some(tokio::time::Instant::now());
        Ok(())
    }

    async fn record(&self, id: &str) -> Result<SessionRecord, String> {
        if let Some(record) = self.records.lock().await.get(id).cloned() {
            return Ok(record);
        }
        if self
            .state
            .read()
            .await
            .resolve_session_target(id)
            .is_some_and(|target| target.provider != "pi")
        {
            return Err(format!("Session {id} belongs to another provider"));
        }
        self.discover(false).await?;
        self.records
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Pi session {id} was not found"))
    }

    async fn connect(
        &self,
        record: SessionRecord,
        fresh: bool,
        model: &str,
        effort: &str,
        request: Option<&StartThreadRequest>,
    ) -> Result<Arc<Session>, String> {
        let mut args = if record.path.is_file() {
            vec![
                "--session".into(),
                record.path.to_string_lossy().into_owned(),
            ]
        } else {
            let mut args = vec!["--session-id".into(), record.id.clone()];
            if !fresh {
                args.extend([
                    "--session-dir".into(),
                    record
                        .path
                        .parent()
                        .ok_or("Pi session has no directory")?
                        .to_string_lossy()
                        .into_owned(),
                ]);
            }
            args
        };
        let trust = self.trust_arg(&record.cwd).await;
        let trusted = trust == "--approve";
        args.push(trust);
        if let Some(prompt) = &record.system_prompt {
            args.extend(["--append-system-prompt".into(), prompt.clone()]);
        }
        if fresh && !model.is_empty() && model != "default" {
            args.extend(["--model".into(), model.into()]);
        }
        if fresh && !effort.is_empty() {
            args.extend(["--thinking".into(), effort.into()]);
        }
        let bridge_path = PathBuf::from(crate::provider::sealwire_mcp_bridge_path());
        let extension = absolute_path(
            bridge_path,
            &std::env::current_dir().map_err(|e| e.to_string())?,
        )
        .with_file_name("pi-extension.mjs");
        args.extend([
            "--extension".into(),
            extension.to_string_lossy().into_owned(),
        ]);
        let (mcp, ask_token) = self.mcp_config(&record.id, request).await;
        let env = vec![(
            "SEALWIRE_PI_MCP".into(),
            mcp.clone().unwrap_or(Value::Null).to_string(),
        )];
        let (connection, receiver) =
            Connection::spawn_with_env(&self.binary, Path::new(&record.cwd), &args, &env).await?;
        let runtime = Arc::new(Mutex::new(events::Runtime::default()));
        events::spawn(
            receiver,
            connection.clone(),
            self.state.clone(),
            record.id.clone(),
            runtime.clone(),
        );
        let result = async {
            let info = connection.request(json!({"type":"get_state"})).await?;
            if info["sessionId"].as_str() != Some(record.id.as_str()) {
                return Err("Pi opened a different session".into());
            }
            connection.drain_events().await?;
            if !runtime.lock().await.bridge_ready {
                return Err("Pi could not load the Sealwire extension".into());
            }
            let path = info["sessionFile"]
                .as_str()
                .ok_or("Pi did not return a persistent session file")?;
            let entries = connection.request(json!({"type":"get_entries"})).await?;
            let entries = entries["entries"]
                .as_array()
                .ok_or("Pi returned invalid session entries")?;
            let mut runtime = runtime.lock().await;
            runtime.last_used = Some(tokio::time::Instant::now());
            runtime.ids = MessageIds::seed(entries);
            for entry in entries {
                history::message_rows(&entry["message"], "", &mut runtime.tools);
            }
            let record = SessionRecord {
                path: PathBuf::from(path),
                ..record
            };
            Ok(record)
        }
        .await;
        let record = match result {
            Ok(value) => value,
            Err(error) => {
                connection.close().await;
                return Err(error);
            }
        };
        if let Some(token) = ask_token.filter(|_| fresh) {
            self.state.write().await.bind_ask_token(&token, &record.id);
        }
        let session = Arc::new(Session {
            connection,
            record,
            operation: Arc::new(Mutex::new(())),
            runtime,
            trusted,
            mcp,
        });
        Ok(session)
    }

    async fn session(&self, id: &str) -> Result<Arc<Session>, String> {
        let _attach = self.attach.lock().await;
        let existing = self.sessions.lock().await.get(id).cloned();
        if let Some(session) = existing {
            if !session.connection.closed.load(Ordering::Acquire) {
                let trust_matches =
                    (self.trust_arg(&session.record.cwd).await == "--approve") == session.trusted;
                let (mcp, _) = self.mcp_config(id, None).await;
                if (trust_matches && mcp == session.mcp)
                    || session.runtime.lock().await.turn.is_some()
                    || session.operation.try_lock().is_err()
                {
                    session.runtime.lock().await.last_used = Some(tokio::time::Instant::now());
                    return Ok(session);
                }
                session.close().await;
            }
        }
        self.evict_idle().await;
        let record = self.record(id).await?;
        let previous_path = record.path.clone();
        let session = self.connect(record, false, "", "", None).await?;
        if previous_path != session.record.path && self.metadata_path(id).is_file() {
            self.remember(&session.record).await?;
        }
        self.records
            .lock()
            .await
            .insert(id.into(), session.record.clone());
        self.sessions
            .lock()
            .await
            .insert(id.into(), session.clone());
        Ok(session)
    }

    async fn evict_idle(&self) {
        reaper::reap(
            &self.sessions,
            reaper::MAX_IDLE_PROCESSES - 1,
            std::time::Duration::from_secs(600),
        )
        .await;
    }

    async fn history_index(&self, record: &SessionRecord) -> Result<Arc<index::Index>, String> {
        let metadata = tokio::fs::metadata(&record.path)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(index) = self
            .indexes
            .lock()
            .await
            .get(&record.id)
            .filter(|i| i.size == metadata.len() && i.modified == metadata.modified().ok())
            .cloned()
        {
            return Ok(index);
        }
        let index = Arc::new(index::Index::read(&record.path).await?);
        if index.summary.id != record.id {
            return Err("Pi session file identity changed".into());
        }
        let mut indexes = self.indexes.lock().await;
        if indexes.len() >= 8 {
            indexes.clear();
        }
        indexes.insert(record.id.clone(), index.clone());
        Ok(index)
    }

    fn metadata_path(&self, id: &str) -> PathBuf {
        self.metadata
            .join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
    }

    async fn remember(&self, record: &SessionRecord) -> Result<(), String> {
        tokio::fs::create_dir_all(&self.metadata)
            .await
            .map_err(|e| e.to_string())?;
        let path = self.metadata_path(&record.id);
        let temporary = path.with_extension("tmp");
        tokio::fs::write(
            &temporary,
            serde_json::to_vec(record).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| format!("Save Pi session metadata: {e}"))?;
        tokio::fs::rename(&temporary, path)
            .await
            .map_err(|e| format!("Save Pi session metadata: {e}"))?;
        self.records
            .lock()
            .await
            .insert(record.id.clone(), record.clone());
        Ok(())
    }
}

async fn files_in(path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut directory = match tokio::fs::read_dir(path).await {
        Ok(dir) => dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("List {}: {e}", path.display())),
    };
    let mut paths = Vec::new();
    while let Some(entry) = directory.next_entry().await.map_err(|e| e.to_string())? {
        paths.push(entry.path());
    }
    Ok(paths)
}

async fn file_time(path: &Path) -> u64 {
    tokio::fs::metadata(path)
        .await
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_secs())
        .unwrap_or_default()
}

fn absolute_path(path: PathBuf, cwd: &Path) -> PathBuf {
    if let Ok(tail) = path.strip_prefix("~") {
        if let Some(home) = crate::state_paths::home_dir() {
            return home.join(tail);
        }
    }
    cwd.join(path)
}

fn permissions(approval: &str, sandbox: &str) -> Result<(), String> {
    if approval != "bypass" || sandbox != "danger-full-access" {
        return Err("Pi requires Full access (YOLO): its RPC interface has no tool approval or filesystem sandbox. Read-only sessions are not supported.".into());
    }
    Ok(())
}

fn model_id(model: &Value) -> Option<String> {
    let provider = model["provider"].as_str()?;
    if provider == "unknown" {
        return None;
    }
    Some(format!("{}/{}", provider, model["id"].as_str()?))
}

fn thinking_levels(model: &Value) -> Vec<String> {
    if model["reasoning"] != true {
        return vec!["off".into()];
    }
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .into_iter()
        .filter(|level| match model["thinkingLevelMap"].get(*level) {
            Some(Value::Null) => false,
            Some(_) => true,
            None => !matches!(*level, "xhigh" | "max"),
        })
        .map(str::to_string)
        .collect()
}

#[async_trait]
impl ProviderBridge for PiBridge {
    async fn shutdown(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().await);
        let mut closing = tokio::task::JoinSet::new();
        for session in sessions.into_values() {
            closing.spawn(async move { session.close().await });
        }
        while let Some(result) = closing.join_next().await {
            if let Err(error) = result {
                tracing::warn!("Pi shutdown failed: {error}");
            }
        }
    }

    async fn refresh_workspace_trust(&self) -> Result<(), String> {
        let _attach = self.attach.lock().await;
        let sessions: Vec<_> = self.sessions.lock().await.values().cloned().collect();
        for session in sessions {
            let trusted = self.trust_arg(&session.record.cwd).await == "--approve";
            if trusted != session.trusted {
                if trusted
                    && (session.runtime.lock().await.turn.is_some()
                        || session.operation.try_lock().is_err())
                {
                    continue;
                }
                self.sessions.lock().await.remove(&session.record.id);
                self.state.write().await.push_log(
                    "info",
                    format!(
                        "Closing Pi session {} after workspace trust changed",
                        session.record.id
                    ),
                );
                session.close().await;
            }
        }
        Ok(())
    }
    fn provider_name(&self) -> &'static str {
        "pi"
    }
    fn supports_read_only_reviews(&self) -> bool {
        false
    }
    fn read_thread_reports_activity_time(&self) -> bool {
        true
    }

    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        self.discover(true).await?;
        let records: Vec<_> = self.records.lock().await.values().cloned().collect();
        let mut recent = Vec::new();
        for record in records {
            let updated = file_time(&record.path).await.max(record.created_at);
            recent.push((updated, record));
        }
        recent.sort_by_key(|(time, record)| (std::cmp::Reverse(*time), record.id.clone()));
        recent.truncate(limit);
        let mut threads = Vec::new();
        for (updated, record) in recent {
            let cached = self
                .indexes
                .lock()
                .await
                .get(&record.id)
                .map(|i| i.summary.clone());
            let mut thread = if record.path.is_file() {
                index::summary(&record.path).await?
            } else {
                Document {
                    header: json!({"id":record.id,"cwd":record.cwd}),
                    entries: vec![],
                }
                .sync(None)?
                .thread
            };
            if thread.name.is_none() {
                thread.name = cached.as_ref().and_then(|s| s.name.clone());
            }
            thread.updated_at = updated;
            threads.push(thread);
        }
        Ok(threads)
    }

    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        let cwd = self.metadata.join("discovery");
        tokio::fs::create_dir_all(&cwd)
            .await
            .map_err(|e| e.to_string())?;
        let result = self
            .probe(
                &cwd.to_string_lossy(),
                json!({"type":"get_available_models"}),
            )
            .await?;
        let models = result["models"]
            .as_array()
            .ok_or("Pi returned an invalid model catalog")?;
        Ok(models
            .iter()
            .filter_map(|model| {
                let levels = thinking_levels(model);
                let default_effort = if levels.iter().any(|level| level == "medium") {
                    "medium".into()
                } else {
                    levels.first().cloned().unwrap_or_default()
                };
                Some(ModelOptionView {
                    model: model_id(model)?,
                    display_name: format!(
                        "{} · {}",
                        model["name"].as_str().unwrap_or(model["id"].as_str()?),
                        model["provider"].as_str()?
                    ),
                    provider: "pi".into(),
                    supported_reasoning_efforts: levels,
                    default_reasoning_effort: default_effort,
                    hidden: false,
                    is_default: false,
                    resolved_model: None,
                })
            })
            .collect())
    }

    async fn default_model(&self, cwd: &str) -> Result<String, String> {
        let result = self.probe(cwd, json!({"type":"get_state"})).await?;
        model_id(&result["model"])
            .ok_or("Pi has no model configured. Configure a provider in Pi first.".into())
    }

    async fn start_thread(&self, request: StartThreadRequest) -> Result<StartThreadResult, String> {
        permissions(&request.approval_policy, &request.sandbox)?;
        if request.orchestrator_tools.is_some()
            || matches!(request.purpose, crate::provider::SessionPurpose::Seat(_))
        {
            return Err("Pi Task seats and Orchestrator sessions are not supported".into());
        }
        let _attach = self.attach.lock().await;
        self.evict_idle().await;
        let cwd = Path::new(&request.cwd)
            .canonicalize()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        let id = crate::state::new_uuid_v4();
        let record = SessionRecord {
            id: id.clone(),
            cwd,
            path: self.root.join(format!("{id}.jsonl")),
            system_prompt: request.system_prompt.clone(),
            created_at: crate::state::unix_now(),
        };
        let session = self
            .connect(
                record,
                true,
                &request.model,
                &request.effort,
                Some(&request),
            )
            .await?;
        if let Err(error) = self.remember(&session.record).await {
            session.connection.close().await;
            return Err(error);
        }
        self.sessions.lock().await.insert(id.clone(), session);
        let thread = self.read_thread(&id).await?.thread;
        Ok(StartThreadResult {
            provider_thread_id: Some(id),
            thread,
            consumed_initial_prompt: false,
            initial_user_message: None,
            started_turn_id: None,
        })
    }

    async fn resume_thread(&self, id: &str, approval: &str, sandbox: &str) -> Result<(), String> {
        permissions(approval, sandbox)?;
        self.session(id).await?;
        Ok(())
    }

    async fn read_thread(&self, id: &str) -> Result<ThreadSyncData, String> {
        let record = self.record(id).await?;
        let finalize = |mut data: ThreadSyncData, idle: bool| {
            if data.thread.updated_at == 0 {
                data.thread.updated_at = record.created_at;
            }
            if idle {
                for entry in &mut data.transcript {
                    history::settle_tool(&mut entry.view);
                }
            }
            data
        };
        let session = self.sessions.lock().await.get(id).cloned();
        if let Some(session) = session.filter(|s| !s.connection.closed.load(Ordering::Acquire)) {
            let data = session
                .connection
                .request(json!({"type":"get_entries"}))
                .await?;
            let entries = data["entries"]
                .as_array()
                .ok_or("Pi returned invalid session entries")?
                .clone();
            let doc = Document {
                header: json!({"id":id,"cwd":record.cwd}),
                entries,
            };
            let idle = session.runtime.lock().await.turn.is_none();
            return doc
                .sync(data["leafId"].as_str())
                .map(|data| finalize(data, idle));
        }
        if !record.path.exists() {
            return Document {
                header: json!({"id":id,"cwd":record.cwd}),
                entries: vec![],
            }
            .sync(None)
            .map(|data| finalize(data, true));
        }
        let index = self.history_index(&record).await?;
        index
            .page(&record.path, None, usize::MAX)
            .await
            .map(|page| finalize(page.sync, true))
    }

    async fn read_thread_transcript_page(
        &self,
        id: &str,
        before: Option<usize>,
    ) -> Result<Option<ThreadTranscriptPageData>, String> {
        let record = self.record(id).await?;
        if !record.path.is_file() {
            return Ok(None);
        }
        let index = self.history_index(&record).await?;
        let mut page = index.page(&record.path, before, 100).await?;
        if page.sync.thread.updated_at == 0 {
            page.sync.thread.updated_at = record.created_at;
        }
        let session = self.sessions.lock().await.get(id).cloned();
        let idle = match session {
            Some(session) => session.runtime.lock().await.turn.is_none(),
            None => true,
        };
        if idle {
            for row in &mut page.sync.transcript {
                history::settle_tool(&mut row.view);
            }
        }
        Ok(Some(page))
    }

    async fn read_thread_entry_detail(
        &self,
        id: &str,
        item: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        let record = self.record(id).await?;
        if !record.path.is_file() {
            return Ok(None);
        }
        let index = self.history_index(&record).await?;
        let Some(position) = index.row_position(item) else {
            return Ok(None);
        };
        let mut row = index
            .page(&record.path, Some(position + 1), 1)
            .await?
            .sync
            .into_views()
            .into_iter()
            .next();
        let session = self.sessions.lock().await.get(id).cloned();
        let idle = match session {
            Some(session) => session.runtime.lock().await.turn.is_none(),
            None => true,
        };
        if idle {
            if let Some(row) = &mut row {
                history::settle_tool(row);
            }
        }
        Ok(row)
    }

    async fn start_turn(
        &self,
        id: &str,
        text: &str,
        model: &str,
        effort: &str,
        images: &[ProviderImage],
    ) -> Result<Option<String>, String> {
        let session = self.session(id).await?;
        let operation = session.operation.clone().lock_owned().await;
        if session.runtime.lock().await.turn.is_some() {
            return Err("Pi session is already working".into());
        }
        if !session.runtime.lock().await.bridge_ready {
            session.close().await;
            return Err("Pi could not load the Sealwire extension; reopen the session".into());
        }
        let info = session
            .connection
            .request(json!({"type":"get_state"}))
            .await?;
        if info["sessionId"].as_str() != Some(id) {
            return Err("Pi changed sessions outside Sealwire; reopen the intended session".into());
        }
        if info["isStreaming"] == true || info["isCompacting"] == true {
            return Err("Pi session is already working".into());
        }
        if !model.is_empty()
            && model != "default"
            && model_id(&info["model"]).as_deref() != Some(model)
        {
            let (provider, model) = model
                .split_once('/')
                .ok_or("Pi model must be provider/model-id")?;
            session
                .connection
                .request(json!({"type":"set_model","provider":provider,"modelId":model}))
                .await?;
        }
        if !effort.is_empty() {
            session
                .connection
                .request(json!({"type":"set_thinking_level","level":effort}))
                .await?;
        }
        let extension_command = if let Some(name) = text
            .strip_prefix('/')
            .and_then(|s| s.split_whitespace().next())
        {
            let commands = session
                .connection
                .request(json!({"type":"get_commands"}))
                .await?;
            commands["commands"].as_array().is_some_and(|commands| {
                commands
                    .iter()
                    .any(|command| command["source"] == "extension" && command["name"] == name)
            })
        } else {
            false
        };
        let turn = crate::state::new_uuid_v4();
        {
            let mut runtime = session.runtime.lock().await;
            runtime.turn = Some(turn.clone());
            runtime.usage_seen.clear();
            runtime.failure = None;
            runtime.message_error = None;
            runtime.stopped = false;
            runtime.prompt_pending = true;
            runtime.extension_pending = false;
            runtime.unsent_text = crate::provider::user_message_transcript_text(text, images.len());
            events::start(&mut *self.state.write().await, id, &turn);
            if extension_command {
                events::handled_command(&mut *self.state.write().await, id, &mut runtime, text);
            }
        }
        let images: Vec<_> = images
            .iter()
            .map(|image| json!({"type":"image","data":image.data,"mimeType":image.media_type}))
            .collect();
        let state = self.state.clone();
        let text = text.to_string();
        tokio::spawn(async move {
            let _operation = operation;
            session.prompt(state, text, images).await;
        });
        Ok(Some(turn))
    }

    async fn request_turn_stop(&self, id: &str, _turn: Option<&str>) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or("Pi session is not running")?;
        let pending = {
            let mut runtime = session.runtime.lock().await;
            runtime.stopped = true;
            let pending = runtime.prompt_pending || runtime.extension_pending;
            if pending {
                runtime.prompt_pending = true;
                events::finish(&mut *self.state.write().await, id, &mut runtime);
            }
            pending
        };
        session.cancel_dialogs(&self.state).await;
        if pending {
            // Pi cannot abort extension preflight hooks; terminate before they can start a run.
            session.close().await;
            return Ok(());
        }
        session
            .connection
            .request(json!({"type":"clear_queue"}))
            .await?;
        session.connection.request(json!({"type":"abort"})).await?;
        Ok(())
    }

    async fn release_thread(&self, id: &str) -> Result<(), String> {
        let _attach = self.attach.lock().await;
        let session = self.sessions.lock().await.get(id).cloned();
        if let Some(session) = session {
            let _operation = session
                .operation
                .try_lock()
                .map_err(|_| "Cannot release a working Pi session")?;
            if session.runtime.lock().await.turn.is_some() {
                return Err("Cannot release a working Pi session".into());
            }
            self.sessions.lock().await.remove(id);
            session.close().await;
        }
        Ok(())
    }

    async fn archive_thread(&self, _id: &str) -> Result<(), String> {
        Err("Pi does not support archiving sessions".into())
    }

    async fn delete_thread_permanently(
        &self,
        id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        let record = self.record(id).await?;
        self.release_thread(id).await?;
        let mut deleted_paths = Vec::new();
        let paths = [record.path, self.metadata_path(id)];
        for path in paths {
            match tokio::fs::remove_file(&path).await {
                Ok(()) => deleted_paths.push(path),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Delete Pi session: {e}")),
            }
        }
        self.records.lock().await.remove(id);
        self.indexes.lock().await.remove(id);
        Ok(LocalThreadDeleteSummary {
            deleted_paths,
            deleted_thread_row: true,
        })
    }

    fn skills_are_per_session(&self) -> bool {
        true
    }
    async fn list_skills(
        &self,
        id: &str,
        _cwd: &str,
    ) -> Result<Option<Vec<ProviderSkillView>>, String> {
        let session = self.session(id).await?;
        let data = session
            .connection
            .request(json!({"type":"get_commands"}))
            .await?;
        let commands = data["commands"]
            .as_array()
            .ok_or("Pi returned invalid commands")?;
        Ok(Some(
            commands
                .iter()
                .filter(|command| {
                    matches!(
                        command["source"].as_str(),
                        Some("skill" | "prompt" | "extension")
                    )
                })
                .filter_map(|command| {
                    Some(ProviderSkillView {
                        name: command["name"].as_str()?.into(),
                        description: command["description"].as_str().unwrap_or_default().into(),
                        scope: "session".into(),
                        origin: command["source"].as_str().map(str::to_string),
                        path: command["sourceInfo"]["path"].as_str().map(str::to_string),
                        argument_hint: None,
                    })
                })
                .collect(),
        ))
    }

    async fn respond_to_approval(
        &self,
        _pending: &PendingApproval,
        _input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        Err("Pi has no native tool approval API".into())
    }
    async fn respond_to_ask_user_question(
        &self,
        id: &str,
        answers: &serde_json::Map<String, Value>,
    ) -> Result<(), String> {
        let sessions: Vec<_> = self.sessions.lock().await.values().cloned().collect();
        for session in sessions {
            let mut runtime = session.runtime.lock().await;
            if let Some(dialog) = runtime.dialogs.get(id) {
                let response = ui::response(dialog, answers)?;
                session.connection.write(response).await?;
                let dialog = runtime.dialogs.remove(id).unwrap();
                let answer_text = ui::answer_text(&dialog, answers);
                ui::resolved(&mut *self.state.write().await, id, &dialog, &answer_text);
                return Ok(());
            }
        }
        Err("Pi dialog is no longer pending".into())
    }

    async fn account(&self) -> Result<crate::provider::account::ProviderAccount, String> {
        let version =
            crate::provider::account::run_cli(self.binary.clone(), &["--version"]).await?;
        Ok(crate::provider::account::ProviderAccount {
            version: crate::provider::account::version_from_banner(&version),
            login_command: Some("pi /login"),
            ..Default::default()
        })
    }
}
