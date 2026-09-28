//! Marking a handover's two injected prompts so clients draw them as cards.
//!
//! Best-effort: a missing mark leaves an ordinary user row and never fails the handover.

use crate::state::{AppState, HandoverMark};

use super::handover::continue_instruction;
use super::injection_marks::thread_provider;

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
            relay.injections.forget_mark(handover_id);
            relay.usage_store.forget_mark(handover_id);
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
