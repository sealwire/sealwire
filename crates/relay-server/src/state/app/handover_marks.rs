//! Marking a handover's two injected prompts so clients draw them as cards.
//!
//! Best-effort: a missing mark leaves an ordinary user row and never fails the handover.

use crate::protocol::{InjectionKind, TranscriptEntryKind};
use crate::state::{AppState, HandoverMark, InjectedMessage, MessageAnchor, RelayState};

use super::handover::continue_instruction;

/// How long to wait for a provider that writes the user row after `start_turn`
/// returns (the fake one does). Claude writes it before, and Codex needs none.
const ROW_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

fn thread_provider(relay: &RelayState, thread_id: &str) -> String {
    relay
        .runtime_for_thread(thread_id)
        .and_then(|runtime| runtime.summary.as_ref())
        .map(|summary| summary.provider.clone())
        .filter(|provider| !provider.is_empty())
        .or_else(|| relay.provider_hint_for_thread(thread_id))
        .unwrap_or_default()
}

impl AppState {
    /// Written once the source is about to be asked, so both cards have something
    /// to draw from the moment the first prompt lands.
    pub(super) async fn record_handover_mark(&self, handover_id: &str, note: &str) {
        let mut relay = self.relay.write().await;
        let Some(record) = relay.handover(handover_id).cloned() else {
            return;
        };
        let mark = HandoverMark {
            id: record.id.clone(),
            source_provider: thread_provider(&relay, &record.source_thread_id),
            target_provider: thread_provider(&relay, &record.target_thread_id),
            source_thread_id: record.source_thread_id,
            target_thread_id: record.target_thread_id,
            note: note.to_string(),
            instruction: continue_instruction().to_string(),
            status: record.status.as_str().to_string(),
            error: record.error,
            created_at: record.created_at,
            updated_at: record.updated_at,
        };
        relay.usage_store.save_handover_mark(&mark);
        relay.injections.put_handover(mark);
    }

    /// Marks the row `text` is about to become, until `anchor_injection` can name it.
    pub(super) async fn expect_injection(
        &self,
        handover_id: &str,
        thread_id: &str,
        text: &str,
        kind: InjectionKind,
    ) {
        let mut relay = self.relay.write().await;
        relay.injections.expect(thread_id, text, kind, handover_id);
    }

    pub(super) async fn forget_injection(
        &self,
        handover_id: &str,
        thread_id: &str,
        kind: InjectionKind,
    ) {
        let mut relay = self.relay.write().await;
        relay
            .injections
            .forget_pending(thread_id, kind, handover_id);
    }

    /// Ties the sent prompt to its row by a key the provider gives back after a restart.
    pub(super) async fn anchor_injection(
        &self,
        handover_id: &str,
        thread_id: &str,
        turn_id: Option<&str>,
        kind: InjectionKind,
    ) {
        let anchor = match turn_id {
            None => None,
            Some(turn_id) => self.stable_anchor(thread_id, turn_id).await,
        };
        let mut relay = self.relay.write().await;
        match anchor {
            Some(anchor) => {
                let message = InjectedMessage {
                    thread_id: thread_id.to_string(),
                    anchor,
                    kind,
                    handover_id: handover_id.to_string(),
                    created_at: crate::state::unix_now(),
                };
                relay.usage_store.record_injected_message(&message);
                relay.injections.anchor(message);
                relay.republish_thread_rows(thread_id);
            }
            None => relay
                .injections
                .forget_pending(thread_id, kind, handover_id),
        }
        relay.notify();
    }

    /// Codex rebuilds its rows under new ids but keeps the turn's; everyone else here
    /// echoes back the row id the relay sent, which a turn id is not (Claude's resets).
    async fn stable_anchor(&self, thread_id: &str, turn_id: &str) -> Option<MessageAnchor> {
        let deadline = tokio::time::Instant::now() + ROW_WAIT;
        loop {
            {
                let relay = self.relay.read().await;
                if thread_provider(&relay, thread_id) == "codex" {
                    return Some(MessageAnchor::Turn(turn_id.to_string()));
                }
                let row = relay.runtime_for_thread(thread_id).and_then(|runtime| {
                    runtime.transcript.iter().find(|row| {
                        row.kind == TranscriptEntryKind::UserText
                            && row.turn_id.as_deref() == Some(turn_id)
                    })
                });
                if let Some(row) = row {
                    let id = row.provider_item_id.as_ref().unwrap_or(&row.row_id);
                    return Some(MessageAnchor::Item(id.clone()));
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    /// Copies how the handover ended onto both cards.
    pub(super) async fn sync_handover_mark(&self, handover_id: &str) {
        let mut relay = self.relay.write().await;
        let Some(record) = relay.handover(handover_id).cloned() else {
            return;
        };
        let Some(mut mark) = relay.injections.handover(handover_id).cloned() else {
            return;
        };
        // Settled with no row carrying it: nothing will ever draw this card.
        if record.status.is_terminal() && !relay.injections.marks_any_row(handover_id) {
            relay.injections.forget_handover(handover_id);
            relay.usage_store.forget_handover_mark(handover_id);
            return;
        }
        mark.status = record.status.as_str().to_string();
        mark.error = record.error;
        mark.updated_at = record.updated_at;
        relay.usage_store.save_handover_mark(&mark);
        relay.injections.put_handover(mark);
        relay.republish_thread_rows(&record.source_thread_id);
        relay.republish_thread_rows(&record.target_thread_id);
        relay.notify();
    }
}
