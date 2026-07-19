use super::*;

use crate::protocol::{TranscriptEntryKind, TranscriptEntryView};
use crate::state::relay::relay_thread_is_busy;

const FORK_BUSY_SOURCE_MSG: &str = "cannot fork a thread while a turn is in progress";
// Only the replay path needs a first message (the transcript IS the prompt).
// A native fork already carries the real context, so an empty fork prompt
// leaves the branch idle instead of burning a turn nobody asked for.
const REPLAY_FORK_FALLBACK_PROMPT: &str =
    "Review the inherited context above. Do not take any action yet — summarize where the session left off and wait for instructions.";
const MAX_FORK_REPLAY_PROMPT_CHARS: usize = 45_000;
const RECENT_RAW_ENTRY_COUNT: usize = 16;
const MAX_SUMMARY_ENTRY_CHARS: usize = 360;
const MAX_RAW_ENTRY_CHARS: usize = 2_000;
const MAX_TOOL_FIELD_CHARS: usize = 700;

impl AppState {
    pub async fn fork_session(&self, input: ForkSessionInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let source_thread_id = non_empty(Some(input.source_thread_id))
            .ok_or_else(|| "source_thread_id is required".to_string())?;
        let _slot = self.acquire_session_slot()?;
        self.expire_stale_controller_if_needed().await;

        let (source_provider_name, source_bridge) = {
            let (name, bridge) = self.find_thread_provider(&source_thread_id).await?;
            (name.to_string(), bridge.clone())
        };
        // Reject from relay-local state BEFORE the expensive provider read: a
        // locked or busy source thread should not cost a full transcript
        // round-trip, and reading first left the busy check evaluating a
        // pre-lock snapshot.
        {
            let relay = self.relay.read().await;
            if relay.is_thread_review_locked(&source_thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay_thread_is_busy(&relay, &source_thread_id) {
                return Err(FORK_BUSY_SOURCE_MSG.to_string());
            }
        }

        let source_data = source_bridge.read_thread(&source_thread_id).await?;
        let defaults = self.defaults().await;
        let source_cwd = non_empty(Some(source_data.thread.cwd.clone()))
            .unwrap_or_else(|| defaults.current_cwd.clone());
        let cwd = normalize_cwd(&non_empty(input.cwd).unwrap_or(source_cwd.clone()));
        let requested_fork_point = non_empty(input.up_to_item_id);
        // Validate against the real transcript BEFORE normalizing, so a bogus
        // id is still an error rather than being silently collapsed away.
        let forked_transcript =
            truncate_transcript_at(&source_data.transcript, requested_fork_point.as_deref())?;
        let up_to_item_id =
            normalize_fork_point(&source_data.transcript, requested_fork_point.as_deref());

        let source_settings = {
            let relay = self.relay.read().await;
            // Re-check under the lock we will act on: the provider read above
            // is a multi-second await during which another paired device can
            // start a turn on the source thread.
            if relay_thread_is_busy(&relay, &source_thread_id)
                || thread_status_is_working(&source_data.status)
            {
                return Err(FORK_BUSY_SOURCE_MSG.to_string());
            }

            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(&source_cwd, &device_scope, &relay.allowed_roots)?;
            ensure_path_within_device_scope(&cwd, &device_scope, &relay.allowed_roots)?;
            relay.remembered_thread_settings(&source_thread_id)
        };

        let target_provider_requested = non_empty(input.provider);
        let target_provider_lookup = target_provider_requested
            .as_deref()
            .unwrap_or(source_provider_name.as_str());
        let (target_provider_name, target_bridge) = {
            let (name, bridge) = self.resolve_provider(Some(target_provider_lookup))?;
            (name.to_string(), bridge.clone())
        };
        let provider_models = self
            .load_provider_model_catalog(&target_provider_name, &target_bridge)
            .await;

        let same_provider = target_provider_name == source_provider_name;
        let source_model = source_settings
            .as_ref()
            .map(|settings| settings.model.clone())
            .filter(|model| !model.is_empty());
        let source_effort = source_settings
            .as_ref()
            .map(|settings| settings.reasoning_effort.clone())
            .filter(|effort| !effort.is_empty());

        // Resolve inheritance HERE rather than leaning on
        // `resolve_provider_model`'s fallback: that helper prefers the catalog
        // default whenever the request omits a model, so the source model it is
        // handed is only reached with an empty catalog. A thread on a
        // non-default model therefore forked onto the provider default — the
        // dialog's "Inherit from source session" promising the opposite.
        //
        // Only within the same provider: a codex model id means nothing to
        // Claude, and effort options are model-specific. The helper is shared
        // by seven call sites, so its ordering is left alone.
        let requested_model = non_empty(input.model)
            .or_else(|| same_provider.then(|| source_model.clone()).flatten());
        let model = resolve_provider_model(
            &target_provider_name,
            &provider_models,
            requested_model.clone(),
            defaults.model.clone(),
        );

        // Inherited effort applies only while the model is also the inherited
        // one — carrying an effort across a model switch can name a level the
        // new model does not support.
        let inherited_model_kept = same_provider && Some(&model) == source_model.as_ref();
        let effort = non_empty(input.effort)
            .or_else(|| {
                inherited_model_kept
                    .then(|| source_effort.clone())
                    .flatten()
            })
            .or_else(|| default_effort_for_model(&provider_models, &model))
            .unwrap_or_else(|| defaults.reasoning_effort.clone());
        let effort = clamp_effort_to_model(effort, &model, &provider_models);
        let approval_policy = non_empty(input.approval_policy)
            .or_else(|| {
                source_settings
                    .as_ref()
                    .map(|settings| settings.approval_policy.clone())
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or_else(|| defaults.approval_policy.clone());
        let sandbox = non_empty(input.sandbox)
            .or_else(|| {
                source_settings
                    .as_ref()
                    .map(|settings| settings.sandbox.clone())
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or_else(|| defaults.sandbox.clone());
        let user_prompt = non_empty(input.initial_prompt);

        if source_provider_name == target_provider_name {
            let request = ProviderForkRequest {
                source_thread_id: source_thread_id.clone(),
                up_to_item_id: up_to_item_id.clone(),
                cwd: cwd.clone(),
                model: model.clone(),
                approval_policy: approval_policy.clone(),
                sandbox: sandbox.clone(),
            };
            if let Some(start_result) = target_bridge.fork_thread(request).await? {
                return self
                    .activate_native_fork_and_start(
                        &target_provider_name,
                        target_bridge,
                        provider_models,
                        start_result,
                        &model,
                        &approval_policy,
                        &sandbox,
                        &effort,
                        &device_id,
                        &source_thread_id,
                        user_prompt,
                    )
                    .await;
            }
        }

        // The replay path always needs a first turn: the transcript only
        // reaches the target provider as the body of a message.
        let replay_task = user_prompt.unwrap_or_else(|| REPLAY_FORK_FALLBACK_PROMPT.to_string());
        let replay_source = ThreadSyncData {
            transcript: forked_transcript,
            ..source_data
        };
        let replay_prompt = build_fork_replay_prompt(
            &source_provider_name,
            &target_provider_name,
            &replay_source,
            &replay_task,
        );
        self.start_replay_fork(
            &target_provider_name,
            target_bridge,
            provider_models,
            &cwd,
            &source_thread_id,
            &model,
            &approval_policy,
            &sandbox,
            &effort,
            &device_id,
            replay_prompt,
        )
        .await
    }

    async fn activate_native_fork_and_start(
        &self,
        target_provider_name: &str,
        target_bridge: Arc<dyn ProviderBridge>,
        provider_models: Option<Vec<ModelOptionView>>,
        start_result: StartThreadResult,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        device_id: &str,
        source_thread_id: &str,
        user_prompt: Option<String>,
    ) -> Result<SessionSnapshot, String> {
        let forked_thread_id = start_result.thread.id.clone();
        let thread_data = target_bridge.read_thread(&forked_thread_id).await?;
        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(target_provider_name.to_string());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
            }
            relay.load_thread_data(
                thread_data,
                approval_policy,
                sandbox,
                effort,
                model,
                device_id,
            );
            relay.set_thread_forked_from(&forked_thread_id, source_thread_id);
            relay.push_log(
                "info",
                format!(
                    "Forked thread {forked_thread_id} natively from {source_thread_id} with {target_provider_name}. Control is now on {}.",
                    short_device_id(device_id)
                ),
            );
            relay.notify();
        }

        // A native fork already carries the source context, so with no fork
        // prompt the branch stays idle and waits for the user rather than
        // auto-running a canned instruction under the inherited approval policy.
        let Some(text) = user_prompt else {
            let _ = self.list_threads(20, Some(device_id.to_string())).await;
            return Ok(self.snapshot().await);
        };

        self.send_message_inner(SendMessageInput {
            text,
            model: Some(model.to_string()),
            effort: Some(effort.to_string()),
            device_id: Some(device_id.to_string()),
            thread_id: forked_thread_id,
        })
        .await
    }

    async fn start_replay_fork(
        &self,
        target_provider_name: &str,
        target_bridge: Arc<dyn ProviderBridge>,
        provider_models: Option<Vec<ModelOptionView>>,
        cwd: &str,
        source_thread_id: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        device_id: &str,
        replay_prompt: String,
    ) -> Result<SessionSnapshot, String> {
        let start_result = target_bridge
            .start_thread(
                cwd,
                model,
                approval_policy,
                sandbox,
                Some(replay_prompt.as_str()),
            )
            .await?;
        let consumed_initial_prompt = start_result.consumed_initial_prompt;
        let started_thread_id = start_result.thread.id.clone();
        let initial_user_message = start_result.initial_user_message.clone();
        let started_turn_id = start_result.started_turn_id.clone();

        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(target_provider_name.to_string());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
            }
            let turn_revision = relay.thread_turn_revision(&started_thread_id);
            relay.activate_started_thread(
                start_result.thread,
                cwd,
                model,
                approval_policy,
                sandbox,
                effort,
                device_id,
            );
            if consumed_initial_prompt {
                if let Some(entry) = initial_user_message {
                    if let (Some(item_id), Some(text)) = (entry.item_id, entry.text) {
                        relay.upsert_user_message(
                            item_id,
                            text,
                            entry.turn_id.unwrap_or_else(|| "initial".to_string()),
                        );
                    }
                }
            }
            if turn_revision == 0 {
                if let Some(turn_id) = started_turn_id {
                    relay.set_active_turn(Some(turn_id));
                    if let Some(active_thread_id) = relay.active_thread_id.clone() {
                        relay.set_thread_status(
                            &active_thread_id,
                            "active".to_string(),
                            Vec::new(),
                        );
                    }
                    relay.touch_progress(Some("thinking"), None);
                }
            }
            relay.set_thread_forked_from(&started_thread_id, source_thread_id);
            relay.push_log(
                "info",
                format!(
                    "Forked thread {source_thread_id} via replay into {target_provider_name}. Control is now on {}.",
                    short_device_id(device_id)
                ),
            );
            relay.notify();
        }

        if !consumed_initial_prompt {
            return self
                .send_message_inner(SendMessageInput {
                    text: replay_prompt,
                    model: Some(model.to_string()),
                    effort: Some(effort.to_string()),
                    device_id: Some(device_id.to_string()),
                    thread_id: started_thread_id,
                })
                .await;
        }

        let _ = self.list_threads(20, Some(device_id.to_string())).await;
        Ok(self.snapshot().await)
    }
}

fn build_fork_replay_prompt(
    source_provider: &str,
    target_provider: &str,
    source: &ThreadSyncData,
    user_prompt: &str,
) -> String {
    let transcript = &source.transcript;
    let tail_start = transcript.len().saturating_sub(RECENT_RAW_ENTRY_COUNT);
    let summary_lines = transcript[..tail_start]
        .iter()
        .map(|entry| compact_entry_line(entry))
        .collect::<Vec<_>>();
    let tail_blocks = transcript[tail_start..]
        .iter()
        .map(|entry| raw_entry_block(entry))
        .collect::<Vec<_>>();

    let task_section = render_task_section(user_prompt);

    // Shrink oldest-first: the compacted head goes before any raw tail entry,
    // and within the tail the oldest block goes first. A fork continues from
    // the newest exchanges, so those must be the last thing dropped — trimming
    // the rendered string from the end (the previous behavior) silently cut
    // exactly the context the fork needed most.
    let mut summary_start = 0usize;
    let mut tail_drop = 0usize;
    loop {
        let context = render_fork_replay_context(
            source_provider,
            target_provider,
            source,
            summary_start,
            &summary_lines[summary_start..],
            tail_drop,
            &tail_blocks[tail_drop..],
        );
        if context.len() + task_section.len() <= MAX_FORK_REPLAY_PROMPT_CHARS {
            return format!("{context}{task_section}");
        }
        if summary_start < summary_lines.len() {
            let remaining = summary_lines.len() - summary_start;
            summary_start += (remaining / 4).max(1);
            continue;
        }
        if tail_drop + 1 < tail_blocks.len() {
            tail_drop += 1;
            continue;
        }
        // Only the newest block is left and it still overflows: trim inside it
        // rather than dropping the one entry the fork branches from.
        return fit_context_with_task(context, task_section);
    }
}

// A fork point that is the transcript's FINAL entry drops nothing, so it names
// the same branch as forking the whole thread. Collapsing it to `None` lets a
// tip-only native fork (Codex `thread/fork`) stay native instead of degrading
// to a lossy replay just because the client named the message it clicked.
//
// Deliberately exact: if ANY entry follows the fork point — including tool
// calls, whose results are real context — the point stays explicit. Treating
// "last agent message with trailing tool calls" as a whole-thread fork would
// hand the branch results the user branched before.
fn normalize_fork_point(
    transcript: &[TranscriptEntryView],
    up_to_item_id: Option<&str>,
) -> Option<String> {
    let item_id = up_to_item_id?;
    let is_final_entry = transcript
        .last()
        .and_then(|entry| entry.item_id.as_deref())
        .is_some_and(|last| last == item_id);
    if is_final_entry {
        return None;
    }
    Some(item_id.to_string())
}

// A fork branches at a specific message, so the replayed context must stop
// there. Without this the branch silently inherits everything that happened
// after the point the user picked.
fn truncate_transcript_at(
    transcript: &[TranscriptEntryView],
    up_to_item_id: Option<&str>,
) -> Result<Vec<TranscriptEntryView>, String> {
    let Some(item_id) = up_to_item_id else {
        return Ok(transcript.to_vec());
    };
    let position = transcript
        .iter()
        .position(|entry| entry.item_id.as_deref() == Some(item_id))
        .ok_or_else(|| {
            format!("fork point {item_id} is not part of the source thread transcript")
        })?;
    Ok(transcript[..=position].to_vec())
}

fn render_fork_replay_context(
    source_provider: &str,
    target_provider: &str,
    source: &ThreadSyncData,
    omitted_summary_entries: usize,
    summary_lines: &[String],
    omitted_tail_entries: usize,
    tail_blocks: &[String],
) -> String {
    let mut prompt = String::new();
    prompt.push_str("You are starting from a forked agent session.\n");
    prompt.push_str("Use the preserved context below as authoritative handoff context, then execute the task for this fork.\n\n");
    prompt.push_str("Fork metadata:\n");
    prompt.push_str(&format!("- Source provider: {source_provider}\n"));
    prompt.push_str(&format!("- Target provider: {target_provider}\n"));
    prompt.push_str(&format!("- Source thread id: {}\n", source.thread.id));
    prompt.push_str(&format!("- Workspace: {}\n", source.thread.cwd));
    prompt.push_str("\nStructured summary of earlier transcript:\n");
    if omitted_summary_entries > 0 {
        prompt.push_str(&format!(
            "- {omitted_summary_entries} earlier entries are compacted or omitted to fit the target context.\n"
        ));
    }
    if summary_lines.is_empty() {
        prompt.push_str("- No earlier entries before the recent tail.\n");
    } else {
        for line in summary_lines {
            prompt.push_str("- ");
            prompt.push_str(line);
            prompt.push('\n');
        }
    }
    prompt.push_str("\nRecent raw transcript tail:\n");
    if omitted_tail_entries > 0 {
        prompt.push_str(&format!(
            "({omitted_tail_entries} older tail entries dropped to fit the target context.)\n"
        ));
    }
    if tail_blocks.is_empty() {
        prompt.push_str("(No prior transcript entries.)\n");
    } else {
        for block in tail_blocks {
            prompt.push_str(block);
            prompt.push('\n');
        }
    }
    prompt
}

fn render_task_section(user_prompt: &str) -> String {
    let header = "\nTask for this fork:\n";
    let footer = "\n";
    let max_prompt_bytes = MAX_FORK_REPLAY_PROMPT_CHARS.saturating_sub(header.len() + footer.len());
    let task = trim_to_char_boundary(user_prompt.to_string(), max_prompt_bytes);
    format!("{header}{task}{footer}")
}

fn fit_context_with_task(context: String, task_section: String) -> String {
    let context_budget = MAX_FORK_REPLAY_PROMPT_CHARS.saturating_sub(task_section.len());
    format!(
        "{}{}",
        trim_to_char_boundary(context, context_budget),
        task_section
    )
}

fn compact_entry_line(entry: &TranscriptEntryView) -> String {
    let label = entry_label(entry);
    let body = entry_summary_text(entry);
    format!(
        "{label}: {}",
        truncate_chars(&body, MAX_SUMMARY_ENTRY_CHARS)
    )
}

fn raw_entry_block(entry: &TranscriptEntryView) -> String {
    let label = entry_label(entry);
    let mut block = format!("[{label}]");
    if let Some(turn_id) = entry.turn_id.as_deref() {
        block.push_str(&format!(" turn={turn_id}"));
    }
    if !entry.status.is_empty() {
        block.push_str(&format!(" status={}", entry.status));
    }
    block.push('\n');
    block.push_str(&truncate_chars(
        &entry_summary_text(entry),
        MAX_RAW_ENTRY_CHARS,
    ));
    block.push('\n');
    block
}

fn entry_label(entry: &TranscriptEntryView) -> &'static str {
    match entry.kind {
        TranscriptEntryKind::UserText => "user",
        TranscriptEntryKind::AgentText => "assistant",
        TranscriptEntryKind::ToolCall => "tool",
        TranscriptEntryKind::Command => "command",
        TranscriptEntryKind::Reasoning => "reasoning",
        TranscriptEntryKind::Error => "error",
    }
}

