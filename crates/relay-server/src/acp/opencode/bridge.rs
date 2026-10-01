use super::*;
use crate::provider::{ProviderForkCapability, ProviderForkRequest};
use std::time::Instant;

const MAX_IDLE_SESSIONS: usize = 2;
const IDLE_SESSION_TIMEOUT: Duration = Duration::from_secs(120);

struct SessionConnection {
    bridge: Arc<AcpBridge>,
    last_used: Instant,
}

type Connections = Arc<Mutex<HashMap<String, SessionConnection>>>;

pub(crate) struct OpenCodeBridge {
    index: AcpBridge,
    sessions: Connections,
    catalog_directory: std::path::PathBuf,
    catalog_loaded: Mutex<bool>,
}

impl OpenCodeBridge {
    pub(crate) async fn spawn(state: Arc<RwLock<RelayState>>) -> Result<Self, String> {
        let index = Self::connection(state, true).await?;
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let weak = Arc::downgrade(&sessions);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let Some(sessions) = weak.upgrade() else {
                    break;
                };
                evict_idle_sessions(&sessions).await;
            }
        });
        Ok(Self {
            index,
            sessions,
            catalog_directory: super::discovery_directory().await?,
            catalog_loaded: Mutex::new(false),
        })
    }

    async fn connection(
        state: Arc<RwLock<RelayState>>,
        owns_provider_connection: bool,
    ) -> Result<AcpBridge, String> {
        AcpBridge::spawn_connection(
            state,
            "opencode",
            &["acp"],
            "OpenCode",
            "opencode",
            owns_provider_connection,
        )
        .await
    }

    async fn session(&self, id: &str) -> Result<Arc<AcpBridge>, String> {
        let lock = self.index.load_lock(id).await;
        let _guard = lock.lock().await;
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(connection) = sessions.get_mut(id) {
                if !connection.bridge.stream_closed.load(Ordering::Acquire) {
                    connection.last_used = Instant::now();
                    return Ok(connection.bridge.clone());
                }
            }
            sessions.remove(id);
        }
        let cwd = self.index.resolve_cwd(id).await?;
        let bridge = Arc::new(Self::connection(self.index.state.clone(), false).await?);
        bridge.sessions.lock().await.insert(
            id.to_string(),
            SessionRuntime {
                cwd,
                has_content: true,
                ..Default::default()
            },
        );
        self.sessions.lock().await.insert(
            id.to_string(),
            SessionConnection {
                bridge: bridge.clone(),
                last_used: Instant::now(),
            },
        );
        evict_idle_sessions(&self.sessions).await;
        Ok(bridge)
    }

    async fn remember(&self, result: &StartThreadResult, bridge: Arc<AcpBridge>) {
        absorb_thread_cwds(
            &mut *self.index.sessions.lock().await,
            std::slice::from_ref(&result.thread),
        );
        self.sessions.lock().await.insert(
            result.thread.id.clone(),
            SessionConnection {
                bridge,
                last_used: Instant::now(),
            },
        );
        evict_idle_sessions(&self.sessions).await;
    }
}

