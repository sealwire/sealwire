//! Ties a prompt the relay sends for someone to the row it becomes, so clients draw it
//! as what it was for. Best-effort: a missing mark leaves an ordinary user row.

use crate::protocol::TranscriptEntryKind;
use crate::state::{AppState, InjectedMessage, InjectionTag, MessageAnchor, RelayState};

use super::review::{DeviceFence, DispatchedTurn, ThreadDriveError};

/// How long to wait for a provider that writes the user row after `start_turn`
/// returns (the fake one does). Claude writes it before, and Codex needs none.
const ROW_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

pub(super) fn thread_provider(relay: &RelayState, thread_id: &str) -> String {
    relay.provider_of_thread(thread_id)
}

impl AppState {
    /// Marks the row `text` is about to become, until `anchor_injection` can name it.
    pub(super) async fn expect_injection(&self, tag: &InjectionTag, thread_id: &str, text: &str) {
        let mut relay = self.relay.write().await;
        relay.injections.expect(thread_id, text, tag.clone());
    }

    pub(super) async fn forget_injection(&self, tag: &InjectionTag, thread_id: &str) {
        let mut relay = self.relay.write().await;
        relay.injections.forget_pending(thread_id, tag);
    }

    /// Ties the sent prompt to its row by a key the provider gives back after a restart.
    pub(super) async fn anchor_injection(
        &self,
        tag: &InjectionTag,
        thread_id: &str,
        turn_id: Option<&str>,
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
                    tag: tag.clone(),
                    created_at: crate::state::unix_now(),
                };
                relay.usage_store.record_injected_message(&message);
                relay.injections.anchor(message);
                relay.republish_thread_rows(thread_id);
            }
            None => relay.injections.forget_pending(thread_id, tag),
        }
        relay.notify();
    }

    /// `send_message_to_thread`, with the row it opens marked. The row is named in the
    /// background: the caller's next step is waiting on the very turn this started.
    pub(super) async fn send_injected(
        &self,
        tag: InjectionTag,
        thread_id: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<DispatchedTurn, ThreadDriveError> {
        self.send_injected_fenced(tag, thread_id, text, model, effort, None)
            .await
    }

    pub(super) async fn send_injected_fenced(
        &self,
        tag: InjectionTag,
        thread_id: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<&str>,
        fence: Option<&DeviceFence<'_>>,
    ) -> Result<DispatchedTurn, ThreadDriveError> {
        self.expect_injection(&tag, thread_id, text).await;
        let sent = self
            .send_message_to_thread_fenced(thread_id, text, model, effort, fence)
            .await;
        match &sent {
            Ok(dispatched) => {
                let app = self.clone();
                let thread_id = thread_id.to_string();
                let turn_id = dispatched.turn_id.clone();
                tokio::spawn(async move {
                    app.anchor_injection(&tag, &thread_id, turn_id.as_deref())
                        .await;
                });
            }
            Err(_) => self.forget_injection(&tag, thread_id).await,
        }
        sent
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
}
