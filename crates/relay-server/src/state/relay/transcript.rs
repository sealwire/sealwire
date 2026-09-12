use serde::{Deserialize, Serialize};

use crate::protocol::{
    FileChangeApplyState, LogEntryView, ToolCallView, TranscriptEntryKind, TranscriptEntryView,
};

use super::transcript_store::IdSpace;
use super::RelayState;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TranscriptMutationMeta {
    pub(crate) base_revision: u64,
    pub(crate) revision: u64,
    pub(crate) entry_seq: u64,
    /// The row this mutation landed on, as the relay names it.
    ///
    /// Callers published the id THEY passed in, which for anything provider-named
    /// is not necessarily the row's key — a delta addressed to a provider id no
    /// client row carries is a delta no client can apply. Publish this instead.
    pub(crate) row_id: String,
    /// The mutated row's birth-time order key (see `TranscriptRecord::order_seq`).
    pub(crate) order_seq: i64,
    pub(crate) server_time: u64,
    /// Length (in UTF-16 code units, matching JS `String.length`) of the
    /// entry's text *before* this delta was appended. Only set for pure-append
    /// agent-text deltas, where the client can use it to detect a missing chunk
    /// (`have < text_offset` => gap) and repair instead of silently freezing.
    /// `None` for mutations where append offset is undefined (command output
    /// inserts separators server-side, snapshots, completions, etc.).
    pub(crate) text_offset: Option<u64>,
    /// True when the relay inserted a newline BEFORE this delta to separate it from the
    /// previous command output.
    ///
    /// The delta published to clients must include that separator. Sending the raw
    /// provider delta while the relay's own copy gained a "\n" makes the two diverge —
    /// `"npm test"` + `"line 1"` renders as `"npm testline 1"` on every surface that
    /// appends what it was sent.
    pub(crate) separator_inserted: bool,
}

impl TranscriptMutationMeta {
    /// The delta as the relay actually appended it, which is what clients must apply.
    pub(crate) fn wire_delta(&self, delta: &str) -> String {
        if self.separator_inserted {
            format!("\n{delta}")
        } else {
            delta.to_string()
        }
    }
}

/// Spacing between consecutively issued order keys, so a future mid-insert can take a
/// midpoint without renumbering anything already published. Exhausting a gap is a
/// fail-fast (checked arithmetic), never a silent reuse.
pub(crate) const ORDER_SEQ_STEP: i64 = 1 << 20;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct TranscriptRecord {
    /// The relay's own name for this row. Minted once when the row is born and
    /// never changed — a snapshot merge can only add and update, so a rename
    /// would leave every client holding the old id beside the new one and show
    /// one message twice.
    ///
    /// For a provider-born row the minted value is the id it was FIRST seen
    /// under, which is what keeps the published `item_id` stable across this
    /// change. That makes the value sometimes equal to a provider id, so it is
    /// still never safe to hand this to a provider: translate through
    /// `provider_item_id` at the boundary.
    #[serde(rename = "item_id")]
    pub(crate) row_id: String,
    /// What the provider calls this row, once it has told us. `None` for a row
    /// the relay created on its own (a send's reservation, `turn-diff:*`) that
    /// the provider has not yet acknowledged, or never will.
    ///
    /// Further provider ids for the same row are held as aliases by
    /// `ThreadTranscript`; this field is the first one bound, and exists so a
    /// rebuilt store can recover the mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) provider_item_id: Option<String>,
    /// The RELAY's own source name for a row it synthesized — `turn-diff:<turn>`,
    /// `turn-error:<turn>`. Deterministic, so the same logical row is recognisable
    /// from one read to the next.
    ///
    /// Held separately from `row_id` because `row_id` may be minted away on a
    /// collision, and then it is no longer the name the next read will use. It is
    /// NOT provider-addressable: nothing here may be sent to a provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) relay_item_id: Option<String>,
    pub(crate) kind: TranscriptEntryKind,
    pub(crate) text: Option<String>,
    pub(crate) status: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) tool: Option<ToolCallView>,
    /// Where this row sorts within its thread, valid for THIS run only
    /// (`transcript_generation`). Assigned once at creation, never mutated. Holes are
    /// legal — continuity is the revision chain's job, never this field's.
    #[serde(default)]
    pub(crate) order_seq: i64,
    /// Withdrawn rows stay in the transcript (a snapshot merge cannot express
    /// absence). ABSORBING: once true, no later copy of the row may clear it.
    #[serde(default)]
    pub(crate) withdrawn: bool,
    /// Relay-global clock at the last live upsert. Hydrated/prepended history leaves this
    /// unset, and delta/status writes do NOT touch it — it is not a general write stamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_live_upsert_revision: Option<u64>,
}

impl TranscriptRecord {
    pub(crate) fn to_view(&self) -> TranscriptEntryView {
        TranscriptEntryView {
            // THE client identity. Every key a client builds is this.
            row_id: Some(self.row_id.clone()),
            // Compatibility: the same value, for a client built before `row_id`
            // existed. Never the provider id — the relay owns that translation.
            item_id: Some(self.row_id.clone()),
            order_seq: Some(self.order_seq),
            withdrawn: self.withdrawn,
            kind: self.kind,
            text: self.text.clone(),
            status: self.status.clone(),
            turn_id: self.turn_id.clone(),
            tool: self.tool.clone(),
            // The runtime holds authoritative, complete content. Snapshot
            // compaction is the only place that downgrades this.
            content_state: crate::protocol::TranscriptContentState::Full,
        }
    }
}

