//! Pure translation between ACP (Agent Client Protocol) shapes and relay views.
//!
//! Everything here is side-effect free so it can be unit-tested without a live
//! `cursor-agent acp` process. The measured wire shapes this targets are
//! recorded in `markdown/cursor-acp-provider-plan.md` (spike, 2026-08-11).

use serde_json::{json, Value};

use crate::protocol::{
    ApprovalDecision, ApprovalDecisionInput, ApprovalScope, ModelOptionView, ThreadSummaryView,
};

/// ACP session modes, as advertised by `session/new`'s `availableModes`.
pub(crate) const MODE_AGENT: &str = "agent";
pub(crate) const MODE_PLAN: &str = "plan";

/// Map the relay's (approval_policy, sandbox) pair onto an ACP mode.
///
/// ACP has no sandbox concept — it has modes. `plan` is "read-only mode for
/// planning and designing", which is the honest target for a read-only relay
/// thread (a reviewer still needs to *read* files, so `ask` — "no edits or
/// command execution" — would be too strict). Everything else runs as `agent`
/// and relies on `session/request_permission` for containment.
pub(crate) fn acp_mode_for_policy(approval_policy: &str, sandbox: &str) -> &'static str {
    if sandbox == "read-only" || approval_policy == "review_read_only" {
        MODE_PLAN
    } else {
        MODE_AGENT
    }
}

/// Whether the relay should auto-answer `session/request_permission` instead of
/// parking it for the user.
///
/// ACP always asks (verified: `cat` triggered a prompt with "Not in allowlist"),
/// so a relay thread configured to never prompt has to be satisfied on the
/// bridge side rather than by a provider flag.
pub(crate) fn auto_approves(approval_policy: &str) -> bool {
    matches!(approval_policy, "never" | "bypass" | "bypassPermissions")
}

/// What the agent's MCP servers are doing, ready to be logged.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct McpSummary {
    /// One-line census. `None` when nothing is configured — a relay that logs
    /// "MCP: 0 configured" on every boot is training the user to ignore the log.
    pub(crate) headline: Option<String>,
    /// One line per server that is failing or reporting something unrecognized.
    pub(crate) problems: Vec<String>,
}