#[async_trait]
impl ProviderBridge for OpenCodeBridge {
    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        self.index.list_opencode_threads(limit).await
    }
    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        // ModelSelection shares this catalog; only failed discovery is retried.
        let mut loaded = self.catalog_loaded.lock().await;
        if *loaded {
            return Ok(self.index.models.lock().await.clone());
        }
        self.index.list_models().await?;
        let models = self
            .index
            .complete_opencode_model_catalog(&self.catalog_directory.to_string_lossy())
            .await?;
        *loaded = !models.is_empty();
        Ok(models)
    }
    async fn default_model(&self, cwd: &str) -> Result<String, String> {
        self.index.default_model(cwd).await
    }
    async fn start_thread(&self, request: StartThreadRequest) -> Result<StartThreadResult, String> {
        if matches!(request.purpose, crate::provider::SessionPurpose::Seat(_)) {
            return Err("OpenCode Task seats are not supported".into());
        }
        // OpenCode's ACP MCP registration is directory-wide within one process.
        let bridge = Arc::new(Self::connection(self.index.state.clone(), false).await?);
        let result = bridge.start_thread(request).await?;
        self.remember(&result, bridge).await;
        Ok(result)
    }
    async fn resume_thread(&self, id: &str, approval: &str, sandbox: &str) -> Result<(), String> {
        self.session(id)
            .await?
            .resume_thread(id, approval, sandbox)
            .await
    }
    async fn session_can_take_a_turn(&self, id: &str) -> bool {
        match self.session(id).await {
            Ok(bridge) => bridge.session_can_take_a_turn(id).await,
            Err(_) => false,
        }
    }
    async fn read_thread(&self, id: &str) -> Result<ThreadSyncData, String> {
        self.session(id).await?.read_thread(id).await
    }
    async fn read_thread_in_cwd(&self, id: &str, cwd: &str) -> Result<ThreadSyncData, String> {
        self.session(id).await?.read_thread_in_cwd(id, cwd).await
    }
    async fn read_thread_entry_detail(
        &self,
        id: &str,
        item: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        self.session(id)
            .await?
            .read_thread_entry_detail(id, item)
            .await
    }
    async fn start_turn(
        &self,
        id: &str,
        text: &str,
        model: &str,
        effort: &str,
        images: &[ProviderImage],
    ) -> Result<Option<String>, String> {
        self.session(id)
            .await?
            .start_turn(id, text, model, effort, images)
            .await
    }
    async fn request_turn_stop(&self, id: &str, turn: Option<&str>) -> Result<(), String> {
        self.session(id).await?.request_turn_stop(id, turn).await
    }
    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        self.session(&pending.thread_id)
            .await?
            .respond_to_approval(pending, input)
            .await
    }
    async fn respond_to_ask_user_question(
        &self,
        _id: &str,
        _answers: &serde_json::Map<String, Value>,
    ) -> Result<(), String> {
        Err("OpenCode does not support AskUserQuestion over ACP".into())
    }
    fn skills_are_per_session(&self) -> bool {
        true
    }
    async fn list_skills(
        &self,
        id: &str,
        cwd: &str,
    ) -> Result<Option<Vec<crate::protocol::ProviderSkillView>>, String> {
        self.session(id).await?.list_skills(id, cwd).await
    }
    async fn release_thread(&self, id: &str) -> Result<(), String> {
        let lock = self.index.load_lock(id).await;
        let _guard = lock.lock().await;
        let bridge = {
            let mut sessions = self.sessions.lock().await;
            if let Some(connection) = sessions.get(id) {
                if Arc::strong_count(&connection.bridge) > 1 {
                    return Err("OpenCode session is in use".into());
                }
                let runtime = connection
                    .bridge
                    .sessions
                    .try_lock()
                    .map_err(|_| "OpenCode session is in use")?;
                if runtime
                    .get(id)
                    .is_some_and(|session| session.turn_id.is_some())
                {
                    return Err(
                        "OpenCode cannot release a session while its turn is running".into(),
                    );
                }
            }
            sessions.remove(id).map(|connection| connection.bridge)
        };
        if let Some(bridge) = bridge {
            if !bridge.stream_closed.load(Ordering::Acquire) {
                if let Err(error) = bridge.release_thread(id).await {
                    let mut relay = self.index.state.write().await;
                    relay.push_log(
                        "warn",
                        format!("Could not close OpenCode session {id}: {error}"),
                    );
                    relay.notify();
                }
            }
        }
        Ok(())
    }
    async fn delete_thread_permanently(
        &self,
        id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        self.release_thread(id).await?;
        self.index.delete_opencode_session(id).await?;
        forget_session(&self.index.sessions, id).await;
        Ok(LocalThreadDeleteSummary {
            deleted_paths: Vec::new(),
            deleted_thread_row: true,
        })
    }
    async fn delete_owned_thread_permanently(
        &self,
        id: &str,
    ) -> Result<Option<LocalThreadDeleteSummary>, String> {
        self.release_thread(id).await?;
        let deleted = self.index.delete_opencode_session(id).await?;
        forget_session(&self.index.sessions, id).await;
        Ok(deleted.then(|| LocalThreadDeleteSummary {
            deleted_paths: Vec::new(),
            deleted_thread_row: true,
        }))
    }
    async fn archive_thread(&self, id: &str) -> Result<(), String> {
        let cwd = self.index.resolve_cwd(id).await?;
        self.release_thread(id).await?;
        self.index
            .opencode_request(
                reqwest::Method::PATCH,
                &format!("/session/{id}"),
                &cwd,
                Some(json!({"time": {"archived": crate::state::unix_now() * 1000}})),
            )
            .await?;
        forget_session(&self.index.sessions, id).await;
        Ok(())
    }
    fn supports_archive(&self) -> bool {
        true
    }
    fn fork_capability(&self) -> ProviderForkCapability {
        ProviderForkCapability::NATIVE_AT_MESSAGE
    }
    async fn fork_thread(
        &self,
        request: ProviderForkRequest,
    ) -> Result<Option<StartThreadResult>, String> {
        let cwd = self.index.resolve_cwd(&request.source_thread_id).await?;
        if cwd != request.cwd {
            return Ok(None);
        }
        let boundary = if let Some(item) = request.up_to_item_id.as_deref() {
            let source = self.session(&request.source_thread_id).await?;
            let sync = source.read_thread(&request.source_thread_id).await?;
            let refs = source
                .sessions
                .lock()
                .await
                .get(&request.source_thread_id)
                .map(|session| session.native_event_refs.clone())
                .unwrap_or_default();
            let messages = source
                .opencode_request(
                    reqwest::Method::GET,
                    &format!("/session/{}/message", request.source_thread_id),
                    &cwd,
                    None,
                )
                .await?;
            let Some(boundary) = fork_boundary(
                &sync.to_views(),
                &refs,
                messages
                    .as_array()
                    .ok_or("OpenCode returned invalid messages")?,
                item,
            ) else {
                return Ok(None);
            };
            boundary
        } else {
            None
        };
        let bridge = Arc::new(Self::connection(self.index.state.clone(), false).await?);
        let forked = bridge
            .opencode_request(
                reqwest::Method::POST,
                &format!("/session/{}/fork", request.source_thread_id),
                &cwd,
                Some(
                    boundary
                        .map(|id| json!({"messageID": id}))
                        .unwrap_or_else(|| json!({})),
                ),
            )
            .await?;
        let id = forked["id"]
            .as_str()
            .ok_or("OpenCode fork returned no session id")?;
        bridge.sessions.lock().await.insert(
            id.to_string(),
            SessionRuntime {
                cwd: cwd.clone(),
                has_content: true,
                ..Default::default()
            },
        );
        let configured = async {
            bridge
                .resume_thread(id, &request.approval_policy, &request.sandbox)
                .await?;
            bridge.apply_model(id, &request.model).await?;
            Ok::<(), String>(())
        }
        .await;
        match configured {
            Ok(()) => (),
            Err(error) => {
                bridge.cleanup_opencode_session(id).await;
                return Err(error);
            }
        };
        let mut result = StartThreadResult {
            provider_thread_id: Some(id.into()),
            thread: empty_thread_sync(id, &cwd, "opencode").thread,
            consumed_initial_prompt: false,
            initial_user_message: None,
            started_turn_id: None,
        };
        result.thread.forked_from = Some(request.source_thread_id);
        self.remember(&result, bridge).await;
        Ok(Some(result))
    }
    fn provider_name(&self) -> &'static str {
        "opencode"
    }
    async fn account(&self) -> Result<crate::provider::account::ProviderAccount, String> {
        self.index.account().await
    }
}