impl RelayState {
    pub fn upsert_transcript_item(
        &mut self,
        item_id: String,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
    ) -> TranscriptMutationMeta {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return self.upsert_transcript_item_legacy(item_id, kind, text, status, turn_id, tool);
        };
        self.upsert_transcript_item_for_thread(
            &thread_id, item_id, kind, text, status, turn_id, tool,
        )
    }

    /// `row_id` is a ROW key — `update_row` resolves in that namespace only. Callers
    /// holding a provider or relay source name must resolve it first.
    fn stamp_transcript_item_seq(&mut self, thread_id: &str, row_id: &str, revision: u64) {
        if let Some(runtime) = self.runtimes.get_mut(thread_id) {
            runtime.transcript.update_row(row_id, |entry| {
                entry.last_live_upsert_revision = Some(revision);
            });
        }
    }

    /// The provider named this item. A row born here records `item_id` as its
    /// `provider_item_id` too, which is what lets a fork or a detail request
    /// translate back to something the provider can match.
    pub fn upsert_transcript_item_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
    ) -> TranscriptMutationMeta {
        self.upsert_item_for_thread(
            thread_id,
            item_id,
            IdSpace::Provider,
            kind,
            text,
            status,
            turn_id,
            tool,
        )
    }

    /// The row a RELAY-synthesized name refers to, on the active thread.
    ///
    /// Symmetric with `upsert_relay_named_item`, which resolves in the same space.
    /// Matching the spelling against ROW keys instead disagreed with the write the
    /// moment `row_id` had to be minted away from the source name — and then landed
    /// on whichever unrelated row owns that spelling.
    ///
    /// Straight off the runtime record, NOT through `snapshot()`: the snapshot
    /// projection strips `tool.diff` for transport, so a caller that read the diff
    /// back out of it always got `None`.
    pub(crate) fn relay_named_entry(&self, item_id: &str) -> Option<TranscriptEntryView> {
        // The same mirror `upsert_relay_named_item` falls back to with no active
        // thread, so the read cannot look somewhere the write never went.
        let transcript = match self.selected_runtime() {
            Some(runtime) => &runtime.transcript,
            None => &self.transcript,
        };
        let row_id = transcript.resolve_relay(item_id)?;
        transcript.get_row(row_id).map(TranscriptRecord::to_view)
    }

    /// Active-thread convenience for a row the RELAY synthesized.
    pub(crate) fn upsert_relay_named_item(
        &mut self,
        item_id: String,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
    ) -> TranscriptMutationMeta {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return self.upsert_transcript_item_legacy(item_id, kind, text, status, turn_id, tool);
        };
        self.upsert_relay_named_item_for_thread(
            &thread_id, item_id, kind, text, status, turn_id, tool,
        )
    }

    /// The RELAY synthesized this row and will derive the same name again from a
    /// later read — `turn-diff:<turn>`, `turn-error:<turn>`. That name is recorded
    /// as the row's SOURCE identity, which is how the next read recognises it even
    /// if `row_id` had to be minted away on a collision. It is never sent to a
    /// provider.
    pub(crate) fn upsert_relay_named_item_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
    ) -> TranscriptMutationMeta {
        self.upsert_item_for_thread(
            thread_id,
            item_id,
            IdSpace::Relay,
            kind,
            text,
            status,
            turn_id,
            tool,
        )
    }

    /// A row the relay owns outright and that no read will ever re-derive — a send
    /// reservation, a per-attempt workspace error. Unique by construction, so it
    /// carries no source name in either alias space.
    pub(crate) fn upsert_relay_owned_row_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
    ) -> TranscriptMutationMeta {
        self.upsert_item_for_thread(
            thread_id,
            item_id,
            IdSpace::Row,
            kind,
            text,
            status,
            turn_id,
            tool,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn upsert_item_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        space: IdSpace,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
    ) -> TranscriptMutationMeta {
        let (stamp_id, entry_seq, order_seq) = {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            // One resolve, up front: from here on the row is addressed by the
            // relay's own key, never by whatever the caller named it.
            if let Some(index) = runtime.transcript.resolve_index_in(space, &item_id) {
                let row_id = runtime.transcript[index].row_id.clone();
                let order_seq = runtime.transcript[index].order_seq;
                runtime.transcript.update_row(&row_id, |entry| {
                    entry.kind = kind;
                    entry.text = text.or(entry.text.take());
                    entry.status = status;
                    entry.turn_id = turn_id;
                    entry.tool = if kind == TranscriptEntryKind::ToolCall {
                        merge_tool_call_view(entry.tool.take(), tool)
                    } else {
                        tool
                    };
                });
                (row_id, index as u64 + 1, order_seq)
            } else {
                let entry_seq = runtime.transcript.len() as u64 + 1;
                let order_seq = runtime.alloc_tail_order_seq();
                let provider_item_id = space.provider_name_of(&item_id);
                let relay_item_id = space.relay_name_of(&item_id);
                let row_id = runtime.transcript.push(TranscriptRecord {
                    row_id: item_id,
                    provider_item_id,
                    relay_item_id,
                    kind,
                    text,
                    status,
                    turn_id,
                    tool,
                    order_seq,
                    withdrawn: false,
                    last_live_upsert_revision: None,
                });
                (row_id, entry_seq, order_seq)
            }
        };
        let (base_revision, revision) = self.bump_thread_transcript_revision(thread_id);
        self.stamp_transcript_item_seq(thread_id, &stamp_id, revision);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        transcript_mutation_meta(base_revision, revision, entry_seq, order_seq, stamp_id)
    }

    fn upsert_transcript_item_legacy(
        &mut self,
        item_id: String,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
    ) -> TranscriptMutationMeta {
        if let Some(index) = self
            .transcript
            .resolve_index_in(IdSpace::Provider, &item_id)
        {
            let (base_revision, revision) = self.bump_transcript_revision();
            let row_id = self.transcript[index].row_id.clone();
            let order_seq = self.transcript[index].order_seq;
            self.transcript.update_row(&row_id, |entry| {
                entry.kind = kind;
                entry.text = text.or(entry.text.take());
                entry.status = status;
                entry.turn_id = turn_id;
                entry.tool = if kind == TranscriptEntryKind::ToolCall {
                    merge_tool_call_view(entry.tool.take(), tool)
                } else {
                    tool
                };
                entry.last_live_upsert_revision = Some(revision);
            });
            return transcript_mutation_meta(
                base_revision,
                revision,
                index as u64 + 1,
                order_seq,
                row_id,
            );
        }

        let entry_seq = self.transcript.len() as u64 + 1;
        let (base_revision, revision) = self.bump_transcript_revision();
        let order_seq = next_legacy_tail_order_seq(&self.transcript);
        // The legacy mirror is fed only by provider bridges, and the row must record
        // that name or the item's own completion resolves to nothing and mints a twin.
        let provider_item_id = IdSpace::Provider.provider_name_of(&item_id);
        let row_id = self.transcript.push(TranscriptRecord {
            row_id: item_id,
            provider_item_id,
            relay_item_id: None,
            kind,
            text,
            status,
            turn_id,
            tool,
            order_seq,
            withdrawn: false,
            last_live_upsert_revision: Some(revision),
        });
        transcript_mutation_meta(base_revision, revision, entry_seq, order_seq, row_id)
    }

    pub fn push_log(&mut self, kind: &str, message: impl Into<String>) {
        self.logs.insert(
            0,
            LogEntryView {
                kind: kind.to_string(),
                message: message.into(),
                created_at: super::super::unix_now(),
                // Operator-only by default: the global buffer mixes lines from
                // every thread/cwd and broker-bound snapshots are broadcast to
                // all paired devices irrespective of `path_scope`. A line reaches
                // remote/iOS surfaces only by explicitly setting `remote_safe`.
                // Fail closed.
                remote_safe: false,
            },
        );
        if self.logs.len() > super::super::MAX_LOG_LINES {
            self.logs.truncate(super::super::MAX_LOG_LINES);
        }
    }

    /// The audit log, for tests that assert a line was filed on the channel a
    /// user can actually see (see `push_log`'s channel classification).
    #[cfg(test)]
    pub(crate) fn logs_for_test(&self) -> &[LogEntryView] {
        &self.logs
    }

    pub fn start_agent_message(&mut self, item_id: String, turn_id: String) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.start_agent_message_for_thread(&thread_id, item_id, turn_id);
            return;
        }
        self.upsert_transcript_item_legacy(
            item_id,
            TranscriptEntryKind::AgentText,
            Some(String::new()),
            "streaming".to_string(),
            Some(turn_id),
            None,
        );
    }

    pub fn start_agent_message_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        turn_id: String,
    ) {
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::AgentText,
            Some(String::new()),
            "streaming".to_string(),
            Some(turn_id),
            None,
        );
    }

    pub fn append_agent_delta(
        &mut self,
        item_id: &str,
        delta: &str,
        turn_id: &str,
    ) -> TranscriptMutationMeta {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return self.append_agent_delta_legacy(item_id, delta, turn_id);
        };
        self.append_agent_delta_for_thread(&thread_id, item_id, delta, turn_id)
    }

    pub fn append_agent_delta_for_thread(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
        turn_id: &str,
    ) -> TranscriptMutationMeta {
        self.append_agent_delta_in(thread_id, IdSpace::Provider, item_id, delta, turn_id)
    }

    /// Append agent text to a row the RELAY named.
    ///
    /// The Claude worker's `assistant_delta` carries no item id, so the relay has to
    /// derive one. That derived name is not provider-addressable — offering it as a
    /// fork point or a detail id would address the SDK with a string it never
    /// issued — so the row records it as a relay source name instead.
    pub fn append_relay_named_agent_delta_for_thread(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
        turn_id: &str,
    ) -> TranscriptMutationMeta {
        self.append_agent_delta_in(thread_id, IdSpace::Relay, item_id, delta, turn_id)
    }

    fn append_agent_delta_in(
        &mut self,
        thread_id: &str,
        space: IdSpace,
        item_id: &str,
        delta: &str,
        turn_id: &str,
    ) -> TranscriptMutationMeta {
        let (row_id, entry_seq, order_seq, text_offset) = {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            if let Some(index) = runtime.transcript.resolve_index_in(space, item_id) {
                let row_id = runtime.transcript[index].row_id.clone();
                let order_seq = runtime.transcript[index].order_seq;
                let text_offset = runtime
                    .transcript
                    .update_row(&row_id, |entry| {
                        entry.kind = TranscriptEntryKind::AgentText;
                        let text = entry.text.get_or_insert_with(String::new);
                        let text_offset = text.encode_utf16().count() as u64;
                        text.push_str(delta);
                        entry.status = "streaming".to_string();
                        entry.turn_id.get_or_insert_with(|| turn_id.to_string());
                        entry.tool = None;
                        text_offset
                    })
                    .unwrap_or(0);
                (row_id, index as u64 + 1, order_seq, text_offset)
            } else {
                let entry_seq = runtime.transcript.len() as u64 + 1;
                let order_seq = runtime.alloc_tail_order_seq();
                let row_id = runtime.transcript.push(TranscriptRecord {
                    row_id: item_id.to_string(),
                    provider_item_id: space.provider_name_of(item_id),
                    relay_item_id: space.relay_name_of(item_id),
                    kind: TranscriptEntryKind::AgentText,
                    text: Some(delta.to_string()),
                    status: "streaming".to_string(),
                    turn_id: Some(turn_id.to_string()),
                    tool: None,
                    order_seq,
                    withdrawn: false,
                    last_live_upsert_revision: None,
                });
                (row_id, entry_seq, order_seq, 0)
            }
        };
        let (base_revision, revision) = self.bump_thread_transcript_revision(thread_id);
        // A delta births rows too, so it owes the same birth stamp an upsert pays.
        // Without it the resume read-race merge cannot see that this row appeared
        // AFTER the provider read began, and stale history is appended past it.
        //
        // Stamped by ROW id, not by the name the caller passed: the row may have had
        // to mint one when that name was already spoken for in another namespace,
        // and stamping the source spelling then lands on the unrelated row that
        // holds it — or on nothing at all, silently skipping the birth stamp.
        self.stamp_transcript_item_seq(thread_id, &row_id, revision);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        transcript_mutation_meta_with_text_offset(
            base_revision,
            revision,
            entry_seq,
            order_seq,
            row_id,
            text_offset,
        )
    }

    fn append_agent_delta_legacy(
        &mut self,
        item_id: &str,
        delta: &str,
        turn_id: &str,
    ) -> TranscriptMutationMeta {
        if let Some(index) = self.transcript.resolve_index_in(IdSpace::Provider, item_id) {
            let (base_revision, revision) = self.bump_transcript_revision();
            let row_id = self.transcript[index].row_id.clone();
            let order_seq = self.transcript[index].order_seq;
            let text_offset = self
                .transcript
                .update_row(&row_id, |entry| {
                    entry.kind = TranscriptEntryKind::AgentText;
                    let text = entry.text.get_or_insert_with(String::new);
                    let text_offset = text.encode_utf16().count() as u64;
                    text.push_str(delta);
                    entry.status = "streaming".to_string();
                    entry.tool = None;
                    text_offset
                })
                .unwrap_or(0);
            return transcript_mutation_meta_with_text_offset(
                base_revision,
                revision,
                index as u64 + 1,
                order_seq,
                row_id,
                text_offset,
            );
        }

        let meta = self.upsert_transcript_item(
            item_id.to_string(),
            TranscriptEntryKind::AgentText,
            Some(delta.to_string()),
            "streaming".to_string(),
            Some(turn_id.to_string()),
            None,
        );
        // Brand-new entry: this delta is the whole text, so its append offset is 0.
        TranscriptMutationMeta {
            text_offset: Some(0),
            ..meta
        }
    }

    pub fn upsert_user_message(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.upsert_user_message_for_thread(&thread_id, item_id, text, turn_id);
            return;
        }
        self.upsert_user_message_legacy(item_id, text, turn_id);
    }

    /// Install the user entry before Codex can emit output for this start.
    ///
    /// The reservation is also the per-thread admission fence. In particular, an
    /// unbound reservation survives an uncertain RPC timeout: until Codex emits a
    /// turn id or disconnects, a retry would make an unknown notification
    /// impossible to attribute to the old or new request.
    pub fn begin_codex_user_turn(&mut self, thread_id: &str, text: &str) -> Result<String, String> {
        let generation = self.transcript_generation.clone();
        let item_id = {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            if runtime.active_turn_id.is_some() {
                return Err("Codex already has an active turn for this thread".to_string());
            }
            if runtime.codex_start_reservation.is_some() {
                return Err(
                    "the previous Codex turn/start is still unresolved for this thread".to_string(),
                );
            }
            runtime.codex_user_reservation_seq =
                runtime.codex_user_reservation_seq.saturating_add(1);
            // The generation is what makes this safe to keep FOREVER as the row's id.
            // The counter is rebuilt at zero from provider history, so across a restart
            // it alone would reissue `...:1` — and a client still holding the previous
            // run's `...:1` (in a persisted page) merges the two sends into one row by
            // id, losing the new message with no error. The counter stays for readable
            // ordering within a run.
            format!(
                "codex:user-reserve:{generation}:{thread_id}:{}",
                runtime.codex_user_reservation_seq
            )
        };
        self.upsert_relay_owned_row_for_thread(
            thread_id,
            item_id.clone(),
            TranscriptEntryKind::UserText,
            Some(text.to_string()),
            "completed".to_string(),
            None,
            None,
        );
        if let Some(runtime) = self.runtimes.get_mut(thread_id) {
            runtime.codex_start_reservation = Some(super::CodexStartReservation {
                row_id: item_id.clone(),
                turn_id: None,
            });
        }
        Ok(item_id)
    }

    /// Bind the RPC result to the exact reservation created by that request.
    pub fn bind_codex_user_reservation(
        &mut self,
        thread_id: &str,
        reservation_id: &str,
        turn_id: &str,
    ) {
        let Some(runtime) = self.runtimes.get_mut(thread_id) else {
            return;
        };
        let Some(reservation) = runtime.codex_start_reservation.as_mut() else {
            return;
        };
        if reservation.row_id != reservation_id {
            return;
        }
        if reservation.turn_id.is_some() {
            return;
        }
        reservation.turn_id = Some(turn_id.to_string());
        runtime.transcript.update_row(reservation_id, |entry| {
            entry.turn_id = Some(turn_id.to_string());
        });
        let _ = self.bump_thread_transcript_revision(thread_id);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
    }

    /// Observe a provider lifecycle event. A known, inactive turn is stale and
    /// must not claim the current reservation or become active again.
    pub fn bind_pending_codex_user_reservation(&mut self, thread_id: &str, turn_id: &str) -> bool {
        let Some(runtime) = self.runtimes.get(thread_id) else {
            return true;
        };
        if runtime.active_turn_id.as_deref() == Some(turn_id) {
            return true;
        }
        if let Some(reservation) = runtime.codex_start_reservation.as_ref() {
            if runtime.active_turn_id.is_some() {
                return false;
            }
            if !reservation.can_claim_turn(&runtime.transcript, turn_id) {
                return false;
            }
            if reservation.turn_id.is_some() {
                return true;
            }
            let reservation_id = reservation.row_id.clone();
            self.bind_codex_user_reservation(thread_id, &reservation_id, turn_id);
            return true;
        }
        !runtime
            .transcript
            .iter()
            .any(|entry| entry.turn_id.as_deref() == Some(turn_id))
    }

    /// Remove a reservation only when Codex definitively rejected its start.
    /// A provider event may beat that response; in that case the bound user entry
    /// is real and must be retained.
    pub fn fail_codex_user_turn_definitive(&mut self, thread_id: &str, reservation_id: &str) {
        let Some(runtime) = self.runtimes.get_mut(thread_id) else {
            return;
        };
        let Some(reservation) = runtime.codex_start_reservation.as_ref() else {
            return;
        };
        if reservation.row_id != reservation_id {
            return;
        }
        // A lifecycle event outranks a contradictory error response: Codex has
        // already demonstrated that work exists, so keep blocking until its
        // terminal event or provider disconnect.
        if reservation.turn_id.is_some() {
            return;
        }
        runtime.codex_start_reservation = None;
        mark_reservation_row_withdrawn(&mut runtime.transcript, reservation_id);
        let _ = self.bump_thread_transcript_revision(thread_id);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
    }

    /// The provider process ended, so an unbound request can no longer emit a
    /// notification. This is the one safe recovery point for its admission fence.
    pub fn abandon_codex_start_reservation(&mut self, thread_id: &str) {
        let reservation = self
            .runtimes
            .get_mut(thread_id)
            .and_then(|runtime| runtime.codex_start_reservation.take());
        let Some(reservation) = reservation else {
            return;
        };
        if reservation.turn_id.is_none() {
            if let Some(runtime) = self.runtimes.get_mut(thread_id) {
                mark_reservation_row_withdrawn(&mut runtime.transcript, &reservation.row_id);
            }
            let _ = self.bump_thread_transcript_revision(thread_id);
            if self.active_thread_id.as_deref() == Some(thread_id) {
                self.sync_selected_runtime_to_fields();
            }
        }
    }

    /// A terminal event identifies and settles a response-first reservation even
    /// when `turn/started` was omitted.
    pub fn finish_codex_start_reservation(&mut self, thread_id: &str, turn_id: &str) {
        let matches = self
            .runtimes
            .get(thread_id)
            .and_then(|runtime| runtime.codex_start_reservation.as_ref())
            .is_some_and(|reservation| reservation.turn_id.as_deref() == Some(turn_id));
        if matches {
            if let Some(runtime) = self.runtimes.get_mut(thread_id) {
                runtime.codex_start_reservation = None;
            }
        }
    }

    /// `provider_item_id` is what Codex calls this message. The relay minted this
    /// row's key before Codex had said anything, so Codex will never name the row
    /// that way — binding its id here is the only chance to learn the mapping, and
    /// without it every later event about this message resolves to nothing and
    /// mints a twin.
    fn reconcile_codex_user_reservation(
        &mut self,
        thread_id: &str,
        provider_item_id: &str,
        text: String,
        turn_id: String,
    ) -> bool {
        // A bound or already-reconciled user entry is authoritative for this
        // turn, including a late echo after terminal settlement.
        let mut local_id = self.runtimes.get(thread_id).and_then(|runtime| {
            runtime
                .transcript
                .iter()
                .find(|entry| {
                    entry.kind == TranscriptEntryKind::UserText
                        && entry.turn_id.as_deref() == Some(turn_id.as_str())
                })
                .map(|entry| entry.row_id.clone())
        });

        // An early echo may provide the first identity for the sole outstanding
        // start. Never let a turn represented before this placeholder claim it.
        if local_id.is_none() {
            if let Some(runtime) = self.runtimes.get(thread_id) {
                if let Some(reservation) = runtime.codex_start_reservation.as_ref() {
                    if reservation.can_claim_turn(&runtime.transcript, &turn_id) {
                        local_id = Some(reservation.row_id.clone());
                    }
                }
            }
        }
        let Some(local_id) = local_id else {
            return false;
        };
        let Some(runtime) = self.runtimes.get_mut(thread_id) else {
            return false;
        };
        if let Some(reservation) = runtime.codex_start_reservation.as_mut() {
            if reservation.row_id == local_id && reservation.turn_id.is_none() {
                reservation.turn_id = Some(turn_id.clone());
            }
        }
        // The relay's own id STAYS this row's id. It was published to clients the
        // moment the send was accepted, and a snapshot merge can only add and update —
        // it cannot express a rename, so every client already holding the old id would
        // keep it beside the new one and show one send twice.
        let reconciled = runtime
            .transcript
            .update_row(&local_id, |entry| {
                entry.kind = TranscriptEntryKind::UserText;
                entry.text = if text.is_empty() {
                    entry.text.take()
                } else {
                    Some(text)
                };
                entry.status = "completed".to_string();
                entry.turn_id = Some(turn_id.clone());
                entry.tool = None;
            })
            .is_some();
        if !reconciled {
            return false;
        }
        runtime
            .transcript
            .bind_provider_item_id(&local_id, provider_item_id);
        let _ = self.bump_thread_transcript_revision(thread_id);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        true
    }

    pub fn upsert_user_message_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
    ) {
        if self.reconcile_codex_user_reservation(thread_id, &item_id, text.clone(), turn_id.clone())
        {
            return;
        }
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::UserText,
            // `item/started` can carry no content. Empty must not overwrite the text
            // this row already has — `upsert` treats `Some("")` as a real value. NOT
            // `non_empty`, which trims: a message's own leading/trailing space is text.
            if text.is_empty() { None } else { Some(text) },
            "completed".to_string(),
            Some(turn_id),
            None,
        );
    }

    fn upsert_user_message_legacy(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(row_id) = self
            .transcript
            .resolve_in(IdSpace::Provider, &item_id)
            .map(str::to_string)
        {
            self.bump_transcript_revision();
            self.transcript.update_row(&row_id, |entry| {
                entry.kind = TranscriptEntryKind::UserText;
                entry.text = Some(text);
                entry.status = "completed".to_string();
                entry.tool = None;
            });
            return;
        }

        self.upsert_transcript_item(
            item_id,
            TranscriptEntryKind::UserText,
            Some(text),
            "completed".to_string(),
            Some(turn_id),
            None,
        );
    }

    pub fn complete_agent_message(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.complete_agent_message_for_thread(&thread_id, item_id, text, turn_id);
            return;
        }
        self.complete_agent_message_legacy(item_id, text, turn_id);
    }

    pub fn complete_agent_message_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
    ) {
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::AgentText,
            Some(text),
            "completed".to_string(),
            Some(turn_id),
            None,
        );
    }

    fn complete_agent_message_legacy(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(row_id) = self
            .transcript
            .resolve_in(IdSpace::Provider, &item_id)
            .map(str::to_string)
        {
            self.bump_transcript_revision();
            self.transcript.update_row(&row_id, |entry| {
                entry.kind = TranscriptEntryKind::AgentText;
                entry.text = Some(text);
                entry.status = "completed".to_string();
                entry.tool = None;
            });
            return;
        }

        self.upsert_transcript_item(
            item_id,
            TranscriptEntryKind::AgentText,
            Some(text),
            "completed".to_string(),
            Some(turn_id),
            None,
        );
    }

    pub fn add_command_result(
        &mut self,
        item_id: String,
        command: String,
        output: Option<String>,
        status: String,
        turn_id: String,
    ) {
        let mut text = command;
        if let Some(output) = super::super::non_empty(Some(output.unwrap_or_default())) {
            text.push_str("\n");
            text.push_str(&output);
        }

        if let Some(thread_id) = self.active_thread_id.clone() {
            self.upsert_transcript_item_for_thread(
                &thread_id,
                item_id,
                TranscriptEntryKind::Command,
                Some(text),
                status,
                Some(turn_id),
                None,
            );
            return;
        }

        if let Some(row_id) = self
            .transcript
            .resolve_in(IdSpace::Provider, &item_id)
            .map(str::to_string)
        {
            self.bump_transcript_revision();
            self.transcript.update_row(&row_id, |entry| {
                entry.kind = TranscriptEntryKind::Command;
                entry.text = Some(text);
                entry.status = status;
                entry.tool = None;
            });
            return;
        }

        self.upsert_transcript_item(
            item_id,
            TranscriptEntryKind::Command,
            Some(text),
            status,
            Some(turn_id),
            None,
        );
    }

    pub fn start_command_execution(
        &mut self,
        item_id: String,
        command: String,
        status: String,
        turn_id: String,
    ) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.start_command_execution_for_thread(&thread_id, item_id, command, status, turn_id);
            return;
        }
        self.start_command_execution_legacy(item_id, command, status, turn_id);
    }

    pub fn start_command_execution_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        command: String,
        status: String,
        turn_id: String,
    ) {
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::Command,
            Some(command),
            status,
            Some(turn_id),
            None,
        );
    }

    fn start_command_execution_legacy(
        &mut self,
        item_id: String,
        command: String,
        status: String,
        turn_id: String,
    ) {
        if let Some(row_id) = self
            .transcript
            .resolve_in(IdSpace::Provider, &item_id)
            .map(str::to_string)
        {
            self.bump_transcript_revision();
            self.transcript.update_row(&row_id, |entry| {
                entry.kind = TranscriptEntryKind::Command;
                entry.text = Some(command);
                entry.status = status;
                entry.turn_id = Some(turn_id);
                entry.tool = None;
            });
            return;
        }

        self.upsert_transcript_item(
            item_id,
            TranscriptEntryKind::Command,
            Some(command),
            status,
            Some(turn_id),
            None,
        );
    }

    pub fn append_command_delta(&mut self, item_id: &str, delta: &str) -> TranscriptMutationMeta {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return self.append_command_delta_legacy(item_id, delta);
        };
        self.append_command_delta_for_thread(&thread_id, item_id, delta)
    }

    pub fn append_command_delta_for_thread(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
    ) -> TranscriptMutationMeta {
        let mut separator_inserted = false;
        let (row_id, entry_seq, order_seq) = {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            if let Some(index) = runtime
                .transcript
                .resolve_index_in(IdSpace::Provider, item_id)
            {
                let row_id = runtime.transcript[index].row_id.clone();
                let order_seq = runtime.transcript[index].order_seq;
                separator_inserted = runtime
                    .transcript
                    .update_row(&row_id, |entry| {
                        entry.kind = TranscriptEntryKind::Command;
                        let text = entry.text.get_or_insert_with(String::new);
                        let mut inserted = false;
                        if !text.is_empty() && !text.ends_with('\n') && !delta.starts_with('\n') {
                            text.push('\n');
                            inserted = true;
                        }
                        text.push_str(delta);
                        if entry.status.trim().is_empty() || entry.status == "completed" {
                            entry.status = "running".to_string();
                        }
                        entry.tool = None;
                        inserted
                    })
                    .unwrap_or(false);
                (row_id, index as u64 + 1, order_seq)
            } else {
                let entry_seq = runtime.transcript.len() as u64 + 1;
                let order_seq = runtime.alloc_tail_order_seq();
                let row_id = runtime.transcript.push(TranscriptRecord {
                    row_id: item_id.to_string(),
                    provider_item_id: Some(item_id.to_string()),
                    relay_item_id: None,
                    kind: TranscriptEntryKind::Command,
                    text: Some(delta.to_string()),
                    status: "running".to_string(),
                    turn_id: None,
                    tool: None,
                    order_seq,
                    withdrawn: false,
                    last_live_upsert_revision: None,
                });
                (row_id, entry_seq, order_seq)
            }
        };
        let (base_revision, revision) = self.bump_thread_transcript_revision(thread_id);
        // Same birth stamp as the agent-text delta above, by ROW id for the same
        // reason: the source spelling may belong to a different row entirely.
        self.stamp_transcript_item_seq(thread_id, &row_id, revision);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        TranscriptMutationMeta {
            separator_inserted,
            ..transcript_mutation_meta(base_revision, revision, entry_seq, order_seq, row_id)
        }
    }

    fn append_command_delta_legacy(
        &mut self,
        item_id: &str,
        delta: &str,
    ) -> TranscriptMutationMeta {
        if let Some(index) = self.transcript.resolve_index_in(IdSpace::Provider, item_id) {
            let (base_revision, revision) = self.bump_transcript_revision();
            let row_id = self.transcript[index].row_id.clone();
            let order_seq = self.transcript[index].order_seq;
            self.transcript.update_row(&row_id, |entry| {
                entry.kind = TranscriptEntryKind::Command;
                let text = entry.text.get_or_insert_with(String::new);
                if !text.is_empty() && !text.ends_with('\n') && !delta.starts_with('\n') {
                    text.push('\n');
                }
                text.push_str(delta);
                if entry.status.trim().is_empty() || entry.status == "completed" {
                    entry.status = "running".to_string();
                }
                entry.tool = None;
            });
            return transcript_mutation_meta(
                base_revision,
                revision,
                index as u64 + 1,
                order_seq,
                row_id,
            );
        }

        self.upsert_transcript_item(
            item_id.to_string(),
            TranscriptEntryKind::Command,
            Some(delta.to_string()),
            "running".to_string(),
            None,
            None,
        )
    }

    pub fn set_file_change_apply_state_for_thread(
        &mut self,
        thread_id: &str,
        item_id: &str,
        state: FileChangeApplyState,
    ) -> bool {
        let runtime = self.ensure_runtime_for_thread(thread_id);
        // Client-supplied, so a ROW key. `apply_states` is keyed the same way, or
        // the overlay lands under a key `transcript_views` never looks up.
        let Some(row_id) = runtime.transcript.resolve_row(item_id).map(str::to_string) else {
            return false;
        };
        runtime.apply_states.insert(row_id, state);
        self.bump_thread_transcript_revision(thread_id);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        true
    }

    /// `space` says whether `item_id` is the provider's name for the item or the
    /// relay's own key — a `turn-diff:*` row has no provider name at all, so looking
    /// it up in the provider namespace finds nothing.
    pub fn set_transcript_item_status(
        &mut self,
        space: IdSpace,
        item_id: &str,
        status: &str,
    ) -> bool {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return self.set_transcript_item_status_legacy(space, item_id, status);
        };
        self.set_transcript_item_status_for_thread(&thread_id, space, item_id, status)
    }

    pub fn set_transcript_item_status_for_thread(
        &mut self,
        thread_id: &str,
        space: IdSpace,
        item_id: &str,
        status: &str,
    ) -> bool {
        let Some(row_id) = self
            .ensure_runtime_for_thread(thread_id)
            .transcript
            .resolve_in(space, item_id)
            .map(str::to_string)
        else {
            return false;
        };
        self.ensure_runtime_for_thread(thread_id)
            .transcript
            .update_row(&row_id, |entry| entry.status = status.to_string());
        self.bump_thread_transcript_revision(thread_id);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        true
    }

    fn set_transcript_item_status_legacy(
        &mut self,
        space: IdSpace,
        item_id: &str,
        status: &str,
    ) -> bool {
        let Some(row_id) = self
            .transcript
            .resolve_in(space, item_id)
            .map(str::to_string)
        else {
            return false;
        };
        self.bump_transcript_revision();
        self.transcript
            .update_row(&row_id, |entry| entry.status = status.to_string());
        true
    }

    /// The turn's changes as they stand right now, INCLUDING edits still in flight —
    /// that is the "files being changed" feedback while a turn runs.
    pub fn turn_file_change_summary(
        &self,
        turn_id: &str,
    ) -> Vec<crate::protocol::FileChangeDiffView> {
        self.collect_turn_file_changes(turn_id, false)
    }

    /// The turn's changes once it has ENDED. An edit still marked running at that point
    /// never landed, so counting it would claim a finished change to a file nothing
    /// wrote — and hand it an Undo control.
    pub fn settled_turn_file_change_summary(
        &self,
        turn_id: &str,
    ) -> Vec<crate::protocol::FileChangeDiffView> {
        self.collect_turn_file_changes(turn_id, true)
    }

    fn collect_turn_file_changes(
        &self,
        turn_id: &str,
        settled: bool,
    ) -> Vec<crate::protocol::FileChangeDiffView> {
        let mut file_changes = Vec::new();

        let entries = self
            .selected_runtime()
            .map(|runtime| runtime.transcript.rows())
            .unwrap_or(self.transcript.rows());

        for entry in entries {
            if entry.turn_id.as_deref() != Some(turn_id) {
                continue;
            }
            // An edit that FAILED changed nothing, so it is not part of this turn's
            // changes. Including it made the transcript claim a file count for a turn
            // that touched nothing, and gave the synthetic turnDiff an Undo control for
            // an edit that was never applied. Filtering at the collector means every
            // consumer (live synthesis, hydration, the snapshot) inherits it.
            //
            // Only a terminal FAILURE is excluded: an edit still in flight has no diff
            // yet but is a real pending change and must stay listed.
            if matches!(entry.status.as_str(), "failed" | "error") {
                continue;
            }
            // Once the turn is over, "still running" means it never landed.
            if settled && entry.status != "completed" {
                continue;
            }
            let Some(tool) = entry.tool.as_ref() else {
                continue;
            };
            if tool.item_type != "fileChange" {
                continue;
            }

            for path in tool
                .file_changes
                .iter()
                .map(|change| change.path.clone())
                .chain(tool.path.clone())
            {
                crate::file_changes::merge_file_change_view(
                    &mut file_changes,
                    crate::protocol::FileChangeDiffView {
                        path,
                        change_type: "update".to_string(),
                        diff: String::new(),
                    },
                );
            }
            for change in tool.file_changes.clone() {
                crate::file_changes::merge_file_change_view(&mut file_changes, change);
            }
        }

        file_changes
    }
}