/// Parse `<agent> mcp list` into a census plus the problems worth surfacing.
///
/// ACP cannot answer this. Measured 2026-08-12 against `cursor-agent
/// 2026.08.04-aaa8809` with a healthy, a broken and a disabled server
/// configured: `initialize` advertises `agentCapabilities.mcpCapabilities`
/// (what the *client* may pass in, not what the agent loaded) and `session/new`
/// returns only `sessionId`/`modes`/`models`/`configOptions`. No MCP field, and
/// no notification, while two servers were actively failing. So the CLI is the
/// only signal — the same conclusion codex reached for its own app-server.
///
/// The measured grammar is `<name>: <status>`, with `status` one of `ready`,
/// `disabled`, or `Error: <message>`; an empty install prints a single
/// "No MCP servers configured …" line. There is no `--json`.
pub(crate) fn summarize_mcp_servers(provider: &str, output: &str) -> McpSummary {
    let (mut ready, mut disabled, mut failed, mut unknown) = (0_usize, 0_usize, 0_usize, 0_usize);
    let mut problems = Vec::new();
    let mut total = 0_usize;

    for raw_line in output.lines() {
        // Indentation means continuation, not a new server. A failing stdio
        // server prints a stack trace, and every frame contains a colon — read
        // as `name: status` those become phantom servers, one `warn` line each,
        // which is enough to evict the whole audit-log buffer at boot.
        if raw_line.starts_with(char::is_whitespace) {
            continue;
        }
        let line = raw_line.trim();
        // The measured empty-install sentence has no colon and would fall out of
        // the parser on its own; this guard is for a build that words it with
        // one, which would otherwise be read as a broken server named
        // "No MCP servers configured (expected in".
        if line.is_empty() || line.starts_with("No MCP servers configured") {
            continue;
        }

        // Split at the status, not at the first colon: a name may contain one
        // (`aws:prod: ready`), and so may the status (`Error: spawn … ENOENT`).
        // Recognise the known tail first and only fall back to the naive split.
        let (name, status) = if let Some(name) = strip_status_suffix(line, "ready") {
            (name, Status::Ready)
        } else if let Some(name) = strip_status_suffix(line, "disabled") {
            (name, Status::Disabled)
        } else if let Some((name, reason)) = split_error_status(line) {
            (name, Status::Failed(reason))
        } else {
            match line.split_once(':') {
                Some((name, status)) => (name.trim(), Status::Unknown(status.trim())),
                None => continue,
            }
        };
        if name.is_empty() {
            continue;
        }
        total += 1;

        match status {
            Status::Ready => ready += 1,
            Status::Disabled => disabled += 1,
            Status::Failed(reason) => {
                failed += 1;
                problems.push(format!(
                    "{provider} MCP server `{name}` failed to load: {reason}"
                ));
            }
            // Deliberately not counted as healthy. The grammar was measured
            // against one build of one agent; a status nobody has seen must
            // read as "unknown", not as "fine".
            Status::Unknown(status) => {
                unknown += 1;
                problems.push(format!(
                    "{provider} MCP server `{name}` reported an unrecognized status: {status}"
                ));
            }
        }
    }

    if total == 0 {
        return McpSummary::default();
    }

    // Named, because the channel no longer says whose these are: filed under
    // `info`/`warn` so the audit view shows them at all, two agents on one relay
    // would otherwise produce two indistinguishable census lines.
    let mut headline = format!(
        "{provider} MCP: {total} configured ({ready} ready, {disabled} disabled, {failed} failed"
    );
    if unknown > 0 {
        headline.push_str(&format!(", {unknown} unrecognized"));
    }
    headline.push(')');

    McpSummary {
        headline: Some(headline),
        problems,
    }
}

enum Status<'a> {
    Ready,
    Disabled,
    Failed(&'a str),
    Unknown(&'a str),
}

/// `"<name>: <word>"` → `<name>`, case-insensitively.
fn strip_status_suffix<'a>(line: &'a str, word: &str) -> Option<&'a str> {
    let split = line.len().checked_sub(word.len())?;
    line.get(split..)
        .filter(|tail| tail.eq_ignore_ascii_case(word))
        .and_then(|_| line.get(..split))
        .and_then(|head| head.trim_end().strip_suffix(':'))
        .map(str::trim)
}

/// `"<name>: Error: <reason>"` → `(<name>, <reason>)`, case-insensitively on the
/// marker so a build that lowercases it is still counted as failed rather than
/// silently bucketed as "unrecognized" with a `0 failed` headline.
fn split_error_status(line: &str) -> Option<(&str, &str)> {
    let marker = line
        .char_indices()
        .find(|(index, _)| {
            line[*index..].len() >= 7 && line[*index..*index + 7].eq_ignore_ascii_case(": error")
        })
        .map(|(index, _)| index)?;
    let name = line.get(..marker)?.trim();
    let reason = line
        .get(marker + 7..)?
        .trim_start()
        .trim_start_matches(':')
        .trim();
    Some((name, reason))
}

/// Prefix marking a parked approval as a `cursor/create_plan`, not a
/// `session/request_permission`.
///
/// The two share `respond_to_approval` and the same `result.outcome` envelope
/// but speak different vocabularies, so the bridge has to tell them apart after
/// the round trip through the relay. The discriminator is this relay-minted id
/// prefix rather than "the pending has no option list": an agent that sent a
/// *permission* request with an empty `options` array would then be read as a
/// plan and answered `accepted` — auto-granting a permission nobody approved.
/// A missing option list must keep meaning "cancel" (see `approval_option_id`).
pub(crate) const PLAN_APPROVAL_PREFIX: &str = "acp-plan-";

pub(crate) fn is_plan_approval(request_id: &str) -> bool {
    request_id.starts_with(PLAN_APPROVAL_PREFIX)
}

