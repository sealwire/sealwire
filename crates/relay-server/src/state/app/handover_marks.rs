//! Marking a handover's prompts and summary so clients draw them as cards.
//!
//! Best-effort: a missing mark leaves an ordinary message and never fails the handover.

use crate::protocol::InjectionKind;
use crate::state::delegation::one_line_result;
use crate::state::handover::summary_digest;
use crate::state::{
    AppState, HandoverMark, InjectedMessage, InjectionTag, MessageAnchor, RelayState, TurnOutcome,
};

use super::handover::continue_instruction;
use super::injection_marks::thread_provider;
use super::review::agent_entry_for_turn;

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
        // A fast turn can end before its id is stored here.
        relay.settle_handover_if_ended(handover_id);
    }

    /// The fallback for what no turn will ever end: a target that went away, or one
    /// started without a turn to go by. A recorded outcome is settled as it happens.
    pub(crate) async fn settle_handover_turns(&self) {
        let pending: Vec<(String, String, bool)> = {
            let relay = self.relay.read().await;
            relay
                .injections
                .handovers()
                .filter(|mark| mark.status == "done" && mark.finished_at.is_none())
                .map(|mark| {
                    (
                        mark.id.clone(),
                        mark.target_thread_id.clone(),
                        mark.target_turn_id.is_some(),
                    )
                })
                .collect()
        };
        if pending.is_empty() {
            return;
        }
        let mut relay = self.relay.write().await;
        for (handover_id, target, has_turn) in pending {
            match relay
                .runtime_for_thread(&target)
                .map(|runtime| runtime.is_working())
            {
                None => relay.settle_handover(&handover_id, None, None),
                Some(false) if !has_turn => relay.settle_handover(&handover_id, None, None),
                _ => relay.settle_handover_if_ended(&handover_id),
            }
        }
    }
}

impl RelayState {
    /// Called as a turn ends: settles the handover whose brief started it, if any.
    pub(crate) fn settle_handovers_for_turn(&mut self, thread_id: &str, turn_id: &str) {
        let ended: Vec<String> = self
            .injections
            .handovers()
            .filter(|mark| {
                mark.finished_at.is_none()
                    && mark.target_thread_id == thread_id
                    && mark.target_turn_id.as_deref() == Some(turn_id)
            })
            .map(|mark| mark.id.clone())
            .collect();
        for handover_id in ended {
            self.settle_handover_if_ended(&handover_id);
        }
    }

    /// Settles by the outcome the target recorded for its turn, once there is one.
    pub(crate) fn settle_handover_if_ended(&mut self, handover_id: &str) {
        let Some(mark) = self.injections.handover(handover_id) else {
            return;
        };
        let (target, Some(turn_id)) = (mark.target_thread_id.clone(), mark.target_turn_id.clone())
        else {
            return;
        };
        if mark.finished_at.is_some() {
            return;
        }
        let Some(outcome) = self.turn_terminal(&target, &turn_id) else {
            return;
        };
        // Only a completed turn has an answer; a stopped one's text is half of one.
        let reply = (outcome == TurnOutcome::Completed)
            .then(|| {
                let runtime = self.runtime_for_thread(&target)?;
                agent_entry_for_turn(&runtime.transcript_views(), &turn_id)
            })
            .flatten()
            .map(|(_, text, _, _)| text);
        self.settle_handover(handover_id, Some(outcome), reply);
    }

    /// `outcome` is `None` when how the target's turn ended can never be known.
    pub(crate) fn settle_handover(
        &mut self,
        handover_id: &str,
        outcome: Option<TurnOutcome>,
        reply: Option<String>,
    ) {
        let Some(mut mark) = self.injections.handover(handover_id).cloned() else {
            return;
        };
        mark.outcome = outcome.map(|outcome| {
            match outcome {
                TurnOutcome::Completed => "completed",
                TurnOutcome::Failed => "failed",
                TurnOutcome::Stopped => "stopped",
            }
            .to_string()
        });
        mark.result = reply.as_deref().and_then(one_line_result);
        mark.finished_at = Some(crate::state::unix_now());
        self.usage_store.save_handover_mark(&mark);
        self.injections.put_handover(mark);
        self.notify();
    }
}