pub(super) fn merge_tool_call_view(
    existing: Option<ToolCallView>,
    incoming: Option<ToolCallView>,
) -> Option<ToolCallView> {
    match (existing, incoming) {
        (None, None) => None,
        (Some(existing), None) => Some(existing),
        (None, Some(incoming)) => Some(incoming),
        (Some(existing), Some(incoming)) => {
            let merge_file_changes =
                should_merge_tool_file_changes(&existing.item_type, &incoming.item_type);
            let name = if incoming.name.trim().is_empty() {
                existing.name.clone()
            } else {
                incoming.name.clone()
            };
            let file_changes = merge_tool_file_changes(
                existing.file_changes,
                incoming.file_changes,
                merge_file_changes,
            );

            Some(ToolCallView {
                item_type: select_tool_item_type(&existing.item_type, &incoming.item_type),
                name: name.clone(),
                title: select_tool_title(&existing.title, &incoming.title, &name),
                kind: incoming.kind.or(existing.kind),
                detail: incoming.detail.or(existing.detail),
                query: incoming.query.or(existing.query),
                path: incoming.path.or(existing.path),
                url: incoming.url.or(existing.url),
                command: incoming.command.or(existing.command),
                input_preview: incoming.input_preview.or(existing.input_preview),
                result_preview: incoming.result_preview.or(existing.result_preview),
                diff: incoming.diff.or(existing.diff),
                file_changes,
                apply_state: incoming.apply_state.or(existing.apply_state),
                file_changes_omitted: incoming.file_changes_omitted
                    || existing.file_changes_omitted,
                can_apply: None,
            })
        }
    }
}