async fn evict_idle_sessions(connections: &Connections) {
    let mut connections = connections.lock().await;
    let mut idle: Vec<_> = connections
        .iter_mut()
        .filter_map(|(id, connection)| {
            let busy = Arc::strong_count(&connection.bridge) != 1
                || connection
                    .bridge
                    .sessions
                    .try_lock()
                    .map_or(true, |sessions| {
                        sessions.values().any(|session| session.turn_id.is_some())
                    });
            if busy {
                connection.last_used = Instant::now();
                return None;
            }
            Some((
                id.clone(),
                connection.last_used,
                connection.bridge.stream_closed.load(Ordering::Acquire),
            ))
        })
        .collect();
    idle.sort_by_key(|(_, last_used, _)| *last_used);
    let excess = idle.len().saturating_sub(MAX_IDLE_SESSIONS);
    for (index, (id, last_used, closed)) in idle.into_iter().enumerate() {
        if closed || index < excess || last_used.elapsed() >= IDLE_SESSION_TIMEOUT {
            connections.remove(&id);
        }
    }
}

// OpenCode's fork boundary is exclusive; Sealwire's selected row is inclusive.
fn fork_boundary(
    transcript: &[TranscriptEntryView],
    refs: &HashMap<String, NativeEventRange>,
    messages: &[Value],
    item: &str,
) -> Option<Option<String>> {
    let mut owners = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        owners.insert(message["info"]["id"].as_str()?, index);
        for part in message["parts"].as_array()? {
            if let Some(id) = part["id"].as_str() {
                owners.insert(id, index);
            }
            if let Some(id) = part["callID"].as_str() {
                owners.insert(id, index);
            }
        }
    }
    let row = transcript
        .iter()
        .position(|row| row.item_id.as_deref() == Some(item))?;
    let owner = *owners.get(refs.get(item)?.last.as_str())?;
    // A row inside a native message cannot include that message's later tool calls.
    for later in &transcript[row + 1..] {
        let later_ref = refs.get(later.item_id.as_deref()?)?;
        if *owners.get(later_ref.first.as_str())? <= owner {
            return None;
        }
    }
    match messages.get(owner + 1) {
        Some(message) => Some(Some(message["info"]["id"].as_str()?.to_string())),
        None => Some(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn model_catalog_cache_retries_failure_then_reuses_memory_for_its_lifetime() {
        use axum::{routing::get, Json, Router};
        use std::sync::atomic::AtomicUsize;

        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("catalog.json");
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let server = Router::new().route("/provider", get(move || {
            let calls = observed.clone();
            async move {
                let call = calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                if call == 0 {
                    return Json(json!({"error": "catalog unavailable"}));
                }
                let variants = json!({"low": {}, "high": {}});
                Json(json!({"all": [{"id": "test", "models": {"echo": {"variants": variants}}}]}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let (changes, _) = tokio::sync::watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            directory.path().to_string_lossy().into(),
            changes,
            crate::state::SecurityProfile::private(),
        )));
        let (outbound, _outbound_peer) = tokio::io::duplex(8192);
        let (_inbound_peer, inbound) = tokio::io::duplex(8192);
        let mut index = AcpBridge::for_test(state, outbound, inbound, "opencode");
        index.opencode_api = Some(super::super::Api::for_test(port));
        index.models_cache = Some(cache.clone());
        let options = json!([{"category":"model", "type":"select", "currentValue":"test/echo", "options":[{"value":"test/echo"}]}]);
        *index.models.lock().await = crate::acp::config::models(
            options.as_array().unwrap(),
            "opencode",
            Some("test/echo"),
            &[],
            true,
        );
        let bridge = OpenCodeBridge {
            index,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            catalog_directory: directory.path().into(),
            catalog_loaded: Mutex::new(false),
        };
        assert!(bridge.list_models().await.is_err());
        for result in futures_util::future::join_all((0..16).map(|_| bridge.list_models())).await {
            assert_eq!(
                result.unwrap()[0].supported_reasoning_efforts,
                ["low", "high", "default"]
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        std::fs::write(&cache, "warm reads must not touch this file").unwrap();
        assert_eq!(bridge.list_models().await.unwrap()[0].model, "test/echo");
        assert_eq!(
            std::fs::read_to_string(&cache).unwrap(),
            "warm reads must not touch this file"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        server.abort();
    }

    fn mock_connection() -> (AcpBridge, tokio::io::DuplexStream, tokio::io::DuplexStream) {
        let (changes, _) = tokio::sync::watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp".into(),
            changes,
            crate::state::SecurityProfile::private(),
        )));
        let (outbound, peer) = tokio::io::duplex(8192);
        let (writer, inbound) = tokio::io::duplex(8192);
        (
            AcpBridge::for_test(state, outbound, inbound, "opencode"),
            peer,
            writer,
        )
    }

    #[tokio::test]
    async fn idle_pool_caps_lru_preserves_running_and_in_use_connections() {
        let connections = Arc::new(Mutex::new(HashMap::new()));
        let mut peers = Vec::new();
        let mut held = None;
        for id in 0..6 {
            let (bridge, peer, writer) = mock_connection();
            peers.push((peer, writer));
            let bridge = Arc::new(bridge);
            if id == 0 {
                bridge.sessions.lock().await.insert(
                    "running".into(),
                    SessionRuntime {
                        turn_id: Some("turn".into()),
                        ..Default::default()
                    },
                );
            }
            if id == 1 {
                held = Some(bridge.clone());
            }
            connections.lock().await.insert(
                id.to_string(),
                SessionConnection {
                    bridge,
                    last_used: Instant::now() - Duration::from_secs(10 - id),
                },
            );
        }
        evict_idle_sessions(&connections).await;
        let mut keys: Vec<_> = connections.lock().await.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["0", "1", "4", "5"]);
        drop(held);
        for connection in connections.lock().await.values_mut() {
            connection.last_used = Instant::now() - IDLE_SESSION_TIMEOUT;
        }
        evict_idle_sessions(&connections).await;
        assert_eq!(
            connections.lock().await.keys().cloned().collect::<Vec<_>>(),
            ["0"]
        );
        {
            let connections = connections.lock().await;
            connections["0"]
                .bridge
                .sessions
                .lock()
                .await
                .get_mut("running")
                .unwrap()
                .turn_id = None;
        }
        evict_idle_sessions(&connections).await;
        assert!(
            connections.lock().await.contains_key("0"),
            "a long turn gets its idle timeout after completion"
        );
    }

    #[tokio::test]
    async fn failed_close_releases_connection_without_blocking_other_sessions() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (index, _index_peer, _index_writer) = mock_connection();
        let (closing, peer, mut writer) = mock_connection();
        closing.capabilities.lock().await.close_session = true;
        let (other, _other_peer, _other_writer) = mock_connection();
        let connections = HashMap::from([
            (
                "closing".into(),
                SessionConnection {
                    bridge: Arc::new(closing),
                    last_used: Instant::now(),
                },
            ),
            (
                "other".into(),
                SessionConnection {
                    bridge: Arc::new(other),
                    last_used: Instant::now(),
                },
            ),
        ]);
        let bridge = OpenCodeBridge {
            index,
            sessions: Arc::new(Mutex::new(connections)),
            catalog_directory: "/tmp".into(),
            catalog_loaded: Mutex::new(false),
        };
        let close = bridge.release_thread("closing");
        let other = async {
            let line = BufReader::new(peer)
                .lines()
                .next_line()
                .await
                .unwrap()
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            timeout(Duration::from_millis(100), bridge.session("other"))
                .await
                .unwrap()
                .unwrap();
            writer.write_all(format!("{}\n", json!({"jsonrpc":"2.0", "id":request["id"], "error":{"code":-32000,"message":"close failed"}})).as_bytes()).await.unwrap();
        };
        let (released, ()) = tokio::join!(close, other);
        released.unwrap();
        assert!(!bridge.sessions.lock().await.contains_key("closing"));
        {
            let connections = bridge.sessions.lock().await;
            let other = &connections["other"].bridge;
            other.sessions.lock().await.insert(
                "other".into(),
                SessionRuntime {
                    turn_id: Some("turn".into()),
                    ..Default::default()
                },
            );
        }
        assert!(bridge.release_thread("other").await.is_err());
        {
            let connections = bridge.sessions.lock().await;
            let other = &connections["other"].bridge;
            other
                .sessions
                .lock()
                .await
                .get_mut("other")
                .unwrap()
                .turn_id = None;
            other.stream_closed.store(true, Ordering::Release);
        }
        bridge.release_thread("other").await.unwrap();
        assert!(bridge.sessions.lock().await.is_empty());
    }

    #[test]
    fn native_fork_checks_the_start_of_a_row_spanning_multiple_messages() {
        let mut session = SessionRuntime::default();
        let mut transcript = Vec::new();
        for update in [
            json!({"sessionUpdate":"tool_call", "toolCallId":"call_a", "title":"Inspect", "status":"completed"}),
            json!({"sessionUpdate":"agent_message_chunk", "messageId":"msg_a", "content":{"type":"text","text":"b"}}),
            json!({"sessionUpdate":"agent_thought_chunk", "messageId":"part_b", "content":{"type":"text","text":"thinking"}}),
            json!({"sessionUpdate":"agent_message_chunk", "messageId":"msg_b", "content":{"type":"text","text":"c"}}),
        ] {
            let op = rpc::plan_update(&update, &mut session);
            rpc::capture_op(&mut transcript, op);
        }
        let messages = vec![
            json!({"info":{"id":"msg_a"}, "parts":[{"id":"part_a", "callID":"call_a"}]}),
            json!({"info":{"id":"msg_b"}, "parts":[{"id":"part_b"}]}),
        ];
        let tool = transcript[0].item_id.as_deref().unwrap();
        let text = transcript[1].item_id.as_deref().unwrap();
        assert_eq!(session.native_event_refs[text].first, "msg_a");
        assert_eq!(session.native_event_refs[text].last, "msg_b");
        assert_eq!(
            fork_boundary(&transcript, &session.native_event_refs, &messages, tool),
            None
        );
    }

    fn rows(ids: &[&str]) -> Vec<TranscriptEntryView> {
        let mut rows = Vec::new();
        for id in ids {
            rpc::capture_op(
                &mut rows,
                rpc::TranscriptOp::User {
                    item_id: (*id).into(),
                    text: (*id).into(),
                },
            );
        }
        rows
    }

    #[test]
    fn native_fork_converts_inclusive_rows_to_exclusive_messages() {
        let messages = vec![
            json!({"info": {"id": "msg_a"}, "parts": []}),
            json!({"info": {"id": "msg_b"}, "parts": [{"id": "part_b", "callID": "call_b"}]}),
            json!({"info": {"id": "msg_c"}, "parts": []}),
        ];
        let refs = HashMap::from([
            ("user".into(), "msg_a".into()),
            ("tool".into(), "call_b".into()),
            ("reply".into(), "msg_c".into()),
        ]);
        let rows = rows(&["user", "tool", "reply"]);
        assert_eq!(
            fork_boundary(&rows, &refs, &messages, "user"),
            Some(Some("msg_b".into()))
        );
        assert_eq!(
            fork_boundary(&rows, &refs, &messages, "tool"),
            Some(Some("msg_c".into()))
        );
        assert_eq!(fork_boundary(&rows, &refs, &messages, "reply"), Some(None));
        assert_eq!(fork_boundary(&rows, &refs, &messages, "unknown"), None);
    }

    #[test]
    fn native_fork_never_widens_a_row_inside_one_message() {
        let messages = vec![
            json!({"info": {"id": "msg_a"}, "parts": [{"id": "part_a"}, {"id": "part_b", "callID": "call_b"}]}),
        ];
        let refs = HashMap::from([
            ("thought".into(), "part_a".into()),
            ("tool".into(), "call_b".into()),
        ]);
        let rows = rows(&["thought", "tool"]);
        assert_eq!(fork_boundary(&rows, &refs, &messages, "thought"), None);
        assert_eq!(fork_boundary(&rows, &refs, &messages, "tool"), Some(None));
    }
}