/// The outcome to answer `cursor/create_plan` with.
///
/// Measured 2026-08-11 against `cursor-agent 2026.08.04-aaa8809`, and confirmed
/// against the agent's own `create-plan-handler.ts`: the result must be
/// `{outcome: {outcome: "accepted"|"rejected"|"cancelled", ...}}`. Anything else
/// — including the blanket `{}` this bridge used to send — throws inside the
/// handler, and its catch path degrades to *success*. So a malformed reply is
/// not an inert no-op; it silently accepts the plan on the user's behalf.
///
/// `reason` is not cosmetic: it is handed to the agent, which quotes it back and
/// changes course ("The plan was rejected (…), so I did not change notes.txt.
/// What should I do instead?").
pub(crate) fn plan_outcome(decision: ApprovalDecision) -> Value {
    match decision {
        ApprovalDecision::Approve => json!({"outcome": "accepted"}),
        // No `planUri`: the agent writes the plan artifact itself when the
        // client does not supply one.
        ApprovalDecision::Deny => json!({"outcome": "rejected", "reason": "Rejected by the user"}),
        ApprovalDecision::Cancel => json!({"outcome": "cancelled"}),
    }
}

pub(crate) fn reviewer_plan_rejected_outcome() -> Value {
    json!({
        "outcome": "rejected",
        "reason": "Cursor reviewer protocol: do not create or wait on a plan. Continue the review and finish with final agent_text containing `VERDICT: APPROVED` or `VERDICT: NEEDS_CHANGES`; put findings below `VERDICT: NEEDS_CHANGES`."
    })
}

/// The ACP `optionId` to answer a permission request with, chosen from the
/// options the agent actually offered.
///
/// Cursor offers `allow_once` / `allow_always` / `reject_once`. Two asymmetries
/// matter: there is no `reject_always`, so a deny-for-session degrades to a
/// single-shot reject rather than silently doing nothing; and `allow_always` is
/// never selected at all, because it is a persistent global grant rather than a
/// session scope (see the match arm).
pub(crate) fn approval_option_id(
    input: &ApprovalDecisionInput,
    options: &[Value],
) -> Option<String> {
    let wanted: &[&str] = match (input.decision, input.scope) {
        // Session scope deliberately collapses onto `allow_once`. ACP's
        // `allow_always` is not a session scope: measured 2026-08-11, it writes
        // a `Shell(<cmd>)` entry into `~/.cursor/cli-config.json`'s
        // `permissions.allow` — a user-global, on-disk grant that outlives the
        // session, the thread, the relay process and the workspace. Escalating a
        // user's "approve for this session" into that would leak permission into
        // every later, possibly stricter, thread.
        (ApprovalDecision::Approve, _) => &["allow_once"],
        // No `reject_always` exists; fall back to the single-shot reject.
        (ApprovalDecision::Deny, _) => &["reject_always", "reject_once"],
        (ApprovalDecision::Cancel, _) => &["reject_once", "reject_always"],
    };

    for kind in wanted {
        if let Some(id) = options.iter().find_map(|option| {
            let matches_kind = option.get("kind").and_then(Value::as_str) == Some(kind);
            let matches_id =
                option.get("optionId").and_then(Value::as_str) == Some(&kind.replace('_', "-"));
            (matches_kind || matches_id)
                .then(|| option.get("optionId").and_then(Value::as_str))
                .flatten()
        }) {
            return Some(id.to_string());
        }
    }
    None
}

/// The decisions the relay may offer for an ACP permission request: allow and
/// deny, never a session scope.
pub(crate) fn approval_decisions(_options: &[Value]) -> (Vec<String>, bool) {
    // `supports_session_scope` is always false. The only "remember this" option
    // ACP defines is `allow_always`, which is a persistent global allowlist
    // entry rather than a session-scoped one (see `approval_option_id`), so
    // advertising session scope would put an "Approve Session" button in the UI
    // that grants something far broader than it says.
    (vec!["approve".to_string(), "deny".to_string()], false)
}