fn merge_tool_file_changes(
    existing: Vec<crate::protocol::FileChangeDiffView>,
    incoming: Vec<crate::protocol::FileChangeDiffView>,
    merge_file_changes: bool,
) -> Vec<crate::protocol::FileChangeDiffView> {
    if !merge_file_changes {
        return if incoming.is_empty() {
            existing
        } else {
            incoming
        };
    }

    let mut file_changes = existing;
    for change in incoming {
        crate::file_changes::merge_file_change_view(&mut file_changes, change);
    }
    file_changes
}

fn should_merge_tool_file_changes(existing_item_type: &str, incoming_item_type: &str) -> bool {
    !existing_item_type.eq_ignore_ascii_case("turnDiff")
        && !incoming_item_type.eq_ignore_ascii_case("turnDiff")
}

/// Whether a reservation's row may still be withdrawn.
///
/// The reservation's id STAYS the settled row's id — there is no rename — so the id
/// alone no longer separates "still only a placeholder" from "Codex has answered for
/// this". Both callers already refuse once `reservation.turn_id` is set, and binding
/// stamps the reservation and the row together, so this is belt-and-braces rather than
/// the load-bearing check: it keeps the rule on the ROW, where a future caller that
/// forgets the reservation-side guard still cannot delete a real message.
/// A tombstone, not a deletion: a snapshot merge can only add and update, so a
/// deleted row lives on in every client that saw it. The marked row travels the
/// ordinary update channel instead. Withdrawal never rewinds the order cursors,
/// so the key stays spent either way.
fn mark_reservation_row_withdrawn(transcript: &mut super::ThreadTranscript, reservation_id: &str) {
    transcript.update_all(|entry| {
        if is_withdrawable_reservation_row(entry, reservation_id) {
            entry.withdrawn = true;
        }
    });
}

