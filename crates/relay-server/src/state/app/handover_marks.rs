//! Marking a handover's prompts and summary so clients draw them as cards.
//!
//! Best-effort: a missing mark leaves an ordinary message and never fails the handover.

use crate::protocol::InjectionKind;
use crate::state::delegation::one_line_result;
use crate::state::handover::summary_digest;
use crate::state::{
    AppState, HandoverMark, InjectedMessage, InjectionTag, MessageAnchor, TurnOutcome,
};

use super::handover::continue_instruction;
use super::injection_marks::thread_provider;

impl AppState {
    /// The reply can be the entire tail page, including after a provider history read.
    pub(super) async fn mark_handover_summary(
        &self,
        handover_id: &str,
        thread_id: &str,
        row_id: &str,
    ) {
        let mut relay = self.relay.write().await;
        let anchor = relay.runtime_for_thread(thread_id).and_then(|runtime| {
            runtime.transcript.get_row(row_id).map(|row| {
                MessageAnchor::Item(
                    row.provider_item_id
                        .clone()
                        .unwrap_or_else(|| row.row_id.clone()),
                )
            })
        });
        let Some(anchor) = anchor else {
            tracing::warn!(
                handover_id,
                thread_id,
                row_id,
                "handover summary row missing when recording its card"
            );
            return;
        };
        let message = InjectedMessage {
            thread_id: thread_id.to_string(),
            anchor,
            tag: InjectionTag::handover(InjectionKind::HandoverSummary, handover_id),
            created_at: crate::state::unix_now(),
        };
        relay.usage_store.record_injected_message(&message);
        relay.injections.anchor(message);
        relay.republish_thread_rows(thread_id);
        relay.notify();
    }

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
            ..HandoverMark::default()
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

    /// What the target was handed, kept as the panel's lines, and the turn it started.
    pub(super) async fn record_handover_delivery(
        &self,
        handover_id: &str,
        summary: &str,
        target_turn_id: Option<String>,
    ) {
        let mut relay = self.relay.write().await;
        let Some(mut mark) = relay.injections.handover(handover_id).cloned() else {
            return;
        };
        let lines = summary_digest(summary);
        mark.goal = lines.goal;
        mark.state = lines.state;
        mark.next = lines.next;
        mark.target_turn_id = target_turn_id;
        relay.usage_store.save_handover_mark(&mark);
        relay.injections.put_handover(mark);
    }

    /// Settles each delivered handover once the target's turn on it has ended, by the
    /// outcome the target recorded: an idle target may just as well have failed.
    pub(crate) async fn settle_handover_turns(&self) {
        let ended: Vec<(String, String, Option<String>, Option<TurnOutcome>)> = {
            let relay = self.relay.read().await;
            relay
                .injections
                .handovers()
                .filter(|mark| mark.status == "done" && mark.finished_at.is_none())
                .filter_map(|mark| {
                    let runtime = relay.runtime_for_thread(&mark.target_thread_id);
                    let outcome = match (runtime, mark.target_turn_id.as_deref()) {
                        (Some(runtime), Some(turn)) => Some(runtime.finished_turn(turn)?),
                        (Some(runtime), None) if runtime.is_working() => return None,
                        // Gone, or started with no turn to go by: how it ended is unknown.
                        _ => None,
                    };
                    Some((
                        mark.id.clone(),
                        mark.target_thread_id.clone(),
                        mark.target_turn_id.clone(),
                        outcome,
                    ))
                })
                .collect()
        };
        for (handover_id, target, turn_id, outcome) in ended {
            let reply = match (outcome, turn_id) {
                (Some(TurnOutcome::Completed), Some(turn_id)) => {
                    self.assistant_entry_for_turn(&target, &turn_id).await
                }
                _ => None,
            };
            let mut relay = self.relay.write().await;
            let Some(mut mark) = relay.injections.handover(&handover_id).cloned() else {
                continue;
            };
            mark.outcome = outcome.map(|outcome| {
                match outcome {
                    TurnOutcome::Completed => "completed",
                    TurnOutcome::Failed => "failed",
                    TurnOutcome::Stopped => "stopped",
                }
                .to_string()
            });
            mark.result = reply.and_then(|(_, text, _, _)| one_line_result(&text));
            mark.finished_at = Some(crate::state::unix_now());
            relay.usage_store.save_handover_mark(&mark);
            relay.injections.put_handover(mark);
            relay.notify();
        }
    }
}