/// The cursor to fetch the next `session/list` page with, if there is one.
///
/// `session/list` is standard ACP cursor pagination. Reading only the first page
/// hides later threads *and* leaves their cwd uncached, which is what
/// `resolve_cwd` needs to reload them after a restart.
pub(crate) fn next_list_cursor(result: &Value) -> Option<String> {
    result
        .get("nextCursor")
        .and_then(Value::as_str)
        .filter(|cursor| !cursor.is_empty())
        .map(str::to_string)
}

/// Split an ACP model id into its base name and the bracketed attribute list.
///
/// Cursor bakes reasoning effort into the id itself — e.g.
/// `claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]` — so
/// the relay's separate `(model, effort)` pair has no independent effort axis
/// here. The id is opaque and must be echoed back verbatim.
pub(crate) fn split_model_id(model_id: &str) -> (&str, Vec<(&str, &str)>) {
    let Some(open) = model_id.find('[') else {
        return (model_id, Vec::new());
    };
    let base = &model_id[..open];
    let attrs = model_id[open + 1..]
        .strip_suffix(']')
        .unwrap_or(&model_id[open + 1..]);
    let parsed = attrs
        .split(',')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?.trim();
            let value = parts.next()?.trim();
            (!key.is_empty()).then_some((key, value))
        })
        .collect();
    (base, parsed)
}

/// The reasoning effort encoded in an ACP model id, if any. Cursor uses either
/// `effort=` (Anthropic/Grok-shaped) or `reasoning=` (OpenAI-shaped).
pub(crate) fn model_effort(model_id: &str) -> Option<String> {
    let (_, attrs) = split_model_id(model_id);
    attrs
        .iter()
        .find(|(key, _)| *key == "effort" || *key == "reasoning")
        .map(|(_, value)| (*value).to_string())
}

/// Translate `session/new`'s `models.availableModels` into relay model options.
///
/// `provider` is set to the relay provider key (not a vendor namespace) because
/// an ACP agent proxies many vendors — Cursor's catalog spans Anthropic, OpenAI,
/// Google, xAI, Moonshot and its own Composer — and `list_models` filters on
/// this field to keep one bridge's catalog out of another's picker.
/// `current_model_id` should be passed ONLY from `session/new`, whose answer is
/// the model a fresh session starts on — i.e. the provider's default. A
/// `session/load` reports the model *that* conversation happens to use, and
/// marking it default would make opening one old Sonnet thread silently change
/// what every future new session starts on.
pub(crate) fn model_options(
    available: &[Value],
    current_model_id: Option<&str>,
    provider_key: &str,
) -> Vec<ModelOptionView> {
    available
        .iter()
        .filter_map(|entry| {
            let model = entry.get("modelId").and_then(Value::as_str)?;
            let display_name = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_else(|| split_model_id(model).0);
            let effort = model_effort(model);
            Some(ModelOptionView {
                model: model.to_string(),
                display_name: display_name.to_string(),
                provider: provider_key.to_string(),
                supported_reasoning_efforts: effort.clone().into_iter().collect(),
                default_reasoning_effort: effort.unwrap_or_default(),
                hidden: false,
                is_default: Some(model) == current_model_id,
            })
        })
        .collect()
}

/// Whether `model` is one this agent actually offers.
///
/// An empty catalog means "not harvested yet" (ACP reports models only on
/// `session/new`), so it vetoes nothing. A populated catalog that lacks the id
/// means the relay handed us another provider's model — the session defaults
/// carry one until the picker has been populated — and forwarding it would fail
/// the whole session start on `Invalid model value`.
pub(crate) fn model_is_known(catalog: &[ModelOptionView], model: &str) -> bool {
    catalog.is_empty() || catalog.iter().any(|option| option.model == model)
}