fn entry_summary_text(entry: &TranscriptEntryView) -> String {
    if let Some(tool) = entry.tool.as_ref() {
        let mut parts = Vec::new();
        if !tool.title.is_empty() {
            parts.push(format!(
                "title={}",
                truncate_chars(&tool.title, MAX_TOOL_FIELD_CHARS)
            ));
        }
        if !tool.name.is_empty() {
            parts.push(format!("name={}", tool.name));
        }
        if let Some(command) = tool.command.as_ref().filter(|value| !value.is_empty()) {
            parts.push(format!(
                "command={}",
                truncate_chars(command, MAX_TOOL_FIELD_CHARS)
            ));
        }
        if let Some(path) = tool.path.as_ref().filter(|value| !value.is_empty()) {
            parts.push(format!("path={path}"));
        }
        if let Some(result) = tool
            .result_preview
            .as_ref()
            .filter(|value| !value.is_empty())
        {
            parts.push(format!(
                "result={}",
                truncate_chars(result, MAX_TOOL_FIELD_CHARS)
            ));
        }
        if !tool.file_changes.is_empty() {
            let paths = tool
                .file_changes
                .iter()
                .take(8)
                .map(|change| format!("{} {}", change.change_type, change.path))
                .collect::<Vec<_>>()
                .join(", ");
            parts.push(format!("file_changes={paths}"));
        }
        if !parts.is_empty() {
            return parts.join("; ");
        }
    }

    entry
        .text
        .as_ref()
        .filter(|text| !text.is_empty())
        .cloned()
        .unwrap_or_else(|| "(no text)".to_string())
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    out.push_str("...");
    out
}

