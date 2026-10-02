use super::*;
use rand::RngCore;

pub(in crate::acp) struct Api {
    client: reqwest::Client,
    port: u16,
    password: String,
}

impl Api {
    #[cfg(test)]
    pub(in crate::acp) fn for_test(port: u16) -> Self {
        let mut api = Self::new().unwrap();
        api.port = port;
        api
    }

    pub(in crate::acp) fn new() -> Result<Self, String> {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let mut secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut secret);
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?,
            port,
            password: secret.iter().map(|byte| format!("{byte:02x}")).collect(),
        })
    }

    pub(in crate::acp) fn configure(&self, command: &mut Command) {
        command
            .args([
                "--hostname",
                "127.0.0.1",
                "--port",
                &self.port.to_string(),
                "--mdns=false",
            ])
            .env("OPENCODE_SERVER_USERNAME", "sealwire")
            .env("OPENCODE_SERVER_PASSWORD", &self.password);
    }

    pub(in crate::acp) async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        cwd: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut request = self
            .client
            .request(method, format!("http://127.0.0.1:{}{path}", self.port))
            .basic_auth("sealwire", Some(&self.password))
            .query(&[("directory", cwd)])
            .query(query);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("OpenCode API: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("OpenCode API {path}: HTTP {status}"));
        }
        response
            .json()
            .await
            .map_err(|e| format!("OpenCode API {path}: {e}"))
    }
}

impl AcpBridge {
    pub(in crate::acp) async fn complete_opencode_model_catalog(
        &self,
        cwd: &str,
    ) -> Result<Vec<ModelOptionView>, String> {
        let providers = self
            .opencode_request(reqwest::Method::GET, "/provider", cwd, None)
            .await?;
        let providers = providers["all"]
            .as_array()
            .ok_or("OpenCode returned an invalid provider catalog")?;
        let mut models = self.models.lock().await;
        populate_native_details(&mut models, providers);
        if let Some(path) = self.models_cache.as_deref() {
            write_cached_models(path, &models);
        }
        Ok(models.clone())
    }

    pub(in crate::acp) async fn opencode_request(
        &self,
        method: reqwest::Method,
        path: &str,
        cwd: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        self.opencode_api
            .as_ref()
            .ok_or("OpenCode HTTP API is unavailable")?
            .request(method, path, cwd, &[], body)
            .await
    }

    pub(in crate::acp) async fn refresh_opencode_tools(&self, id: &str) -> Result<(), String> {
        let server = self
            .sessions
            .lock()
            .await
            .get(id)
            .and_then(|s| s.relay_mcp_server.clone());
        if let Some(server) = server {
            let cwd = self.resolve_cwd(id).await?;
            // OpenCode caches tools/list; roles and permissions can change between turns.
            self.opencode_request(
                reqwest::Method::POST,
                &format!("/mcp/{server}/connect"),
                &cwd,
                None,
            )
            .await?;
            let status = self
                .opencode_request(reqwest::Method::GET, "/mcp", &cwd, None)
                .await?;
            if status[&server]["status"].as_str() != Some("connected") {
                return Err("OpenCode could not connect this session's Sealwire tools".into());
            }
        }
        Ok(())
    }

    pub(in crate::acp) async fn validate_opencode_command(
        &self,
        id: &str,
        text: &str,
    ) -> Result<(), String> {
        let Some((name, arguments)) = native_command(text) else {
            return Ok(());
        };
        let (approval, sandbox, mode, cwd) = {
            let sessions = self.sessions.lock().await;
            let session = sessions.get(id).ok_or("OpenCode session is not attached")?;
            (
                session.approval_policy.clone(),
                session.sandbox.clone(),
                session.mode.clone(),
                session.cwd.clone(),
            )
        };
        if matches!(approval.as_str(), "never" | "bypass") && sandbox != "read-only" {
            return Ok(());
        }
        let commands = self
            .opencode_request(reqwest::Method::GET, "/command", &cwd, None)
            .await?;
        let commands = commands
            .as_array()
            .ok_or("OpenCode returned invalid commands")?;
        let Some(command) = commands
            .iter()
            .find(|command| command["name"].as_str() == Some(name))
        else {
            return Ok(());
        };
        if unsafe_command_expansion(&command["template"], arguments) {
            return Err(format!("OpenCode expands shell or file references in /{name} without permission checks; send a normal message so Sealwire tool approvals apply"));
        }
        let mut subtask = command["subtask"].as_bool() == Some(true);
        if command["subtask"].as_bool() != Some(false) && !subtask {
            let agents = self
                .opencode_request(reqwest::Method::GET, "/agent", &cwd, None)
                .await?;
            let agents = agents
                .as_array()
                .ok_or("OpenCode returned invalid agents")?;
            let agent = command["agent"].as_str().unwrap_or(&mode);
            subtask = agents
                .iter()
                .any(|row| row["name"].as_str() == Some(agent) && row["mode"] == "subagent");
        }
        // Native command subtasks bypass task permission checks and drop inherited ask rules.
        if subtask {
            return Err(format!("OpenCode command /{name} starts a subagent that cannot preserve Sealwire approvals; use /delegate instead"));
        }
        Ok(())
    }