fn is_withdrawable_reservation_row(entry: &TranscriptRecord, reservation_id: &str) -> bool {
    entry.row_id == reservation_id
        && entry.kind == TranscriptEntryKind::UserText
        && entry.turn_id.is_none()
}

/// The legacy mirror only ever appends and never deletes in place, so deriving from
/// the last row cannot reissue a key. Runtimes must use their cursors instead.
fn next_legacy_tail_order_seq(transcript: &[TranscriptRecord]) -> i64 {
    transcript
        .last()
        .map(|record| {
            record
                .order_seq
                .checked_add(ORDER_SEQ_STEP)
                .expect("order_seq tail space exhausted")
        })
        .unwrap_or(0)
}

fn transcript_mutation_meta(
    base_revision: u64,
    revision: u64,
    entry_seq: u64,
    order_seq: i64,
    row_id: String,
) -> TranscriptMutationMeta {
    TranscriptMutationMeta {
        base_revision,
        revision,
        entry_seq,
        order_seq,
        row_id,
        server_time: super::super::unix_now(),
        text_offset: None,
        separator_inserted: false,
    }
}

fn transcript_mutation_meta_with_text_offset(
    base_revision: u64,
    revision: u64,
    entry_seq: u64,
    order_seq: i64,
    row_id: String,
    text_offset: u64,
) -> TranscriptMutationMeta {
    TranscriptMutationMeta {
        base_revision,
        revision,
        entry_seq,
        order_seq,
        row_id,
        server_time: super::super::unix_now(),
        text_offset: Some(text_offset),
        separator_inserted: false,
    }
}

fn select_tool_title(existing: &str, incoming: &str, name: &str) -> String {
    if incoming.trim().is_empty() {
        return existing.to_string();
    }
    if existing.trim().is_empty() {
        return incoming.to_string();
    }
    if is_generic_tool_title(incoming, name) && !is_generic_tool_title(existing, name) {
        return existing.to_string();
    }
    incoming.to_string()
}

fn select_tool_item_type(existing: &str, incoming: &str) -> String {
    if incoming.trim().is_empty() {
        return existing.to_string();
    }
    if existing.trim().is_empty() {
        return incoming.to_string();
    }
    if incoming.eq_ignore_ascii_case("toolCall") && !existing.eq_ignore_ascii_case("toolCall") {
        return existing.to_string();
    }
    incoming.to_string()
}

fn is_generic_tool_title(title: &str, name: &str) -> bool {
    let trimmed_title = title.trim();
    trimmed_title.eq_ignore_ascii_case(name)
        || trimmed_title.eq_ignore_ascii_case(&format!("{name} call"))
}