fn trim_to_char_boundary(value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    if max_bytes == 0 {
        return String::new();
    }
    if max_bytes <= "...".len() {
        return ".".repeat(max_bytes);
    }
    let mut end = max_bytes.saturating_sub("...".len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &value[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_with_transcript(transcript: Vec<TranscriptEntryView>) -> ThreadSyncData {
        ThreadSyncData {
            thread: crate::protocol::ThreadSummaryView {
                id: "source-thread".to_string(),
                name: Some("Source".to_string()),
                preview: String::new(),
                cwd: "/tmp/project".to_string(),
                updated_at: 1,
                source: "local".to_string(),
                status: "idle".to_string(),
                model_provider: "openai".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
            },
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript,
        }
    }

    #[test]
    fn replay_prompt_trims_context_before_the_fork_task() {
        let transcript = (0..80)
            .map(|index| TranscriptEntryView {
                item_id: Some(format!("item-{index}")),
                kind: TranscriptEntryKind::AgentText,
                text: Some("context ".repeat(800)),
                status: "completed".to_string(),
                turn_id: Some(format!("turn-{index}")),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            })
            .collect();
        let source = source_with_transcript(transcript);
        let prompt = build_fork_replay_prompt(
            "codex",
            "claude_code",
            &source,
            "preserve this exact fork task",
        );

        assert!(prompt.len() <= MAX_FORK_REPLAY_PROMPT_CHARS);
        assert!(prompt.contains("Task for this fork:\npreserve this exact fork task"));
    }

    fn agent_entry(item_id: &str, text: &str) -> TranscriptEntryView {
        TranscriptEntryView {
            item_id: Some(item_id.to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some(text.to_string()),
            status: "completed".to_string(),
            turn_id: Some(format!("turn-{item_id}")),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        }
    }

    // Forking from a message means the fork must not see anything the user had
    // not yet read at that point — otherwise "branch from here" silently
    // carries the future of the original thread into the branch.
    #[test]
    fn transcript_is_truncated_at_the_requested_fork_point() {
        let transcript = vec![
            agent_entry("a1", "EARLY-MARKER decided on approach A"),
            agent_entry("a2", "MIDDLE-MARKER implemented approach A"),
            agent_entry("a3", "LATE-MARKER reverted everything"),
        ];

        let truncated = truncate_transcript_at(&transcript, Some("a2")).expect("fork point exists");

        assert_eq!(truncated.len(), 2);
        assert_eq!(truncated[1].item_id.as_deref(), Some("a2"));
    }

    // A fork point that IS the last entry drops nothing, so it is the same
    // branch as forking the whole thread. Normalizing it lets a tip-only native
    // fork (Codex `thread/fork`) stay native instead of falling back to a lossy
    // replay just because the client named the message it clicked.
    #[test]
    fn a_fork_point_at_the_final_entry_normalizes_to_a_whole_thread_fork() {
        let transcript = vec![agent_entry("a1", "one"), agent_entry("a2", "two")];
        assert_eq!(normalize_fork_point(&transcript, Some("a2")), None);
    }

    #[test]
    fn a_fork_point_with_entries_after_it_is_preserved() {
        let transcript = vec![agent_entry("a1", "one"), agent_entry("a2", "two")];
        assert_eq!(
            normalize_fork_point(&transcript, Some("a1")),
            Some("a1".to_string())
        );
    }

    // Trailing tool calls are real context. Forking at the last AGENT message
    // when tool entries follow it must NOT be treated as a whole-thread fork —
    // that would silently hand the branch results the user branched before.
    #[test]
    fn trailing_tool_entries_keep_the_fork_point_explicit() {
        let mut transcript = vec![agent_entry("a1", "one")];
        transcript.push(TranscriptEntryView {
            item_id: Some("tool-1".to_string()),
            kind: TranscriptEntryKind::ToolCall,
            text: None,
            status: "completed".to_string(),
            turn_id: Some("turn-a1".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        });
        assert_eq!(
            normalize_fork_point(&transcript, Some("a1")),
            Some("a1".to_string())
        );
    }

    #[test]
    fn an_absent_fork_point_stays_absent() {
        let transcript = vec![agent_entry("a1", "one")];
        assert_eq!(normalize_fork_point(&transcript, None), None);
        assert_eq!(
            normalize_fork_point(&[], Some("a1")),
            Some("a1".to_string())
        );
    }

    #[test]
    fn an_unknown_fork_point_is_an_error_rather_than_a_silent_full_fork() {
        let transcript = vec![agent_entry("a1", "only entry")];
        assert!(truncate_transcript_at(&transcript, Some("nope")).is_err());
    }

    #[test]
    fn no_fork_point_keeps_the_whole_transcript() {
        let transcript = vec![agent_entry("a1", "one"), agent_entry("a2", "two")];
        let kept = truncate_transcript_at(&transcript, None).expect("no fork point");
        assert_eq!(kept.len(), 2);
    }

    // The budget loop can only shrink the summarized head. When the raw tail
    // alone blows the budget the old code trimmed the END of the render, which
    // dropped the newest exchanges — exactly the context a fork needs most.
    #[test]
    fn oversized_tail_drops_oldest_entries_not_newest() {
        let transcript = (0..RECENT_RAW_ENTRY_COUNT)
            .map(|index| {
                agent_entry(
                    &format!("item-{index}"),
                    &format!("ENTRY{index} {}", "x".repeat(MAX_RAW_ENTRY_CHARS * 2)),
                )
            })
            .collect::<Vec<_>>();
        let source = source_with_transcript(transcript);

        let prompt = build_fork_replay_prompt("codex", "codex", &source, "the fork task");

        assert!(prompt.len() <= MAX_FORK_REPLAY_PROMPT_CHARS);
        assert!(
            prompt.contains("Task for this fork:\nthe fork task"),
            "fork task must always survive"
        );
        let newest = format!("ENTRY{}", RECENT_RAW_ENTRY_COUNT - 1);
        assert!(
            prompt.contains(&newest),
            "newest entry {newest} must survive truncation: {}",
            &prompt[prompt.len().saturating_sub(400)..]
        );
    }
}