    pub(in crate::acp) async fn apply_opencode_policy(
        &self,
        id: &str,
        approval: &str,
        sandbox: &str,
    ) -> Result<(), String> {
        let cwd = self.resolve_cwd(id).await?;
        let path = format!("/session/{id}");
        let native = self
            .opencode_request(reqwest::Method::GET, &path, &cwd, None)
            .await?;
        if native["directory"].as_str() != Some(cwd.as_str()) {
            return Err("OpenCode session belongs to a different working directory".into());
        }
        let server = self
            .sessions
            .lock()
            .await
            .get(id)
            .and_then(|s| s.relay_mcp_server.clone());
        let rules = permission_rules(approval, sandbox, server.as_deref());
        // Upstream PATCH appends rules. Avoid rewriting unchanged policy on every turn.
        if native["permission"]
            .as_array()
            .is_some_and(|current| current.ends_with(&rules))
        {
            return Ok(());
        }
        self.opencode_request(
            reqwest::Method::PATCH,
            &path,
            &cwd,
            Some(json!({"permission": rules})),
        )
        .await?;
        Ok(())
    }
}

fn native_command(text: &str) -> Option<(&str, &str)> {
    // ACP uses JavaScript whitespace: it includes BOM but excludes NEL.
    let whitespace = |ch: char| ch != '\u{85}' && (ch.is_whitespace() || ch == '\u{feff}');
    let command = text.trim_matches(whitespace).strip_prefix('/')?;
    let (name, arguments) = command.split_once(whitespace).unwrap_or((command, ""));
    (!name.is_empty()).then_some((name, arguments))
}

fn unsafe_command_expansion(template: &Value, arguments: &str) -> bool {
    let Some(template) = template.as_str() else {
        return true;
    };
    // Placeholders can assemble shell syntax across template/argument boundaries.
    [template, arguments].iter().any(|text| text.contains('@'))
        || ([template, arguments].iter().any(|text| text.contains('!'))
            && [template, arguments].iter().any(|text| text.contains('`')))
}

fn populate_native_details(models: &mut [ModelOptionView], providers: &[Value]) {
    for model in models {
        let Some((provider, id)) = model.model.split_once('/') else {
            continue;
        };
        let Some(native) = providers
            .iter()
            .find(|row| row["id"].as_str() == Some(provider))
            .and_then(|row| row["models"].get(id))
        else {
            continue;
        };
        // Image, video, speech and embedding models cannot call tools, so a session
        // started on one can do no work. OpenCode lists them all the same.
        model.hidden = native["capabilities"]["toolcall"] == false;
        let mut efforts: Vec<_> = native["variants"]
            .as_object()
            .into_iter()
            .flat_map(|variants| variants.keys())
            .filter(|key| key.as_str() != "default")
            .cloned()
            .collect();
        let order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
        efforts.sort_by_key(|effort| {
            order
                .iter()
                .position(|known| *known == effort)
                .unwrap_or(order.len())
        });
        efforts.push("default".into());
        // ACP otherwise picks the first variant, which can disable reasoning ("none").
        model.default_reasoning_effort = "default".into();
        model.supported_reasoning_efforts = efforts;
    }
}

