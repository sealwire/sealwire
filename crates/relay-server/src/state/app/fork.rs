use super::*;

use crate::protocol::{TranscriptEntryKind, TranscriptEntryView};
use crate::state::relay::relay_thread_is_busy;

const FORK_BUSY_SOURCE_MSG: &str = "cannot fork a thread while a turn is in progress";
/// Neither the provider nor the materialized read can locate the requested row —
/// an unbound send reservation is the real case. Refusing by name beats branching
/// at a guessed message. A row the READ can locate is replayed instead, not refused.
const FORK_POINT_NOT_PROVIDER_ADDRESSABLE_MSG: &str =
    "this message cannot be used as a fork point: the provider never assigned it an id";
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
        self.fork_session_with_images(input, Vec::new()).await
    }

    /// Fork carrying images pasted into the local fork dialog. Only the local
    /// HTTP surface can supply these — the shared `ForkSessionInput` that the
    /// broker forwards has no image field, so a remote fork always lands here
    /// with an empty vec.
    pub async fn fork_session_with_images(
        &self,
        input: ForkSessionInput,
        images: Vec<ProviderImage>,
    ) -> Result<SessionSnapshot, String> {
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
            if relay.is_thread_or_cwd_workflow_locked(&source_thread_id) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
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
        let client_fork_point = non_empty(input.up_to_item_id);
        // A NATIVE fork is described to the provider, so it can only be expressed
        // with an id the provider issued. Resolve at the boundary, against both the
        // runtime (where a locally created send learns its provider name) and the
        // materialized read (which can answer for a thread with no runtime).
        let fork_point = match client_fork_point.as_deref() {
            Some(requested) => {
                let resolved = {
                    let relay = self.relay.read().await;
                    resolve_fork_point(
                        relay
                            .runtime_for_thread(&source_thread_id)
                            .map(|runtime| &runtime.transcript),
                        &source_data.transcript,
                        requested,
                    )
                };
                // Nothing can locate it, or the read is ambiguous about which entry
                // was meant. Either way, guessing would cut the branch in a place
                // the user did not choose.
                Some(resolved.ok_or_else(|| FORK_POINT_NOT_PROVIDER_ADDRESSABLE_MSG.to_string())?)
            }
            None => None,
        };
        let source_views = source_data.to_views();
        // Cut BY POSITION. Re-matching the id against the views would pick the first
        // entry that happens to spell it the same way, which in a read containing
        // both a provider item `x` and a synthesized row `x` is a coin flip.
        let forked_transcript = forked_entries(&source_views, fork_point.as_ref())?;
        // A branch point the relay can locate but the provider cannot name is still a
        // real branch point — it just has to be REPLAYED rather than described. Going
        // native with no id would fork the whole thread, handing the branch
        // everything the user chose to cut.
        let native_fork_possible = fork_point
            .as_ref()
            .is_none_or(|point| point.provider_item_id.is_some());
        let up_to_item_id = native_fork_point_id(source_views.len(), fork_point.as_ref());

        let (source_settings, source_project_id) = {
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
            if relay.is_thread_workflow_locked(&source_thread_id)
                || relay.is_cwd_workflow_locked(&source_cwd)
                || relay.is_cwd_workflow_locked(&cwd)
            {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
            (
                relay.remembered_thread_settings(&source_thread_id),
                // A dangling membership resolves to None, so the fork lands
                // Unassigned rather than re-creating a deleted project.
                relay
                    .project_for_thread(&source_thread_id)
                    .map(|project| project.id.clone()),
            )
        };

        // Three states (see ForkSessionInput). Deliberately NOT `non_empty`, which
        // collapses `Some("")` into `None` and would silently re-inherit.
        let target_project_id = match input.project_id {
            Some(explicit) if explicit.is_empty() => None,
            Some(explicit) => Some(explicit),
            None => source_project_id,
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

        if source_provider_name == target_provider_name && native_fork_possible {
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
                        target_project_id.as_deref(),
                        user_prompt,
                        images,
                    )
                    .await;
            }
        }

        // The replay path always needs a first turn: the transcript only
        // reaches the target provider as the body of a message.
        let replay_task = user_prompt.unwrap_or_else(|| REPLAY_FORK_FALLBACK_PROMPT.to_string());
        let replay_source = ThreadSyncData {
            // Replay only renders text, so provenance is irrelevant past this point.
            transcript: crate::provider::ProviderTranscriptEntry::all_provider_named(
                forked_transcript,
            ),
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
            target_project_id.as_deref(),
            replay_prompt,
            images,
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
        project_id: Option<&str>,
        user_prompt: Option<String>,
        images: Vec<ProviderImage>,
    ) -> Result<SessionSnapshot, String> {
        let forked_thread_id = start_result.thread.id.clone();
        let read_started_at_revision = {
            let relay = self.relay.read().await;
            relay.transcript_clock()
        };
        let thread_data = target_bridge.read_thread(&forked_thread_id).await?;
        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(target_provider_name.to_string());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
            }
            relay.load_thread_data_after_read_start(
                thread_data,
                approval_policy,
                sandbox,
                effort,
                model,
                device_id,
                read_started_at_revision,
            );
            relay.set_thread_forked_from(&forked_thread_id, source_thread_id);
            if let Some(project_id) = project_id {
                if super::projects::attach_new_thread_to_project(
                    &mut relay,
                    &forked_thread_id,
                    project_id,
                ) {
                    relay.bump_projects_revision();
                }
            }
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
        // Pasted images ARE a prompt though: an image-only fork must still open
        // a turn, or the screenshot the user attached is silently discarded.
        if user_prompt.is_none() && images.is_empty() {
            let _ = self.list_threads(20, Some(device_id.to_string())).await;
            return Ok(self.snapshot().await);
        }

        self.send_message_inner_with_images(
            SendMessageInput {
                text: user_prompt.unwrap_or_default(),
                model: Some(model.to_string()),
                effort: Some(effort.to_string()),
                device_id: Some(device_id.to_string()),
                thread_id: forked_thread_id,
            },
            &images,
        )
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
        project_id: Option<&str>,
        replay_prompt: String,
        images: Vec<ProviderImage>,
    ) -> Result<SessionSnapshot, String> {
        // Thread creation cannot carry images — `start_thread` only takes text.
        // So when the fork has attachments, withhold the prompt here and send
        // the whole first turn (replay context + images) through the turn path
        // instead, the same split `start_session_with_images` uses. Letting the
        // provider consume the prompt at creation would strand the images.
        let initial_prompt = images.is_empty().then_some(replay_prompt.as_str());
        let start_result = target_bridge
            .start_thread(
                StartThreadRequest::new(cwd, model, approval_policy, sandbox)
                    .with_initial_prompt(initial_prompt),
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
            if let Some(project_id) = project_id {
                if super::projects::attach_new_thread_to_project(
                    &mut relay,
                    &started_thread_id,
                    project_id,
                ) {
                    relay.bump_projects_revision();
                }
            }
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
            let sent = self
                .send_message_inner_with_images(
                    SendMessageInput {
                        text: replay_prompt,
                        model: Some(model.to_string()),
                        effort: Some(effort.to_string()),
                        device_id: Some(device_id.to_string()),
                        thread_id: started_thread_id.clone(),
                    },
                    &images,
                )
                .await;
            if sent.is_err() {
                // Lineage was recorded above so the branch is linked the moment
                // it appears, but the fork never actually started. Keeping the
                // row would persist a link to a thread that carries none of the
                // source's context — and for Claude the id is a
                // `claude-pending-*` placeholder that is now never promoted, so
                // the entry could never be cleaned up later either.
                let mut relay = self.relay.write().await;
                relay.clear_thread_forked_from(&started_thread_id);
            }
            return sent;
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
    let transcript = source.to_views();
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

/// A fork point resolved to the EXACT entry of the materialized read.
struct ResolvedForkPoint {
    /// Position in the read. The branch is cut here BY POSITION — never by
    /// re-matching a spelling, because two entries in one read may share one and
    /// the wrong one would cut the branch in the wrong place.
    index: usize,
    /// Present only when the provider issued a name for this entry. The only thing
    /// a native fork can be described with.
    provider_item_id: Option<String>,
}

/// Resolve a fork point the CLIENT named, to a position in the read.
///
/// The client can only send back the row id it rendered. Two sources can say what
/// that row is: the thread's runtime, which holds the row's typed identities, and
/// the read itself, whose entries carry their own. Matching is done through those
/// typed identities so a provider item and a synthesized row that share a spelling
/// never stand in for each other.
///
/// `None` means nothing can locate it — an unbound send reservation, or a read
/// where the requested spelling is ambiguous and guessing would cut the wrong way.
fn resolve_fork_point(
    transcript: Option<&crate::state::relay::ThreadTranscript>,
    read: &[crate::provider::ProviderTranscriptEntry],
    requested: &str,
) -> Option<ResolvedForkPoint> {
    // The runtime is authoritative when it holds the row: it is where a locally
    // created send learns the provider's name for it, and where a synthesized row
    // keeps its source name after `row_id` was minted away from it.
    if let Some(transcript) = transcript {
        if transcript.get_row(requested).is_some() {
            if let Some(provider_item_id) = transcript.provider_item_id(requested) {
                let index = read.iter().position(|entry| {
                    entry.provider_item_id.as_deref() == Some(provider_item_id)
                })?;
                return Some(ResolvedForkPoint {
                    index,
                    provider_item_id: Some(provider_item_id.to_string()),
                });
            }
            if let Some(relay_item_id) = transcript.relay_item_id(requested) {
                let index = read
                    .iter()
                    .position(|entry| entry.relay_item_id.as_deref() == Some(relay_item_id))?;
                return Some(ResolvedForkPoint {
                    index,
                    provider_item_id: None,
                });
            }
            // A row the relay owns outright: no source name, so no read can carry it.
            return None;
        }
    }
    // No runtime row. The requested id can only have come from an earlier
    // materialization of this read, so match its own key — but refuse when more
    // than one entry answers to it, since nothing here says which was meant.
    let mut matches = read
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.view.item_id.as_deref() == Some(requested));
    let (index, entry) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(ResolvedForkPoint {
        index,
        provider_item_id: entry.provider_item_id.clone(),
    })
}

/// The entries a branch inherits: everything up to and INCLUDING the fork point.
///
/// Indexed, never re-matched by id — a read may contain two entries spelling their
/// ids the same way, and picking the first would cut the branch somewhere the user
/// did not choose.
fn forked_entries(
    views: &[TranscriptEntryView],
    point: Option<&ResolvedForkPoint>,
) -> Result<Vec<TranscriptEntryView>, String> {
    match point {
        Some(point) => views
            .get(..=point.index)
            .map(<[TranscriptEntryView]>::to_vec)
            .ok_or_else(|| "fork point fell outside the source transcript".to_string()),
        None => Ok(views.to_vec()),
    }
}

/// The id a NATIVE fork is described with.
///
/// `None` for a point the provider cannot name — the branch is replayed instead —
/// and `None` for a point that IS the final entry, which drops nothing and so names
/// the same branch as forking the whole thread. Deliberately exact: if ANY entry
/// follows the point, including tool calls whose results are real context, the point
/// stays explicit rather than widening to the whole thread.
fn native_fork_point_id(total_entries: usize, point: Option<&ResolvedForkPoint>) -> Option<String> {
    let point = point?;
    if point.index + 1 == total_entries {
        return None;
    }
    point.provider_item_id.clone()
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
                workspace_trusted: false,
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
                renamed: false,
                flagged: false,
            },
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript: crate::provider::ProviderTranscriptEntry::all_provider_named(transcript),
        }
    }

    #[test]
    fn replay_prompt_trims_context_before_the_fork_task() {
        let transcript = (0..80)
            .map(|index| TranscriptEntryView {
                order_seq: None,
                withdrawn: false,
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
            order_seq: None,
            withdrawn: false,
            item_id: Some(item_id.to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some(text.to_string()),
            status: "completed".to_string(),
            turn_id: Some(format!("turn-{item_id}")),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        }
    }

    fn point(index: usize, provider_item_id: Option<&str>) -> ResolvedForkPoint {
        ResolvedForkPoint {
            index,
            provider_item_id: provider_item_id.map(str::to_string),
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

        let truncated =
            forked_entries(&transcript, Some(&point(1, Some("a2")))).expect("fork point exists");

        assert_eq!(truncated.len(), 2);
        assert_eq!(truncated[1].item_id.as_deref(), Some("a2"));
    }

    // A fork point that IS the last entry drops nothing, so it is the same
    // branch as forking the whole thread. Normalizing it lets a tip-only native
    // fork (Codex `thread/fork`) stay native instead of falling back to a lossy
    // replay just because the client named the message it clicked.
    #[test]
    fn a_fork_point_at_the_final_entry_normalizes_to_a_whole_thread_fork() {
        assert_eq!(native_fork_point_id(2, Some(&point(1, Some("a2")))), None);
    }

    #[test]
    fn a_fork_point_with_entries_after_it_is_preserved() {
        assert_eq!(
            native_fork_point_id(2, Some(&point(0, Some("a1")))),
            Some("a1".to_string())
        );
    }

    // Trailing tool calls are real context. Forking at the last AGENT message
    // when tool entries follow it must NOT be treated as a whole-thread fork —
    // that would silently hand the branch results the user branched before.
    #[test]
    fn trailing_tool_entries_keep_the_fork_point_explicit() {
        // Two entries: the agent message at 0, a tool call after it.
        assert_eq!(
            native_fork_point_id(2, Some(&point(0, Some("a1")))),
            Some("a1".to_string())
        );
    }

    #[test]
    fn an_absent_fork_point_stays_absent() {
        assert_eq!(native_fork_point_id(1, None), None);
    }

    /// A point the provider cannot name is never described to it, wherever it sits.
    #[test]
    fn a_point_the_provider_cannot_name_is_never_sent_natively() {
        assert_eq!(native_fork_point_id(3, Some(&point(0, None))), None);
        assert_eq!(native_fork_point_id(3, Some(&point(2, None))), None);
    }

    #[test]
    fn no_fork_point_keeps_the_whole_transcript() {
        let transcript = vec![agent_entry("a1", "one"), agent_entry("a2", "two")];
        let kept = forked_entries(&transcript, None).expect("no fork point");
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

#[cfg(test)]
mod fork_point_resolution_tests {
    use super::*;
    use crate::protocol::TranscriptEntryKind;
    use crate::provider::ProviderTranscriptEntry;
    use crate::state::relay::{ThreadTranscript, TranscriptRecord};

    fn row(row_id: &str) -> TranscriptRecord {
        TranscriptRecord {
            row_id: row_id.to_string(),
            provider_item_id: None,
            relay_item_id: None,
            kind: TranscriptEntryKind::AgentText,
            text: Some(row_id.to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: None,
            order_seq: 0,
            withdrawn: false,
            last_live_upsert_revision: None,
        }
    }

    fn view(item_id: &str) -> TranscriptEntryView {
        TranscriptEntryView {
            order_seq: None,
            withdrawn: false,
            item_id: Some(item_id.to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some(item_id.to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        }
    }

    /// A read holding a provider item `x` AND a synthesized row `x`. Each published
    /// row must resolve to ITS OWN entry — matching the spelling would pick
    /// whichever came first.
    #[test]
    fn same_spelling_provider_and_synthetic_rows_resolve_to_their_own_entries() {
        // Synthetic first, so a spelling match would always find the wrong one for
        // the provider row.
        let read = vec![
            ProviderTranscriptEntry::relay_named(view("x")),
            ProviderTranscriptEntry::provider_named(view("x")),
            ProviderTranscriptEntry::provider_named(view("tail")),
        ];
        let mut store = ThreadTranscript::new();
        let synthetic = store.push(TranscriptRecord {
            relay_item_id: Some("x".to_string()),
            ..row("x")
        });
        let provider_row = store.push(TranscriptRecord {
            provider_item_id: Some("x".to_string()),
            ..row("x")
        });
        assert_ne!(synthetic, provider_row, "the second had to mint");

        let resolved = resolve_fork_point(Some(&store), &read, &provider_row)
            .expect("the provider row is locatable");
        assert_eq!(
            resolved.index, 1,
            "the PROVIDER entry, not the synthetic one"
        );
        assert_eq!(resolved.provider_item_id.as_deref(), Some("x"));

        let resolved = resolve_fork_point(Some(&store), &read, &synthetic)
            .expect("the synthetic row is locatable by its source name");
        assert_eq!(resolved.index, 0, "the SYNTHETIC entry");
        assert_eq!(
            resolved.provider_item_id, None,
            "a synthesized row is never described to the provider"
        );
    }

    /// The tip condition must be decided by position too. With the colliding
    /// spellings reversed, the provider row is the tip and the synthetic one is not.
    #[test]
    fn the_tip_test_uses_position_so_a_shared_spelling_cannot_widen_the_fork() {
        let read = vec![
            ProviderTranscriptEntry::relay_named(view("x")),
            ProviderTranscriptEntry::provider_named(view("x")),
        ];
        let mut store = ThreadTranscript::new();
        let synthetic = store.push(TranscriptRecord {
            relay_item_id: Some("x".to_string()),
            ..row("x")
        });
        let provider_row = store.push(TranscriptRecord {
            provider_item_id: Some("x".to_string()),
            ..row("x")
        });

        let at_tip = resolve_fork_point(Some(&store), &read, &provider_row).expect("locatable");
        assert_eq!(
            native_fork_point_id(read.len(), Some(&at_tip)),
            None,
            "the provider row IS the tip, so it forks the whole thread natively"
        );

        let before_tip = resolve_fork_point(Some(&store), &read, &synthetic).expect("locatable");
        assert_eq!(
            forked_entries(
                &read.iter().map(|e| e.view.clone()).collect::<Vec<_>>(),
                Some(&before_tip)
            )
            .expect("in range")
            .len(),
            1,
            "the synthetic row is NOT the tip and must cut the entry after it"
        );
    }

    /// A locally-created send resolves through the provider name it was later given.
    #[test]
    fn a_bound_send_resolves_to_the_provider_entry_it_names() {
        let read = vec![
            ProviderTranscriptEntry::provider_named(view("codex-item-1")),
            ProviderTranscriptEntry::provider_named(view("codex-item-2")),
        ];
        let mut store = ThreadTranscript::new();
        let row_id = store.push(row("codex:user-reserve:gen-1:t:1"));
        store.bind_provider_item_id(&row_id, "codex-item-1");

        let resolved = resolve_fork_point(Some(&store), &read, &row_id).expect("locatable");
        assert_eq!(resolved.index, 0);
        assert_eq!(resolved.provider_item_id.as_deref(), Some("codex-item-1"));
    }

    /// A row the relay owns outright has no source name, so no read can carry it.
    #[test]
    fn an_unacknowledged_reservation_is_unlocatable() {
        let read = vec![ProviderTranscriptEntry::provider_named(view(
            "codex-item-1",
        ))];
        let mut store = ThreadTranscript::new();
        let row_id = store.push(row("codex:user-reserve:gen-1:t:1"));

        assert!(resolve_fork_point(Some(&store), &read, &row_id).is_none());
        assert!(resolve_fork_point(None, &read, "never-heard-of-it").is_none());
    }

    /// With no runtime to consult, a spelling that names two entries is ambiguous.
    /// Guessing would cut the branch somewhere the user did not choose.
    #[test]
    fn an_ambiguous_spelling_with_no_runtime_is_refused() {
        let read = vec![
            ProviderTranscriptEntry::relay_named(view("x")),
            ProviderTranscriptEntry::provider_named(view("x")),
        ];
        assert!(resolve_fork_point(None, &read, "x").is_none());

        let unique = vec![ProviderTranscriptEntry::provider_named(view("x"))];
        let resolved = resolve_fork_point(None, &unique, "x").expect("unambiguous");
        assert_eq!(resolved.index, 0);
    }
}
