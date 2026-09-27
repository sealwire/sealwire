//! What each provider's CLI says about itself (version, sign-in, plan) for the
//! Settings > Providers panel. Every field is best-effort: `None` means "could not tell".

use std::ffi::OsString;
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;
use tokio::time::timeout;

const CLI_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderAccount {
    pub version: Option<String>,
    pub signed_in: Option<bool>,
    /// The subscription as a person would say it: "Max", "Pro", "API key".
    pub plan: Option<String>,
    pub login_command: Option<&'static str>,
}

/// Runs a CLI and returns stdout. A non-zero exit still yields its stdout, because a
/// signed-out status command often exits 1 while printing exactly what we need.
pub(crate) async fn run_cli(program: OsString, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(&program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = timeout(CLI_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("{} {} timed out", program.to_string_lossy(), args.join(" ")))?
        .map_err(|error| format!("{} {}: {error}", program.to_string_lossy(), args.join(" ")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if stdout.trim().is_empty() && !output.status.success() {
        return Err(format!(
            "{} {} exited with {}",
            program.to_string_lossy(),
            args.join(" "),
            output.status
        ));
    }
    Ok(stdout)
}

/// First dotted version number in a CLI banner: "codex-cli 0.156.1" -> "0.156.1".
pub(crate) fn version_from_banner(stdout: &str) -> Option<String> {
    stdout
        .split_whitespace()
        .map(|token| token.trim_matches(|c: char| c == '(' || c == ')' || c == 'v'))
        .find(|token| {
            let mut parts = token.split('.');
            parts
                .next()
                .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
                && parts.next().is_some()
        })
        .map(str::to_string)
}

/// "prolite" / "pro_lite" / "max" -> "Pro Lite" / "Pro Lite" / "Max".
pub(crate) fn plan_label(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let spaced = match raw.to_ascii_lowercase().as_str() {
        "prolite" => "pro lite".to_string(),
        other => other.replace(['_', '-'], " "),
    };
    Some(
        spaced
            .split_whitespace()
            .map(|word| {
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Codex app-server `account/read`: `{account: {type, planType} | null, requiresOpenaiAuth}`.
pub(crate) fn codex_account_from_read(result: &Value) -> (Option<bool>, Option<String>) {
    match result.get("account") {
        Some(account) if account.is_object() => {
            let plan = match account.get("type").and_then(Value::as_str) {
                Some("apiKey") => Some("API key".to_string()),
                _ => account
                    .get("planType")
                    .and_then(Value::as_str)
                    .and_then(plan_label),
            };
            (Some(true), plan)
        }
        // No account is only "signed out" when the CLI says it needs one; a local
        // model provider runs without any.
        _ => match result.get("requiresOpenaiAuth").and_then(Value::as_bool) {
            Some(true) => (Some(false), None),
            _ => (None, None),
        },
    }
}

/// The Claude worker's `account/read` reply (see claude-worker/cli-account.mjs).
pub(crate) fn claude_account_from_worker(result: &Value) -> ProviderAccount {
    let signed_in = result.get("logged_in").and_then(Value::as_bool);
    let plan = result
        .get("subscription_type")
        .and_then(Value::as_str)
        .and_then(plan_label)
        .or_else(|| {
            // Signed in without a subscription means a Console API key.
            let method = result.get("auth_method").and_then(Value::as_str)?;
            (signed_in == Some(true) && method != "claude.ai").then(|| "API key".to_string())
        });
    ProviderAccount {
        version: result
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        signed_in,
        plan,
        login_command: Some("claude auth login"),
    }
}

/// `cursor-agent about --format json` and `cursor-agent status --format json`.
pub(crate) fn cursor_account(about: Option<&Value>, status: Option<&Value>) -> ProviderAccount {
    ProviderAccount {
        version: about
            .and_then(|about| about.get("cliVersion"))
            .and_then(Value::as_str)
            .map(str::to_string),
        signed_in: status
            .and_then(|status| status.get("isAuthenticated"))
            .and_then(Value::as_bool),
        plan: about
            .and_then(|about| about.get("subscriptionTier"))
            .and_then(Value::as_str)
            .and_then(plan_label),
        login_command: Some("cursor-agent login"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn version_from_banner_finds_the_dotted_number() {
        assert_eq!(
            version_from_banner("codex-cli 0.156.1\n").as_deref(),
            Some("0.156.1")
        );
        assert_eq!(
            version_from_banner("2.1.281 (Claude Code)").as_deref(),
            Some("2.1.281")
        );
        assert_eq!(version_from_banner("v1.9.0").as_deref(), Some("1.9.0"));
        assert_eq!(version_from_banner("no version here"), None);
    }

    #[test]
    fn plan_label_reads_like_the_vendor_says_it() {
        assert_eq!(plan_label("max").as_deref(), Some("Max"));
        assert_eq!(plan_label("prolite").as_deref(), Some("Pro Lite"));
        assert_eq!(plan_label("team_premium").as_deref(), Some("Team Premium"));
        assert_eq!(plan_label("Pro").as_deref(), Some("Pro"));
        assert_eq!(plan_label("  "), None);
    }

    #[test]
    fn codex_account_distinguishes_signed_out_from_no_account_needed() {
        assert_eq!(
            codex_account_from_read(&json!({
                "account": {"type": "chatgpt", "planType": "pro", "email": "me@example.com"},
                "requiresOpenaiAuth": true
            })),
            (Some(true), Some("Pro".to_string()))
        );
        assert_eq!(
            codex_account_from_read(
                &json!({"account": {"type": "apiKey"}, "requiresOpenaiAuth": true})
            ),
            (Some(true), Some("API key".to_string()))
        );
        assert_eq!(
            codex_account_from_read(&json!({"account": null, "requiresOpenaiAuth": true})),
            (Some(false), None)
        );
        assert_eq!(
            codex_account_from_read(&json!({"account": null, "requiresOpenaiAuth": false})),
            (None, None)
        );
    }

    #[test]
    fn claude_account_maps_the_worker_reply() {
        let account = claude_account_from_worker(&json!({
            "version": "2.1.281", "logged_in": true, "subscription_type": "max", "auth_method": "claude.ai"
        }));
        assert_eq!(account.version.as_deref(), Some("2.1.281"));
        assert_eq!(account.signed_in, Some(true));
        assert_eq!(account.plan.as_deref(), Some("Max"));

        let api_key = claude_account_from_worker(&json!({
            "version": "2.1.281", "logged_in": true, "subscription_type": null, "auth_method": "console"
        }));
        assert_eq!(api_key.plan.as_deref(), Some("API key"));

        let signed_out = claude_account_from_worker(&json!({
            "version": null, "logged_in": false, "subscription_type": null, "auth_method": "none"
        }));
        assert_eq!(signed_out.signed_in, Some(false));
        assert_eq!(signed_out.plan, None);
        assert_eq!(signed_out.login_command, Some("claude auth login"));
    }

    #[test]
    fn cursor_account_reads_about_and_status() {
        let about = json!({"cliVersion": "2026.08.04-aaa8809", "subscriptionTier": "Pro", "userEmail": "me@example.com"});
        let status = json!({"status": "authenticated", "isAuthenticated": true});
        let account = cursor_account(Some(&about), Some(&status));
        assert_eq!(account.version.as_deref(), Some("2026.08.04-aaa8809"));
        assert_eq!(account.plan.as_deref(), Some("Pro"));
        assert_eq!(account.signed_in, Some(true));

        let unknown = cursor_account(None, None);
        assert_eq!(unknown.signed_in, None);
        assert_eq!(unknown.version, None);
    }
}