/// Parse an RFC3339/ISO-8601 UTC timestamp (`2026-08-11T16:39:48.293Z`) into
/// unix seconds. ACP reports `updatedAt` in this form and the relay sorts
/// threads on a `u64`; the workspace has no date dependency, so this is a
/// deliberate hand-roll rather than a new crate.
pub(crate) fn parse_rfc3339_secs(value: &str) -> Option<u64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num =
        |range: std::ops::Range<usize>| -> Option<i64> { value.get(range)?.parse::<i64>().ok() };
    let year = num(0..4)?;
    let month = num(5..7)?;
    let day = num(8..10)?;
    let hour = num(11..13)?;
    let minute = num(14..16)?;
    let second = num(17..19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    // Days from civil (Howard Hinnant's algorithm), epoch 1970-01-01.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_adjusted = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_adjusted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;

    let total = days * 86_400 + hour * 3_600 + minute * 60 + second;
    u64::try_from(total).ok()
}

/// Translate one `session/list` entry into a thread row.
///
/// `source`, `provider` and `model_provider` are all set to the provider key:
/// the relay's thread-routing guard accepts a match on any of the three, and an
/// ACP agent has no separate vendor identity to report.
pub(crate) fn thread_summary(
    session: &Value,
    provider_key: &str,
    fallback_updated_at: u64,
) -> Option<ThreadSummaryView> {
    let id = session.get("sessionId").and_then(Value::as_str)?;
    let title = session.get("title").and_then(Value::as_str).unwrap_or("");
    let updated_at = session
        .get("updatedAt")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_secs)
        .unwrap_or(fallback_updated_at);

    Some(ThreadSummaryView {
        workspace_trusted: false,
        id: id.to_string(),
        name: (!title.is_empty()).then(|| title.to_string()),
        preview: title.to_string(),
        cwd: session
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        updated_at,
        source: provider_key.to_string(),
        status: "idle".to_string(),
        model_provider: provider_key.to_string(),
        provider: provider_key.to_string(),
        forked_from: None,
        renamed: false,
        flagged: false,
    })
}

/// Concatenate the text out of an ACP content block (`{type:"text",text}`) or a
/// `content` array of them. Non-text blocks (image, resource) are skipped.
pub(crate) fn content_text(content: &Value) -> String {
    match content {
        Value::Array(blocks) => blocks.iter().map(content_text).collect::<Vec<_>>().join(""),
        Value::Object(_) => {
            if let Some(nested) = content.get("content") {
                // `{type:"content", content:{type:"text", ...}}` wrapper.
                if content.get("text").is_none() {
                    return content_text(nested);
                }
            }
            content
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        }
        Value::String(text) => text.clone(),
        _ => String::new(),
    }
}