pub(super) fn permission_rules(
    approval: &str,
    sandbox: &str,
    relay_server: Option<&str>,
) -> Vec<Value> {
    let read_only = sandbox == "read-only" || approval == "review_read_only";
    let mut rules = vec![
        json!({"permission": "*", "pattern": "*", "action": if read_only { "deny" } else if matches!(approval, "never" | "bypass") { "allow" } else { "ask" }}),
    ];
    if read_only || approval == "on-request" {
        for permission in ["read", "glob", "grep", "list", "lsp", "skill"] {
            rules.push(json!({"permission": permission, "pattern": "*", "action": "allow"}));
        }
    }
    if !read_only && !matches!(approval, "never" | "bypass") {
        // OpenCode subagents inherit denies, but discard the parent's ask rules.
        rules.push(json!({"permission": "task", "pattern": "*", "action": "deny"}));
        if approval == "on-request" {
            for pattern in ["*.env", "*.env.*"] {
                rules.push(json!({"permission": "read", "pattern": pattern, "action": "ask"}));
            }
            rules
                .push(json!({"permission": "read", "pattern": "*.env.example", "action": "allow"}));
            rules.push(json!({"permission": "todowrite", "pattern": "*", "action": "allow"}));
        }
    }
    if read_only {
        for permission in ["webfetch", "websearch"] {
            rules.push(json!({"permission": permission, "pattern": "*", "action": "allow"}));
        }
        // Inspection needs shell commands; this is tool-level containment, not an OS sandbox.
        rules.push(json!({"permission": "bash", "pattern": "*", "action": "allow"}));
        rules.push(json!({"permission": "external_directory", "pattern": "*", "action": "allow"}));
    }
    if let Some(server) = relay_server {
        rules.push(
            json!({"permission": format!("{}_*", server), "pattern": "*", "action": "allow"}),
        );
    }
    rules
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_command_guards_match_acp_whitespace_and_cover_template_expansion() {
        for text in [
            "/init args",
            "\u{feff}/init args",
            "/init\u{feff}args",
            " \u{feff}/init\u{feff}args\u{feff}",
        ] {
            assert_eq!(native_command(text), Some(("init", "args")));
        }
        assert_eq!(native_command("/init"), Some(("init", "")));
        assert_eq!(
            native_command("/foo\u{85}bar args"),
            Some(("foo\u{85}bar", "args"))
        );
        assert_eq!(native_command("/init\u{85}"), Some(("init\u{85}", "")));
        assert_eq!(native_command("\u{85}/init args"), None);
        assert_eq!(native_command("plain /init"), None);
        assert_eq!(native_command("/  "), None);
        for (template, args) in [
            (json!("$ARGUMENTS"), "!`touch escaped`"),
            (json!("!`touch escaped`"), ""),
            (json!("!$1`touch escaped`"), ""),
            (json!("$1`touch escaped`"), "!"),
            (json!("!$ARGUMENTS"), "`touch escaped`"),
            (json!("$ARGUMENTS"), "@../.env"),
            (json!("@~/.ssh/key"), ""),
            (json!({}), "plain"),
        ] {
            assert!(
                unsafe_command_expansion(&template, args),
                "{template}: {args}"
            );
        }
        assert!(!unsafe_command_expansion(
            &json!("Inspect `Cargo.toml`: $ARGUMENTS"),
            "explain build"
        ));
    }

    #[test]
    fn models_that_cannot_call_tools_are_hidden() {
        let options = json!([
            {"category": "model", "type": "select", "currentValue": "google/gemini-3.8-flash", "options": [
                {"value": "google/gemini-3.8-flash"}, {"value": "google/veo-3.1-generate-preview"},
                {"value": "google/gemini-embedding-2"}, {"value": "custom/unknown"}
            ]}
        ]);
        let mut models = crate::acp::config::models(
            options.as_array().unwrap(),
            "opencode",
            Some("google/gemini-3.8-flash"),
            &[],
            true,
        );
        populate_native_details(
            &mut models,
            &[json!({"id": "google", "models": {
                "gemini-3.8-flash": {"capabilities": {"toolcall": true}},
                "veo-3.1-generate-preview": {"capabilities": {"toolcall": false}},
                "gemini-embedding-2": {"capabilities": {"toolcall": false}}
            }})],
        );
        let hidden: Vec<_> = models
            .iter()
            .map(|m| (m.model.as_str(), m.hidden))
            .collect();
        assert_eq!(
            hidden,
            [
                ("google/gemini-3.8-flash", false),
                ("google/veo-3.1-generate-preview", true),
                ("google/gemini-embedding-2", true),
                ("custom/unknown", false),
            ]
        );
    }

    #[test]
    fn provider_catalog_populates_unselected_models_without_borrowing_efforts() {
        let options = json!([
            {"category": "model", "type": "select", "currentValue": "test/echo", "options": [
                {"value": "test/echo"}, {"value": "test/namespace/reasoner"}, {"value": "test/plain"}
            ]},
            {"category": "thought_level", "type": "select", "currentValue": "low", "options": [
                {"value": "low"}, {"value": "high"}, {"value": "default"}
            ]}
        ]);
        let mut models = crate::acp::config::models(
            options.as_array().unwrap(),
            "opencode",
            Some("test/echo"),
            &[],
            true,
        );
        models[2].supported_reasoning_efforts = vec!["high".into()];
        models[2].default_reasoning_effort = "high".into();
        populate_native_details(
            &mut models,
            &[json!({"id": "test", "models": {
                "echo": {"variants": {"high": {}, "low": {}}},
                "namespace/reasoner": {"variants": {"xhigh": {}, "minimal": {}, "turbo": {}}},
                "plain": {"variants": {}}
            }})],
        );
        assert_eq!(
            models[0].supported_reasoning_efforts,
            ["low", "high", "default"]
        );
        assert_eq!(models[0].default_reasoning_effort, "default");
        assert!(models[0].is_default);
        assert_eq!(models[1].model, "test/namespace/reasoner");
        assert_eq!(
            models[1].supported_reasoning_efforts,
            ["minimal", "xhigh", "turbo", "default"]
        );
        assert_eq!(models[1].default_reasoning_effort, "default");
        assert_eq!(models[2].supported_reasoning_efforts, ["default"]);
        assert_eq!(models[2].default_reasoning_effort, "default");
    }
}
