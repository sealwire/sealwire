//! Keeping a delegate's cards in step with its ask.

use relay_api::delegation::StartedBy;

use crate::protocol::{InjectionKind, TranscriptEntryKind};
use crate::state::delegation::{intent_title, Ask};

use super::injections::{DelegateMark, InjectedMessage, InjectionTag, MessageAnchor};
use super::transcript::TranscriptRecord;
use super::RelayState;

/// Claude names it `mcp__sealwire__report_back`, Codex plain `report_back`.
fn is_report_back_call(record: &TranscriptRecord) -> bool {
    record.kind == TranscriptEntryKind::ToolCall
        && record
            .tool
            .as_ref()
            .is_some_and(|tool| tool.name == "report_back" || tool.name.ends_with("__report_back"))
}

impl RelayState {
    /// Written as the ask is accepted, so its first row has a card to carry.
    pub(crate) fn record_delegate_mark(&mut self, ask: &Ask) {
        let mut mark = DelegateMark {
            id: ask.id.clone(),
            asker_thread_id: ask.asker_thread_id.clone(),
            // Before the brief, a person's ask holds what they typed.
            task: match ask.started_by {
                StartedBy::Person => ask.message.trim().to_string(),
                StartedBy::Agent => String::new(),
            },
            asked_at: ask.asked_at,
            ..DelegateMark::default()
        };
        self.fill_delegate_mark(&mut mark, ask);
        self.usage_store.save_delegate_mark(&mark);
        self.injections.put_delegate(mark);
    }

    /// Mirrors the ask onto its cards. An ask that settled before any row carried it
    /// has nothing left to draw.
    pub(crate) fn sync_delegate_mark(&mut self, ask_id: &str) {
        let Some(ask) = self.asks.get(ask_id).cloned() else {
            return;
        };
        let Some(mark) = self.injections.delegate(ask_id).cloned() else {
            return;
        };
        let mut next = mark.clone();
        self.fill_delegate_mark(&mut next, &ask);
        if next == mark {
            return;
        }
        if next.is_settled() && !self.injections.marks_any_row(ask_id) {
            self.injections.forget_mark(ask_id);
            self.usage_store.forget_mark(ask_id);
            return;
        }
        self.store_delegate_mark(next);
    }

    /// The peer's reply that became the answer: its own row carries the card, so the
    /// card does not wait for the task row to be loaded as well.
    pub(crate) fn mark_delegate_reply(
        &mut self,
        ask_id: &str,
        peer_thread_id: &str,
        item_id: &str,
    ) {
        self.mark_delegate_answer_row(ask_id, peer_thread_id, |record| {
            record.row_id == item_id || record.provider_item_id.as_deref() == Some(item_id)
        });
    }

    /// Best-effort: a call not yet in the transcript leaves the client to find it.
    pub(crate) fn mark_report_back_call(&mut self, ask_id: &str, peer_thread_id: &str) {
        let turn = self.asks.get(ask_id).and_then(|ask| ask.turn_id.clone());
        self.mark_delegate_answer_row(ask_id, peer_thread_id, |record| {
            is_report_back_call(record)
                && match (&turn, &record.turn_id) {
                    (Some(asked), Some(called)) => asked == called,
                    _ => true,
                }
        });
    }

    fn mark_delegate_answer_row(
        &mut self,
        ask_id: &str,
        peer_thread_id: &str,
        is_it: impl Fn(&TranscriptRecord) -> bool,
    ) {
        let Some(anchor) = self.runtime_for_thread(peer_thread_id).and_then(|runtime| {
            let record = runtime
                .transcript
                .iter()
                .filter(|record| is_it(record))
                .last()?;
            Some(MessageAnchor::Item(
                record
                    .provider_item_id
                    .clone()
                    .unwrap_or_else(|| record.row_id.clone()),
            ))
        }) else {
            return;
        };
        let tag = InjectionTag::delegate(InjectionKind::DelegateReported, &[ask_id.to_string()]);
        // Already an earlier ask's answer: this call is not in the transcript yet, and
        // overwriting would hand that card this answer, on disk too.
        if self
            .injections
            .tag_at(peer_thread_id, &anchor)
            .is_some_and(|held| *held != tag)
        {
            return;
        }
        let message = InjectedMessage {
            thread_id: peer_thread_id.to_string(),
            anchor,
            tag,
            created_at: crate::state::unix_now(),
        };
        self.usage_store.record_injected_message(&message);
        self.injections.anchor(message);
        self.republish_thread_rows(peer_thread_id);
    }

    /// After a restart the asks come back from the session file; their cards follow them.
    pub(crate) fn resync_delegate_marks(&mut self) {
        let ids: Vec<String> = self.asks.keys().cloned().collect();
        for id in ids {
            self.sync_delegate_mark(&id);
        }
    }

    pub(crate) fn edit_delegate_mark(
        &mut self,
        ask_id: &str,
        edit: impl FnOnce(&mut DelegateMark),
    ) {
        let Some(mut mark) = self.injections.delegate(ask_id).cloned() else {
            return;
        };
        edit(&mut mark);
        self.store_delegate_mark(mark);
    }

    fn store_delegate_mark(&mut self, mut mark: DelegateMark) {
        mark.updated_at = crate::state::unix_now();
        self.usage_store.save_delegate_mark(&mark);
        let threads = [mark.asker_thread_id.clone(), mark.peer_thread_id.clone()];
        self.injections.put_delegate(mark);
        for thread_id in threads.iter().filter(|id| !id.is_empty()) {
            self.republish_thread_rows(thread_id);
        }
    }

    fn fill_delegate_mark(&self, mark: &mut DelegateMark, ask: &Ask) {
        mark.peer_thread_id = ask.peer_thread_id.clone();
        mark.asker_provider = ask
            .asker_provider
            .clone()
            .filter(|provider| !provider.is_empty())
            .unwrap_or_else(|| self.provider_of_thread(&ask.asker_thread_id));
        mark.peer_provider = if !ask.peer_provider.is_empty() || ask.peer_thread_id.is_empty() {
            ask.peer_provider.clone()
        } else {
            self.provider_of_thread(&ask.peer_thread_id)
        };
        mark.title = intent_title(&ask.message).unwrap_or_default();
        mark.status = ask.status.as_str().to_string();
        mark.error = ask.error.clone();
        mark.answer = ask.answer.clone();
        mark.cited = ask.cited.clone();
        mark.answered_with_tool = ask.answered_with_tool;
        mark.delivered = ask.delivered;
        mark.finished_at = ask.finished_at;
        mark.sent_at = ask.sent_at;
    }
}