/// A stable, relay-owned transcript item id.
///
/// ACP item ids cannot be used directly for two measured reasons: a live
/// `toolCallId` embeds a raw newline (`call-…-0\nfc_…_0`), and `session/load`
/// reassigns ids entirely (the same call replays as `replay-0-1`). Minting our
/// own per-kind ordinals keeps ids stable across live-vs-reload, because the
/// replay order matches the live order within each kind.
pub(crate) fn item_id(kind: &str, ordinal: u64) -> String {
    format!("acp-{kind}-{ordinal}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_only_maps_to_plan_mode_not_ask() {
        // `ask` forbids command execution, which would stop a reviewer from
        // reading files at all. `plan` is the read-only mode that still reads.
        assert_eq!(acp_mode_for_policy("on-request", "read-only"), MODE_PLAN);
        assert_eq!(
            acp_mode_for_policy("review_read_only", "workspace-write"),
            MODE_PLAN
        );
        assert_eq!(
            acp_mode_for_policy("on-request", "workspace-write"),
            MODE_AGENT
        );
    }

    #[test]
    fn only_never_and_bypass_auto_approve() {
        assert!(auto_approves("never"));
        assert!(auto_approves("bypass"));
        assert!(!auto_approves("on-request"));
        assert!(!auto_approves("untrusted"));
    }

    fn cursor_options() -> Vec<Value> {
        // Verbatim from the 2026-08-11 spike.
        vec![
            json!({"optionId":"allow-once","name":"Allow once","kind":"allow_once"}),
            json!({"optionId":"allow-always","name":"Allow always","kind":"allow_always"}),
            json!({"optionId":"reject-once","name":"Reject","kind":"reject_once"}),
        ]
    }

    #[test]
    fn every_approve_maps_to_allow_once_regardless_of_scope() {
        // Supersedes the round-1 mapping (session scope -> `allow_always`),
        // which was written from reasoning; `review2_tests` records what
        // measuring the grant's real lifetime showed.
        let options = cursor_options();
        for scope in [
            None,
            Some(ApprovalScope::Once),
            Some(ApprovalScope::Session),
        ] {
            let input = ApprovalDecisionInput {
                decision: ApprovalDecision::Approve,
                scope,
                device_id: None,
            };
            assert_eq!(
                approval_option_id(&input, &options).as_deref(),
                Some("allow-once"),
                "scope {scope:?} must not reach the persistent allowlist"
            );
        }
    }

    #[test]
    fn deny_for_session_degrades_to_reject_once_because_acp_has_no_reject_always() {
        let options = cursor_options();
        let deny_session = ApprovalDecisionInput {
            decision: ApprovalDecision::Deny,
            scope: Some(ApprovalScope::Session),
            device_id: None,
        };
        // The important part is that it resolves to SOMETHING — silently
        // returning None would leave the agent parked forever.
        assert_eq!(
            approval_option_id(&deny_session, &options).as_deref(),
            Some("reject-once")
        );
    }

    #[test]
    fn approve_and_deny_are_the_only_decisions_offered() {
        let (decisions, session) = approval_decisions(&cursor_options());
        assert_eq!(decisions, vec!["approve".to_string(), "deny".to_string()]);
        // Never, whatever the agent offers — see `review2_tests` for why.
        assert!(!session);
    }

    #[test]
    fn model_ids_are_opaque_and_effort_is_read_out_of_the_brackets() {
        assert_eq!(
            split_model_id("claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]").0,
            "claude-opus-4-7"
        );
        assert_eq!(
            model_effort("claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]")
                .as_deref(),
            Some("xhigh")
        );
        // OpenAI-shaped ids spell it `reasoning`.
        assert_eq!(
            model_effort("gpt-5.5[context=272k,reasoning=medium,fast=false]").as_deref(),
            Some("medium")
        );
        // Empty and absent bracket lists must not panic.
        assert_eq!(split_model_id("gemini-3.1-pro[]").0, "gemini-3.1-pro");
        assert_eq!(model_effort("gemini-3.1-pro[]"), None);
        assert_eq!(split_model_id("default[]").0, "default");
        assert_eq!(model_effort("bare-model"), None);
    }

    #[test]
    fn model_options_keep_the_full_id_and_tag_the_relay_provider_key() {
        let available = vec![
            json!({"modelId":"default[]","name":"Auto"}),
            json!({"modelId":"gpt-5.5[context=272k,reasoning=medium,fast=false]","name":"gpt-5.5"}),
        ];
        let options = model_options(&available, Some("default[]"), "cursor");
        assert_eq!(options.len(), 2);
        // The bracketed id is what ACP expects back — it must survive verbatim.
        assert_eq!(
            options[1].model,
            "gpt-5.5[context=272k,reasoning=medium,fast=false]"
        );
        assert_eq!(options[1].display_name, "gpt-5.5");
        // Not "openai": an ACP agent proxies many vendors, and `list_models`
        // filters on this field.
        assert_eq!(options[1].provider, "cursor");
        assert_eq!(
            options[1].supported_reasoning_efforts,
            vec!["medium".to_string()]
        );
        assert!(options[0].is_default);
        assert!(!options[1].is_default);
    }

    #[test]
    fn rfc3339_parses_to_unix_seconds() {
        // 2026-08-11T16:39:48.293Z — the timestamp the spike actually returned.
        assert_eq!(
            parse_rfc3339_secs("2026-08-11T16:39:48.293Z"),
            Some(1786466388)
        );
        assert_eq!(parse_rfc3339_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_secs("2000-02-29T12:00:00Z"), Some(951825600));
        assert_eq!(parse_rfc3339_secs("not-a-date"), None);
        assert_eq!(parse_rfc3339_secs(""), None);
        assert_eq!(parse_rfc3339_secs("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn thread_summary_tags_all_three_provider_fields() {
        let session = json!({
            "sessionId":"69341411-d238-427e-9141-e74e04c6e1e1",
            "cwd":"/tmp/acp-spike-ws",
            "title":"Cat File Content",
            "updatedAt":"2026-08-11T16:39:48.293Z"
        });
        let thread = thread_summary(&session, "cursor", 0).expect("thread");
        assert_eq!(thread.id, "69341411-d238-427e-9141-e74e04c6e1e1");
        assert_eq!(thread.name.as_deref(), Some("Cat File Content"));
        assert_eq!(thread.cwd, "/tmp/acp-spike-ws");
        assert_eq!(thread.updated_at, 1786466388);
        // `thread_belongs_to_provider` accepts a match on any of the three.
        assert_eq!(thread.provider, "cursor");
        assert_eq!(thread.source, "cursor");
        assert_eq!(thread.model_provider, "cursor");
    }

    #[test]
    fn thread_summary_falls_back_when_updated_at_is_missing_or_bad() {
        let session = json!({"sessionId":"s1","cwd":"/tmp","title":"t"});
        assert_eq!(
            thread_summary(&session, "cursor", 42).unwrap().updated_at,
            42
        );
        let bad = json!({"sessionId":"s1","updatedAt":"garbage"});
        assert_eq!(thread_summary(&bad, "cursor", 7).unwrap().updated_at, 7);
        // No session id at all is not a thread.
        assert!(thread_summary(&json!({"cwd":"/tmp"}), "cursor", 0).is_none());
    }

    #[test]
    fn content_text_handles_blocks_arrays_and_the_permission_wrapper() {
        assert_eq!(content_text(&json!({"type":"text","text":"hi"})), "hi");
        assert_eq!(
            content_text(&json!([{"type":"text","text":"a"},{"type":"text","text":"b"}])),
            "ab"
        );
        // The shape `session/request_permission` uses for its explanation.
        assert_eq!(
            content_text(
                &json!({"type":"content","content":{"type":"text","text":"Not in allowlist: cat"}})
            ),
            "Not in allowlist: cat"
        );
        // Image blocks contribute nothing rather than panicking.
        assert_eq!(content_text(&json!({"type":"image","data":"…"})), "");
        assert_eq!(content_text(&Value::Null), "");
    }

    #[test]
    fn item_ids_are_per_kind_ordinals_so_replay_matches_live() {
        // Live and replay disagree on ACP's own ids, but agree on per-kind
        // ordering — so ordinals are stable across a reload.
        assert_eq!(item_id("tool", 3), "acp-tool-3");
        assert_ne!(item_id("tool", 3), item_id("msg", 3));
    }
}

/// What the agent said it can do, read from the `initialize` response.
///
/// ACP makes `loadSession`, session listing and image prompts all optional, and
/// the spec requires a client to check before calling them. Assuming Cursor's
/// answers would make this bridge Cursor-specific in exactly the way the
/// module doc says it is not.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AgentCapabilities {
    pub(crate) load_session: bool,
    pub(crate) list_sessions: bool,
    pub(crate) prompt_images: bool,
}

impl AgentCapabilities {
    pub(crate) fn from_initialize(result: &Value) -> Self {
        let caps = result.get("agentCapabilities");
        let flag = |key: &str| {
            caps.and_then(|caps| caps.get(key))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };
        Self {
            load_session: flag("loadSession"),
            // Presence, not truth: measured as `"sessionCapabilities":{"list":{}}`
            // — an empty object marking the capability as supported.
            list_sessions: caps
                .and_then(|caps| caps.get("sessionCapabilities"))
                .and_then(|session| session.get("list"))
                .is_some_and(|list| list.as_bool() != Some(false)),
            prompt_images: caps
                .and_then(|caps| caps.get("promptCapabilities"))
                .and_then(|prompt| prompt.get("image"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }
}

#[cfg(test)]
mod review2_tests {
    use super::*;
    use serde_json::json;

    fn cursor_options() -> Vec<Value> {
        vec![
            json!({"optionId":"allow-once","name":"Allow once","kind":"allow_once"}),
            json!({"optionId":"allow-always","name":"Allow always","kind":"allow_always"}),
            json!({"optionId":"reject-once","name":"Reject","kind":"reject_once"}),
        ]
    }

    #[test]
    fn session_scope_is_never_offered_because_allow_always_is_a_global_grant() {
        // MEASURED 2026-08-11: after an `allow_always`, the grant lands in
        // `~/.cursor/cli-config.json` as `permissions.allow: ["Shell(ls)"]`
        // under `approvalMode: "allowlist"` — a user-global, on-disk allowlist
        // that outlives the session, the thread, the relay process AND the
        // workspace. Offering it as "Approve Session" would let a decision made
        // on a throwaway thread silently widen permissions on every later one.
        let (decisions, supports_session) = approval_decisions(&cursor_options());
        assert_eq!(decisions, vec!["approve".to_string(), "deny".to_string()]);
        assert!(
            !supports_session,
            "ACP `allow_always` is a persistent global grant, not a session scope"
        );
    }

    #[test]
    fn an_approve_for_session_still_only_grants_once() {
        // Even if a caller asks for session scope (an older client, a scripted
        // action), the bridge must not escalate it into a permanent grant.
        let approve_session = ApprovalDecisionInput {
            decision: ApprovalDecision::Approve,
            scope: Some(ApprovalScope::Session),
            device_id: None,
        };
        assert_eq!(
            approval_option_id(&approve_session, &cursor_options()).as_deref(),
            Some("allow-once"),
            "session scope must never map onto the persistent allowlist entry"
        );
    }

    #[test]
    fn list_pagination_threads_the_cursor_through() {
        // ACP `session/list` is standard cursor pagination: while the response
        // carries `nextCursor`, the client must ask again with it. Reading only
        // the first page leaves later threads unlistable and, worse, uncached —
        // so their cwd is unknown and they cannot be reloaded after a restart.
        assert_eq!(
            next_list_cursor(&json!({"sessions": [], "nextCursor": "page-2"})).as_deref(),
            Some("page-2")
        );
        assert_eq!(next_list_cursor(&json!({"sessions": []})), None);
        // An empty cursor is absence, not a page to fetch — treating it as one
        // would loop forever.
        assert_eq!(next_list_cursor(&json!({"nextCursor": ""})), None);
        assert_eq!(next_list_cursor(&json!({"nextCursor": null})), None);
    }
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    use serde_json::json;

    fn catalog() -> Vec<ModelOptionView> {
        model_options(
            &[
                json!({"modelId":"default[]","name":"Auto"}),
                json!({"modelId":"claude-sonnet-4-6[thinking=true]","name":"claude-sonnet-4-6"}),
            ],
            Some("default[]"),
            "cursor",
        )
    }

    #[test]
    fn a_model_from_another_provider_is_not_a_selection_for_this_one() {
        // Found by the first live run: the relay's session defaults carry
        // `gpt-5.5` (Codex's), and ACP has no standalone catalog method — so
        // before any session exists there is nothing to heal it against and the
        // foreign id reaches `session/set_model`, which rejects it and fails the
        // whole session start.
        assert!(!model_is_known(&catalog(), "gpt-5.5"));
        assert!(model_is_known(
            &catalog(),
            "claude-sonnet-4-6[thinking=true]"
        ));
        assert!(model_is_known(&catalog(), "default[]"));
    }

    #[test]
    fn an_unharvested_catalog_cannot_veto_anything() {
        // ACP only reports models on `session/new`, so an empty catalog means
        // "not known yet", not "no such model". Vetoing there would make the
        // first session of every process ignore the user's model choice.
        assert!(model_is_known(&[], "anything-at-all"));
    }
}
