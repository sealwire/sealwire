use serde_json::{json, Value};

use crate::provider::{self, SealwireMcpIdentity, StartThreadRequest};

use super::PiBridge;

pub(super) fn literal(value: &str) -> String {
    let escaped = value.replace('$', "$$");
    if escaped.starts_with('!') {
        format!("${escaped}")
    } else {
        escaped
    }
}

impl PiBridge {
    pub(super) async fn mcp_config(
        &self,
        handle: &str,
        request: Option<&StartThreadRequest>,
    ) -> (Option<Value>, Option<String>) {
        let mut relay = self.state.write().await;
        let session_id = relay
            .session_for_provider_handle("pi", handle)
            .unwrap_or_else(|| handle.into());
        let identity = request
            .map(|r| provider::sealwire_mcp_for_new_session(&r.purpose))
            .unwrap_or_else(|| {
                provider::sealwire_mcp_for_reattach(
                    relay.retained_seat_run_id_for_thread(&session_id),
                    relay.thread_is_standalone(&session_id),
                )
            });
        let token;
        let mut env = json!({
            "SEALWIRE_RELAY_URL": provider::sealwire_relay_url(),
            "SEALWIRE_ASK_TOKEN": "",
            "SEALWIRE_SEAT_RUN_ID": "",
            "SEALWIRE_DEVICE_ID": "",
        });
        let name = match identity {
            SealwireMcpIdentity::Peer => {
                let value = if request.is_some() {
                    relay.mint_unbound_ask_token(true)
                } else {
                    relay.ask_token_for_thread(&session_id)
                };
                env["SEALWIRE_ASK_TOKEN"] = json!(value);
                let name = provider::relay_mcp_server_name(&value);
                token = Some(value);
                name
            }
            _ => return (None, None),
        };
        env["SEALWIRE_PI_MARKS"] = json!("1");
        for value in env.as_object_mut().unwrap().values_mut() {
            *value = json!(literal(value.as_str().unwrap()));
        }
        let path = std::path::PathBuf::from(provider::sealwire_mcp_bridge_path());
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir().unwrap_or_default().join(path)
        };
        (
            Some(json!({
                "name": name,
                "server": {
                    "command": std::env::var("CLAUDE_NODE_BINARY").unwrap_or_else(|_| "node".into()),
                    "args": [path.to_string_lossy()],
                    "env": env,
                    "exposure": "direct",
                }
            })),
            token,
        )
    }
}
